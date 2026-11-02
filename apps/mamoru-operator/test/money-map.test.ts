// otto/mamoru#269: the money map. Brais's beta (1 Nov): Home showed 11.70 instead of ~13.7 for 15m41s, because the
// CCTP burn of 2.075638 USDC (Base to Monad) was counted nowhere, and then neither was the mint on his Monad Safe.
// Operator.funding() is run for real; the chains are mocks (Base read patched in, Monad behind a Multicall3 mock),
// the bridge journal is the real MonadBridge on disk.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionResult, getAddress, toFunctionSelector, toHex, type Hex, type PublicClient } from 'viem'
import type { AccountContext, MoneyMap } from '@mamoru/domain'
import { address, baseRegistry, monadRegistry, nonfungiblePositionManagerAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { BridgeSigning } from '@mamoru/scenarios/driver/engine.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { buildMoneyMap, chainLegOf } from '../src/money-map.ts'
import { MINTED_KEEP_MS, MonadBridge, type BridgeBurn } from '../src/bridge-monad.ts'
import { inUsdc, usdcPools, type SafeRead } from '../src/chain.ts'
import { Operator, type OperatorConfig } from '../src/operator.ts'
import type { Relayer } from '../src/relayer.ts'
import type { AccountState, StateStore } from '../src/state.ts'
import { answerAggregate3 } from './fake-multicall.ts'

const T0 = Date.parse('2026-11-01T10:22:53Z') // the burn of Brais's beta
const MIN = 60_000
const UOP = `0x${'11'.repeat(32)}` as Hex
const BURN_TX = `0x${'22'.repeat(32)}` as Hex
const MINT_TX = `0x${'33'.repeat(32)}` as Hex
/** Brais's burn, raw USDC, and what his Base Safe held before it and after it. */
const BURN = 2_075_638n
const BASE_AFTER = { USDC: 7_640_000n, USDT: 4_060_000n } // 11.70
const TOTAL = 11_700_000n + BURN // 13.775638
const MONAD_SAFE = getAddress('0x000000000000000000000000000000000000d72a')
const OLD_C_SAFE = getAddress('0x000000000000000000000000000000000000c0de')

const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
const owners = [address('SafeWebAuthnSharedSigner', baseRegistry)]
const ctx: AccountContext = {
  accountKey: 'brais',
  chainId: 8453,
  address: counterfactualAddress(accountSetup(owners, 42n, webAuthnSigner(passkey.x, passkey.y))),
  owners,
  saltNonce: '42',
  passkey: { credentialId: 'unit', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
}

const WMON_TICK = -300_000
const word = (v: bigint) => toHex(v, { size: 32 })

/** A SafeRead of any chain from token balances: every USDC pool of the registry priced (USDC-quoted tokens at 1:1, WMON at its tick). */
function readOf(registry: typeof baseRegistry, block: bigint, tokens: Record<string, bigint>, eth = 10n ** 17n): SafeRead {
  const pools = usdcPools(registry)
  const prices = Object.fromEntries(pools.map((p) => [p, p.includes('WMON') ? { sqrtPriceX96: sqrtRatioAtTick(WMON_TICK), tick: WMON_TICK } : { sqrtPriceX96: 1n << 96n, tick: 0 }]))
  const all = Object.fromEntries([...new Set(pools.flatMap((p) => registry.entries.filter((e) => e.name === p).flatMap((e) => [e.token0!, e.token1!])))].map((t) => [t, tokens[t] ?? 0n]))
  const live = prices[pools[0]!]!
  return { block, deployed: true, eth, usdc: all.USDC ?? 0n, sqrtPriceX96: live.sqrtPriceX96, tick: live.tick, tokens: all, prices, positions: [] }
}

/** The Monad chain behind readSafe: a Multicall3 mock answering block, MON, token balances, slot0 and no NFTs; `down` fails every call. */
function monadWorld() {
  const st = { block: 5_000n, down: false, tokens: {} as Record<string, bigint>, mon: 3n * 10n ** 18n, calls: 0, nfts: 0, used: new Set<string>(), pos: {} as Record<string, { liquidity: bigint; tickLower: number; tickUpper: number }>, ids: ((i: number) => BigInt(i + 1)) as (i: number) => bigint }
  const tokenByAddress = new Map<string, string>()
  for (const e of monadRegistry.entries) if (e.kind === 'token') tokenByAddress.set(address(e.name, monadRegistry).toLowerCase(), e.name)
  const client = {
    call: async ({ to, data }: { to: string; data: Hex }) => {
      st.calls++
      if (st.down) throw new Error('HTTP request failed. Status: 503 (keyed https://monad.example/v2/SECRET)')
      if (to.toLowerCase() !== address('Multicall3', monadRegistry).toLowerCase()) throw new Error(`unexpected call to ${to}`)
      return {
        data: answerAggregate3(data, (target, callData) => {
          if (callData.startsWith(toFunctionSelector('getBlockNumber()'))) return word(st.block)
          if (callData.startsWith('0x4d2301cc')) return word(st.mon)
          if (callData.startsWith('0x3850c7bd')) return encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'slot0', result: [sqrtRatioAtTick(WMON_TICK), WMON_TICK, 0, 0, 0, 0, true] })
          if (callData.startsWith(toFunctionSelector('tokenOfOwnerByIndex(address,uint256)'))) return word(st.ids(Number(BigInt(`0x${callData.slice(74, 138)}`))))
          if (callData.startsWith(toFunctionSelector('positions(uint256)'))) {
            const id = BigInt(`0x${callData.slice(10, 74)}`)
            const p = st.pos[id.toString()] ?? { liquidity: 1n, tickLower: -300_600, tickUpper: -299_400 } // junk: dust
            return encodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'positions', result: [0n, '0x0000000000000000000000000000000000000000', address('WMON', monadRegistry), address('USDC', monadRegistry), 3000, p.tickLower, p.tickUpper, p.liquidity, 0n, 0n, 0n, 0n] })
          }
          if (callData.startsWith(toFunctionSelector('ownerOf(uint256)'))) return word(BigInt(MONAD_SAFE))
          if (callData.startsWith('0x70a08231')) {
            const t = tokenByAddress.get(target.toLowerCase())
            const holder = `0x${callData.slice(34, 74)}`.toLowerCase()
            // Only the Safe the tests fund holds anything; the position manager's balanceOf (no token) answers no NFTs.
            return word(!t ? BigInt(holder === MONAD_SAFE.toLowerCase() ? st.nfts : 0) : holder === MONAD_SAFE.toLowerCase() ? (st.tokens[t] ?? 0n) : 0n)
          }
          throw new Error('execution reverted')
        }),
      }
    },
    getCode: async () => '0x01',
    getBalance: async () => st.mon,
    readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
      if (functionName === 'usedNonces') return st.used.has(String(args![0]).toLowerCase()) ? 1n : 0n
      throw new Error('unexpected readContract')
    },
  } as unknown as PublicClient
  return { st, client }
}

function setup(o: { downAtStart?: boolean; v4?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mamoru-money-map-'))
  const clock = { t: T0 - 10 * MIN }
  const monad = monadWorld()
  monad.st.down = o.downAtStart === true
  const chain = { landedAt: null as bigint | null }
  const base = {
    getBlock: async () => ({ number: 900n }),
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName === 'getNonce') return chain.landedAt !== null && (blockNumber ?? 0n) >= chain.landedAt ? 8n : 7n
      throw new Error(functionName)
    },
  } as unknown as PublicClient
  const bridge = new MonadBridge(dir, base, monad.client, null, (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch, () => clock.t, baseRegistry, monadRegistry)
  const store = { state: { accounts: {} as Record<string, AccountState> }, save: () => {} } as unknown as StateStore
  const cfg = { chainId: 8453, registry: baseRegistry, live: true, rpcUrl: '', bundlerUrl: '', policy: POLICIES['conservador-live-v2']!, reviewMs: 1, waitBlockMs: 1, maxWaitBlocks: 1, bridgeMonad: bridge } satisfies OperatorConfig
  const op = new Operator(cfg, {} as PublicClient, {} as Relayer, store)
  const { acc } = op.account(ctx)
  // The same account on an operator that has no bridge leg at all: what funding's exposure and overCap are without this PR's code.
  const plain = new Operator({ ...cfg, bridgeMonad: undefined }, {} as PublicClient, {} as Relayer, { state: { accounts: {} as Record<string, AccountState> }, save: () => {} } as unknown as StateStore)
  plain.account(ctx)
  acc.remote = { chainId: 143, address: MONAD_SAFE, spec: { chainId: 143, policyId: 'conservador-live-v6', sessionKey: `0x${'00'.repeat(19)}01`, validAfter: 0, validUntil: Math.floor(T0 / 1000) + 86_400 * 30, capUsdc: '100000000' }, permissionIds: [], ready: true }
  const home = { read: readOf(baseRegistry, 1_005n, { USDC: BASE_AFTER.USDC + BURN, USDT: BASE_AFTER.USDT }) }
  ;(op as unknown as { readSafeCached: () => Promise<SafeRead> }).readSafeCached = async () => home.read
  ;(plain as unknown as { readSafeCached: () => Promise<SafeRead> }).readSafeCached = async () => home.read
  const journal = () => (bridge as unknown as { journal: { burns: Record<string, BridgeBurn> } }).journal
  const update = (patch: Partial<BridgeBurn>) => (bridge as unknown as { update(b: BridgeBurn, p: Partial<BridgeBurn>): void }).update(journal().burns[UOP]!, patch)
  const signing: BridgeSigning = {
    opId: 'op-1', account: ctx.address, recipient: MONAD_SAFE, depositor: ctx.address, chainId: 143, pool: 'pool:WMON/USDC/3000', bucket: 'growth', amount: BURN, destinationDomain: 15,
    userOpHash: UOP, nonceKey: 0n, nonce: 7n, prepareBlock: 1_000n,
  }
  /** Time moves on (the Monad leg's cache lives 15 s) and funding is read. */
  const fund = async (advanceMs = 30_000) => {
    clock.t += advanceMs
    return op.funding(ctx)
  }
  /** The cap's outputs (exposure, overCap) with and without the bridge leg: they must be byte-identical in every phase. */
  const capSame = async (f: { exposure?: unknown; overCap?: unknown }) => {
    const base = await plain.funding(ctx)
    expect(JSON.stringify({ exposure: f.exposure, overCap: f.overCap })).toBe(JSON.stringify({ exposure: base.exposure, overCap: base.overCap }))
  }
  return { plain, capSame, store, dir, op, acc, bridge, clock, monad, chain, home, journal, update, signing, fund, cfg }
}

const landedBurned = (s: ReturnType<typeof setup>) => {
  s.chain.landedAt = 1_010n
  s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
  s.bridge.recordSending('brais', s.signing)
  s.update({ state: 'burned', txHash: BURN_TX, burnBlock: '1010', burnedAt: new Date(T0).toISOString() })
}

const sum = (m: MoneyMap) => m.chains.reduce((s, c) => s + BigInt(c.totalUsdc), 0n) + m.inFlight.reduce((s, f) => s + BigInt(f.amountUsdc), 0n)
const baseLeg = (m: MoneyMap) => m.chains.find((c) => c.chainId === 8453)!
const monadLeg = (m: MoneyMap) => m.chains.find((c) => c.chainId === 143 && c.safe === MONAD_SAFE)!

describe('the money map follows Brais through his bridge (otto/mamoru#269)', () => {
  test('the total is the same in every phase: before the burn, sending, burned, attested, minted but not yet read, read, and the Monad LP open', async () => {
    const s = setup()
    const seen: { phase: string; total: bigint }[] = []
    const check = async (phase: string, want: { inFlight: number; stage?: string }) => {
      const f = await s.fund()
      const m = f.money!
      expect(m).toBeDefined()
      // The invariant, in every phase, and the map is complete (Monad was read).
      expect(BigInt(m.totalUsdc)).toBe(sum(m))
      expect(m.complete).toBe(true)
      expect(m.inFlight.length).toBe(want.inFlight)
      if (want.stage) expect(m.inFlight[0]!.stage as string).toBe(want.stage)
      // The cap is untouched: its outputs are those of an operator without the bridge leg, in every phase.
      await s.capSame(f)
      seen.push({ phase, total: BigInt(m.totalUsdc) })
      return m
    }

    // 1. Before the burn: all on Base, 13.775638.
    const before = await check('before the burn', { inFlight: 0 })
    expect(BigInt(before.totalUsdc)).toBe(TOTAL)
    expect(BigInt(baseLeg(before).totalUsdc)).toBe(TOTAL)
    expect(BigInt(monadLeg(before).totalUsdc)).toBe(0n)

    // 2. The userOp is signed and on disk ('sending'), not on Base yet: the Base read still holds the USDC, so it is not also in flight.
    s.bridge.recordSending('brais', s.signing)
    await check('sending, not landed', { inFlight: 0 })

    // 3. It landed at Base block 1010: the Base read after it (1020) is 2.075638 lighter, the journal still says 'sending': in flight.
    s.chain.landedAt = 1_010n
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    const landed = await check('sending, landed', { inFlight: 1, stage: 'sending' })
    expect(landed.inFlight[0]).toMatchObject({ amountUsdc: BURN.toString(), from: 8453, to: 143, recipient: MONAD_SAFE, finality: 'standard', feeUsdc: '0' })
    expect(BigInt(baseLeg(landed).totalUsdc)).toBe(11_700_000n)

    // 4. Burned (the sync saw it): same row, now with the burn tx and the 13..19 min window.
    s.update({ state: 'burned', txHash: BURN_TX, burnBlock: '1010', burnedAt: new Date(T0).toISOString() })
    const burned = await check('burned', { inFlight: 1, stage: 'burned' })
    expect(burned.inFlight[0]).toMatchObject({ burnTx: BURN_TX, burnedAt: new Date(T0).toISOString(), eta: { from: new Date(T0 + 13 * MIN).toISOString(), to: new Date(T0 + 19 * MIN).toISOString(), late: false } })

    // 4b. The same burn against a cached Base read from before it landed (block 1005 still holds the USDC): it is in that read, not in flight.
    s.home.read = readOf(baseRegistry, 1_005n, { USDC: BASE_AFTER.USDC + BURN, USDT: BASE_AFTER.USDT })
    await check('burned, cached Base read from before the burn', { inFlight: 0 })
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)

    // 5. Circle's attestation seen.
    s.update({ attestedAt: new Date(T0 + 14 * MIN).toISOString() })
    await check('attested', { inFlight: 1, stage: 'attested' })

    // 6. Minted at Monad block 5001, but the Monad read the map has is from block 5000: still in flight (the USDC is not in that read yet).
    s.clock.t = T0 + 15 * MIN + 41_000
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001' })
    const minted = await check('minted, Monad read older than the mint', { inFlight: 1, stage: 'minted' })
    expect(BigInt(monadLeg(minted).totalUsdc)).toBe(0n)
    expect(minted.inFlight[0]!.mintTx).toBe(MINT_TX)

    // 7. Monad read at 5002 holds it: on the destination chain now, no longer in flight.
    s.monad.st.block = 5_002n
    s.monad.st.tokens = { USDC: BURN }
    const read = await check('minted and read', { inFlight: 0 })
    expect(BigInt(monadLeg(read).totalUsdc)).toBe(BURN)
    expect(monadLeg(read).read).toMatchObject({ block: 5_002, stale: false })

    // 8. The Monad LP opens: a part of the USDC is swapped to WMON (valued at the same pool price Base shows, to the unit).
    const wmonValue = 1_075_638n
    const wmon = (wmonValue << 192n) / (sqrtRatioAtTick(WMON_TICK) * sqrtRatioAtTick(WMON_TICK)) + 1n
    const exact = inUsdc('pool:WMON/USDC/3000', 'WMON', wmon, sqrtRatioAtTick(WMON_TICK), monadRegistry)
    s.monad.st.block = 5_020n
    s.monad.st.tokens = { USDC: BURN - exact, WMON: wmon }
    const lp = await check('Monad LP open', { inFlight: 0 })
    expect(BigInt(monadLeg(lp).totalUsdc)).toBe(BURN)
    expect(monadLeg(lp).idle.map((t) => t.token).sort()).toEqual(['USDC', 'WMON'])

    // Never below the pre-burn total, in any phase (here nothing was lost to fees or slippage).
    for (const p of seen) expect(p.total).toBe(TOTAL)
    // The old Home number (Base only) was 11.70 for the whole of the bridge: this is the incident.
    expect(BigInt(baseLeg(burned).totalUsdc)).toBe(11_700_000n)
    expect(BigInt(burned.totalUsdc) - BigInt(baseLeg(burned).totalUsdc)).toBe(BURN)
  })

  test('the ETA is late once past the 19 minutes while still burned', async () => {
    const s = setup()
    s.chain.landedAt = 1_010n
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    s.bridge.recordSending('brais', s.signing)
    s.update({ state: 'burned', txHash: BURN_TX, burnBlock: '1010', burnedAt: new Date(T0).toISOString() })
    s.clock.t = T0 + 19 * MIN - 1_000
    expect((await s.op.funding(ctx)).money!.inFlight[0]!.eta!.late).toBe(false)
    s.clock.t = T0 + 19 * MIN + 1_000
    const late = (await s.op.funding(ctx)).money!
    expect(late.inFlight[0]!.eta!.late).toBe(true)
    expect(BigInt(late.totalUsdc)).toBe(TOTAL)
    // The progress line (what Home's tick shows) carries the same trail.
    expect(s.bridge.view(UOP)).toMatchObject({ state: 'burned', burnTx: BURN_TX, recipient: MONAD_SAFE, eta: { late: true } })
  })
})

describe('Monad cannot be read (otto/mamoru#269)', () => {
  test('after a good read: the last value comes back stale with its time, never 0, never left out, and the total holds', async () => {
    const s = setup()
    s.monad.st.tokens = { USDC: BURN }
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    const good = (await s.fund()).money!
    expect(BigInt(monadLeg(good).totalUsdc)).toBe(BURN)
    const readAt = monadLeg(good).read.at
    s.monad.st.down = true
    const down = await s.fund(60_000)
    const m = down.money!
    expect(monadLeg(m)).toMatchObject({ totalUsdc: BURN.toString(), read: { stale: true, at: readAt, block: 5_000 } })
    expect(m.complete).toBe(true)
    expect(BigInt(m.totalUsdc)).toBe(TOTAL)
    expect(BigInt(m.totalUsdc)).toBe(sum(m))
    await s.capSame(down)
    // Cached as a failure for a few seconds: the next poll does not hit the dead RPC again.
    const calls = s.monad.st.calls
    await s.fund(1_000)
    expect(s.monad.st.calls).toBe(calls)
  })

  test('after a restart (new process, same journal): the last good total on disk is the stale value', async () => {
    const s = setup()
    s.monad.st.tokens = { USDC: BURN }
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    await s.fund()
    const again = new MonadBridge(s.dir, {} as PublicClient, (() => {
      const w = monadWorld()
      w.st.down = true
      return w.client
    })(), null, fetch, () => s.clock.t + 3_600_000, baseRegistry, monadRegistry)
    const leg = await again.sleeveLeg('brais', MONAD_SAFE, 15_000)
    expect(leg).toMatchObject({ totalUsdc: BURN.toString(), read: { stale: true, block: 5_000 } })
    expect(leg.read.at).not.toBeNull()
  })

  test('never read: the chain is on the map unread, the map says it is not complete, the cap read fails closed, and the burn in flight still counts', async () => {
    const s = setup({ downAtStart: true })
    s.chain.landedAt = 1_010n
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    s.bridge.recordSending('brais', s.signing)
    s.update({ state: 'burned', txHash: BURN_TX, burnBlock: '1010', burnedAt: new Date(T0).toISOString() })
    const f = await s.fund()
    const m = f.money!
    expect(m.complete).toBe(false)
    expect(monadLeg(m).read.at).toBeNull()
    expect(m.inFlight).toHaveLength(1)
    expect(BigInt(m.totalUsdc)).toBe(TOTAL) // Base 11.70 + the burn in flight: what is known is not lost
    expect(BigInt(m.totalUsdc)).toBe(sum(m))
    await s.capSame(f)
    // The error text of the provider (it may quote a keyed URL) is not in the map.
    expect(JSON.stringify(m)).not.toContain('SECRET')
  })
})

describe('both kinds of account resolve their remote Safes (otto/mamoru#269)', () => {
  test('design C (a v6 account): acc.remote, journaled under the account key', () => {
    const s = setup()
    expect((s.op as unknown as { remoteSafes(a: AccountState): unknown[] }).remoteSafes(s.acc)).toEqual([{ key: 'brais', safe: MONAD_SAFE }])
  })

  test('a V4 account: its registered remote V4 Safe under the account key, and its retired design-C Safe under #retired', () => {
    const s = setup()
    const V4_SAFE = getAddress('0x00000000000000000000000000000000000000f4')
    s.acc.policyId = 'one-auth-v4' as AccountState['policyId']
    s.acc.oneAuth = { remote: { domain: 15, address: V4_SAFE, sessionKey: `0x${'00'.repeat(19)}02`, ready: true } } as AccountState['oneAuth']
    s.acc.remote = { ...s.acc.remote!, address: OLD_C_SAFE }
    const out = (s.op as unknown as { remoteSafes(a: AccountState): unknown[] }).remoteSafes(s.acc)
    expect(out).toEqual([{ key: 'brais', safe: V4_SAFE }, { key: 'brais#retired', safe: OLD_C_SAFE }])
  })

  test('no bridge leg: no remote Safes, and an account with none has no money map beyond its home chain', async () => {
    const s = setup()
    s.acc.remote = undefined
    const f = await s.fund()
    expect(f.money!.chains.map((c) => c.chainId)).toEqual([8453])
    expect(f.money!.complete).toBe(true)
    await s.capSame(f)
  })
})

// ---- Round 1 of the review of PR 1: one regression test per finding. ----
describe('review round 1 (otto/mamoru#269)', () => {

  test('P1 phantom: a Safe that was a recipient stays on the map after the account\'s remote changed, and its minted burn is not in flight', async () => {
    const s = setup()
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001' })
    s.monad.st.block = 5_002n
    s.monad.st.tokens = { USDC: BURN }
    // The account's remote is rotated to another Safe: the old recipient is still read.
    s.acc.remote = { ...s.acc.remote!, address: OLD_C_SAFE }
    const f = await s.fund()
    expect(f.money!.chains.map((c) => c.safe)).toContain(MONAD_SAFE)
    expect(f.money!.inFlight).toHaveLength(0)
    expect(BigInt(f.money!.totalUsdc)).toBe(TOTAL)
    expect(BigInt(monadLeg(f.money!).totalUsdc)).toBe(BURN)
  })

  test('P1 phantom (bridge): a minted burn to a Safe nobody reads is settled; one without mintedBlock is never settled (counted, unsure); a burn still flying is counted', async () => {
    const s = setup()
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001' })
    expect((await s.bridge.moneyInFlight('brais', 1_020n, () => undefined)).rows).toHaveLength(0)
    expect((await s.bridge.moneyInFlight('brais', 1_020n, () => ({ block: 5_000n, stale: false }))).rows).toHaveLength(1)
    // An old journal entry with no mintedBlock (every mint path writes it): counted, flagged, in both modes.
    s.update({ mintedBlock: undefined })
    const local = await s.bridge.moneyInFlight('brais', 1_020n, () => ({ block: 9_000n, stale: false }))
    expect(local.rows).toHaveLength(1)
    expect(local.unsure).toBe(true)
    expect((await s.bridge.moneyInFlight('brais', 1_020n, () => undefined)).rows).toHaveLength(1)
    s.update({ state: 'burned', mintTx: undefined })
    expect((await s.bridge.moneyInFlight('brais', 1_020n, () => undefined)).rows).toHaveLength(1)
  })

  test('P1 mint paths: every state change to minted writes mintedBlock', async () => {
    const src = await Bun.file(new URL('../src/bridge-monad.ts', import.meta.url)).text()
    const writes = src.match(/state: 'minted'[^}]*\}/g) ?? []
    expect(writes.length).toBeGreaterThanOrEqual(3)
    for (const w of writes) expect(w).toContain('mintedBlock')
  })

  test('P1-4: a recipient survives the pruning of its burns, and is released only by a live read showing it empty', async () => {
    const s = setup()
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001' })
    s.monad.st.block = 5_002n
    s.monad.st.tokens = { USDC: BURN }
    s.acc.remote = { ...s.acc.remote!, address: OLD_C_SAFE } // rotated: MONAD_SAFE is now only a past recipient
    await s.fund()
    // 31 days on the burn is pruned from the journal; the Safe still holds the USDC and is still counted.
    s.clock.t += MINTED_KEEP_MS + 86_400_000
    await s.bridge.tick()
    expect(s.bridge.burns()).toHaveLength(0)
    const still = (await s.fund()).money!
    expect(BigInt(monadLeg(still).totalUsdc)).toBe(BURN)
    expect(s.bridge.recipients('brais').map((a) => a.toLowerCase())).toContain(MONAD_SAFE.toLowerCase())
    // The USDC leaves: a live read of the empty Safe releases it.
    s.monad.st.tokens = {}
    s.monad.st.block = 5_900n
    const after = (await s.fund()).money!
    expect(s.bridge.recipients('brais')).not.toContain(MONAD_SAFE)
    expect(BigInt(after.totalUsdc)).toBe(11_700_000n)
    // A stale read never releases.
    expect(s.bridge.releaseRecipient('brais', OLD_C_SAFE, { block: 1, stale: true, empty: true })).toBe(false)
  })

  test('P1 RPC load: a check at a block is asked once; a stale leg asks Monad for nothing; a hung Monad does not hold funding', async () => {
    const s = setup()
    s.bridge.recordSending('brais', s.signing)
    let nonceCalls = 0
    const base = (s.bridge as unknown as { base: { readContract: (a: unknown) => Promise<bigint> } }).base
    const orig = base.readContract
    base.readContract = async (a) => (nonceCalls++, orig(a))
    for (let i = 0; i < 5; i++) await s.bridge.moneyInFlight('brais', 1_005n, () => undefined)
    expect(nonceCalls).toBe(1)
    // A minted burn above a stale leg: no usedNonces read at the old block, counted, and unsure.
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001', cctpNonce: `0x${'44'.repeat(32)}` })
    const monadCalls = s.monad.st.calls
    const r = await s.bridge.moneyInFlight('brais', 1_020n, () => ({ block: 4_000n, stale: true }))
    expect(r.rows).toHaveLength(1)
    expect(r.unsure).toBe(true)
    expect(r.rows[0]!.unsure).toBe(true)
    expect(s.monad.st.calls).toBe(monadCalls)
    // A Monad that never answers: the leg is given up after the timeout and funding returns.
    const hung = setup()
    ;(hung.bridge as unknown as { legTimeoutMs: number }).legTimeoutMs = 30
    ;(hung.bridge as unknown as { monad: { call: () => Promise<never> } }).monad.call = () => new Promise<never>(() => {})
    const t0 = Date.now()
    const f = await hung.fund()
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(monadLeg(f.money!).read.at).toBeNull()
    expect(f.money!.complete).toBe(false)
  })

  test('P1 unsure: a failed check surfaces on the row and the map is not complete', async () => {
    const s = setup()
    s.bridge.recordSending('brais', s.signing)
    ;(s.bridge as unknown as { base: { readContract: () => Promise<never> } }).base.readContract = async () => {
      throw new Error('rpc down')
    }
    const f = await s.fund()
    expect(f.money!.inFlight[0]).toMatchObject({ stage: 'sending', unsure: true })
    expect(f.money!.complete).toBe(false)
  })

  test('P2: the home leg reports stale when its read is old; the Ethereum route row keeps exposure and money equal; unsure rows are flagged', async () => {
    const s = setup()
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    ;(s.op as unknown as { homeReadAt: WeakMap<object, number> }).homeReadAt.set(s.home.read, Date.now() - 60_000)
    ;(s.op as unknown as { bridgeInFlight: () => bigint }).bridgeInFlight = () => 500_000n
    const f = await s.fund()
    expect(baseLeg(f.money!).read.stale).toBe(true)
    expect(f.money!.inFlight.find((x) => x.kind === 'bridge')).toMatchObject({ amountUsdc: '500000', from: 1, to: 8453 })
    ;(s.plain as unknown as { bridgeInFlight: () => bigint }).bridgeInFlight = () => 500_000n
    await s.capSame(f)
    expect(BigInt(f.money!.totalUsdc)).toBe(11_700_000n + 500_000n)
  })
})

describe('final review round 1 (otto/mamoru#269)', () => {
  const sleevesOf = (s: ReturnType<typeof setup>) => (s.bridge as unknown as { journal: { sleeves: Record<string, { value: string; block: string; at: string; safe?: string }> } }).journal.sleeves

  test('1: after a rotation with Monad unreadable the old Safe keeps its last value and the new one does not inherit it (no double count)', async () => {
    const s = setup()
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001' })
    s.monad.st.block = 5_002n
    s.monad.st.tokens = { USDC: BURN }
    await s.fund()
    // The engine's sleeve record is by account key, for the Safe it read.
    sleevesOf(s).brais = { value: BURN.toString(), block: '5000', at: new Date(T0).toISOString(), safe: MONAD_SAFE.toLowerCase() }
    s.acc.remote = { ...s.acc.remote!, address: OLD_C_SAFE } // rotated: MONAD_SAFE is past, OLD_C_SAFE is the current Safe under the account key
    s.monad.st.down = true
    const f = await s.fund(60_000)
    const m = f.money!
    expect(m.chains.find((c) => c.safe === MONAD_SAFE)).toMatchObject({ totalUsdc: BURN.toString(), read: { stale: true } })
    expect(m.chains.find((c) => c.safe === OLD_C_SAFE)).toMatchObject({ totalUsdc: '0', read: { at: null } })
    expect(BigInt(m.totalUsdc)).toBe(TOTAL)
  })

  test('1: V4 retirement with Monad unreadable: the retired Safe keeps its value, the new V4 Safe does not take the account-key sleeve record', async () => {
    const s = setup()
    const V4_SAFE = getAddress('0x00000000000000000000000000000000000000f4')
    s.monad.st.tokens = { USDC: BURN }
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    await s.fund()
    sleevesOf(s).brais = { value: BURN.toString(), block: '5000', at: new Date(T0).toISOString(), safe: MONAD_SAFE.toLowerCase() }
    s.acc.policyId = 'one-auth-v4' as AccountState['policyId']
    s.acc.oneAuth = { remote: { domain: 15, address: V4_SAFE, sessionKey: `0x${'00'.repeat(19)}02`, ready: true } } as AccountState['oneAuth']
    s.monad.st.down = true
    const m = (await s.fund(60_000)).money!
    expect(m.chains.find((c) => c.safe === MONAD_SAFE)).toMatchObject({ totalUsdc: BURN.toString() })
    expect(BigInt(m.chains.find((c) => c.safe === V4_SAFE)!.totalUsdc)).toBe(0n)
    expect(BigInt(m.totalUsdc)).toBe(TOTAL)
  })

  test('2: a burn whose mint landed before the journal says minted is not counted twice (nonce used at the block the Safe was read at)', async () => {
    const s = setup()
    landedBurned(s)
    s.update({ attestedAt: new Date(T0 + 14 * MIN).toISOString(), cctpNonce: `0x${'44'.repeat(32)}`, mintTx: MINT_TX })
    s.monad.st.block = 5_002n
    s.monad.st.tokens = { USDC: BURN }
    s.monad.st.used.add(`0x${'44'.repeat(32)}`)
    const m = (await s.fund()).money!
    expect(m.inFlight).toHaveLength(0)
    expect(BigInt(m.totalUsdc)).toBe(TOTAL)
  })

  test('3: an unread leg is never cached over the journal: the engine\'s sleeve record for that Safe is used on the next failure, and the newer of shown and sleeves wins', async () => {
    const s = setup({ downAtStart: true })
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    expect(monadLeg((await s.fund()).money!).read.at).toBeNull()
    sleevesOf(s).brais = { value: BURN.toString(), block: '5010', at: new Date(T0).toISOString(), safe: MONAD_SAFE.toLowerCase() }
    const later = monadLeg((await s.fund(60_000)).money!)
    expect(later).toMatchObject({ totalUsdc: BURN.toString(), read: { stale: true, block: 5_010 } })
    // shown is older than sleeves: sleeves wins
    ;(s.bridge as unknown as { journal: { shown: Record<string, unknown> } }).journal.shown[MONAD_SAFE.toLowerCase()] = { totalUsdc: '0', block: '5000', at: new Date(T0).toISOString() }
    ;(s.bridge as unknown as { legCache: Map<string, unknown> }).legCache.clear()
    expect(monadLeg((await s.fund(60_000)).money!).totalUsdc).toBe(BURN.toString())
  })

  test('5: a Monad that never answers the check or the nonce read does not hold funding past the leg timeout', async () => {
    const hang = new Promise<never>(() => {})
    const s = setup()
    ;(s.bridge as unknown as { legTimeoutMs: number }).legTimeoutMs = 30
    ;(s.bridge as unknown as { verified: boolean; verify: () => Promise<void> }).verified = false
    ;(s.bridge as unknown as { verify: () => Promise<void> }).verify = () => hang
    const t0 = Date.now()
    const f = await s.fund()
    expect(Date.now() - t0).toBeLessThan(2_000)
    expect(monadLeg(f.money!).read.at).toBeNull()
    const u = setup()
    ;(u.bridge as unknown as { legTimeoutMs: number }).legTimeoutMs = 30
    landedBurned(u)
    u.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001', cctpNonce: `0x${'44'.repeat(32)}` })
    ;(u.bridge as unknown as { monad: { readContract: () => Promise<never> } }).monad.readContract = () => hang
    const t1 = Date.now()
    const m = (await u.fund()).money!
    expect(Date.now() - t1).toBeLessThan(2_000)
    expect(m.inFlight[0]).toMatchObject({ unsure: true })
  })

  test('gate 1: an unread leg is cached for the short failure TTL (no hammering of a failing Monad), and still does not shadow later journal data', async () => {
    const s = setup({ downAtStart: true })
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    await s.fund()
    const calls = s.monad.st.calls
    await s.fund(1_000)
    await s.fund(1_000)
    expect(s.monad.st.calls).toBe(calls)
    sleevesOf(s).brais = { value: BURN.toString(), block: '5010', at: new Date(T0).toISOString(), safe: MONAD_SAFE.toLowerCase() }
    expect(monadLeg((await s.fund(60_000)).money!).totalUsdc).toBe(BURN.toString())
  })

  test('gate 3: a minted burn to a tracked Safe that has no leg now stays in flight (unsure); it is never dropped from the total', async () => {
    const s = setup()
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001' })
    s.monad.st.block = 5_002n
    s.monad.st.tokens = { USDC: BURN }
    ;(s.bridge as unknown as { sleeveLeg: () => Promise<never> }).sleeveLeg = async () => {
      throw new Error('legs failed as a whole')
    }
    const m = (await s.fund()).money!
    expect(m.inFlight).toHaveLength(1)
    expect(m.inFlight[0]).toMatchObject({ unsure: true })
    expect(m.complete).toBe(false)
    expect(BigInt(m.totalUsdc)).toBe(TOTAL)
  })

  test('gate 4: the engine\'s sleeve record is found by Safe address, whatever synthetic key the leg is read under', async () => {
    const s = setup({ downAtStart: true })
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    sleevesOf(s).brais = { value: BURN.toString(), block: '5010', at: new Date(T0).toISOString(), safe: MONAD_SAFE.toLowerCase() }
    const leg = await s.bridge.sleeveLeg('brais#past:abc', MONAD_SAFE, 15_000)
    expect(leg).toMatchObject({ totalUsdc: BURN.toString(), read: { stale: true, block: 5_010 } })
    const other = await s.bridge.sleeveLeg('brais', OLD_C_SAFE, 15_000)
    expect(other.read.at).toBeNull()
  })

  test('gate 5: the Monad part of funding shares ONE deadline: a slow read plus a hung nonce check do not add up', async () => {
    const s = setup()
    ;(s.bridge as unknown as { legTimeoutMs: number }).legTimeoutMs = 300
    landedBurned(s)
    s.update({ state: 'burned', cctpNonce: `0x${'44'.repeat(32)}` })
    const monad = (s.bridge as unknown as { monad: { call: (a: unknown) => Promise<unknown>; readContract: () => Promise<never> } }).monad
    const call = monad.call
    monad.call = async (a) => (await Bun.sleep(180), call(a))
    monad.readContract = () => new Promise<never>(() => {})
    const t0 = Date.now()
    const m = (await s.fund()).money!
    expect(Date.now() - t0).toBeLessThan(450) // sequential bounds would be ~180 + 300
    expect(m.inFlight).toHaveLength(1)
    expect(m.inFlight[0]).toMatchObject({ unsure: true })
    expect(BigInt(m.totalUsdc)).toBe(TOTAL)
  })

  test('final 1: a minted burn is not pruned while no read of its recipient at or after the mint is recorded, so it cannot vanish from the total; it is pruned once one is', async () => {
    const s = setup({ downAtStart: true })
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001' })
    s.clock.t += MINTED_KEEP_MS + 86_400_000
    await s.bridge.tick()
    expect(s.bridge.burns()).toHaveLength(1)
    const down = (await s.fund()).money!
    expect(down.inFlight).toHaveLength(1)
    expect(BigInt(down.totalUsdc)).toBe(TOTAL)
    // Monad answers: the Safe is read at a block after the mint; now the burn can go and the leg carries the money.
    s.monad.st.down = false
    s.monad.st.block = 5_002n
    s.monad.st.tokens = { USDC: BURN }
    const up = (await s.fund(60_000)).money!
    expect(BigInt(up.totalUsdc)).toBe(TOTAL)
    await s.bridge.tick()
    expect(s.bridge.burns()).toHaveLength(0)
    expect(BigInt((await s.fund(30_000)).money!.totalUsdc)).toBe(TOTAL)
  })

  test('final 1b: a legacy minted burn with no mintedBlock is kept on age alone; it is pruned only after a live read of its recipient made after the mint', async () => {
    const s = setup({ downAtStart: true })
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: undefined })
    s.clock.t += MINTED_KEEP_MS + 86_400_000
    await s.bridge.tick()
    expect(s.bridge.burns()).toHaveLength(1)
    const down = (await s.fund()).money!
    expect(down.inFlight).toHaveLength(1)
    expect(BigInt(down.totalUsdc)).toBe(TOTAL)
    s.monad.st.down = false
    s.monad.st.block = 5_002n
    s.monad.st.tokens = { USDC: BURN }
    await s.fund(60_000)
    await s.bridge.tick()
    expect(s.bridge.burns()).toHaveLength(0)
    expect(BigInt((await s.fund(30_000)).money!.totalUsdc)).toBe(TOTAL)
  })

  test('final 2: a sleeve record written before it carried a Safe belongs to the primary remote (plain key) only', async () => {
    const s = setup({ downAtStart: true })
    sleevesOf(s).brais = { value: BURN.toString(), block: '5010', at: new Date(T0).toISOString() }
    expect(await s.bridge.sleeveLeg('brais', MONAD_SAFE, 15_000)).toMatchObject({ totalUsdc: BURN.toString(), read: { stale: true } })
    expect((await s.bridge.sleeveLeg('brais#retired', OLD_C_SAFE, 15_000)).read.at).toBeNull()
    expect((await s.bridge.sleeveLeg('brais#past:x', getAddress('0x00000000000000000000000000000000000000b2'), 15_000)).read.at).toBeNull()
  })

  test('final 3: past Safes are seeded from every sleeve record and every provisioning op the account still has', async () => {
    const s = setup({ downAtStart: true })
    // A journal from before pastRecipients: no burns left, but the engine recorded a sleeve for a Safe that was later rotated.
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-seed-'))
    writeFileSync(join(dir, 'bridge-monad.json'), JSON.stringify({ burns: {}, mintDays: {}, sleeves: { brais: { value: '5', block: '9', at: 'x', safe: OLD_C_SAFE.toLowerCase() } }, cooldowns: {} }))
    const seeded = new MonadBridge(dir, {} as PublicClient, {} as PublicClient, null, fetch, () => T0, baseRegistry, monadRegistry)
    expect(seeded.recipients('brais').map((a) => a.toLowerCase())).toEqual([OLD_C_SAFE.toLowerCase()])
    // The operator also lists every Safe an owner op of the account provisioned.
    const PAST = getAddress('0x00000000000000000000000000000000000000b3')
    s.acc.ops.push({ opId: 'own-1', kind: 'activate', state: 'confirmed', updatedAt: 'x', ownerRemote: { chainId: 143, address: PAST, spec: s.acc.remote!.spec, permissionIds: [] } } as never)
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    const m = (await s.fund()).money!
    expect(m.chains.some((c) => c.safe === PAST)).toBe(true)
    expect(m.complete).toBe(false) // never read: said, not hidden
  })

  test('final 4: with the bridge leg absent an account that has a Monad Safe shows it unread and the map incomplete', async () => {
    const s = setup()
    ;(s.cfg as { bridgeMonad?: unknown }).bridgeMonad = undefined
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    const m = (await s.fund()).money!
    expect(m.complete).toBe(false)
    expect(monadLeg(m).read.at).toBeNull()
    const none = setup()
    ;(none.cfg as { bridgeMonad?: unknown }).bridgeMonad = undefined
    none.acc.remote = undefined
    expect((await none.fund()).money!.complete).toBe(true) // no Monad footprint: nothing to hide
    await s.capSame(await s.fund())
  })

  test('6: a released recipient is not resurrected by a restart while its old burns are still journaled', async () => {
    const s = setup()
    landedBurned(s)
    s.update({ state: 'minted', mintTx: MINT_TX, mintedBlock: '5001' })
    s.monad.st.block = 5_002n
    s.acc.remote = { ...s.acc.remote!, address: OLD_C_SAFE }
    await s.fund() // MONAD_SAFE is a past recipient, read live and empty: released
    expect(s.bridge.recipients('brais').map((a) => a.toLowerCase())).not.toContain(MONAD_SAFE.toLowerCase())
    const again = new MonadBridge(s.dir, {} as PublicClient, {} as PublicClient, null, fetch, () => s.clock.t, baseRegistry, monadRegistry)
    expect(again.burns()).toHaveLength(1)
    expect(again.recipients('brais').map((a) => a.toLowerCase())).not.toContain(MONAD_SAFE.toLowerCase())
  })
})

describe('display only (otto/mamoru#269)', () => {
  test('junk NFTs on a Monad Safe: below the limit they are below the dust floor and not shown; above it the leg is partial and the map incomplete; the cap is untouched either way', async () => {
    const s = setup()
    s.monad.st.tokens = { USDC: BURN }
    s.home.read = readOf(baseRegistry, 1_020n, BASE_AFTER)
    s.monad.st.nfts = 10
    const few = await s.fund()
    expect(monadLeg(few.money!).positions).toHaveLength(0)
    expect(few.money!.complete).toBe(true)
    await s.capSame(few)
    s.monad.st.nfts = 500
    const many = await s.fund()
    expect(monadLeg(many.money!).partial).toBe(true)
    expect(many.money!.complete).toBe(false)
    expect(BigInt(many.money!.totalUsdc)).toBe(TOTAL)
    await s.capSame(many)
  })

  test('liveness: a hung Monad read is awaited once, not restarted by each poll', async () => {
    const hung = setup()
    ;(hung.bridge as unknown as { legTimeoutMs: number }).legTimeoutMs = 20
    let started = 0
    ;(hung.bridge as unknown as { monad: { call: () => Promise<never> } }).monad.call = () => (started++, new Promise<never>(() => {}))
    for (let i = 0; i < 4; i++) await hung.fund(10_000)
    expect(started).toBe(1)
  })
})

