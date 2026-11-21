import type { ReasonCode } from '@mamoru/domain'
import { hasManageAny, type PolicyVersion } from '@mamoru/policy'
import type { EnterSwapProposal, Observation, ReduceProposal } from '../types.ts'
import { anyKey, convertKey, isManaged, positionValue } from '../rerange/index.ts'
import { inSavings, opCostInSavings, volatileOf } from '../value.ts'

/**
 * otto/mamoru#427: the next step of leaving this chain's pools (`policy.chainExit`, from the engine settings' `chainExit`).
 * One rule, one step per review, through the pool's manage-any session only: first every managed position is taken out
 * in full (decrease, collect and burn, to the Safe), then the volatile token the Safe holds, harvested or not, is sold for
 * the savings asset. The savings stay where they are: an exit never bridges and never transfers. A position worth
 * nothing that still owes tokens is collected and burnt when that is worth its gas; an empty one is left alone. A pool
 * the action policy would refuse every swap in (#401) keeps its token until it would not. Null when the chain is not
 * being left.
 */
export function chainExitStep(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>): { code: ReasonCode; proposal: ReduceProposal | EnterSwapProposal | null } | null {
  if (!policy.chainExit) return null
  if (!hasManageAny(policy)) return { code: 'DECIDE_CHAIN_EXIT_DONE', proposal: null }
  const savings = policy.savingsAsset
  const floor = opCostInSavings(obs, savings) * BigInt(policy.harvest.costFactorBps)
  for (const p of obs.positions) {
    const pool = p.pool ? obs.pools.find((x) => x.name === p.pool) : undefined
    if (!pool || !isManaged(p, policy, policyPools)) continue
    if (p.liquidity === 0n) {
      // `collectable` is what a collect returns now: fees and any principal a past decrease left owed.
      const owed = inSavings(pool, pool.token0, p.collectable0, savings) + inSavings(pool, pool.token1, p.collectable1, savings)
      if (owed * 10_000n <= floor) continue
    }
    return { code: 'DECIDE_CHAIN_EXIT', proposal: { kind: 'reduce', grant: anyKey(policy, 'manage-any', pool.name), pool: pool.name, tokenId: p.tokenId, liquidity: p.liquidity, burn: true } }
  }
  const depthHeld = new Set((obs.depthShort ?? []).map((d) => d.pool))
  let held = false
  for (const pool of obs.pools) {
    if (!policyPools.has(pool.name)) continue
    const volatile = volatileOf(pool, savings)
    const amount = obs.balances[volatile] ?? 0n
    if (amount === 0n || inSavings(pool, volatile, amount, savings) * 10_000n <= floor) continue
    if (depthHeld.has(pool.name)) {
      held = true
      continue
    }
    return { code: 'DECIDE_CHAIN_EXIT', proposal: { kind: 'enter_swap', grant: convertKey(policy, pool.name), pool: pool.name, tokenIn: volatile, tokenOut: savings, fee: pool.fee, amountIn: amount } }
  }
  return { code: held ? 'REMOTE_DEPTH_BELOW_BUDGET' : 'DECIDE_CHAIN_EXIT_DONE', proposal: null }
}
