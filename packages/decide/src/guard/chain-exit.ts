import type { ReasonCode } from '@mamoru/domain'
import { hasManageAny, type PolicyVersion } from '@mamoru/policy'
import type { EnterSwapProposal, Observation, ReduceProposal } from '../types.ts'
import { anyKey, convertKey, isManaged, positionValue } from '../rerange/index.ts'
import { inSavings, opCostInSavings, volatileOf } from '../value.ts'
import { depthOf } from '../depth/index.ts'

/** Price impact one exit sale may cause when the settings carry no depth sizing (bps; the live setting is 30). */
export const CHAIN_EXIT_IMPACT_BPS = 30

/**
 * otto/mamoru#427: the next step of leaving this chain's pools (`policy.chainExit`, from the engine settings' `chainExit`).
 * One rule, one step per review, through the pool's manage-any session only: first every managed position is taken out
 * in full (decrease, collect and burn, to the Safe), then the volatile token the Safe holds, harvested or not, is sold for
 * the savings asset. The savings stay where they are: an exit never bridges and never transfers. A position worth
 * nothing that still owes tokens is collected and burnt when that is worth its gas; an empty one is left alone. A pool
 * the action policy would refuse every swap in (#401) keeps its token until it would not. Each sale is cut to what the
 * pool takes at the depth sizing's impact (`depthOf` sellRoom, as the depeg exit), so a large balance goes in slices
 * over several reviews instead of one sale at any price. Without a manage-any session nothing can be taken out: that
 * says so (DECIDE_WAIT_RENEWAL), never that the exit is done. Null when the chain is not being left.
 */
export function chainExitStep(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>): { code: ReasonCode; proposal: ReduceProposal | EnterSwapProposal | null } | null {
  if (!policy.chainExit) return null
  if (!hasManageAny(policy)) return { code: 'DECIDE_WAIT_RENEWAL', proposal: null }
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
  let held: ReasonCode | null = null
  for (const pool of obs.pools) {
    if (!policyPools.has(pool.name)) continue
    const volatile = volatileOf(pool, savings)
    const amount = obs.balances[volatile] ?? 0n
    if (amount === 0n || inSavings(pool, volatile, amount, savings) * 10_000n <= floor) continue
    if (depthHeld.has(pool.name)) {
      held ??= 'REMOTE_DEPTH_BELOW_BUDGET'
      continue
    }
    const impact = policy.depth?.maxImpactBpsByPool?.[pool.name] ?? policy.depth?.maxImpactBps ?? CHAIN_EXIT_IMPACT_BPS
    const room = depthOf(obs, { ...policy, depth: { maxImpactBps: impact, maxShareBps: 10_000 } }, pool, policy.range.widthTicksByPool?.[pool.name] ?? policy.range.widthTicks)?.sellRoom ?? 0n
    const amountIn = amount < room ? amount : room
    // A slice not worth its gas waits for the pool to deepen (or the TWAP liquidity to be read) rather than pay for dust.
    if (inSavings(pool, volatile, amountIn, savings) * 10_000n <= floor) {
      held ??= 'DECIDE_WAIT_DEPTH'
      continue
    }
    return { code: 'DECIDE_CHAIN_EXIT', proposal: { kind: 'enter_swap', grant: convertKey(policy, pool.name), pool: pool.name, tokenIn: volatile, tokenOut: savings, fee: pool.fee, amountIn } }
  }
  return { code: held ?? 'DECIDE_CHAIN_EXIT_DONE', proposal: null }
}
