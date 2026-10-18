import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, keccak256, stringToHex, type Hex, type PublicClient } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import type { Proposal } from '@mamoru/decide'
import { conservadorLabV4, grantKey, instantiateGrant, POLICIES, type PolicyVersion } from '@mamoru/policy'
import { address, baseRegistry, erc20Abi, mamoruActionPolicyAbi, nonfungiblePositionManagerAbi, swapRouter02Abi, type Registry } from '@mamoru/registry'
import { precheck, SessionLedger } from '@mamoru/account/precheck'
import { executeCallData, permissionIdOf, toSmartSession, useModeSignature } from '@mamoru/account/sessions'
import { quoterV2Abi, sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { decreaseMins, engineBand, swapBounds } from '@mamoru/uniswap-v3/action-policy'
import type { Simulation } from '@mamoru/rpc'
import { Engine, type EngineSession } from './engine.ts'

// Spec 007 (otto/mamoru#151) T3: the engine's calls under a v4 session, and under v1/v2 sessions exactly as before.

const CHAIN = 31337
const ACCOUNT = '0x00000000000000000000000000000000000000AA' as Address
const POLICY = '0x00000000000000000000000000000000000A11cE' as Address
const deployed: Registry = { ...baseRegistry, entries: [...baseRegistry.entries, { name: 'MamoruActionPolicy', kind: 'smart-sessions-policy', role: 'test', address: POLICY, codeHash: null }], undeployed: [] }
const V2 = POLICIES['conservador-lab-geometry-v1']! // conservador-live-v2 on a fork
const V4 = conservadorLabV4
const POOL = 'pool:WETH/USDC/3000'
const TICK = -193_380
const RANGE = { tickLower: -194_400, tickUpper: -192_420 }
const sessionKey = privateKeyToAccount(generatePrivateKey())
const caps = new Proxy({}, { get: () => 10n ** 30n }) as Record<string, bigint>
const BAND = V4.actionPolicy!.byPool[POOL]!.bandTicks

function session(p: PolicyVersion, key: string): EngineSession {
  const v4 = p.actionPolicy !== undefined
  const grant = instantiateGrant(p, key, { account: ACCOUNT, sessionKey: sessionKey.address, chainId: CHAIN, salt: `0x${'01'.repeat(32)}`, validAfter: 0, validUntil: 2_000_000_000, caps, ...(v4 ? { generation: 1n, registry: deployed, caps: new Proxy({}, { get: () => 10n ** 30n }) } : {}) })
  return { name: key, grant, permissionId: permissionIdOf(toSmartSession(grant)) }
}
const v4s = session(V4, `engine:${POOL}`)

type Chain = { spot: number; twap: number; quote: bigint; admitted: Address; owner?: Address; paused?: boolean; pos: { tickLower: number; tickUpper: number; liquidity: bigint } }

function engineAt(over: Partial<Chain> = {}, policy: PolicyVersion = V4) {
  const c: Chain = { spot: TICK, twap: TICK, quote: 0n, admitted: address(POOL), pos: { ...RANGE, liquidity: 10n ** 12n }, ...over }
  const e = new Engine(
    { mode: 'lab', chainId: CHAIN, signingChainIds: [CHAIN], rpcUrl: 'http://127.0.0.1:9/', bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 0n, historyFromBlock: 0n, sessions: [] },
    { waitBlock: async () => {} },
  )
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      if (functionName === 'slot0') return [sqrtRatioAtTick(c.spot), c.spot, 0, 0, 0, 0, true]
      if (functionName === 'observe') {
        const w = BigInt((args![0] as readonly number[])[0]!)
        return [[0n, BigInt(c.twap) * w], [0n, 1n]]
      }
      if (functionName === 'positions') return [0n, address('NonfungiblePositionManager'), address('WETH'), address('USDC'), 3000, c.pos.tickLower, c.pos.tickUpper, c.pos.liquidity, 0n, 0n, 0n, 0n]
      if (functionName === 'admittedPool') return c.admitted
      if (functionName === 'ownerOf') return c.owner ?? ACCOUNT
      if (functionName === 'isPaused') return c.paused ?? false
      throw new Error(`unexpected read ${functionName}`)
    },
    call: async () => ({ data: encodeFunctionResult({ abi: quoterV2Abi, functionName: 'quoteExactInputSingle', result: [c.quote, 0n, 0, 0n] }) }),
  } as unknown as PublicClient
  ;(e as unknown as { client: PublicClient }).client = client
  return e as unknown as {
    prepareCalls(p: Proposal, block: bigint, timestamp: bigint, s: EngineSession): Promise<{ calls: { target: Address; callData: Hex }[]; expiresAt: bigint | null; quote?: { amountOutMinimum: bigint } }>
    deltaMismatch(p: Proposal, prepared: unknown, sim: Pick<Simulation, 'deltas' | 'nftDelta'>): string | null
  }
}

function check(s: EngineSession, calls: { target: Address; callData: Hex }[]) {
  const ledger = new SessionLedger()
  ledger.activate(s.permissionId, s.grant)
  return precheck({ sender: ACCOUNT, callData: executeCallData(calls.map((c) => ({ target: c.target, value: 0n, callData: c.callData }))), signature: useModeSignature(s.permissionId, '0x') }, { chainId: CHAIN, now: 1_000, ledger })
}

// 1 WETH ~ 4,000 USDC at TICK (token0 WETH, 18 decimals; token1 USDC, 6).
const sellWeth: Proposal = { kind: 'enter_swap', grant: `engine:${POOL}`, pool: POOL, tokenIn: 'WETH', tokenOut: 'USDC', fee: 3000, amountIn: 10n ** 17n }
const buyWeth: Proposal = { kind: 'enter_swap', grant: `engine:${POOL}`, pool: POOL, tokenIn: 'USDC', tokenOut: 'WETH', fee: 3000, amountIn: 400_000_000n }
const mintP: Proposal = { kind: 'enter_mint', grant: `engine:${POOL}`, pool: POOL, ...RANGE, amount0Desired: 10n ** 15n, amount1Desired: 4_000_000n }
const increaseP: Proposal = { kind: 'increase_liquidity', grant: `engine:${POOL}`, pool: POOL, tokenId: 3n, ...RANGE, amount0Desired: 10n ** 15n, amount1Desired: 4_000_000n }
const rerangeP: Proposal = { kind: 'rerange', grant: `engine:${POOL}`, pool: POOL, tokenId: 3n, liquidity: 10n ** 12n }
const reduceP: Proposal = { kind: 'reduce', grant: `engine:${POOL}`, pool: POOL, tokenId: 3n, liquidity: 4n * 10n ** 11n }
const QUOTE_SELL = 397_000_000n // a fair quote for 0.1 WETH, about 0.3% fee and a little impact
const QUOTE_BUY = 99_500_000_000_000_000n

const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))

/**
 * keccak of the calls the engine built for these v2 proposals before spec 007 T3 (engine.ts at eac4520, same stub
 * chain). Equal: a v1/v2 account's userOps are byte for byte what they were.
 */
const V2_CALLS: Record<string, string> = {
  sellWeth: '0x9e4ca4730d3e8b0cc6add4d8b0aa1d0f4f365ce842f9361b53f8b224ec1e61de',
  buyWeth: '0x072e8f0b79e0d39d9875636463f5f2a167f1a9649ef9b0730497b0f723a673b6',
  mint: '0xe5ba249e87fa7fa64f9556bc5149f708fcf4a275df67418e2a5bddc0babe400d',
  rerange: '0x845f11a1bb15cb0a41907a48f8f6467bdbbb8b84afaf4ab421cc0b0ac885205e',
  reduce: '0xac362f2dedc0747ece7d8f3ab968cc58c44234d52e8182799eaa98560d58b680',
}

async function v2CallHashes(build: typeof engineAt): Promise<Record<string, string>> {
  const at = (q: bigint) => build({ quote: q }, V2)
  const s = (k: string) => session(V2, `${k}:${POOL}`)
  const out: Record<string, string> = {}
  out.sellWeth = keccak256(stringToHex(j(await at(QUOTE_SELL).prepareCalls({ ...sellWeth, grant: `convert-any:${POOL}` } as Proposal, 100n, 1_000n, s('convert-any')))))
  out.buyWeth = keccak256(stringToHex(j(await at(QUOTE_BUY).prepareCalls({ ...buyWeth, grant: `enter-swap:${POOL}` } as Proposal, 100n, 1_000n, s('enter-swap')))))
  out.mint = keccak256(stringToHex(j(await at(0n).prepareCalls({ ...mintP, grant: `enter-mint:${POOL}` } as Proposal, 100n, 1_000n, s('enter-mint')))))
  out.rerange = keccak256(stringToHex(j(await at(0n).prepareCalls({ ...rerangeP, grant: `manage-any:${POOL}` } as Proposal, 100n, 1_000n, s('manage-any')))))
  out.reduce = keccak256(stringToHex(j(await at(0n).prepareCalls({ ...reduceP, grant: `manage-any:${POOL}` } as Proposal, 100n, 1_000n, s('manage-any')))))
  return out
}

describe('engine under v1/v2 sessions (spec 007 T3)', () => {
  test('swap, mint, re-range and reduce calls are byte-identical to before', async () => {
    expect(await v2CallHashes(engineAt)).toEqual(V2_CALLS)
  })

  test('an increase is never built on a session without MamoruActionPolicy', async () => {
    await expect(engineAt({}, V2).prepareCalls(increaseP, 100n, 1_000n, session(V2, `enter-mint:${POOL}`))).rejects.toMatchObject({ code: 'SESSION_MISSING' })
  })
})

describe('engine under a v4 session (spec 007 T3)', () => {
  test('swap: minimum and price limit from the policy bounds at 0.8 x band; the policy accepts them after a 0.2 x band TWAP drift', async () => {
    for (const [p, quote] of [[sellWeth, QUOTE_SELL], [buyWeth, QUOTE_BUY]] as const) {
      const r = await engineAt({ quote }).prepareCalls(p, 100n, 1_000n, v4s)
      expect(r.calls.map((c) => c.target)).toEqual([address('SwapRouter02'), address(p.tokenIn), address('SwapRouter02')])
      expect(decodeFunctionData({ abi: swapRouter02Abi, data: r.calls[0]!.callData }).functionName).toBe('multicall')
      const s = decodeFunctionData({ abi: swapRouter02Abi, data: r.calls[2]!.callData }).args![0] as { amountOutMinimum: bigint; sqrtPriceLimitX96: bigint; recipient: Address }
      const zeroForOne = p.tokenIn === 'WETH'
      const engine = swapBounds({ twapTick: TICK, band: engineBand(BAND), fee: 3000, tokenInIsToken0: zeroForOne, amountIn: p.amountIn })
      expect(s.sqrtPriceLimitX96).toBe(engine.sqrtPriceLimitX96)
      expect(s.amountOutMinimum).toBeGreaterThanOrEqual(engine.minOut)
      expect(s.recipient).toBe(ACCOUNT)
      // What MamoruActionPolicy._swapOk checks at validation, with the TWAP moved against the swap by the 0.2 x band left.
      const drift = BAND - engineBand(BAND)
      const later = swapBounds({ twapTick: zeroForOne ? TICK + drift : TICK - drift, band: BAND, fee: 3000, tokenInIsToken0: zeroForOne, amountIn: p.amountIn })
      expect(s.amountOutMinimum).toBeGreaterThanOrEqual(later.minOut)
      expect(zeroForOne ? s.sqrtPriceLimitX96 >= later.sqrtPriceLimitX96 : s.sqrtPriceLimitX96 <= later.sqrtPriceLimitX96).toBe(true)
      expect(s.sqrtPriceLimitX96).not.toBe(0n)
      expect(check(v4s, r.calls)).toMatchObject({ ok: true })
    }
  })

  test('swap not sent: a quote under the policy bound, or a spot past the engine band', async () => {
    const bound = swapBounds({ twapTick: TICK, band: engineBand(BAND), fee: 3000, tokenInIsToken0: true, amountIn: sellWeth.amountIn }).minOut
    await expect(engineAt({ quote: bound - 1n }).prepareCalls(sellWeth, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
    await expect(engineAt({ quote: QUOTE_SELL, spot: TICK + engineBand(BAND) + 1 }).prepareCalls(sellWeth, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
    // A swap proposed for another pool than the session's.
    await expect(engineAt({ quote: QUOTE_SELL }).prepareCalls(sellWeth, 100n, 1_000n, session(V4, 'engine:pool:USDC/cbBTC/500'))).rejects.toMatchObject({ code: 'POLICY_DENIED_TARGET' })
  })

  test('mint through MamoruActionPolicy.mint: exact approvals of the policy, recipient the account, no approval of the manager', async () => {
    const r = await engineAt().prepareCalls(mintP, 100n, 1_000n, v4s)
    expect(r.calls.map((c) => c.target)).toEqual([address('WETH'), address('USDC'), POLICY])
    expect([0, 1].map((i) => decodeFunctionData({ abi: erc20Abi, data: r.calls[i]!.callData }).args)).toEqual([[POLICY, 10n ** 15n], [POLICY, 4_000_000n]])
    const m = decodeFunctionData({ abi: mamoruActionPolicyAbi, data: r.calls[2]!.callData })
    expect(m.functionName).toBe('mint')
    expect(r.calls[2]!.callData.slice(0, 10)).toBe('0x88316456')
    const a = m.args![0] as { recipient: Address; amount0Min: bigint; amount1Min: bigint; tickLower: number; tickUpper: number }
    expect([a.recipient, a.tickLower, a.tickUpper]).toEqual([ACCOUNT, RANGE.tickLower, RANGE.tickUpper])
    expect(a.amount0Min > 0n && a.amount1Min > 0n).toBe(true)
    expect(check(v4s, r.calls)).toMatchObject({ ok: true })
    // The v2 manage-any session does not hold the policy's mint.
    expect(check(session(V2, `manage-any:${POOL}`), r.calls)).toMatchObject({ ok: false })
    await expect(engineAt({ spot: TICK - engineBand(BAND) - 1 }).prepareCalls(mintP, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
  })

  test('increase through MamoruActionPolicy.increase on an admitted position; refused for one the policy did not admit', async () => {
    const r = await engineAt().prepareCalls(increaseP, 100n, 1_000n, v4s)
    expect(r.calls.map((c) => c.target)).toEqual([address('WETH'), address('USDC'), POLICY])
    const inc = decodeFunctionData({ abi: mamoruActionPolicyAbi, data: r.calls[2]!.callData })
    expect(inc.functionName).toBe('increase')
    expect(r.calls[2]!.callData.slice(0, 10)).toBe('0x4110c363')
    const a = inc.args![0] as { tokenId: bigint; amount0Min: bigint; amount1Min: bigint; deadline: bigint }
    expect(a.tokenId).toBe(3n)
    expect(a.amount0Min > 0n && a.amount1Min > 0n).toBe(true)
    expect(a.deadline).toBe(1_000n + BigInt(V4.execution.observationTtlSeconds))
    expect(check(v4s, r.calls)).toMatchObject({ ok: true })
    // Never the position manager's increaseLiquidity, which does not check who owns the tokenId.
    expect(r.calls.some((c) => c.target === address('NonfungiblePositionManager'))).toBe(false)
    await expect(engineAt({ admitted: '0x0000000000000000000000000000000000000000' }).prepareCalls(increaseP, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'POLICY_DENIED_POSITION' })
    await expect(engineAt({ admitted: address('pool:USDC/cbBTC/500') }).prepareCalls(increaseP, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'POLICY_DENIED_POSITION' })
    // Admitted but moved out of the Safe since: not sent (the policy would refuse it and the userOp's gas be lost).
    await expect(engineAt({ owner: '0x00000000000000000000000000000000000000bb' }).prepareCalls(increaseP, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'POLICY_DENIED_POSITION' })
    await expect(engineAt({ owner: '0x00000000000000000000000000000000000000bb' }).prepareCalls(reduceP, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'POLICY_DENIED_POSITION' })
    // #171's checks stay: the position must be the one decided on, the price inside it.
    await expect(engineAt({ pos: { tickLower: RANGE.tickLower + 60, tickUpper: RANGE.tickUpper, liquidity: 1n } }).prepareCalls(increaseP, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'EHG_OBSERVATION_STALE' })
  })

  test('decrease minimums: never under the policy minimums at 0.8 x band, nor under the slippage minimums', async () => {
    // A narrow range (+-60 ticks) so the band edges fall outside it and the policy minimums bind.
    const narrow = { tickLower: TICK - 60, tickUpper: TICK + 60, liquidity: 10n ** 15n }
    for (const pos of [{ ...RANGE, liquidity: 10n ** 12n }, narrow]) {
      const r = await engineAt({ pos }).prepareCalls({ ...rerangeP, liquidity: pos.liquidity }, 100n, 1_000n, v4s)
      expect(r.calls.map((c) => decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: c.callData }).functionName)).toEqual(['decreaseLiquidity', 'collect', 'burn'])
      const d = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: r.calls[0]!.callData }).args![0] as { amount0Min: bigint; amount1Min: bigint }
      const engine = decreaseMins({ twapTick: TICK, band: engineBand(BAND), tickLower: pos.tickLower, tickUpper: pos.tickUpper, liquidity: pos.liquidity })
      const policy = decreaseMins({ twapTick: TICK, band: BAND, tickLower: pos.tickLower, tickUpper: pos.tickUpper, liquidity: pos.liquidity })
      expect(d.amount0Min).toBeGreaterThanOrEqual(engine.amount0Min)
      expect(d.amount1Min).toBeGreaterThanOrEqual(engine.amount1Min)
      expect(d.amount0Min).toBeGreaterThanOrEqual(policy.amount0Min)
      expect(d.amount1Min).toBeGreaterThanOrEqual(policy.amount1Min)
      expect(check(v4s, r.calls)).toMatchObject({ ok: true })
    }
    await expect(engineAt({ admitted: '0x0000000000000000000000000000000000000000' }).prepareCalls(reduceP, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'POLICY_DENIED_POSITION' })
    await expect(engineAt({ spot: TICK + engineBand(BAND) + 1 }).prepareCalls(reduceP, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'EHG_PRICE_DIVERGENCE' })
  })

  test('nothing is built while the guardian has paused the account', async () => {
    for (const p of [sellWeth, mintP, increaseP, rerangeP]) await expect(engineAt({ paused: true, quote: QUOTE_SELL }).prepareCalls(p, 100n, 1_000n, v4s)).rejects.toMatchObject({ code: 'SESSION_REVOKED' })
  })

  test('the simulation of an increase must move no NFT and take no more than the desired amounts', () => {
    const e = engineAt()
    const ok = { nftDelta: 0n, deltas: { WETH: -(10n ** 15n), USDC: -3_900_000n } }
    expect(e.deltaMismatch(increaseP, {}, ok)).toBeNull()
    expect(e.deltaMismatch(increaseP, {}, { ...ok, nftDelta: 1n })).toBe('positions changed by 1, intent 0')
    expect(e.deltaMismatch(increaseP, {}, { ...ok, deltas: { WETH: -(10n ** 15n), USDC: -4_000_001n } })).toContain('USDC moved')
  })

  test('the v4 session holds every call the engine builds, and nothing of a v2 grant name', () => {
    expect(grantKey(V4.session.grants[2]!)).toBe(`engine:${POOL}`)
    expect(v4s.grant.actionPolicy?.address).toBe(POLICY)
  })
})
