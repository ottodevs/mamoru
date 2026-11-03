// otto/mamoru#355: the cap counts the return leg Monad → Base in flight. Brais on V4: his home Safe on Base and his remote
// V4 Safe on Monad are different addresses, each in the other's `ownerSafes`, so each operator asks the other for both.
// The burning side (Monad, its release journal) counts its own release sending or burned until an answer of Base in the
// same total lists the id (Base's ReturnHome holds it: burned on its way, or minted, counted until Base's read holds the
// mint). Base counts its journal's returns and the releases Monad reports that its journal does not hold yet. Two real
// Operators, a real ReturnHome on disk, the real release state functions on the Monad account, real PeerExposure on both
// sides; the chains are stubs at the Safe-read seam, the clock is frozen and moved by hand.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, getAddress, keccak256, pad, toHex, type Address, type Hex, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { TOKEN_MESSENGER_V2 } from '../src/cctp.ts'
import type { AccountContext } from '@mamoru/domain'
import { baseRegistry, monadRegistry } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { verifyMetricsSignature } from '@mamoru/operator-auth'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import type { SafeRead } from '../src/chain.ts'
import { PeerExposure, parseExposurePath, type ChainExposure, type Covered, type ExposureWire, type PeerRead } from '../src/exposure.ts'
import { buildMoneyMap, returnRows, type ReturnLeg } from '../src/money-map.ts'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import { applySettle, beforeSign, cancelRelease, releaseView, requestRelease, releasesToCount } from '../src/release.ts'
import { RETURN_KEEP_MS, RETURN_LISTED, ReturnHome, type ReturnEntry, type ReturnPeer } from '../src/return-home.ts'
import type { AccountState, StateStore } from '../src/state.ts'

const SECRET = 'test-operator-secret'
const USDC = 1_000_000n
const T0 = Date.parse('2026-11-03T10:00:00Z')
const HOME = getAddress('0x99ac3d214d4ce2e761f3108ee592d2a17ec3c01c')
const REMOTE = getAddress('0xd72a7cb9773dc58a9b944f9737996f45dbd1f108')
const RET = 20n * USDC
/** What Brais holds, whatever the phase: 60 on Base, 40 on Monad before the return. */
const TRUE = 100n * USDC
const BASE0 = 60n * USDC
const MONAD0 = 40n * USDC
const BURN_BLOCK = 2_000
const MINTED_AT = 9_000n
const UOP = `0x${'55'.repeat(32)}` as Hex
const BURN_TX = `0x${'66'.repeat(32)}` as Hex

const ctxOf = (accountKey: string, chainId: number, address: Address, remote?: unknown): AccountContext => ({ accountKey, chainId, address, owners: [], saltNonce: '0', passkey: { credentialId: accountKey, x: `0x${'01'.repeat(32)}`, y: `0x${'02'.repeat(32)}` }, ...(remote ? { remote } : {}) }) as AccountContext

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
  elsewhereOf(acc: AccountState, peers: PeerRead, local?: { safe: Address; block: bigint }): bigint | null
}

/** A peer behind fetch: signature on the pathname, the path parsed as the server does; `strip` drops wire fields (an older peer). */
function fetchTo(op: () => Operator, clock: { t: number }, paths: string[], strip: () => (keyof ExposureWire)[]) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url)
    const sig = (init.headers as Record<string, string>)['x-mamoru-sig']
    if (!(await verifyMetricsSignature(SECRET, 'GET', u.pathname, sig, clock.t))) return new Response('{}', { status: 401 })
    const asked = parseExposurePath(u.pathname)
    if (!asked) return new Response('{}', { status: 400 })
    paths.push(u.pathname)
    const w = (await op().exposureFor(asked.safe as Address, asked.covered)) as Record<string, unknown>
    for (const k of strip()) delete w[k]
    return Response.json(w)
  }
}

const V4 = getAddress('0x00000000000000000000000000000000000000f4')
const MONAD_USDC = getAddress('0x00000000000000000000000000000000000000c5')
const u = (v: bigint | number, n: number) => pad(toHex(v), { size: n })
/** The CCTP V2 message of a burn Monad → Base: V4 burned Monad USDC to `to`. */
const message = (to: Address, amount: bigint, nonce = 42n): Hex =>
  concat([
    u(1, 4), u(15, 4), u(6, 4), u(nonce, 32), pad(TOKEN_MESSENGER_V2, { size: 32 }), pad(TOKEN_MESSENGER_V2, { size: 32 }), u(0, 32), u(2000, 4), u(2000, 4),
    u(1, 4), pad(MONAD_USDC, { size: 32 }), pad(to, { size: 32 }), u(amount, 32), pad(V4, { size: 32 }), u(0, 32), u(0, 32), u(99, 32),
  ])
const attester = privateKeyToAccount(generatePrivateKey())

/**
 * `journal`: a return journal already on disk (as the deploy finds it); `baseClient`: Base for the journal's backfill;
 * `cctp`: Circle and Base for the journal's on-chain resolution of a reported release (its burn BURN_TX of RET to `to`,
 * its nonce used on Base once `chains.minted` is set and Base's head is at or past it).
 */
function setup(o: { journal?: unknown; baseClient?: PublicClient; cctp?: { to: Address } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-cap-returns-'))
  if (o.journal) writeFileSync(join(dir, 'return-home.json'), JSON.stringify(o.journal))
  const clock = { t: T0 }
  /** The chains: what each Safe holds as a function of the block it is read at. */
  const chains = { baseBlock: 8_000n, monadBlock: 1_990n, landed: null as number | null, minted: null as bigint | null }
  const monadUsdc = (block = chains.monadBlock) => (chains.landed !== null && block >= BigInt(chains.landed) ? MONAD0 - RET : MONAD0)
  const baseUsdc = (block = chains.baseBlock) => (chains.minted !== null && block >= chains.minted ? BASE0 + RET : BASE0)
  const iris = { calls: 0 }
  const cctpBase = {
    getBlockNumber: async () => chains.baseBlock,
    getTransactionReceipt: async () => null,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === 'signatureThreshold') return 1n
      if (functionName === 'isEnabledAttester') return (args![0] as string).toLowerCase() === attester.address.toLowerCase()
      if (functionName === 'usedNonces') return chains.minted !== null && chains.baseBlock >= chains.minted ? 1n : 0n
      throw new Error(functionName)
    },
  } as unknown as PublicClient
  const irisFetch = async (url: string) => {
    iris.calls++
    if (!o.cctp || !url.includes(BURN_TX)) return new Response('{}', { status: 404 })
    const m = message(o.cctp.to, RET)
    return Response.json({ messages: [{ status: 'complete', message: m, attestation: await attester.sign({ hash: keccak256(m) }) }] })
  }
  const rh = new ReturnHome(dir, o.baseClient ?? (o.cctp ? cctpBase : ({} as PublicClient)), null, () => (o.cctp ? { v4: V4, usdc: MONAD_USDC } : null), irisFetch as unknown as typeof fetch, () => clock.t)
  const relayer = { address: `0x${'7'.repeat(40)}` } as unknown as Relayer
  const store = (acc: AccountState) => ({ state: { accounts: { [acc.accountKey]: acc } }, save: () => {} }) as unknown as StateStore
  const accOf = (accountKey: string, ctx: AccountContext): AccountState => ({ accountKey, ctx, trusted: false, active: true, grants: [], revoked: [], managedTokenIds: [], depositsAfter: '0', historyFromBlock: '0', epoch: 0, ops: [], seq: 0 }) as AccountState
  const toMonad: string[] = []
  const toBase: string[] = []
  const strip = { base: [] as (keyof ExposureWire)[], monad: [] as (keyof ExposureWire)[] }
  let base!: Operator
  let monad!: Operator
  const common = { live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1 }
  base = new Operator(
    { ...common, chainId: 8453, registry: baseRegistry, returnHome: rh, peers: new PeerExposure([{ chainId: 143, url: 'http://monad.test' }], SECRET, fetchTo(() => monad, clock, toMonad, () => strip.monad), () => clock.t) } satisfies OperatorConfig,
    {} as PublicClient,
    relayer,
    store(accOf('brais', ctxOf('brais', 8453, HOME))),
  )
  monad = new Operator(
    { ...common, chainId: 143, registry: monadRegistry, peers: new PeerExposure([{ chainId: 8453, url: 'http://base.test' }], SECRET, fetchTo(() => base, clock, toBase, () => strip.base), () => clock.t) } satisfies OperatorConfig,
    {} as PublicClient,
    relayer,
    store(accOf('brais-143', ctxOf('brais-143', 143, REMOTE, { chainId: 143, home: HOME, homeDomain: 6 }))),
  )
  const baseAcc = (base as unknown as { store: StateStore }).store.state.accounts.brais!
  const monadAcc = (monad as unknown as { store: StateStore }).store.state.accounts['brais-143']!
  const b = base as unknown as Priv
  const m = monad as unknown as Priv
  b.readSafeCached = b.readOf = async (_a, safe) => read(chains.baseBlock, safe.toLowerCase() === HOME.toLowerCase() ? baseUsdc() : 0n)
  b.readUnowned = async () => read(chains.baseBlock, 0n)
  m.readSafeCached = m.readOf = async (_a, safe) => read(chains.monadBlock, safe.toLowerCase() === REMOTE.toLowerCase() ? monadUsdc() : 0n)
  m.readUnowned = async () => read(chains.monadBlock, 0n)
  for (const [p, chainId] of [[b, 8453], [m, 143]] as const) p.localExposure = (a, r) => ({ chainId, idleUsdc: (r as unknown as { usdc: bigint }).usdc, placedUsdc: 0n, active: a?.active ?? false })
  b.otherSafes = () => [REMOTE]
  m.otherSafes = () => [HOME]
  const iso = () => new Date(clock.t).toISOString()
  /** Base's RemotePeer to the Monad operator, reduced to the release state functions on the Monad account. */
  const peer: ReturnPeer = {
    release: async (_r, id, amount) => requestRelease(monadAcc, { id, amount: amount.toString() }, iso()),
    releaseStatus: async (_r, id) => releaseView(monadAcc, id),
  }
  const remoteCtx = monadAcc.ctx
  const ret = () => rh.returns()[0]!
  const updateRet = (patch: Partial<ReturnEntry>) => (rh as unknown as { update(e: ReturnEntry, p: Partial<ReturnEntry>): void }).update(ret(), patch)
  const signing = (): BridgeSigning => ({ opId: 'op-r', account: REMOTE, recipient: HOME, depositor: REMOTE, chainId: 8453, pool: 'pool:WMON/USDC/3000', bucket: 'growth', amount: RET, destinationDomain: 6, userOpHash: UOP, nonceKey: 0n, nonce: 3n, prepareBlock: 1_990n })
  /** The Monad release: the engine signs its burn (sending), then the chain settles it (burned at BURN_BLOCK). */
  const sending = () => beforeSign(monadAcc, signing(), iso())
  const burned = () => expect(applySettle(monadAcc, monadAcc.release!.sending!, { kind: 'burned', userOpHash: UOP, amount: RET.toString(), txHash: BURN_TX, block: BURN_BLOCK }, iso())).toBe(true)
  /** Every total of both operators: Start (startTotal), funding (exposure.totalUsdc), and an engine review's cap. */
  const totals = async () => {
    clock.t += 60_000 // every peer cache is older than any check allows
    const startB = (await b.startTotal(baseAcc, await b.localTotal(baseAcc, HOME))).total
    const startM = (await m.startTotal(monadAcc, await m.localTotal(monadAcc, REMOTE))).total
    clock.t += 60_000
    b.enginePeers.set('brais', await b.peerRead(baseAcc, 2_000))
    const engineB = baseUsdc() + (await b.engineCap(baseAcc, chains.baseBlock)).elsewhereUsdc!
    const engineM = monadUsdc() + (await m.engineCap(monadAcc, chains.monadBlock)).elsewhereUsdc!
    return { startB, startM, engineB, engineM }
  }
  return { dir, clock, iris, chains, rh, base, monad, baseAcc, monadAcc, b, m, peer, remoteCtx, ret, updateRet, sending, burned, totals, toMonad, toBase, strip, baseUsdc, monadUsdc, iso }
}

const all = (t: Record<string, bigint>, v: bigint) => Object.values(t).every((x) => x === v)
const atLeast = (t: Record<string, bigint>, v: bigint) => Object.values(t).every((x) => x >= v)

describe('Brais returns 20 USDC home: the account total on both operators (otto/mamoru#355)', () => {
  test('requested, sending, landed unsettled, burned on Monad, Base ticks to burned, minted with Base reading before and at the mint: never below, exact once settled', async () => {
    const s = setup()
    expect(all(await s.totals(), TRUE)).toBe(true)

    // Requested on Base, open on Monad: the value is in the Monad Safe's read.
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    expect(s.monadAcc.release?.state).toBe('open')
    expect(all(await s.totals(), TRUE)).toBe(true)

    // Sending: on disk before the userOp is signed; the USDC is still in the Monad Safe. Counted twice: only less is placed.
    s.sending()
    expect(all(await s.totals(), TRUE + RET)).toBe(true)

    // The userOp landed (the USDC left the Monad Safe) but nothing settled it yet: still sending, still counted. Exact.
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 5n
    expect(all(await s.totals(), TRUE)).toBe(true)

    // Burned on Monad; Base's journal still says requested (no tick yet). Without #355 both sides read 80 here.
    s.burned()
    expect(s.ret().state).toBe('requested')
    expect(all(await s.totals(), TRUE)).toBe(true)

    // Base ticks: its journal learns the burn. Base counts it from its journal and lists it; Monad stops counting it.
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    expect(s.ret().state).toBe('burned')
    expect(all(await s.totals(), TRUE)).toBe(true)
    const w = await s.base.exposureFor(HOME, { chainId: 143, safe: REMOTE.toLowerCase(), block: s.chains.monadBlock })
    expect(w.returns).toEqual([s.ret().id])
    expect(BigInt(w.idleUsdc)).toBe(BASE0 + RET)

    // Minted on Base at 9000, every Base read still at 8999: counted on its way.
    s.chains.minted = MINTED_AT
    s.chains.baseBlock = MINTED_AT - 1n
    s.updateRet({ state: 'minted', mintTx: `0x${'77'.repeat(32)}`, mintedBlock: MINTED_AT.toString(), mintAt: s.iso() })
    expect(all(await s.totals(), TRUE)).toBe(true)

    // Base's reads reach the mint: the USDC is in the home Safe, counted there only.
    s.chains.baseBlock = MINTED_AT
    expect(all(await s.totals(), TRUE)).toBe(true)
    s.chains.baseBlock = MINTED_AT + 40n
    expect(all(await s.totals(), TRUE)).toBe(true)
    const settled = await s.base.exposureFor(HOME)
    expect(BigInt(settled.idleUsdc)).toBe(BASE0 + RET)
    expect(settled.returns).toEqual([s.ret().id])

    // A new return later: the burned release moves to the finished ones on Monad and is still listed, never counted twice.
    expect(requestRelease(s.monadAcc, { id: 'ret-next', amount: '1' }, s.iso()).state).toBe('open')
    expect(all(await s.totals(), TRUE)).toBe(true)
  })

  test('the Monad answer reports the release with id, amount and burn block; nothing of it is in its idle', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    let w = await s.monad.exposureFor(REMOTE)
    expect(w.releases).toEqual([{ id: s.ret().id, amount: RET.toString() }])
    expect(BigInt(w.idleUsdc)).toBe(MONAD0)
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 1n
    s.burned()
    w = await s.monad.exposureFor(REMOTE)
    expect(w.releases).toEqual([{ id: s.ret().id, amount: RET.toString(), block: String(BURN_BLOCK), tx: BURN_TX }])
    expect(BigInt(w.idleUsdc)).toBe(MONAD0 - RET)
    // Asked about the home's address, Monad has no release from it.
    expect((await s.monad.exposureFor(HOME)).releases).toEqual([])
    expect(releasesToCount(s.monadAcc)).toMatchObject([{ id: s.ret().id, amount: RET, chainId: 8453, home: HOME, block: BURN_BLOCK, tx: BURN_TX }])
  })

  test('cancelled while open: nothing counted anywhere, the money never left the Monad Safe', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    expect(all(await s.totals(), TRUE)).toBe(true)
    expect(cancelRelease(s.monadAcc, { id: s.ret().id }, s.iso()).state).toBe('cancelled')
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    expect(s.ret().state).toBe('cancelled')
    expect(all(await s.totals(), TRUE)).toBe(true)
    expect(releasesToCount(s.monadAcc)).toEqual([])
    expect((await s.base.exposureFor(HOME)).returns).toBeUndefined()
  })

  test('a sending burn that reverts (open again) stops counting; the USDC never left', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    expect(atLeast(await s.totals(), TRUE)).toBe(true)
    expect(applySettle(s.monadAcc, s.monadAcc.release!.sending!, { kind: 'reopen', why: 'reverted' }, s.iso())).toBe(true)
    expect(all(await s.totals(), TRUE)).toBe(true)
  })
})

describe('older peers during a deploy (otto/mamoru#355)', () => {
  test('Base on older code (no `returns` in its answers): Monad counts its burned release all along, an over-count, never under', async () => {
    const s = setup()
    s.strip.base = ['returns']
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 1n
    s.burned()
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    const t = await s.totals()
    expect(atLeast(t, TRUE)).toBe(true)
    expect(t.startM).toBe(TRUE + RET)
    s.chains.minted = MINTED_AT
    s.chains.baseBlock = MINTED_AT + 1n
    s.updateRet({ state: 'minted', mintedBlock: MINTED_AT.toString() })
    const after = await s.totals()
    expect(atLeast(after, TRUE)).toBe(true)
    expect(after.startB).toBe(TRUE)
    expect(after.startM).toBe(TRUE + RET)
  })

  test('Monad on older code (no `releases`): Base counts what its journal holds; the window before its tick is the one this ticket closes once Monad runs it', async () => {
    const s = setup()
    s.strip.monad = ['releases']
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 1n
    s.burned()
    // Base's journal does not know the burn: the release is reported by nobody (the older Monad sends no list).
    expect((await s.totals()).startB).toBe(TRUE - RET)
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    expect((await s.totals()).startB).toBe(TRUE)
  })

  test('a malformed list fails the read closed', async () => {
    const bad: Partial<ExposureWire>[] = [
      { releases: [{ id: 'bad id', amount: '1' }] },
      { releases: [{ id: 'x', amount: '-1' }] },
      { releases: [{ id: 'x', amount: '1', block: 'z' }] },
      { releases: 'x' as unknown as [] },
      { returns: ['ok', 7 as unknown as string] },
      { returns: Array.from({ length: 65 }, (_, i) => `r${i}`) },
    ]
    for (const extra of bad) {
      const r = new PeerExposure([{ chainId: 8453, url: 'http://base.test' }], SECRET, async () => Response.json({ chainId: 8453, address: HOME.toLowerCase(), block: '1', idleUsdc: '0', placedUsdc: '0', active: true, ...extra }))
      expect((await r.read(HOME, 0)).ok).toBe(false)
    }
    const ok = new PeerExposure([{ chainId: 8453, url: 'http://base.test' }], SECRET, async () => Response.json({ chainId: 8453, address: HOME.toLowerCase(), block: '1', idleUsdc: '0', placedUsdc: '0', active: true, releases: [{ id: 'ret-1', amount: '5', block: '9' }, { id: 'ret-2', amount: '6' }], returns: ['ret-0'] }))
    const got = await ok.read(HOME, 0)
    expect(got.ok && got.chains[0]!.releases).toEqual([{ id: 'ret-1', amount: '5', block: '9' }, { id: 'ret-2', amount: '6' }])
    expect(got.ok && got.chains[0]!.returns).toEqual(['ret-0'])
  })
})

describe('peer answers reused from the cache (otto/mamoru#355)', () => {
  test('a Base answer from before its journal learned the burn, reused after: Monad keeps counting the release, exact', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 1n
    s.burned()
    // Monad's engine reads Base (cover: its observation), then Base ticks and mints, then the engine reviews again within 2 s.
    const first = s.monadUsdc() + (await s.m.engineCap(s.monadAcc, s.chains.monadBlock)).elsewhereUsdc!
    expect(first).toBe(TRUE)
    const asked = s.toBase.length
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    s.chains.minted = MINTED_AT
    s.chains.baseBlock = MINTED_AT + 1n
    s.updateRet({ state: 'minted', mintedBlock: MINTED_AT.toString() })
    const again = s.monadUsdc() + (await s.m.engineCap(s.monadAcc, s.chains.monadBlock)).elsewhereUsdc!
    expect(s.toBase.length).toBe(asked) // the cached answer stood
    expect(again).toBe(TRUE) // its old Base read (60, no id listed) plus the release Monad still counts
  })

  test('a Monad answer from while sending (the USDC still in its read), reused after the burn: Base counts more, never less', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    const peers = await s.b.peerRead(s.baseAcc, 30_000)
    expect(s.b.elsewhereOf(s.baseAcc, peers, { safe: HOME, block: s.chains.baseBlock })).toBe(MONAD0 + RET)
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 1n
    s.burned()
    const cached = await s.b.peerRead(s.baseAcc, 30_000)
    expect(cached).toEqual(peers)
    expect(s.baseUsdc() + s.b.elsewhereOf(s.baseAcc, cached, { safe: HOME, block: s.chains.baseBlock })!).toBe(TRUE + RET)
    // A failed read: Monad's releases are not known to Base; Base's own journal still counts; the cap is closed anyway.
    expect(s.b.elsewhereOf(s.baseAcc, { ok: false, chainId: 143 })).toBeNull()
  })

  test('Base counts a minted return until a read of its home in the same total is at or after the mint; without one, always', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    s.burned()
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    s.updateRet({ state: 'minted', mintedBlock: MINTED_AT.toString() })
    const none: PeerRead = { ok: true, chains: [] }
    expect(s.b.elsewhereOf(s.baseAcc, none, { safe: HOME, block: MINTED_AT - 1n })).toBe(RET)
    expect(s.b.elsewhereOf(s.baseAcc, none, { safe: HOME, block: MINTED_AT })).toBe(0n)
    expect(s.b.elsewhereOf(s.baseAcc, none, { safe: REMOTE, block: MINTED_AT + 5n })).toBe(RET)
    expect(s.b.elsewhereOf(s.baseAcc, none)).toBe(RET)
    // A sibling read of the home in the peers (another account's total that reads it) covers it the same way.
    const sib: PeerRead = { ok: true, chains: [{ chainId: 8453, idleUsdc: 0n, placedUsdc: 0n, active: false, at: { safe: HOME.toLowerCase(), block: MINTED_AT } }] }
    expect(s.b.elsewhereOf(s.baseAcc, sib)).toBe(0n)
    // A Monad report of the same id adds nothing: the journal holds it.
    const rep: PeerRead = { ok: true, chains: [{ chainId: 143, idleUsdc: 0n, placedUsdc: 0n, active: true, at: { safe: REMOTE.toLowerCase(), block: 1n }, releases: [{ id: s.ret().id, amount: RET.toString(), block: '1' }] }] }
    expect(s.b.elsewhereOf(s.baseAcc, rep, { safe: HOME, block: MINTED_AT })).toBe(0n)
  })
})

describe('gate r1/r2 (otto/mamoru#355)', () => {
  /** A release burned on Monad (BURN_TX, RET to `home`) that Base's journal does not hold: Base resolves it on chain. */
  const burnedOnMonad = (s: ReturnType<typeof setup>, id: string, at: string) => {
    s.monadAcc.release = { id, amount: RET.toString(), chainId: 8453, state: 'burned', burn: { userOpHash: UOP, amount: RET.toString(), txHash: BURN_TX, block: BURN_BLOCK }, at, updatedAt: at }
  }

  test('journal recreated empty while a release is burned: both sides keep counting it, until Base finds its mint on chain and adopts it', async () => {
    const s = setup({ cctp: { to: HOME } })
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 1n
    burnedOnMonad(s, 'ret-lost-1', new Date(T0).toISOString())
    // Not minted: the money is in neither Safe; each side counts it once (Monad its release, Base the report).
    expect(all(await s.totals(), TRUE)).toBe(true)
    await s.rh.tick(() => null)
    expect(s.rh.returns()).toEqual([]) // the nonce is not used on Base: nothing adopted
    // Minted on Base (by anyone): before Base resolves it, both count it on top of the home read (more, never less).
    s.chains.minted = s.chains.baseBlock
    expect(all(await s.totals(), TRUE + RET)).toBe(true)
    s.clock.t += 60_000
    await s.rh.tick(() => null)
    expect(s.rh.returns()).toMatchObject([{ id: 'ret-lost-1', state: 'minted', home: HOME, mintedBlock: s.chains.baseBlock.toString(), burn: { txHash: BURN_TX } }])
    expect(all(await s.totals(), TRUE)).toBe(true)
    expect((await s.base.exposureFor(HOME)).returns).toEqual(['ret-lost-1'])
  })

  test('a return minted 35 days before the deploy and pruned: counted twice until adopted from the chain, then exact', async () => {
    const t = T0 - 35 * 24 * 3600_000
    const s = setup({ cctp: { to: HOME }, journal: { returns: {}, mintDays: {} } })
    s.chains.landed = 0
    s.chains.minted = 0n
    burnedOnMonad(s, `ret-${t.toString(36)}-0a1b2c3d`, new Date(t).toISOString())
    expect(all(await s.totals(), TRUE + RET)).toBe(true)
    await s.rh.tick(() => null)
    expect(s.rh.returns()[0]?.state).toBe('minted')
    expect(all(await s.totals(), TRUE)).toBe(true)
  })

  test('adoption checks the attestation: another recipient, or an attestation Base does not accept, adopts nothing', async () => {
    const s = setup({ cctp: { to: getAddress('0x5151515151515151515151515151515151515151') } })
    s.chains.landed = 0
    s.chains.minted = 0n
    burnedOnMonad(s, 'ret-other', new Date(T0).toISOString())
    expect(atLeast(await s.totals(), TRUE)).toBe(true)
    await s.rh.tick(() => null)
    expect(s.rh.returns()).toEqual([])
    expect(all(await s.totals(), TRUE + RET)).toBe(true)
  })

  test('the prune waits for a report, and keeps every return the last report still has', async () => {
    const s = setup()
    const j = s.rh as unknown as { journal: { returns: Record<string, ReturnEntry> }; prune(): void }
    const old = new Date(T0).toISOString()
    for (const id of ['ret-a', 'ret-b']) j.journal.returns[id] = { id, accountKey: 'brais', home: HOME, amount: '1', state: 'minted', burn: { amount: '1', txHash: BURN_TX, block: 1 }, mintedBlock: '1', at: old, updatedAt: old }
    s.clock.t = T0 + RETURN_KEEP_MS + 60_000
    j.prune()
    expect(s.rh.returns()).toHaveLength(2) // no report since boot: nothing pruned
    s.rh.noteReported(REMOTE, [{ id: 'ret-a', amount: '1', block: '1', tx: BURN_TX }], 'brais', [HOME])
    j.prune()
    expect(s.rh.returns().map((e) => e.id)).toEqual(['ret-a'])
    s.rh.noteReported(REMOTE, [], 'brais', [HOME])
    j.prune()
    expect(s.rh.returns()).toEqual([])
  })

  test('the prune follows the live answers: a Monad that still reports a release keeps its entry', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 1n
    s.burned()
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    s.chains.minted = s.chains.baseBlock
    s.updateRet({ state: 'minted', mintedBlock: s.chains.baseBlock.toString() })
    await s.totals() // Base reads Monad: its report names the release
    s.clock.t += RETURN_KEEP_MS + 60_000
    await s.rh.tick(() => null)
    expect(s.rh.returns()).toHaveLength(1)
    expect(all(await s.totals(), TRUE)).toBe(true)
  })

  test('more than RETURN_LISTED returns minted before the home read advances: Base counts them all, lists the newest, and Monad keeps counting the rest', async () => {
    const s = setup()
    const j = s.rh as unknown as { journal: { returns: Record<string, ReturnEntry> } }
    const n = RETURN_LISTED + 6
    for (let i = 0; i < n; i++) {
      const id = `ret-m${String(i).padStart(3, '0')}`
      const at = new Date(T0 + i).toISOString()
      j.journal.returns[id] = { id, accountKey: 'brais', home: HOME, amount: '1', state: 'minted', burn: { amount: '1', txHash: BURN_TX, block: 1 }, mintedBlock: '9000', at, updatedAt: at }
    }
    const c = s.rh.capUsdc([HOME], () => 8_999n)
    expect(c.usdc).toBe(BigInt(n))
    expect(c.ids).toHaveLength(RETURN_LISTED)
    expect(c.ids[0]).toBe(`ret-m${String(n - 1).padStart(3, '0')}`)
    // Monad: a release listed stops counting; one left out keeps counting (more, never less).
    const at = new Date(T0).toISOString()
    s.monadAcc.release = { id: 'ret-m000', amount: '1', chainId: 8453, state: 'burned', burn: { userOpHash: UOP, amount: '1', txHash: BURN_TX, block: 1 }, at, updatedAt: at }
    s.monadAcc.releasesDone = [{ ...s.monadAcc.release, id: `ret-m${String(n - 1).padStart(3, '0')}` }]
    const answer: PeerRead = { ok: true, chains: [{ chainId: 8453, idleUsdc: 0n, placedUsdc: 0n, active: true, at: { safe: HOME.toLowerCase(), block: 8_999n }, returns: c.ids }] }
    expect(s.m.elsewhereOf(s.monadAcc, answer)).toBe(1n)
  })

  test('a release to a non-default home: matched by its own mint recipient, never by another Safe\'s answer', async () => {
    const s = setup()
    const HOME2 = getAddress('0x2222222222222222222222222222222222222222')
    s.monadAcc.ctx = { ...s.monadAcc.ctx, remote: { chainId: 143, home: HOME2, homeDomain: 6 } } as AccountContext
    const at = new Date(T0).toISOString()
    s.monadAcc.release = { id: 'ret-h2', amount: RET.toString(), chainId: 8453, state: 'burned', burn: { userOpHash: UOP, amount: RET.toString(), txHash: BURN_TX, block: 1 }, at, updatedAt: at }
    expect(releasesToCount(s.monadAcc)[0]!.home).toBe(HOME2)
    const answer = (safe: Address): PeerRead => ({ ok: true, chains: [{ chainId: 8453, idleUsdc: 0n, placedUsdc: 0n, active: true, at: { safe: safe.toLowerCase(), block: 1n }, returns: ['ret-h2'] }] })
    expect(s.m.elsewhereOf(s.monadAcc, answer(HOME))).toBe(RET)
    expect(s.m.elsewhereOf(s.monadAcc, answer(HOME2))).toBe(0n)
    // Base: an entry to HOME2 counts in a total that reads HOME2, and is held (listed) only there.
    const j = s.rh as unknown as { journal: { returns: Record<string, ReturnEntry> } }
    j.journal.returns['ret-h2'] = { id: 'ret-h2', accountKey: 'brais', home: HOME2, amount: RET.toString(), state: 'burned', burn: { amount: RET.toString(), txHash: BURN_TX, block: 1 }, at, updatedAt: at }
    expect(s.rh.capUsdc([HOME], () => undefined)).toEqual({ usdc: 0n, ids: [] })
    expect(s.rh.capUsdc([HOME, HOME2], () => undefined)).toEqual({ usdc: RET, ids: ['ret-h2'] })
    expect(s.rh.holds('ret-h2', [HOME])).toBe(false)
    expect(s.rh.holds('ret-h2', [HOME2])).toBe(true)
  })

  test('a cancelled entry is never held: a release Monad reports under that id is counted by Base too', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.updateRet({ state: 'cancelled' })
    expect(s.rh.holds(s.ret().id, [HOME])).toBe(false)
    expect((await s.base.exposureFor(HOME)).returns).toBeUndefined()
  })

  test('1: a minted return without mintedBlock gets its receipt block, or the head block when there is none; updatedAt kept', async () => {
    const MINT = `0x${'77'.repeat(32)}` as Hex
    const receipts = new Map<string, bigint>()
    const baseClient = { getTransactionReceipt: async ({ hash }: { hash: Hex }) => (receipts.has(hash) ? { status: 'success', blockNumber: receipts.get(hash)! } : null), getBlockNumber: async () => MINTED_AT + 7n } as unknown as PublicClient
    const entry = (id: string, mintTx?: Hex): ReturnEntry => ({ id, accountKey: 'brais', home: HOME, amount: RET.toString(), state: 'minted', burn: { amount: RET.toString(), txHash: BURN_TX, block: BURN_BLOCK }, ...(mintTx ? { mintTx } : {}), at: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString() })
    const a = `ret-${T0.toString(36)}-0000000a`
    const b = `ret-${(T0 + 1).toString(36)}-0000000b`
    receipts.set(MINT, MINTED_AT)
    const s = setup({ baseClient, journal: { returns: { [a]: entry(a, MINT), [b]: entry(b) }, mintDays: {} } })
    s.chains.landed = 0
    s.chains.minted = MINTED_AT
    s.chains.baseBlock = MINTED_AT + 10n
    // Before the backfill: counted on top of the read that holds them (over).
    expect(s.rh.capUsdc([HOME], () => s.chains.baseBlock).usdc).toBe(2n * RET)
    await s.rh.tick(() => null)
    const got = Object.fromEntries(s.rh.returns().map((e) => [e.id, e]))
    expect(got[a]!.mintedBlock).toBe(MINTED_AT.toString())
    expect(got[b]!.mintedBlock).toBe((MINTED_AT + 7n).toString())
    expect(got[a]!.updatedAt).toBe(new Date(T0).toISOString())
    expect(s.rh.capUsdc([HOME], () => s.chains.baseBlock).usdc).toBe(0n)
    expect(s.rh.capUsdc([HOME], () => MINTED_AT + 6n).usdc).toBe(RET)
  })

  test('3: a sibling read on Base of a Safe with the Monad recipient\'s address never covers a Base→Monad burn (only chain 143 reads do)', async () => {
    const s = setup()
    s.chains.baseBlock = 10n ** 9n // a Base block far above any Monad mintedBlock
    const seen: (bigint | undefined)[] = []
    ;(s.base as unknown as { cfg: OperatorConfig }).cfg.bridgeMonad = { capUsdc: (_src: readonly string[], readAt: (r: Address) => bigint | undefined) => (seen.push(readAt(REMOTE)), 0n) } as unknown as OperatorConfig['bridgeMonad']
    const peers = await s.b.peerRead(s.baseAcc, 0)
    // Both reads of REMOTE are there: Base's own sibling read (8453) and Monad's answer (143).
    expect(peers.ok && peers.chains.filter((e) => e.at?.safe === REMOTE.toLowerCase()).map((e) => [e.chainId, e.at!.block])).toEqual([[143, s.chains.monadBlock], [8453, 10n ** 9n]])
    s.b.elsewhereOf(s.baseAcc, peers, { safe: HOME, block: s.chains.baseBlock })
    expect(seen).toEqual([s.chains.monadBlock])
    // returnsOf reads only this chain's reads: the Monad block never covers a Base mint.
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    s.burned()
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    s.updateRet({ state: 'minted', mintedBlock: '1995' })
    const monadOnly: PeerRead = { ok: true, chains: [{ chainId: 143, idleUsdc: 0n, placedUsdc: 0n, active: true, at: { safe: HOME.toLowerCase(), block: 5_000n } }] }
    ;(s.base as unknown as { cfg: OperatorConfig }).cfg.bridgeMonad = undefined
    expect(s.b.elsewhereOf(s.baseAcc, monadOnly)).toBe(RET)
  })

  test('4: a burned entry without its burn still counts (largest try, or the request) on Monad, and its amount on Base', () => {
    const s = setup()
    const at = new Date(T0).toISOString()
    s.monadAcc.release = { id: 'ret-x', amount: (RET + 5n).toString(), chainId: 8453, state: 'burned', at, updatedAt: at }
    expect(releasesToCount(s.monadAcc).map((x) => x.amount)).toEqual([RET + 5n])
    s.monadAcc.release = { ...s.monadAcc.release, sending: { nonceKey: '0', nonce: '1', fromBlock: '1', tries: [{ userOpHash: UOP, amount: RET.toString(), depositor: REMOTE }] } }
    expect(releasesToCount(s.monadAcc).map((x) => x.amount)).toEqual([RET])
    const j = s.rh as unknown as { journal: { returns: Record<string, ReturnEntry> } }
    j.journal.returns['ret-y'] = { id: 'ret-y', accountKey: 'brais', home: HOME, amount: RET.toString(), state: 'burned', at, updatedAt: at }
    expect(s.rh.capUsdc([HOME], () => undefined)).toEqual({ usdc: RET, ids: ['ret-y'] })
  })

  test('6: the ids ReturnHome generates pass the wire check', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    const id = s.ret().id
    expect(id).toMatch(/^ret-[0-9a-z]+-[0-9a-f]{8}$/)
    s.sending()
    const reader = new PeerExposure([{ chainId: 143, url: 'http://monad.test' }], SECRET, async () => Response.json(await s.monad.exposureFor(REMOTE)))
    const r = await reader.read(REMOTE, 0)
    expect(r.ok && r.chains[0]!.releases?.[0]?.id).toBe(id)
    s.burned()
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    const back = new PeerExposure([{ chainId: 8453, url: 'http://base.test' }], SECRET, async () => Response.json(await s.base.exposureFor(HOME)))
    const b = await back.read(HOME, 0)
    expect(b.ok && b.chains[0]!.returns).toEqual([id])
  })
})

describe('the money map shows the return in flight, 143 → 8453 (otto/mamoru#355)', () => {
  test('the map total holds through every phase', () => {
    const leg = (block: bigint) => ({ block, stale: false })
    const x = (o: Partial<ReturnLeg>): ReturnLeg => ({ id: 'ret-1', home: HOME, amount: RET, state: 'burned', ...o })
    // The Monad leg read at `mb`, the Base leg at `bb`; what each holds there, plus the rows.
    const total = (r: ReturnLeg[], mb: bigint, bb: bigint, minted: bigint | null) => {
      const rows = returnRows(r, { from: 143, to: 8453, homeBlock: bb, legOf: () => leg(mb) })
      const monadLeg = mb >= BigInt(BURN_BLOCK) ? MONAD0 - RET : MONAD0
      const baseLeg = minted !== null && bb >= minted ? BASE0 + RET : BASE0
      return { rows, total: BigInt(buildMoneyMap([{ totalUsdc: monadLeg.toString(), read: { at: 'x' } } as never, { totalUsdc: baseLeg.toString(), read: { at: 'x' } } as never], rows).totalUsdc) }
    }
    // Burned, the Monad leg read before the burn: still in it, no row.
    expect(total([x({ burnBlock: BigInt(BURN_BLOCK) })], BigInt(BURN_BLOCK) - 1n, 8_000n, null)).toMatchObject({ rows: [], total: TRUE })
    // Burned, read after: a row 143 → 8453.
    const burnedRow = total([x({ burnBlock: BigInt(BURN_BLOCK) })], BigInt(BURN_BLOCK), 8_000n, null)
    expect(burnedRow.total).toBe(TRUE)
    expect(burnedRow.rows[0]).toMatchObject({ id: 'ret-1', kind: 'cctp', from: 143, to: 8453, recipient: HOME, amountUsdc: RET.toString(), stage: 'burned' })
    expect(burnedRow.rows[0]!.unsure).toBeUndefined()
    // Minting, then minted with the home read before the mint: still a row; at the mint: none, the home leg holds it.
    expect(total([x({ burnBlock: BigInt(BURN_BLOCK), mintTx: BURN_TX })], BigInt(BURN_BLOCK) + 9n, 8_000n, null).rows[0]!.stage).toBe('minting')
    expect(total([x({ state: 'minted', burnBlock: BigInt(BURN_BLOCK), mintedBlock: MINTED_AT })], BigInt(BURN_BLOCK) + 9n, MINTED_AT - 1n, MINTED_AT)).toMatchObject({ total: TRUE })
    expect(total([x({ state: 'minted', burnBlock: BigInt(BURN_BLOCK), mintedBlock: MINTED_AT })], BigInt(BURN_BLOCK) + 9n, MINTED_AT, MINTED_AT)).toMatchObject({ rows: [], total: TRUE })
    // Sending, seen not landed at a block the leg's read is not past: the Monad leg holds it, no row; the total stays.
    expect(total([x({ state: 'sending', notLandedAt: BigInt(BURN_BLOCK) - 1n })], BigInt(BURN_BLOCK) - 1n, 8_000n, null)).toMatchObject({ rows: [], total: TRUE })
    // Sending with its nonce read unknown (failed, or an older Monad), or a leg read after it was seen not landed: an unsure row.
    for (const r of [x({ state: 'sending' }), x({ state: 'sending', notLandedAt: BigInt(BURN_BLOCK) - 2n })]) expect(returnRows([r], { from: 143, to: 8453, homeBlock: 8_000n, legOf: () => leg(BigInt(BURN_BLOCK) - 1n) })).toMatchObject([{ stage: 'sending', unsure: true }])
    // No fresh Monad leg: counted, unsure.
    expect(returnRows([x({ burnBlock: 5n })], { from: 143, to: 8453, homeBlock: 1n, legOf: () => undefined })[0]!.unsure).toBe(true)
  })

  test('funding on Base: a release Monad reports burned while Base still says requested is a row, then the journal\'s', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 3n
    s.burned()
    type Rows = { returnRowsOf(acc: AccountState, home: Address, homeBlock: bigint, legs: { safe: Address; leg: unknown }[], peers: PeerRead | undefined): { id: string; stage: string; unsure?: boolean }[]; remoteSafes(acc: AccountState): { key: string; safe: Address }[] }
    const rb = s.base as unknown as Rows
    rb.remoteSafes = () => [{ key: 'brais', safe: REMOTE }]
    s.baseAcc.oneAuth = { remote: { address: REMOTE } } as AccountState['oneAuth']
    const legs = [{ safe: REMOTE, leg: { read: { block: Number(s.chains.monadBlock), at: 'x', stale: false } } }]
    const peers = await s.b.peerRead(s.baseAcc, 0)
    expect(rb.returnRowsOf(s.baseAcc, HOME, s.chains.baseBlock, legs, peers)).toMatchObject([{ id: s.ret().id, stage: 'burned' }])
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    // The journal's entry (with the burn tx), once; no report needed.
    expect(rb.returnRowsOf(s.baseAcc, HOME, s.chains.baseBlock, legs, undefined)).toMatchObject([{ id: s.ret().id, stage: 'burned' }])
    expect(rb.returnRowsOf(s.baseAcc, HOME, s.chains.baseBlock, legs, peers)).toHaveLength(1)
  })

  test('5: a sending release Monad sees landed (its nonce used at the read\'s block) is reported with that block, and is a row once the leg is past it', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    const nonce = { used: 3n }
    ;(s.monad as unknown as { client: unknown }).client = { readContract: async () => nonce.used }
    expect((await s.monad.exposureFor(REMOTE)).releases).toEqual([{ id: s.ret().id, amount: RET.toString(), notLandedAt: String(s.chains.monadBlock) }])
    ;(s.monad as unknown as { client: unknown }).client = { readContract: async () => Promise.reject(new Error('down')) }
    expect((await s.monad.exposureFor(REMOTE)).releases).toEqual([{ id: s.ret().id, amount: RET.toString() }])
    ;(s.monad as unknown as { client: unknown }).client = { readContract: async () => nonce.used }
    nonce.used = 4n
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 2n
    expect((await s.monad.exposureFor(REMOTE)).releases).toEqual([{ id: s.ret().id, amount: RET.toString(), block: String(s.chains.monadBlock) }])
    // Display: before that block the leg may hold it (no row); at or after it, a row. The cap counts it either way.
    const x: ReturnLeg = { id: s.ret().id, home: HOME, amount: RET, state: 'burned', burnBlock: s.chains.monadBlock }
    expect(returnRows([x], { from: 143, to: 8453, homeBlock: 1n, legOf: () => ({ block: s.chains.monadBlock - 1n, stale: false }) })).toEqual([])
    expect(returnRows([x], { from: 143, to: 8453, homeBlock: 1n, legOf: () => ({ block: s.chains.monadBlock, stale: false }) })).toHaveLength(1)
    expect(all(await s.totals(), TRUE)).toBe(true)
  })

  test('5: without acc.oneAuth.remote the journal\'s rows use the remote legs: a leg read before the burn holds it (no row, no double count)', async () => {
    const s = setup()
    await s.rh.request('brais', HOME, s.remoteCtx, s.peer, RET, MONAD0)
    s.sending()
    // Sending, Monad's nonce read unavailable here: an unsure row (never dropped on a guess).
    type Rows = { returnRowsOf(acc: AccountState, home: Address, homeBlock: bigint, legs: { safe: Address; leg: unknown }[], peers: PeerRead | undefined): { id: string; stage: string; unsure?: boolean }[]; remoteSafes(acc: AccountState): { key: string; safe: Address }[] }
    const rb = s.base as unknown as Rows
    rb.remoteSafes = () => [{ key: 'brais', safe: REMOTE }]
    const legAt = (block: bigint) => [{ safe: REMOTE, leg: { read: { block: Number(block), at: 'x', stale: false } } }]
    expect(rb.returnRowsOf(s.baseAcc, HOME, s.chains.baseBlock, legAt(s.chains.monadBlock), await s.b.peerRead(s.baseAcc, 0))).toMatchObject([{ stage: 'sending', unsure: true }])
    s.chains.landed = BURN_BLOCK
    s.chains.monadBlock = BigInt(BURN_BLOCK) + 1n
    s.burned()
    await s.rh.tick(() => ({ remote: s.remoteCtx, peer: s.peer }))
    expect(s.baseAcc.oneAuth).toBeUndefined()
    // The leg read before the burn: no row. After: one row, not unsure.
    expect(rb.returnRowsOf(s.baseAcc, HOME, s.chains.baseBlock, legAt(BigInt(BURN_BLOCK) - 1n), undefined)).toEqual([])
    expect(rb.returnRowsOf(s.baseAcc, HOME, s.chains.baseBlock, legAt(BigInt(BURN_BLOCK) + 1n), undefined)).toMatchObject([{ stage: 'burned' }])
    expect(rb.returnRowsOf(s.baseAcc, HOME, s.chains.baseBlock, legAt(BigInt(BURN_BLOCK) + 1n), undefined)[0]!.unsure).toBeUndefined()
  })
})
