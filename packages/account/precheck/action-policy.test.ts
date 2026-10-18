// Spec 007 (otto/mamoru#151), task T4: unit tests of `checkActionPolicyCall` (action-policy.ts) — the pure mirror
// of MamoruActionPolicy.checkAction's three refusal classes. Calldata is built with the SAME helpers
// (`@mamoru/uniswap-v3`) and ABIs (`@mamoru/registry`) the engine itself uses, and swap bounds with the SAME
// `swapBoundsAtBand` port T3 added, so a passing case here is a passing case for the real engine wiring too — the
// fork scenario (packages/scenarios/action-policy/t4-fork.ts) cross-checks the same three classes against the
// deployed contract.
import { describe, expect, test } from 'bun:test'
import { encodeFunctionData } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, entry, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import { burn, collect, decreaseLiquidity, exactInputSingle, type V3Call } from '@mamoru/uniswap-v3'
import { swapBoundsAtBand } from '@mamoru/uniswap-v3/policy-bounds'
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
  budgetWindowSeconds: 86_400,
  perWindow0: 60_000_000_000n, // 60,000 USDC
  perWindow1: 60_000_000n, // 0.6 cbBTC
  total0: 180_000_000_000n,
  total1: 180_000_000n,
}

const baseReads: ActionPolicyReads = { twapTick: 0, spend: { epoch: 0n, generation: 1n, window0: 0n, window1: 0n, total0: 0n, total1: 0n }, currentGeneration: 1n }

function toExecution(c: V3Call): Execution {
  return { target: c.to, value: c.value, callData: c.data }
}

function never(): boolean {
  return false
}

describe('(a) price band', () => {
  const amountIn = 10_000_000_000n // 10,000 USDC
  const bound = swapBoundsAtBand({ twap: 0, bandTicks: cfg.bandTicks, feePips: cfg.feePips, zeroForOne: true, tokenIn: cfg.token0, tokenOut: cfg.token1, amountIn })

  test('a minimum/limit at the full-band edge passes and charges the budget', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const call = toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }))
    const res = checkActionPolicyCall(call, cfg, baseReads, NOW, acc, never)
    expect(res.ok).toBe(true)
    expect(acc.get(POOL)).toEqual({ a0: amountIn, a1: 0n })
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

  test('no TWAP/spend read for the pool fails closed', () => {
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
    expect(acc.get(POOL)).toEqual({ a0: mintArgs.amount0Desired, a1: mintArgs.amount1Desired })
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
  const amountIn = 25_000_000_000n // 25,000 USDC; perWindow0 is 60,000
  const bound = swapBoundsAtBand({ twap: 0, bandTicks: cfg.bandTicks, feePips: cfg.feePips, zeroForOne: true, tokenIn: cfg.token0, tokenOut: cfg.token1, amountIn })
  const swapCall = () => toExecution(exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum: bound.minOut, sqrtPriceLimitX96: bound.sqrtPriceLimitX96 }))

  test('a batch of three 25,000 USDC swaps (75,000 total) in one window (budget 60,000): the third is refused', () => {
    const acc: ActionPolicySpendAcc = new Map()
    expect(checkActionPolicyCall(swapCall(), cfg, baseReads, NOW, acc, never).ok).toBe(true)
    expect(checkActionPolicyCall(swapCall(), cfg, baseReads, NOW, acc, never).ok).toBe(true)
    expect(checkActionPolicyCall(swapCall(), cfg, baseReads, NOW, acc, never)).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
  })

  test('a generation rollover zeroes a stale Spend read, even a near-exhausted one', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const staleGen: ActionPolicyReads = { twapTick: 0, spend: { epoch: 0n, generation: 1n, window0: 59_000_000_000n, window1: 0n, total0: 179_000_000_000n, total1: 0n }, currentGeneration: 2n }
    expect(checkActionPolicyCall(swapCall(), cfg, staleGen, NOW, acc, never).ok).toBe(true)
  })

  test('an epoch rollover resets the window but keeps the approval total (same generation)', () => {
    const acc: ActionPolicySpendAcc = new Map()
    const staleEpoch: ActionPolicyReads = { twapTick: 0, spend: { epoch: 0n, generation: 1n, window0: 59_000_000_000n, window1: 0n, total0: 170_000_000_000n, total1: 0n }, currentGeneration: 1n }
    const nextEpoch = cfg.budgetWindowSeconds // a new window has started; total0 170,000 + 25,000 = 195,000 > 180,000 cap
    const res = checkActionPolicyCall(swapCall(), cfg, staleEpoch, nextEpoch, acc, never)
    expect(res).toMatchObject({ ok: false, code: 'POLICY_BUDGET' })
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
