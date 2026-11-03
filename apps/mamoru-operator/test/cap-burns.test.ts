// otto/mamoru#332: the cap counts CCTP burns in flight Base → Monad. Brais (design C): his Base Safe and his Monad Safe
// are different addresses; each is in the other's `ownerSafes`, so each operator asks the other for both. The burns are
// only in the Base operator's journal: the Base operator counts them in its own total until its read of the Monad Safe
// (the peer answer's block) holds the mint, and answers the Monad operator with those its read (the covered block in the
// path) does not hold yet. Two real Operators, a real MonadBridge journal, real PeerExposure on both sides; the chains are
// stubs at the Safe-read seam, the clock is frozen and moved by hand.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, type Address, type Hex, type PublicClient } from 'viem'
import type { AccountContext } from '@mamoru/domain'
import { baseRegistry, monadRegistry } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { verifyMetricsSignature } from '@mamoru/operator-auth'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { MINTED_KEEP_MS, MonadBridge, type BridgeBurn } from '../src/bridge-monad.ts'
import type { SafeRead } from '../src/chain.ts'
import { EXPOSURE_PATH, PeerExposure, coversAsked, exposurePath, parseExposurePath, type ChainExposure, type Covered, type ExposureWire, type PeerRead } from '../src/exposure.ts'
import { RpcMetrics } from '../src/metrics.ts'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import { startServer } from '../src/server.ts'
import type { AccountState, StateStore } from '../src/state.ts'

const SECRET = 'test-operator-secret'
const USDC = 1_000_000n
const T0 = Date.parse('2026-11-01T10:20:00Z')
const BASE_SAFE = getAddress('0x99ac3d214d4ce2e761f3108ee592d2a17ec3c01c')
const MONAD_SAFE = getAddress('0xd72a7cb9773dc58a9b944f9737996f45dbd1f108')
const UOP = `0x${'11'.repeat(32)}` as Hex
const BURN = 20n * USDC
/** What Brais holds, whatever the phase: the cap may count more (never less), and after the covering read exactly this. */
const TRUE = 100n * USDC
const MINTED_AT = 1_000n

const ctxOf = (accountKey: string, chainId: number, address: Address): AccountContext => ({ accountKey, chainId, address, owners: [], saltNonce: '0', passkey: { credentialId: accountKey, x: `0x${'01'.repeat(32)}`, y: `0x${'02'.repeat(32)}` } })

/** A Safe read reduced to what these tests value: a block and the USDC in it (localExposure is patched to read just that). */
const read = (block: bigint, usdc: bigint) => ({ block, usdc }) as unknown as SafeRead

type Priv = {
  readSafeCached(acc: AccountState, safe: Address, fresh: boolean): Promise<SafeRead>
  readOf(acc: AccountState, safe: Address): Promise<SafeRead>
  readUnowned(safe: Address): Promise<SafeRead>
  localExposure(acc: AccountState | undefined, r: SafeRead): ChainExposure
  otherSafes(acc: AccountState): Address[]
  localTotal(acc: AccountState, safe: Address): Promise<{ total: bigint; safe: Address; block: bigint }>
  startTotal(acc: AccountState, local: { total: bigint; safe: Address; block: bigint }): Promise<{ total: bigint; across: boolean }>
  peerRead(acc: AccountState, maxAgeMs: number, covered?: Covered): Promise<PeerRead>
  engineCap(acc: AccountState, observedBlock: bigint): Promise<{ capUsdc: bigint; elsewhereUsdc: bigint | null }>
  enginePeers: Map<string, PeerRead>
  elsewhereOf(acc: AccountState, peers: PeerRead): bigint | null
}

/** A peer operator behind fetch: the signature checked on the pathname, the path parsed as the server does. */
function fetchTo(op: () => Operator, clock: { t: number }, paths: string[]) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url)
    const sig = (init.headers as Record<string, string>)['x-mamoru-sig']
    if (!(await verifyMetricsSignature(SECRET, 'GET', u.pathname, sig, clock.t))) return new Response('{}', { status: 401 })
    const asked = parseExposurePath(u.pathname)
    if (!asked) return new Response('{}', { status: 400 })
    paths.push(u.pathname)
    return Response.json(await op().exposureFor(asked.safe as Address, asked.covered))
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-cap-burns-'))
  const clock = { t: T0 }
  const chains = { baseBlock: 500n, baseUsdc: TRUE, monadBlock: 990n, minted: null as bigint | null }
  const monadUsdc = (block = chains.monadBlock) => (chains.minted !== null && block >= chains.minted ? BURN : 0n)
  /** Mint receipts on Monad (the journal's backfill of mintedBlock reads them); a hash not here is unreadable. */
  const receipts = new Map<string, bigint>()
  const monadClient = { getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
    const n = receipts.get(hash)
    if (n === undefined) throw new Error('receipt not found')
    return { status: 'success', blockNumber: n }
  } } as unknown as PublicClient
  const bridge = new MonadBridge(dir, {} as PublicClient, monadClient, null, (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch, () => clock.t, baseRegistry, monadRegistry)
  const relayer = { address: `0x${'7'.repeat(40)}` } as unknown as Relayer
  /** One account in an operator's store, as a running engine has it (account() would derive the address from keys these tests do not have). */
  const store = (accountKey: string, chainId: number, address: Address) => {
    const acc: AccountState = { accountKey, ctx: ctxOf(accountKey, chainId, address), trusted: false, active: true, grants: [], revoked: [], managedTokenIds: [], depositsAfter: '0', historyFromBlock: '0', epoch: 0, ops: [], seq: 0 }
    return { state: { accounts: { [accountKey]: acc } }, save: () => {} } as unknown as StateStore
  }
  const toMonad: string[] = []
  const toBase: string[] = []
  let base!: Operator
  let monad!: Operator
  const common = { live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  base = new Operator(
    { ...common, chainId: 8453, registry: baseRegistry, bridgeMonad: bridge, peers: new PeerExposure([{ chainId: 143, url: 'http://monad.test' }], SECRET, fetchTo(() => monad, clock, toMonad), () => clock.t) } satisfies OperatorConfig,
    {} as PublicClient,
    relayer,
    store('brais', 8453, BASE_SAFE),
  )
  monad = new Operator(
    { ...common, chainId: 143, registry: monadRegistry, peers: new PeerExposure([{ chainId: 8453, url: 'http://base.test' }], SECRET, fetchTo(() => base, clock, toBase), () => clock.t) } satisfies OperatorConfig,
    {} as PublicClient,
    relayer,
    store('brais-143', 143, MONAD_SAFE),
  )
  const baseAcc = (base as unknown as { store: StateStore }).store.state.accounts.brais!
  const monadAcc = (monad as unknown as { store: StateStore }).store.state.accounts['brais-143']!
  const b = base as unknown as Priv
  const m = monad as unknown as Priv
  // The Safe reads: each chain holds money only in its own Safe of Brais's (the other address is empty there).
  b.readSafeCached = b.readOf = async (_a, safe) => read(chains.baseBlock, safe.toLowerCase() === BASE_SAFE.toLowerCase() ? chains.baseUsdc : 0n)
  b.readUnowned = async () => read(chains.baseBlock, 0n)
  m.readSafeCached = m.readOf = async (_a, safe) => read(chains.monadBlock, safe.toLowerCase() === MONAD_SAFE.toLowerCase() ? monadUsdc() : 0n)
  m.readUnowned = async () => read(chains.monadBlock, 0n)
  // Valuation is not what this ticket changes: USDC only.
  for (const [p, chainId] of [[b, 8453], [m, 143]] as const) p.localExposure = (a, r) => ({ chainId, idleUsdc: (r as unknown as { usdc: bigint }).usdc, placedUsdc: 0n, active: a?.active ?? false })
  // Brais's ownerSafes from the settings pull: each account's other Safe.
  b.otherSafes = () => [MONAD_SAFE]
  m.otherSafes = () => [BASE_SAFE]
  const signing: BridgeSigning = { opId: 'op-1', account: BASE_SAFE, recipient: MONAD_SAFE, depositor: BASE_SAFE, chainId: 143, pool: 'pool:WMON/USDC/3000', bucket: 'growth', amount: BURN, destinationDomain: 15, userOpHash: UOP, nonceKey: 0n, nonce: 7n, prepareBlock: 499n }
  const burn = () => (bridge as unknown as { journal: { burns: Record<string, BridgeBurn> } }).journal.burns[UOP]!
  const update = (patch: Partial<BridgeBurn>) => (bridge as unknown as { update(x: BridgeBurn, p: Partial<BridgeBurn>): void }).update(burn(), patch)
  /** Both operators' totals for the account: the Start check (startTotal) and an engine review's (peer read, then elsewhere). */
  const totals = async () => {
    clock.t += 60_000 // every peer cache is older than any check allows
    const startB = (await b.startTotal(baseAcc, await b.localTotal(baseAcc, BASE_SAFE))).total
    const startM = (await m.startTotal(monadAcc, await m.localTotal(monadAcc, MONAD_SAFE))).total
    clock.t += 60_000
    // The engine loop: Base reads its peers before the review; Monad inside it, pinned to the review's observation.
    b.enginePeers.set('brais', await b.peerRead(baseAcc, 2_000))
    const engineB = (await b.localTotal(baseAcc, BASE_SAFE)).total + (await b.engineCap(baseAcc, chains.baseBlock)).elsewhereUsdc!
    const engineM = (await engineMonad()).total
    return { startB, startM, engineB, engineM }
  }
  /**
   * A Monad engine review: its observation of the Monad Safe at `observed` (a lagging provider: below the head), and the
   * cap's peer read pinned to that block (engineCap). Its total: that observation plus what the cap counts elsewhere.
   */
  const engineMonad = async (observed = chains.monadBlock) => {
    const local = monadUsdc(observed)
    const cap = await m.engineCap(monadAcc, observed)
    return { total: local + cap.elsewhereUsdc!, elsewhere: cap.elsewhereUsdc! }
  }
  return { dir, clock, chains, bridge, receipts, engineMonad, base, monad, baseAcc, monadAcc, b, m, signing, burn, update, totals, toMonad, toBase }
}

const all = (t: Record<string, bigint>, v: bigint) => Object.values(t).every((x) => x === v)

describe('Brais through one bridge: the account total across both operators (otto/mamoru#332)', () => {
  test('before burn, sending, burned, attested, minted with Monad read before mintedBlock, then at it: never below the money, exact once covered', async () => {
    const s = setup()
    // Before the burn: Base 100, Monad 0.
    expect(all(await s.totals(), TRUE)).toBe(true)

    // Sending: on disk before the userOp is signed, the USDC still in the Base Safe. Counted twice: only less is placed.
    s.bridge.recordSending('brais', s.signing)
    expect(all(await s.totals(), TRUE + BURN)).toBe(true)

    // Burned: the USDC left Base; nothing on Monad yet. Without #332 this was 80 on both sides for ~15 min.
    s.chains.baseBlock = 510n
    s.chains.baseUsdc = TRUE - BURN
    s.update({ state: 'burned', txHash: `0x${'22'.repeat(32)}`, burnBlock: '505' })
    expect(all(await s.totals(), TRUE)).toBe(true)

    // Attested (still 'burned' in the journal, with attestedAt and the CCTP nonce).
    s.update({ attestedAt: new Date(s.clock.t).toISOString(), cctpNonce: `0x${'44'.repeat(32)}` })
    expect(all(await s.totals(), TRUE)).toBe(true)

    // Minted at Monad block 1000, every Monad read still at 999 (a lagging provider): the burn keeps counting on both sides.
    s.chains.minted = MINTED_AT
    s.chains.monadBlock = MINTED_AT - 1n
    s.update({ state: 'minted', mintTx: `0x${'33'.repeat(32)}`, mintedBlock: MINTED_AT.toString(), mintAt: new Date(s.clock.t).toISOString() })
    expect(all(await s.totals(), TRUE)).toBe(true)

    // The Monad reads reach the mint's block: the 20 USDC are in them, the burn stops counting. Exactly the money, no double count.
    s.chains.monadBlock = MINTED_AT
    expect(all(await s.totals(), TRUE)).toBe(true)
    s.chains.monadBlock = MINTED_AT + 50n
    expect(all(await s.totals(), TRUE)).toBe(true)

    // The Monad operator asked Base with its own read of its own Safe in the path; Base asked Monad with the older shape.
    expect(s.toBase.some((p) => p === `${EXPOSURE_PATH}${BASE_SAFE.toLowerCase()}/143/${MONAD_SAFE.toLowerCase()}/${MINTED_AT + 50n}`)).toBe(true)
    expect(s.toMonad.every((p) => p.split('/').length === 4)).toBe(true)
  })

  test('pruned (30 days, a read of the recipient at or after mintedBlock recorded): the burn is gone from the journal and the live Monad read holds its money', async () => {
    const s = setup()
    s.bridge.recordSending('brais', s.signing)
    s.chains.baseUsdc = TRUE - BURN
    s.chains.minted = MINTED_AT
    s.chains.monadBlock = MINTED_AT + 10n
    s.update({ state: 'minted', mintedBlock: MINTED_AT.toString(), mintAt: new Date(s.clock.t).toISOString() })
    const j = (s.bridge as unknown as { journal: { shown: Record<string, { totalUsdc: string; block: string; at: string }> }; prune(): void })
    // No confirming read on record: kept however old.
    s.clock.t += MINTED_KEEP_MS + 60_000
    j.prune()
    expect(s.bridge.burns()).toHaveLength(1)
    j.journal.shown[MONAD_SAFE.toLowerCase()] = { totalUsdc: BURN.toString(), block: (MINTED_AT + 5n).toString(), at: new Date(s.clock.t).toISOString() }
    j.prune()
    expect(s.bridge.burns()).toHaveLength(0)
    expect(all(await s.totals(), TRUE)).toBe(true)
  })

  test('a failed or dropped burn is not counted; a minted one without mintedBlock (old entries) counts until pruned', async () => {
    const s = setup()
    s.bridge.recordSending('brais', s.signing)
    s.update({ state: 'failed' })
    expect(s.bridge.capUsdc([BASE_SAFE], () => undefined)).toBe(0n)
    expect(all(await s.totals(), TRUE)).toBe(true)
    s.update({ state: 'dropped' })
    expect(s.bridge.capUsdc([BASE_SAFE], () => undefined)).toBe(0n)

    // Legacy: minted, no mintedBlock. Every read covers nothing: counted on both sides (over, never under).
    s.chains.baseUsdc = TRUE - BURN
    s.chains.minted = MINTED_AT
    s.chains.monadBlock = MINTED_AT + 1_000n
    s.update({ state: 'minted', mintAt: new Date(s.clock.t).toISOString() })
    expect(s.bridge.capUsdc([BASE_SAFE], () => 10n ** 12n)).toBe(BURN)
    expect(all(await s.totals(), TRUE + BURN)).toBe(true)
    // Pruned once 30 days old with a live read of the recipient after the mint was seen: then the read alone counts it.
    const j = s.bridge as unknown as { journal: { shown: Record<string, { totalUsdc: string; block: string; at: string }> }; prune(): void }
    s.clock.t += MINTED_KEEP_MS + 60_000
    j.journal.shown[MONAD_SAFE.toLowerCase()] = { totalUsdc: BURN.toString(), block: (MINTED_AT + 1_000n).toString(), at: new Date(s.clock.t).toISOString() }
    j.prune()
    expect(s.bridge.burns()).toHaveLength(0)
    expect(all(await s.totals(), TRUE)).toBe(true)
  })

  test('Base answers by the covered Safe only: a read of another Safe, another chain, or the older path covers nothing', async () => {
    const s = setup()
    s.bridge.recordSending('brais', s.signing)
    s.chains.baseUsdc = TRUE - BURN
    s.update({ state: 'minted', mintedBlock: MINTED_AT.toString() })
    const idle = async (covered?: Covered) => BigInt((await s.base.exposureFor(BASE_SAFE, covered)).idleUsdc)
    const later = MINTED_AT + 100n
    expect(await idle({ chainId: 143, safe: MONAD_SAFE.toLowerCase(), block: later })).toBe(TRUE - BURN)
    expect(await idle({ chainId: 143, safe: MONAD_SAFE.toLowerCase(), block: MINTED_AT - 1n })).toBe(TRUE)
    expect(await idle({ chainId: 143, safe: `0x${'ab'.repeat(20)}`, block: later })).toBe(TRUE)
    expect(await idle({ chainId: 10, safe: MONAD_SAFE.toLowerCase(), block: later })).toBe(TRUE)
    // The older path (an old Monad operator during the deploy): every minted burn counts, until pruned.
    expect(await idle()).toBe(TRUE)
    // Another Safe's question (the Monad Safe's own address, asked of Base) carries no burn: it is no Base account here.
    expect(BigInt((await s.base.exposureFor(MONAD_SAFE, { chainId: 143, safe: MONAD_SAFE.toLowerCase(), block: 0n })).idleUsdc)).toBe(0n)
  })

  test('Base computing its own total: a minted burn stops counting only at a peer answer of its recipient at or after mintedBlock; a failed peer read counts every burn', async () => {
    const s = setup()
    s.bridge.recordSending('brais', s.signing)
    s.update({ state: 'minted', mintedBlock: MINTED_AT.toString() })
    const at = (safe: Address, block: bigint, chainId = 143): PeerRead => ({ ok: true, chains: [{ chainId, idleUsdc: 0n, placedUsdc: 0n, active: true, at: { safe: safe.toLowerCase(), block } }] })
    expect(s.b.elsewhereOf(s.baseAcc, at(MONAD_SAFE, MINTED_AT))).toBe(0n)
    expect(s.b.elsewhereOf(s.baseAcc, at(MONAD_SAFE, MINTED_AT - 1n))).toBe(BURN)
    expect(s.b.elsewhereOf(s.baseAcc, at(BASE_SAFE, MINTED_AT + 9n))).toBe(BURN)
    expect(s.b.elsewhereOf(s.baseAcc, at(MONAD_SAFE, MINTED_AT + 9n, 8453))).toBe(BURN)
    // Cap closed for placements; funding still shows every burn.
    expect(s.b.elsewhereOf(s.baseAcc, { ok: false, chainId: 143 })).toBeNull()
  })
})

describe('the covered read and the peer cache (otto/mamoru#332)', () => {
  const SAFE = '0x1c046083d60655f3cde66130d774ac64c5a5d60a'
  const OWN = '0x000000000000000000000000000000000000d72a'
  const cov = (block: bigint, safe = OWN, chainId = 143): Covered => ({ chainId, safe, block })

  test('an answer for covered c stands for a read of the same Safe at c or later; one without a covered read stands for any', () => {
    expect(coversAsked(undefined, undefined)).toBe(true)
    expect(coversAsked(undefined, cov(5n))).toBe(true)
    expect(coversAsked(cov(5n), undefined)).toBe(false)
    expect(coversAsked(cov(5n), cov(5n))).toBe(true)
    expect(coversAsked(cov(5n), cov(6n))).toBe(true)
    expect(coversAsked(cov(5n), cov(4n))).toBe(false)
    expect(coversAsked(cov(5n), cov(6n, SAFE))).toBe(false)
    expect(coversAsked(cov(5n), cov(6n, OWN, 10))).toBe(false)
  })

  test('PeerExposure reuses a cached answer only under that rule, and asks again otherwise', async () => {
    const clock = { t: T0 }
    const paths: string[] = []
    const fetchFn = async (url: string) => {
      paths.push(new URL(url).pathname)
      return Response.json({ chainId: 8453, address: SAFE, block: '7', idleUsdc: '1', placedUsdc: '0', active: true } satisfies ExposureWire)
    }
    const r = new PeerExposure([{ chainId: 8453, url: 'http://base.test' }], SECRET, fetchFn, () => clock.t)
    await r.read(SAFE, 30_000, cov(1_000n))
    expect(paths).toEqual([exposurePath(SAFE, cov(1_000n))])
    await r.read(SAFE, 30_000, cov(1_000n))
    await r.read(SAFE, 30_000, cov(1_005n))
    expect(paths).toHaveLength(1)
    await r.read(SAFE, 30_000, cov(999n))
    expect(paths).toHaveLength(2)
    await r.read(SAFE, 30_000, cov(1_005n, SAFE))
    expect(paths).toHaveLength(3)
    await r.read(SAFE, 30_000)
    expect(paths.at(-1)).toBe(`${EXPOSURE_PATH}${SAFE}`)
    // Cached without a covered read (every minted burn counted): stands for any later ask.
    await r.read(SAFE, 30_000, cov(1n))
    expect(paths).toHaveLength(4)
    // Age still applies.
    clock.t += 30_000
    await r.read(SAFE, 30_000, cov(1n))
    expect(paths).toHaveLength(5)
  })

  test('the two path shapes, and the server: older shape and covered shape served, anything else 400', async () => {
    expect(parseExposurePath(`${EXPOSURE_PATH}${SAFE}`)).toEqual({ safe: SAFE })
    expect(parseExposurePath(exposurePath(SAFE, cov(12n)))).toEqual({ safe: SAFE, covered: cov(12n) })
    for (const bad of [`${SAFE}/143/${OWN}`, `${SAFE}/143/${OWN}/x`, `${SAFE}/143/nope/1`, `${SAFE}/x/${OWN}/1`, `${SAFE}/143/${OWN}/1/2`, `${SAFE}/`]) expect(parseExposurePath(`${EXPOSURE_PATH}${bad}`)).toBeNull()

    const d = mkdtempSync(join(tmpdir(), 'mamoru-cap-burns-srv-'))
    const asked: unknown[] = []
    const op = {
      cfg: { chainId: 8453, registry: baseRegistry, live: true, policy: { policyId: 'p' } },
      relayer: { address: '0x1111111111111111111111111111111111111111' },
      exposureFor: async (address: string, covered?: Covered) => (asked.push([address, covered]), { chainId: 8453, address: address.toLowerCase(), block: '9', idleUsdc: '0', placedUsdc: '0', active: false }),
    } as unknown as Operator
    const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics: new RpcMetrics(d), gitSha: 'x', bootedAt: Date.now() })
    try {
      const url = `http://127.0.0.1:${server.port}`
      const reader = new PeerExposure([{ chainId: 8453, url }], SECRET)
      expect((await reader.read(SAFE, 0)).ok).toBe(true)
      expect((await reader.read(SAFE, 0, cov(12n))).ok).toBe(true)
      expect(asked).toEqual([[SAFE, undefined], [SAFE, cov(12n)]])
      // check() probes the shape this operator reads with.
      expect(await reader.check(cov(0n, `0x${'0'.repeat(40)}`))).toEqual([{ chainId: 8453, ok: true }])
      expect(await reader.check()).toEqual([{ chainId: 8453, ok: true }])
      const { metricsSignature } = await import('@mamoru/operator-auth')
      const path = `${EXPOSURE_PATH}${SAFE}/143/${OWN}`
      expect((await fetch(`${url}${path}`, { headers: { 'x-mamoru-sig': await metricsSignature(SECRET, 'GET', path, Math.floor(Date.now() / 60_000)) } })).status).toBe(400)
      // The covered read is under the signature: a signature for the older path does not pass the longer one.
      const sigOld = await metricsSignature(SECRET, 'GET', `${EXPOSURE_PATH}${SAFE}`, Math.floor(Date.now() / 60_000))
      expect((await fetch(`${url}${exposurePath(SAFE, cov(12n))}`, { headers: { 'x-mamoru-sig': sigOld } })).status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('check() against a peer on older code: the covered probe says so (400)', async () => {
    const old = async (url: string) => (new URL(url).pathname.split('/').length > 4 ? new Response('{}', { status: 400 }) : Response.json({ chainId: 8453 }))
    const r = new PeerExposure([{ chainId: 8453, url: 'http://base.test' }], SECRET, old)
    expect(await r.check(cov(0n))).toEqual([{ chainId: 8453, ok: false, why: 'refuses the covered-read path (400): the peer runs older code' }])
    expect(await r.check()).toEqual([{ chainId: 8453, ok: true }])
  })
})

describe('otto/mamoru#332 review r2', () => {
  test('a Monad engine review whose observation lags the head (999, mint at 1000) counts the burn: the cover is that observation', async () => {
    const s = setup()
    s.bridge.recordSending('brais', s.signing)
    s.chains.baseUsdc = TRUE - BURN
    s.chains.minted = MINTED_AT
    s.chains.monadBlock = MINTED_AT
    s.update({ state: 'minted', mintedBlock: MINTED_AT.toString() })
    // A Start on Monad reads its Safe at 1000 (the head) and asks Base with that cover: the burn is in its read.
    const m = s.m
    expect((await m.startTotal(s.monadAcc, await m.localTotal(s.monadAcc, MONAD_SAFE))).total).toBe(TRUE)
    // The review observes at 999 on a lagging provider: the cached answer for cover 1000 does not stand for it, Base is
    // asked again with 999 and counts the burn (the observation does not hold the mint yet).
    const before = s.toBase.length
    const lag = await s.engineMonad(MINTED_AT - 1n)
    expect(lag.total).toBe(TRUE)
    expect(s.toBase.slice(before).some((p) => p.endsWith(`/${MINTED_AT - 1n}`))).toBe(true)
    // Within the engine's 2 s the answer for 999 stands for a review at 1000 (it counts the burn: more, never less).
    expect((await s.engineMonad(MINTED_AT)).total).toBe(TRUE + BURN)
    // A fresh review at the mint's block: the observation holds it and Base leaves it out, exact.
    s.clock.t += 3_000
    expect((await s.engineMonad(MINTED_AT)).total).toBe(TRUE)
  })

  test('burns by source Safe: a sibling Base Safe (no account here) is counted once on each side, never under another Safe', async () => {
    const s = setup()
    const SIB = getAddress('0x5151515151515151515151515151515151515151')
    // Brais's other Base Safe held 20 and burned them to his Monad Safe; his main Safe holds 100.
    s.bridge.recordSending('brais', { ...s.signing, account: SIB, depositor: SIB })
    s.update({ state: 'burned' })
    s.b.otherSafes = () => [MONAD_SAFE, SIB]
    s.m.otherSafes = () => [BASE_SAFE, SIB]
    const truth = TRUE + BURN
    expect(all(await s.totals(), truth)).toBe(true)
    // Base answers each Safe with its own burns only, whether or not an account names it.
    expect(BigInt((await s.base.exposureFor(BASE_SAFE)).idleUsdc)).toBe(TRUE)
    expect(BigInt((await s.base.exposureFor(SIB)).idleUsdc)).toBe(BURN)
  })

  test('a legacy minted burn gets mintedBlock from its mint receipt (updatedAt kept); unreadable, it keeps counting', async () => {
    const s = setup()
    s.bridge.recordSending('brais', s.signing)
    s.chains.baseUsdc = TRUE - BURN
    s.chains.minted = MINTED_AT
    s.chains.monadBlock = MINTED_AT + 5n
    const MINT = `0x${'33'.repeat(32)}` as Hex
    s.update({ state: 'minted', mintTx: MINT, mintAt: new Date(s.clock.t).toISOString() })
    const updatedAt = s.burn().updatedAt
    // Receipt not readable yet: still no mintedBlock, still counted on top of the Monad read that holds it.
    await s.bridge.tick()
    expect(s.burn().mintedBlock).toBeUndefined()
    expect(all(await s.totals(), TRUE + BURN)).toBe(true)
    s.receipts.set(MINT, MINTED_AT)
    await s.bridge.tick()
    expect(s.burn().mintedBlock).toBe(MINTED_AT.toString())
    expect(s.burn().updatedAt).toBe(updatedAt)
    expect(all(await s.totals(), TRUE)).toBe(true)
  })

  test('PeerExposure: answers completing out of order never replace a broader or newer one', async () => {
    const SAFE = '0x1c046083d60655f3cde66130d774ac64c5a5d60a'
    const OWN = '0x000000000000000000000000000000000000d72a'
    const cov = (block: bigint): Covered => ({ chainId: 143, safe: OWN, block })
    const clock = { t: T0 }
    const pending: { path: string; done: (idle: string) => void }[] = []
    let asked = 0
    const fetchFn = (url: string) => {
      asked++
      return new Promise<Response>((resolve) => pending.push({ path: new URL(url).pathname, done: (idle) => resolve(Response.json({ chainId: 8453, address: SAFE, block: '7', idleUsdc: idle, placedUsdc: '0', active: true })) }))
    }
    const r = new PeerExposure([{ chainId: 8453, url: 'http://base.test' }], SECRET, fetchFn, () => clock.t)
    const idle = (x: PeerRead | undefined) => (x && x.ok ? x.chains[0]!.idleUsdc : null)
    // Cover 100 asked first, cover 90 after it (the running read does not stand for 90): 90 completes first.
    const slow = r.read(SAFE, 30_000, cov(100n))
    const fast = r.read(SAFE, 30_000, cov(90n))
    const sent = async (n: number) => {
      for (let i = 0; i < 100 && pending.length < n; i++) await Bun.sleep(1)
    }
    await sent(2)
    expect(pending.map((p) => p.path)).toEqual([exposurePath(SAFE, cov(100n)), exposurePath(SAFE, cov(90n))])
    clock.t += 10
    pending[1]!.done('90')
    await fast
    clock.t += 10
    pending[0]!.done('100')
    await slow
    // The later, narrower answer (cover 100) did not evict the broader one (cover 90): an ask at 95 still has an answer.
    expect(idle(r.cached(SAFE, 30_000, cov(95n)))).toBe(90n)
    expect(idle(r.cached(SAFE, 30_000, cov(100n)))).toBe(100n)
    expect(r.cached(SAFE, 30_000, cov(89n))).toBeUndefined()
    // An uncovered answer completing after both is broader and newer: it stands for every ask.
    const all3 = r.read(SAFE, 30_000)
    await sent(3)
    clock.t += 10
    pending[2]!.done('1')
    await all3
    expect(idle(r.cached(SAFE, 30_000, cov(89n)))).toBe(1n)
    expect(idle(r.cached(SAFE, 30_000, cov(100n)))).toBe(1n)
    expect(asked).toBe(3)
    // An older narrower answer completing after a broader newer one is dropped on arrival.
    const late = r.read(SAFE, 30_000, cov(5n))
    expect(asked).toBe(3) // the uncovered answer stands for it: no read at all
    expect(idle(await late)).toBe(1n)
  })
})
