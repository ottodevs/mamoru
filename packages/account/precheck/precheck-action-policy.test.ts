// Spec 007 (otto/mamoru#151), task T4: proves `precheck` itself — not just the pure mirror (action-policy.test.ts)
// — refuses a v4 swap outside MamoruActionPolicy's band/budget using a real `instantiateGrant`/`retargetToPolicy`
// grant and the `SessionLedger` wiring the engine (packages/scenarios/driver/engine.ts) uses, and that a v2 grant
// (no action-policy pool watched) is byte-for-byte unaffected — the "v2 unchanged" proof this unit's report asks
// for, at the precheck layer.
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, entry } from '@mamoru/registry'
import { computeCaps, conservadorLabV1, conservadorLabV4, instantiateGrant, retargetToPolicy, V4_POOLS, withActionPolicy, type Price } from '@mamoru/policy'
import { approve, decreaseLiquidity, exactInputSingle, type V3Call } from '@mamoru/uniswap-v3'
import { swapBoundsAtBand } from '@mamoru/uniswap-v3/policy-bounds'
import { executeCallData, useModeSignature } from '../sessions/index.ts'
import type { Execution } from '../safe/index.ts'
import { SessionLedger, precheck, type ActionPolicyPoolConfig } from './index.ts'

const ACCOUNT: Address = '0x00000000000000000000000000000000000000a1'
const SESSION_KEY: Address = '0x00000000000000000000000000000000000000bb'
const MAMORU_POLICY: Address = '0x00000000000000000000000000000000000000fe'
const PID = `0x${'44'.repeat(32)}` as Hex
const NOW = 1_790_411_347
const POOL = V4_POOLS.btc.pool

const prices: Record<string, Price> = { USDT: { num: 1n, den: 1n }, cbBTC: { num: 1n, den: 100_000n }, WETH: { num: 1n, den: 3_000n } }
const caps = computeCaps(conservadorLabV4, 10_000n * 1_000_000n, prices)
const grantCtx = { account: ACCOUNT, sessionKey: SESSION_KEY, chainId: 31337, salt: PID, validAfter: NOW - 60, validUntil: NOW + 3600, caps }
const swapGrant = retargetToPolicy(instantiateGrant(conservadorLabV4, `enter-swap:${POOL}`, grantCtx), MAMORU_POLICY)
const SIG = useModeSignature(PID, `0x${'22'.repeat(65)}`)
const enginePolicy = withActionPolicy(conservadorLabV4, MAMORU_POLICY, [V4_POOLS.btc], { caps })
const apConfig: ActionPolicyPoolConfig = (() => {
  const e = entry(POOL)
  const budget = enginePolicy.actionPolicy!.budgetsByPool![POOL]!
  return { pool: POOL, address: MAMORU_POLICY, token0: address(e.token0!), token1: address(e.token1!), feePips: e.fee!, bandTicks: enginePolicy.actionPolicy!.bandTicksByPool[POOL]!, budgetWindowSeconds: budget.windowSeconds, perWindow0: budget.perWindow0, perWindow1: budget.perWindow1, total0: budget.total0, total1: budget.total1 }
})()

function exec(c: V3Call): Execution {
  return { target: c.to, value: c.value, callData: c.data }
}

function ledgerWithActionPolicy(): SessionLedger {
  const l = new SessionLedger()
  l.activate(PID, swapGrant)
  l.watchActionPolicyPool(apConfig)
  l.syncActionPolicyReads(POOL, { twapTick: 0, spend: { epoch: 0n, generation: 1n, window0: 0n, window1: 0n, total0: 0n, total1: 0n }, currentGeneration: 1n })
  return l
}

function run(calls: Execution[], ledger: SessionLedger) {
  const r = precheck({ sender: ACCOUNT, callData: executeCallData(calls), signature: SIG }, { chainId: 31337, now: NOW, ledger })
  return r.ok ? 'ACCEPT' : r.code
}

function swapCalls(amountIn: bigint, amountOutMinimum: bigint, sqrtPriceLimitX96: bigint): Execution[] {
  return [approve('USDC', 'SwapRouter02', amountIn), exactInputSingle({ account: ACCOUNT, tokenIn: 'USDC', tokenOut: 'cbBTC', fee: 500, amountIn, amountOutMinimum, sqrtPriceLimitX96 })].map(exec)
}

describe('precheck wired to MamoruActionPolicy (spec 007 T4)', () => {
  const amountIn = 1_000_000_000n // 1,000 USDC — well inside enter-swap's per-call cap
  const bound = swapBoundsAtBand({ twap: 0, bandTicks: apConfig.bandTicks, feePips: apConfig.feePips, zeroForOne: true, tokenIn: apConfig.token0, tokenOut: apConfig.token1, amountIn })

  test('a swap within the band and budget passes grant rules AND the action-policy mirror', () => {
    expect(run(swapCalls(amountIn, bound.minOut, bound.sqrtPriceLimitX96), ledgerWithActionPolicy())).toBe('ACCEPT')
  })

  test("today's loose grant shape (minOut=1, limit=0) passes UniActionPolicy-equivalent rules alone, but the action-policy mirror refuses it: POLICY_PRICE_BAND", () => {
    // Sanity: without the action-policy pool watched, this same calldata is accepted (proves the grant-level rules
    // alone do not catch it — exactly the gap spec 007 part 1 describes).
    const ledgerNoPolicy = new SessionLedger()
    ledgerNoPolicy.activate(PID, swapGrant)
    expect(run(swapCalls(amountIn, 1n, 0n), ledgerNoPolicy)).toBe('ACCEPT')
    expect(run(swapCalls(amountIn, 1n, 0n), ledgerWithActionPolicy())).toBe('POLICY_PRICE_BAND')
  })

  test('a batch over the action-policy per-window budget is refused even though every call fits the grant-level caps', () => {
    // At this deposit, the grant's own per-call/cumulative approve+swap caps (stableSwapPerCall 4,000, stableSwapTotal
    // 8,000 USDC) are LOOSER than MamoruActionPolicy's own per-window budget (4,000 USDC, W_p = 1xC_p): two calls of
    // exactly the per-call cap pass every grant-level rule (4,000 + 4,000 = 8,000 <= stableSwapTotal), but the second
    // pushes the action-policy window to 8,000 > its 4,000 cap.
    const atCap = apConfig.perWindow0 // 4,000 USDC: equals the grant's own stableSwapPerCall cap at this deposit
    const b = swapBoundsAtBand({ twap: 0, bandTicks: apConfig.bandTicks, feePips: apConfig.feePips, zeroForOne: true, tokenIn: apConfig.token0, tokenOut: apConfig.token1, amountIn: atCap })
    const oneSwap = swapCalls(atCap, b.minOut, b.sqrtPriceLimitX96)
    const ledger = ledgerWithActionPolicy()
    expect(run(oneSwap, ledger)).toBe('ACCEPT') // first call alone: exactly at both caps, passes
    expect(run([...oneSwap, ...oneSwap], ledger)).toBe('POLICY_BUDGET') // the second call in the same batch pushes the window over
  })

  test('decrease/collect/burn on a position never admitted through the policy is refused: POLICY_NOT_ADMITTED', () => {
    const manageGrant = retargetToPolicy(instantiateGrant(conservadorLabV4, `manage-any:${POOL}`, grantCtx), MAMORU_POLICY)
    const ledger = new SessionLedger()
    ledger.activate(PID, manageGrant)
    ledger.watchActionPolicyPool(apConfig)
    ledger.syncActionPolicyReads(POOL, { twapTick: 0, spend: { epoch: 0n, generation: 1n, window0: 0n, window1: 0n, total0: 0n, total1: 0n }, currentGeneration: 1n })
    const calls = [exec(decreaseLiquidity({ tokenId: 999n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 9_999_999_999n }))]
    expect(run(calls, ledger)).toBe('POLICY_NOT_ADMITTED')
    ledger.admitTokenId(999n, POOL)
    expect(run(calls, ledger)).toBe('ACCEPT')
  })
})

describe('v2 grants (no actionPolicy ever watched) are unaffected', () => {
  test('conservadorLabV1 grants carry no pool-level action-policy coverage: precheck behaves exactly as before T4', () => {
    const grant = instantiateGrant(conservadorLabV1, 'enter-swap', { account: ACCOUNT, sessionKey: SESSION_KEY, chainId: 31337, salt: PID, validAfter: NOW - 60, validUntil: NOW + 3600, caps: { usdcSwapPerCall: 2_500_000_000n, usdcSwapTotal: 5_000_000_000n, usdcMint: 5_000_000_000n, cbbtcMint: 3_000_000n, cbbtcConvertPerCall: 3_000_000n, cbbtcConvertTotal: 3_000_000n } })
    const ledger = new SessionLedger()
    ledger.activate(PID, grant)
    // Even if some OTHER pool is watched, a grant whose own `pool` is undefined/different never consults it.
    ledger.watchActionPolicyPool(apConfig)
    const calls = [exec(approve('USDC', 'SwapRouter02', 1_000_000_000n))]
    expect(run(calls, ledger)).toBe('ACCEPT')
  })
})
