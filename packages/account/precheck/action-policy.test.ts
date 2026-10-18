// Spec 007 (otto/mamoru#151), tasks T4 and T6: unit tests of `checkActionPolicyCall` (action-policy.ts) — the pure
// mirror of MamoruActionPolicy.checkAction's refusal classes. Calldata is built with the SAME helpers
// (`@mamoru/uniswap-v3`) and ABIs (`@mamoru/registry`) the engine itself uses, and swap bounds with the SAME
// `priceRange`/`swapBoundsInRange` port the engine uses, so a passing case here is a passing case for the real engine wiring too — the
// fork scenario (packages/scenarios/action-policy/t4-fork.ts) cross-checks the same three classes against the
// deployed contract.
import { describe, expect, test } from 'bun:test'
import { encodeFunctionData } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, entry, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import { burn, collect, decreaseLiquidity, exactInputSingle, type V3Call } from '@mamoru/uniswap-v3'
import { budgetValue, priceRange, swapBoundsInRange, type OracleRead } from '@mamoru/uniswap-v3/policy-bounds'
import type { Execution } from '../safe/index.ts'
import { checkActionPolicyCall, type ActionPolicyPoolConfig, type ActionPolicyReads, type ActionPolicySpendAcc } from './action-policy.ts'

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1'
const MAMORU_POLICY: Address = '0x00000000000000000000000000000000000000fe'
const POOL = 'pool:USDC/cbBTC/500'
const NOW = 0
const e = entry(POOL)

const cfg: ActionPolicyPoolConfig = {
  pool: POOL,
  address: MAMORU_POLICY,
  token0: address(e.token0!),
  token1: address(e.token1!),
  feePips: e.fee!,
  bandTicks: 100,
  budgetIn1: false, // USDC is token0
  budgetWindowSeconds: 86_400,
  perWindow: 60_000_000_000n, // 60,000 USDC of value
  total: 180_000_000_000n,
}

// Tick 0: 1 raw cbBTC unit is worth 1 raw USDC unit, so values below are easy to read.
const flat: OracleRead = { twapLong: 0, twapShort: 0 }
const emptySpend = { generation: 1n, updatedAt: 0n, in1: false, debt: 0n, total: 0n }
const baseReads: ActionPolicyReads = { oracle: flat, spend: emptySpend, currentGeneration: 1n }
const range = priceRange(flat, cfg.bandTicks)!

function toExecution(c: V3Call): Execution {
  return { target: c.to, value: c.value, callData: c.data }
}

function never(): boolean {
  return false
}

describe('(a) price band', () => {
  const amountIn = 10_000_000_000n // 10,000 USDC
  const bound = swapBoundsInRange({ range, feePips: cfg.feePips, zeroForOne: true, tokenIn: cfg.token0, tokenOut: cfg.token1, amountIn })

  test('a minimum/limit at the full-band edge passes and charges the budget', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }))
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res.ok).toBe(true)
    expect(acc.get(POOL)).toBe(amountIn)
  })

  test("today's grant shape (amountOutMinimum=1, sqrtPriceLimitX96=0) is refused: POLICY_PRICE_BAND", () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }))
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
  })

  test('a minimum one unit under the band edge is refused', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: bound.minOut - 1n, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }))
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
  })

  test('a limit past the band edge is refused even with a compliant minimum', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 - 1n }))
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
  })

  test('T6 H-1: a recent push that moves the short TWAP 2 x band from the long one refuses the swap', () => {
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }))
    const res = checkActionPolicyCall(call, cfg, { ...baseReads, oracle: { twapLong: -100, twapShort: -600 } }, NOW, new Map(), never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
  })

  test('T6 H-1: an anchored pool (stables) never prices past the anchor, however far both TWAPs moved', () => {
    const anchored: ActionPolicyPoolConfig = { ...cfg, bandTicks: 10, anchor: { tick: 0, band: 40 } }
    const pushed = { twapLong: -36, twapShort: -36 } // unclipped floor would be -45
    const atPushed = swapBoundsInRange({ range: { lo: -45, hi: -26 }, feePips: cfg.feePips, zeroForOne: true, tokenIn: cfg.token0, tokenOut: cfg.token1, amountIn })
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: atPushed.minOut, sqrtPriceLimitX96: atPushed.sqrtPriceLimitX96 }))
    expect(checkActionPolicyCall(call, anchored, { ...baseReads, oracle: pushed }, NOW, new Map(), never)).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
    expect(checkActionPolicyCall(call, anchored, { ...baseReads, oracle: { twapLong: -86, twapShort: -86 } }, NOW, new Map(), never)).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
  })

  test('T6 M-1: the safer of the two TWAPs sets the edge (a lagging long TWAP does not loosen it)', () => {
    // Market moved up: short 60 ticks above long. Selling token0, the floor follows the short TWAP.
    const moved = { ...flat, twapLong: 0, twapShort: 60 }
    const r = priceRange(moved, cfg.bandTicks)!
    expect(r).toEqual({ lo: 60 - 100 + 1, hi: 0 + 100 })
    const atLong = swapBoundsInRange({ range: { lo: -100, hi: 100 }, feePips: cfg.feePips, zeroForOne: true, tokenIn: cfg.token0, tokenOut: cfg.token1, amountIn })
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: atLong.minOut, sqrtPriceLimitX96: atLong.sqrtPriceLimitX96 }))
    expect(checkActionPolicyCall(call, cfg, { ...baseReads, oracle: moved }, NOW, new Map(), never)).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
    // TWAPs more than ~2 x band apart: no range at all.
    expect(priceRange({ ...flat, twapShort: 200 }, cfg.bandTicks)).toBeNull()
  })

  test('no oracle/spend read for the pool fails closed', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }))
    const res = checkActionPolicyCall(call, cfg, undefined, NOW, acc, never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
  })
})

describe('(b) positions', () => {
  const mintArgs = { token0: cfg.token0, token1: cfg.token1, fee: cfg.feePips, tickLower: -1000, tickUpper: 1000, amount0Desired: 1_000_000_000n, amount1Desired: 1_000_000n, amount0Min: 1n, amount1Min: 1n, recipient: ACCOUNT, deadline: 9_999_999_999n }
  const mintData = encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [mintArgs] })

  test('mint to the manager directly (not through the policy) is refused: POLICY_NOT_ADMITTED', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call: Execution = { target: address('NonfungiblePositionManager'), value: 0n, callData: mintData }
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_NOT_ADMITTED' })
  })

  test('mint through the policy, matching token0/token1/fee, passes and charges the budget', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call: Execution = { target: MAMORU_POLICY, value: 0n, callData: mintData }
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res.ok).toBe(true)
    // T6 M-2: one value, both tokens summed (cbBTC valued at the range's lo edge, in USDC).
    const value = budgetValue({ range, in1: false, token0: cfg.token0, token1: cfg.token1, amount0: mintArgs.amount0Desired, amount1: mintArgs.amount1Desired })
    expect(acc.get(POOL)).toBe(value)
    expect(value - mintArgs.amount0Desired).toBeGreaterThan(mintArgs.amount1Desired) // lo = -99: cbBTC valued at its highest
  })

  test('a decrease is refused when the range is empty (its minimums are priced)', () => {
    const isAdmitted = (tokenId: bigint) => tokenId === 42n
    const call = toExecution(decreaseLiquidity({ tokenId: 42n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 9_999_999_999n }))
    const res = checkActionPolicyCall(call, cfg, { ...baseReads, oracle: { twapLong: 0, twapShort: 300 } }, NOW, new Map(), isAdmitted)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_PRICE_BAND' })
  })

  test('mint through the policy for the wrong pool/fee is refused', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const wrongFee = encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [{ ...mintArgs, fee: 3000 }] })
    const call: Execution = { target: MAMORU_POLICY, value: 0n, callData: wrongFee }
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_NOT_ADMITTED' })
  })

  test('decrease/collect/burn on a tokenId the caller does not admit is refused: POLICY_NOT_ADMITTED', () => {
    const acc: ActionPolicySpendAcc = new Map()
    for (const call of [toExecution(decreaseLiquidity({ tokenId: 42n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 9_999_999_999n })), toExecution(collect({ account: ACCOUNT, tokenId: 42n })), toExecution(burn(42n))]) {
      const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
      expect(res).toMatchObject({ ok: false, code: 'POLICY_NOT_ADMITTED' })
    }
  })

  test('decrease/collect/burn on an admitted tokenId passes (no budget charge)', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const isAdmitted = (tokenId: bigint) => tokenId === 42n
    for (const call of [toExecution(decreaseLiquidity({ tokenId: 42n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 9_999_999_999n })), toExecution(collect({ account: ACCOUNT, tokenId: 42n })), toExecution(burn(42n))]) {
      const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, isAdmitted)
      expect(res.ok).toBe(true)
    }
    expect(acc.size).toBe(0) // decrease/collect/burn never draw on the budget, only swap and mint do
  })
})

describe('(c) budgets', () => {
  const amountIn = 25_000_000_000n // 25,000 USDC; the bucket holds 60,000
  const bound = swapBoundsInRange({ range, feePips: cfg.feePips, zeroForOne: true, tokenIn: cfg.token0, tokenOut: cfg.token1, amountIn })
  const swapCall = () => toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }))

  test('a batch of three 25,000 USDC swaps (75,000 total) in one window (budget 60,000): the third is refused', () => {
    const acc: ActionPolicySpendAcc = new Map()
    expect(checkActionPolicyCall(swapCall(), cfg, baseReads, NOW, acc, never).ok).toBe(true)
    expect(checkActionPolicyCall(swapCall(), cfg, baseReads, NOW, acc, never).ok).toBe(true)
    expect(checkActionPolicyCall(swapCall(), cfg, baseReads, NOW, acc, never)).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
  })

  test('T6 L-5: a generation rollover resets the approval total but carries the bucket', () => {
    const nearlyFull: ActionPolicyReads = { ...baseReads, spend: { ...emptySpend, debt: 59_000_000_000n, total: 179_000_000_000n }, currentGeneration: 2n }
    expect(checkActionPolicyCall(swapCall(), cfg, nearlyFull, NOW, new Map(), never)).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
    const drained: ActionPolicyReads = { ...baseReads, spend: { ...emptySpend, debt: 0n, total: 179_000_000_000n }, currentGeneration: 2n }
    expect(checkActionPolicyCall(swapCall(), cfg, drained, NOW, new Map(), never).ok).toBe(true)
  })

  test('T6 M-3: the bucket refills perWindow/window per second, never a whole window at a boundary', () => {
    const spent: ActionPolicyReads = { ...baseReads, spend: { ...emptySpend, updatedAt: 1_000n, debt: 60_000_000_000n, total: 60_000_000_000n } }
    // Two seconds later: 2/86,400 of 60,000 USDC is back (1.388888 USDC), not 60,000.
    expect(checkActionPolicyCall(swapCall(), cfg, spent, 1_002, new Map(), never)).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
    // 10 h later: 25,000 back (60,000 x 36,000 / 86,400), exactly one swap.
    expect(checkActionPolicyCall(swapCall(), cfg, spent, 1_000 + 36_000, new Map(), never).ok).toBe(true)
    expect(checkActionPolicyCall(swapCall(), cfg, spent, 1_000 + 35_999, new Map(), never)).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
  })

  test('the approval total holds whatever the bucket says', () => {
    const late: ActionPolicyReads = { ...baseReads, spend: { ...emptySpend, updatedAt: 0n, debt: 0n, total: 170_000_000_000n } }
    expect(checkActionPolicyCall(swapCall(), cfg, late, 10 * 86_400, new Map(), never)).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
  })

  test('T6 M-2: a round trip draws both legs on the one budget', () => {
    const acc: ActionPolicySpendAcc = new Map()
    expect(checkActionPolicyCall(swapCall(), cfg, baseReads, NOW, acc, never).ok).toBe(true)
    const back = swapBoundsInRange({ range, feePips: cfg.feePips, zeroForOne: false, tokenIn: cfg.token1, tokenOut: cfg.token0, amountIn: 36_000_000_000n })
    const leg2 = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'cbBTC', tokenOut: 'USDC', fee: 500, amountIn: 36_000_000_000n, amountOutMinimum: back.minOut, sqrtPriceLimitX96: back.sqrtPriceLimitX96 }))
    // 25,000 + 36,000 x 1.0001^99 (cbBTC valued at lo = -99) > 60,000; with one budget per token both legs passed.
    expect(checkActionPolicyCall(leg2, cfg, baseReads, NOW, acc, never)).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
  })

  test('no spend read for a mint fails closed: POLICY_BUDGET', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const mintData = encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'mint', args: [{ token0: cfg.token0, token1: cfg.token1, fee: cfg.feePips, tickLower: -1000, tickUpper: 1000, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 1n, amount1Min: 1n, recipient: ACCOUNT, deadline: 9_999_999_999n }] })
    const call: Execution = { target: MAMORU_POLICY, value: 0n, callData: mintData }
    const res = checkActionPolicyCall(call, cfg, undefined, NOW, acc, never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
  })
})

describe('calls outside this mirror', () => {
  test('an approve is left to the grant-level rules (never denied here)', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call: Execution = { target: cfg.token0, value: 0n, callData: encodeFunctionData({ abi: [{ type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], functionName: 'approve', args: [MAMORU_POLICY, 1n] }) }
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res.ok).toBe(true)
  })
})
