// Spec 007 (otto/mamoru#151), task T3. Proves two things about `Engine.prepareCalls`
// (packages/scenarios/driver/engine.ts):
// - a policy with no `actionPolicy` (every live policy today, `POLICIES['conservador-live-v2']` here) builds the
//   same calls as before this unit: `sqrtPriceLimitX96` zero, minimums from the usual slippage/quote math only,
//   mint and its approvals targeting the NonfungiblePositionManager.
// - a policy that carries one (`withActionPolicy`, test-only `conservadorLabV4` here) wires its pool's band into
//   `@mamoru/uniswap-v3/policy-bounds`'s `priceRange`/`swapBoundsInRange`/`decreaseMinsInRange` correctly (T6:
//   both TWAPs from one observe, the stables anchor): the right range, token
//   ordering and narrowed `bandTicks`, "take the max" against the usual minimum, and mint/approvals retargeted to
//   the deployed policy address.
// `prepareCalls` is private; tests reach it the same way review-requests.test.ts reaches `journal.ops` — a cast,
// not a design change.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, toFunctionSelector, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import type { Proposal } from '@mamoru/decide'
import { POLICIES, conservadorLabV4, withActionPolicy, V4_POOLS, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { address, erc20Abi, nonfungiblePositionManagerAbi, swapRouter02Abi } from '@mamoru/registry'
import type { Execution } from '@mamoru/account/safe'
import { amountsForLiquidityAtPrice, decreaseMinsInRange, narrowBand, priceRange, swapBoundsInRange } from '@mamoru/uniswap-v3/policy-bounds'
import { FakeChain } from '../../rpc/test/fake-chain.ts'
import { Engine, type EngineSession } from './engine.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const POOL = 'pool:USDC/cbBTC/500'
const MAMORU_POLICY: Address = '0x00000000000000000000000000000000000000b1' as Address
const sessionKey = privateKeyToAccount(generatePrivateKey())

type Prepared = { calls: Execution[]; quote?: { amountIn: bigint; amountOut: bigint; amountOutMinimum: bigint } }
type PrepareCalls = (p: Proposal, blockNumber: bigint, timestamp: bigint, s: EngineSession) => Promise<Prepared>

/**
 * otto/mamoru#140 added a 4th `session` argument to `prepareCalls` (the swap-deadline/expiry leg, `swapExpiry`),
 * which only reads `session.grant.actions` (for `grantHasSwapDeadline`) and `session.grant.userOp.validUntil`. A
 * plain, on-chain-expiry-less grant (no SwapRouter02 multicall-deadline action) is enough for these T3 band-math
 * tests — built by hand, not `instantiateGrant`, since `conservadorLabV4` is chain `'fork'` and this fixture's
 * `Engine` always signs as chain 8453 (`FORBIDDEN_LAB_CHAIN_IDS` refuses a lab policy's grant at that chain id).
 */
function session(grantName: string): EngineSession {
  const grant: SessionGrant = {
    policyId: 'test', policyHash: `0x${'00'.repeat(32)}`, name: grantName as SessionGrant['name'], salt: `0x${'02'.repeat(32)}`, chainId: 8453, account: ACCOUNT,
    sessionValidator: 'OwnableValidator', sessionKey: sessionKey.address,
    userOp: { validAfter: 0, validUntil: 2_000_000_000, usageLimit: 100 },
    permitERC4337Paymaster: false, erc7739: 'none', fallbackAction: 'none', actions: [],
  }
  return { name: grantName, grant, permissionId: `0x${'00'.repeat(32)}` }
}

function prepare(e: Engine, p: Proposal, blockNumber: bigint, timestamp: bigint, s: EngineSession): Promise<Prepared> {
  return (e as unknown as { prepareCalls: PrepareCalls }).prepareCalls(p, blockNumber, timestamp, s)
}

async function withEngine<T>(policy: PolicyVersion, fn: (e: Engine, chain: FakeChain) => Promise<T>): Promise<T> {
  const chain = new FakeChain()
  chain.code.set(ACCOUNT.toLowerCase(), '0x6001')
  const rpc = chain.serve()
  try {
    const e = new Engine(
      { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: rpc.url, bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 800n, historyFromBlock: 800n, sessions: [] },
      { waitBlock: async () => {} },
    )
    return await fn(e, chain)
  } finally {
    rpc.stop()
  }
}

// FakeChain's `observe` answers a tick cumulative that falls linearly by 1805*i over 1,800 s, i = the pool's index
// in the registry + 1 (see fake-chain.ts). At `pool:USDC/cbBTC/500` (index 0) both the 1,800 s and the 300 s
// window read tick -2 — the same floor-rounding `poolTwapTick` and the real `OracleLibrary.consult` both apply.
const FAKE_TWAP_TICK = -2
const fakeRange = (bandTicks: number) => priceRange({ twapLong: FAKE_TWAP_TICK, twapShort: FAKE_TWAP_TICK }, bandTicks, V4_POOLS.btc.anchor)!
const OBSERVE_SELECTOR = toFunctionSelector('observe(uint32[])')

function observeCalls(chain: FakeChain): number {
  return chain.requests.filter((r) => r.method === 'eth_call' && typeof r.params[0]?.data === 'string' && (r.params[0].data as Hex).startsWith(OBSERVE_SELECTOR)).length
}

describe('prepareCalls: enter_swap', () => {
  const proposal: Proposal = { kind: 'enter_swap', grant: 'enter-swap', pool: POOL, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn: 10_000_000_000n }

  test('v2 (no actionPolicy): unchanged — sqrtPriceLimitX96 zero, minimum from slippage on the live quote only, one observe call', async () => {
    const policy = POLICIES['conservador-live-v2']!
    await withEngine(policy, async (e, chain) => {
      const prepared = await prepare(e, proposal, chain.head, 1_790_000_000n + chain.head * 2n, session(proposal.grant))
      expect(prepared.calls).toHaveLength(2)
      const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: prepared.calls[1]!.callData })
      const params = decoded.args[0] as { sqrtPriceLimitX96: bigint; amountOutMinimum: bigint }
      expect(params.sqrtPriceLimitX96).toBe(0n)
      // FakeChain's QuoterV2 default: amountOut = amountIn (1:1); minOut = amountOut * (10000 - slippageBps) / 10000.
      const expectedMinOut = (10_000_000_000n * BigInt(10_000 - policy.execution.slippageBps)) / 10_000n
      expect(params.amountOutMinimum).toBe(expectedMinOut)
      expect(prepared.quote!.amountOutMinimum).toBe(expectedMinOut)
      // otto/mamoru#140: `swapMin` always runs the price-divergence guard (one `observe`), no depth/actionPolicy
      // needed for that; no SECOND observe for depth sizing or v4 band math, since neither applies here.
      expect(observeCalls(chain)).toBe(1)
    })
  })

  test('v4 (actionPolicy set for this pool): bounds from swapBoundsInRange at the narrowed band, taking the max over the usual minimum, one observe', async () => {
    const policy = withActionPolicy(conservadorLabV4, MAMORU_POLICY, [V4_POOLS.btc]) // default bandFactorBps (0.8x)
    await withEngine(policy, async (e, chain) => {
      // A bad-but-not-divergent live quote (as a pushed spot would give): bad enough that the usual slippage-only
      // minimum undershoots the policy's own (narrower) band, but not so bad that otto/mamoru#140's own TWAP-
      // deviation guard in `swapMin` refuses the op outright (that guard's wider `maxTwapDeviationTicks` tolerance
      // is unrelated to this pool's tighter `bandTicks`) — the policy's TWAP-anchored bound must still win ("take
      // the max of minimums, the tighter limit" — spec 007 T3).
      chain.quoteAmountOut = () => 9_900_000_000n
      const prepared = await prepare(e, proposal, chain.head, 1_790_000_000n + chain.head * 2n, session(proposal.grant))
      const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: prepared.calls[1]!.callData })
      const params = decoded.args[0] as { sqrtPriceLimitX96: bigint; amountOutMinimum: bigint }
      const bandTicks = narrowBand(V4_POOLS.btc.bandTicks) // default factor, same one the engine applies
      const expected = swapBoundsInRange({ range: fakeRange(bandTicks), feePips: 500, zeroForOne: true, tokenIn: address('USDC'), tokenOut: address('cbBTC'), amountIn: 10_000_000_000n })
      expect(observeCalls(chain)).toBe(1) // both TWAPs in one observe([1800, 300, 0])
      expect(params.sqrtPriceLimitX96).toBe(expected.sqrtPriceLimitX96)
      expect(params.sqrtPriceLimitX96).not.toBe(0n)
      expect(params.amountOutMinimum).toBe(expected.minOut)
      expect(prepared.quote!.amountOutMinimum).toBe(expected.minOut)
      // The bound dominated the (bad-quote) usual minimum.
      const usual = (9_900_000_000n * BigInt(10_000 - policy.execution.slippageBps)) / 10_000n
      expect(expected.minOut).toBeGreaterThan(usual)
    })
  })

  test('T6 H-1: a range outside the pool\'s anchor is refused before any call is built', async () => {
    // FakeChain's TWAPs read tick -2 here; an anchor at +1000 +- 40 leaves no range.
    const anchored = withActionPolicy(conservadorLabV4, MAMORU_POLICY, [{ ...V4_POOLS.btc, anchor: { tick: 1000, band: 40 } }])
    await withEngine(anchored, async (e, chain) => {
      await expect(prepare(e, proposal, chain.head, 1_790_000_000n + chain.head * 2n)).rejects.toMatchObject({ code: 'POLICY_PRICE_BAND' })
    })
  })

  test('a pool not listed in actionPolicy.bandTicksByPool falls back to today\'s calls (fail safe)', async () => {
    const policy = withActionPolicy(conservadorLabV4, MAMORU_POLICY, [V4_POOLS.stables]) // btc pool not listed
    await withEngine(policy, async (e, chain) => {
      const prepared = await prepare(e, proposal, chain.head, 1_790_000_000n + chain.head * 2n, session(proposal.grant))
      const decoded = decodeFunctionData({ abi: swapRouter02Abi, data: prepared.calls[1]!.callData })
      const params = decoded.args[0] as { sqrtPriceLimitX96: bigint }
      expect(params.sqrtPriceLimitX96).toBe(0n)
    })
  })
})

describe('prepareCalls: enter_mint', () => {
  const proposal: Proposal = { kind: 'enter_mint', grant: 'enter-mint', pool: POOL, tickLower: -1000, tickUpper: 1000, amount0Desired: 20_000_000_000n, amount1Desired: 20_000_000n }

  test('v2 (no actionPolicy): approvals and mint target the NonfungiblePositionManager, five calls', async () => {
    const policy = POLICIES['conservador-live-v2']!
    await withEngine(policy, async (e, chain) => {
      const prepared = await prepare(e, proposal, chain.head, 1_790_000_000n + chain.head * 2n, session(proposal.grant))
      expect(prepared.calls).toHaveLength(5)
      for (const c of prepared.calls) expect(c.target.toLowerCase()).not.toBe(MAMORU_POLICY.toLowerCase())
      expect(prepared.calls[2]!.target.toLowerCase()).toBe(address('NonfungiblePositionManager').toLowerCase())
      const mintDecoded = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: prepared.calls[2]!.callData })
      expect(mintDecoded.functionName).toBe('mint')
    })
  })

  test('v4: mint and both approvals target the deployed policy, no trailing zero-approves', async () => {
    const policy = withActionPolicy(conservadorLabV4, MAMORU_POLICY, [V4_POOLS.btc])
    await withEngine(policy, async (e, chain) => {
      const prepared = await prepare(e, proposal, chain.head, 1_790_000_000n + chain.head * 2n, session(proposal.grant))
      expect(prepared.calls).toHaveLength(3) // approve0, approve1, mint — no trailing resets (the pull consumes the allowance in full)
      for (const c of prepared.calls.slice(0, 2)) {
        const d = decodeFunctionData({ abi: erc20Abi, data: c.callData })
        expect(d.functionName).toBe('approve')
        expect((d.args[0] as Address).toLowerCase()).toBe(MAMORU_POLICY.toLowerCase())
      }
      const mintCall = prepared.calls[2]!
      expect(mintCall.target.toLowerCase()).toBe(MAMORU_POLICY.toLowerCase())
      const mintDecoded = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: mintCall.callData })
      expect(mintDecoded.functionName).toBe('mint')
      const params = mintDecoded.args[0] as { recipient: Address; amount0Desired: bigint; amount1Desired: bigint }
      expect(params.recipient.toLowerCase()).toBe(ACCOUNT.toLowerCase())
      expect(params.amount0Desired).toBe(20_000_000_000n)
      expect(params.amount1Desired).toBe(20_000_000n)
    })
  })
})

describe('prepareCalls: rerange / reduce (decreaseLiquidity minimums)', () => {
  const TOKEN_ID = 42n

  test('v2 (no actionPolicy): minimums from the usual slippage math at spot, no oracle read', async () => {
    const policy = POLICIES['conservador-live-v2']!
    await withEngine(policy, async (e, chain) => {
      chain.addPosition(ACCOUNT, TOKEN_ID, POOL)
      const pos = chain.positions.find((p) => p.tokenId === TOKEN_ID)!
      const proposal: Proposal = { kind: 'rerange', grant: 'manage-any', pool: POOL, tokenId: TOKEN_ID, liquidity: pos.liquidity }
      const prepared = await prepare(e, proposal, chain.head, 1_790_000_000n + chain.head * 2n, session(proposal.grant))
      expect(prepared.calls.length).toBe(3) // decrease, collect, burn
      const decreaseDecoded = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: prepared.calls[0]!.callData })
      expect(decreaseDecoded.functionName).toBe('decreaseLiquidity')
      // otto/mamoru#140: `priceGuard`'s divergence check now runs unconditionally for every op that prices a pool
      // (one `observe`); no actionPolicy for this pool means no SECOND observe for the band math (positions + slot0
      // still happen too, for the spot-based minimum).
      expect(observeCalls(chain)).toBe(1)
    })
  })

  test('v4: amount0Min/amount1Min are the max of the usual spot/slippage minimum and decreaseMinsInRange at the narrowed band', async () => {
    const policy = withActionPolicy(conservadorLabV4, MAMORU_POLICY, [V4_POOLS.btc])
    await withEngine(policy, async (e, chain) => {
      chain.addPosition(ACCOUNT, TOKEN_ID, POOL) // fixed fixture range: tickLower -600, tickUpper 600
      const pos = chain.positions.find((p) => p.tokenId === TOKEN_ID)!
      const proposal: Proposal = { kind: 'rerange', grant: 'manage-any', pool: POOL, tokenId: TOKEN_ID, liquidity: pos.liquidity }
      const prepared = await prepare(e, proposal, chain.head, 1_790_000_000n + chain.head * 2n, session(proposal.grant))
      const decreaseDecoded = decodeFunctionData({ abi: nonfungiblePositionManagerAbi, data: prepared.calls[0]!.callData })
      const params = decreaseDecoded.args[0] as { amount0Min: bigint; amount1Min: bigint }
      // Mirrors prepareCalls' own "usual" computation: amountsOf at the fixture's spot sqrtPriceX96 (tick 0's
      // ratio for this pool's index), then the policy's slippageBps.
      const spot = amountsForLiquidityAtPrice(1n << 96n, pos.tickLower, pos.tickUpper, pos.liquidity)
      const slippage = BigInt(10_000 - policy.execution.slippageBps)
      const usual0 = spot.amount0 > 0n ? (spot.amount0 * slippage) / 10_000n : 0n
      const usual1 = spot.amount1 > 0n ? (spot.amount1 * slippage) / 10_000n : 0n
      const bandTicks = narrowBand(V4_POOLS.btc.bandTicks)
      const bound = decreaseMinsInRange({ range: fakeRange(bandTicks), tickLower: pos.tickLower, tickUpper: pos.tickUpper, liquidity: pos.liquidity })
      expect(params.amount0Min).toBe(usual0 > bound.amount0Min ? usual0 : bound.amount0Min)
      expect(params.amount1Min).toBe(usual1 > bound.amount1Min ? usual1 : bound.amount1Min)
      // Sanity: the band math is actually exercised (not a silent no-op) — at least one side differs from the
      // non-v4 (spot-only) minimum computed in the sibling test above.
      expect(bound.amount0Min).toBeGreaterThan(0n)
      expect(bound.amount1Min).toBeGreaterThan(0n)
    })
  })
})
