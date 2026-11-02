import type { ReasonCode } from '@mamoru/domain'
import { hasManageAny, type PolicyVersion } from '@mamoru/policy'
import type { BridgeOutProposal, EnterSwapProposal, Observation, ReduceProposal } from '../types.ts'
import { anyKey, convertKey, isManaged, positionValue } from '../rerange/index.ts'
import { inSavings, opCostInSavings, volatileOf } from '../value.ts'

/** A reduce frees this much more than is missing, for the sale of the volatile half and the pool fee (bps). */
export const RELEASE_MARGIN_BPS = 100n

/**
 * otto/mamoru#278 (spec 002 FR-XCH-014 a/c): a remote Safe its home account asked to send `obs.release.amount` of
 * savings back. One rule: free that much and bridge it home; nothing else is placed meanwhile. In order: the savings are
 * there (bridge them), idle volatile (sell what is missing, 1 % more for the fee), a position (reduce what is missing, 1 % more),
 * nothing left to free (bridge what there is). Null when there is no release.
 */
export function releaseOf(obs: Observation, policy: PolicyVersion, policyPools: ReadonlySet<string>, frozen: ReadonlySet<string> = new Set()): { code: ReasonCode; proposal: BridgeOutProposal | EnterSwapProposal | ReduceProposal | null } | null {
  const r = obs.release
  if (!r || r.amount <= 0n) return null
  if (!hasManageAny(policy)) return { code: 'DECIDE_RELEASE_EMPTY', proposal: null }
  const savings = policy.savingsAsset
  const free = obs.balances[savings] ?? 0n
  const bucket = policy.buckets.find((b) => b.pools.some((p) => policyPools.has(p)))
  const home = (amount: bigint): BridgeOutProposal => ({ kind: 'bridge_out', grant: 'bridge-out', bucket: bucket?.id ?? 'growth', chainId: r.chainId, pool: bucket?.pools[0] ?? savings, amount })
  if (free >= r.amount) return { code: 'DECIDE_RELEASE', proposal: home(r.amount) }
  const floor = opCostInSavings(obs, savings) * BigInt(policy.harvest.costFactorBps)
  // What is missing, with the margin: a sale or a reduce frees this much, never the whole holding when less will do.
  const missing = ((r.amount - free) * (10_000n + RELEASE_MARGIN_BPS)) / 10_000n
  // Missing less than one op is worth: what is there goes now instead of a sale or a reduce that costs more than it
  // frees. Nothing free and only that dust missing: no release in effect, the Safe is managed as usual.
  if (missing * 10_000n <= floor) return free > 0n ? { code: 'DECIDE_RELEASE', proposal: home(free) } : null
  // A frozen pool (fall freeze, depeg) is never sold into nor reduced: the release sends what the others free.
  for (const pool of obs.pools) {
    if (!policyPools.has(pool.name) || frozen.has(pool.name)) continue
    const volatile = volatileOf(pool, savings)
    const held = obs.balances[volatile] ?? 0n
    const value = held === 0n ? 0n : inSavings(pool, volatile, held, savings)
    if (value * 10_000n <= floor) continue
    const amountIn = missing >= value ? held : (held * missing) / value + 1n
    return { code: 'DECIDE_RELEASE', proposal: { kind: 'enter_swap', grant: convertKey(policy, pool.name), pool: pool.name, tokenIn: volatile, tokenOut: savings, fee: pool.fee, amountIn: amountIn > held ? held : amountIn } }
  }
  for (const p of obs.positions) {
    const pool = p.pool ? obs.pools.find((x) => x.name === p.pool) : undefined
    if (!pool || p.liquidity === 0n || frozen.has(pool.name) || !isManaged(p, policy, policyPools)) continue
    const pv = positionValue(p, pool, savings)
    const liquidity = pv === 0n || missing >= pv ? p.liquidity : (p.liquidity * missing) / pv + 1n
    return { code: 'DECIDE_RELEASE', proposal: { kind: 'reduce', grant: anyKey(policy, 'manage-any', pool.name), pool: pool.name, tokenId: p.tokenId, liquidity: liquidity > p.liquidity ? p.liquidity : liquidity } }
  }
  return free > 0n ? { code: 'DECIDE_RELEASE', proposal: home(free) } : { code: 'DECIDE_RELEASE_EMPTY', proposal: null }
}
