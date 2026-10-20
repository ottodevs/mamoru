// Spec 007 (otto/mamoru#151), task T2: a v4 policy version carrying MamoruActionPolicy as a second action policy
// on every action, the merged manage-any/convert-any grant, and the dropped swap price-limit-zero rule (see
// v4-grants.ts). Deliberately NOT added to `POLICIES` (policies.ts): that record is what the live operator and
// app read from (apps/mamoru-operator/src/boot.ts, operator.ts), and spec 007 "What to build" is explicit that
// "live behaviour must not change" — rollout (T7) is a coordinator decision after T1-T6 and Ot's sign-off (spec
// 007 "Upgrade and rollback"). Kept in its own file rather than policies.ts, which PR #62 (otto/mamoru#151-adjacent,
// conservador-live-v3) is editing concurrently.
import type { PolicyVersion } from './types.ts'
import { grantsV4, grantsV5, v4CapFormulas, V4_POOLS, type V4Usage } from './v4-grants.ts'

/**
 * Placeholder sizing (spec 007 "Open questions" #3: "accept 10/100/100 ticks and 1C per day, 3C per approval as
 * the starting point for T5?"). UsageLimitPolicy sizing (how many userOps one approval allows) is a separate axis
 * from MamoruActionPolicy's own budget and is not bounded by a leaked key's loss (#149): it only bounds how many
 * userOps the account's gas pays for. manage-any's limit is higher than v2's plain manage-any (2,500) because it
 * now also carries the harvest swap that convert-any used to hold on its own tiered limit; T5 retunes both halves
 * against real usage, as #149 did for v2.
 */
const V4_USAGE: V4Usage = { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }

const stablesCaps = v4CapFormulas('stables', V4_POOLS.stables)
const btcCaps = v4CapFormulas('btc', V4_POOLS.btc)
const riskCaps = v4CapFormulas('risk', V4_POOLS.risk)

/**
 * Conservador v4 (spec 007): same three pools and weights as conservadorLiveV2 (stables 50%, btc-usdc 40%, risk
 * 10%), with the v4 grants of v4-grants.ts (MamoruActionPolicy as a second action policy on every action, merged
 * manage-any, no per-position manage, no swap price-limit-zero rule). This object carries the grant shapes and
 * caps only, never a MamoruActionPolicy address (spec 007: "the policy contract address is a parameter", never a
 * registry entry or a constant here) — the caller resolves a grant with `instantiateGrant`, rewrites it with
 * `retargetToPolicy(grant, mamoruPolicy)`, and wraps it with `toSmartSession(grant, { policy, initData })`; see
 * packages/scenarios/action-policy/t2-fork.ts for the full sequence against a deployed policy on a fork.
 */
export const conservadorLiveV4: PolicyVersion = {
  policyId: 'conservador-live-v4',
  version: '0.1.0',
  preset: 'conservador',
  chain: 'base',
  buckets: [
    { id: 'stables', preference: 5000, pools: ['pool:USDC/USDT/100'] },
    { id: 'btc-usdc', preference: 4000, pools: ['pool:USDC/cbBTC/500'] },
    { id: 'risk', preference: 1000, pools: ['pool:WETH/USDC/3000'] },
  ],
  savingsAsset: 'USDC',
  gasReserveWei: 300_000_000_000_000n,
  harvest: { costFactorBps: 30000 },
  range: { widthTicks: 2000, adjust: 'on_out_of_range', cooldownSeconds: 900, widthTicksByPool: { 'pool:USDC/USDT/100': 40 } },
  allocation: 'target-weights',
  minEntry: 100_000n,
  rebalanceBandBps: 300,
  execution: { slippageBps: 50, maxTwapDeviationTicks: 100, twapWindowSeconds: 1800, observationTtlSeconds: 120 },
  session: {
    validitySeconds: 365 * 86_400,
    renewalWindowSeconds: 30 * 86_400,
    caps: [...stablesCaps, ...btcCaps, ...riskCaps],
    grants: [...grantsV4(V4_POOLS.stables, V4_USAGE), ...grantsV4(V4_POOLS.btc, V4_USAGE), ...grantsV4(V4_POOLS.risk, V4_USAGE)],
  },
  shadow: ['packaging:eny', 'packaging:eel', 'packaging:price-impact', 'packaging:tvl', 'packaging:depeg'],
}

/** Fork-only twin of conservadorLiveV4 (same shape, signed only for the Lab's fork chain id). */
export const conservadorLabV4: PolicyVersion = { ...conservadorLiveV4, policyId: 'conservador-lab-v4', chain: 'fork' }

/**
 * otto/mamoru#171: how far (bps of the new range's width) each edge of a held position may sit from the edge of the
 * range a mint would get, for an entry to add to that position instead of minting a second NFT. 1000 is the re-range
 * trigger's own edge share: a position that close to the fresh range has the price well inside it, so the liquidity
 * added is not taken straight out again by a re-range, and its token split is within a few percent of the fresh one.
 */
export const INCREASE_TOLERANCE_BPS = 1_000

/**
 * Conservador v5 (spec 007, otto/mamoru#151 and #171): conservadorLiveV4 for MamoruActionPolicyV2 (a new address, so a
 * new policy version). Same pools, weights, caps, bands and budgets; the grants add MamoruActionPolicyV2.increase to
 * each pool's manage-any (an entry adds to a held, admitted position instead of minting a second NFT:
 * `range.increaseToleranceBps`) and the swap deadline under the policy to enter-swap and manage-any, so a guardian pause
 * or a renewal stops every action of the session. conservadorLiveV4 itself is unchanged (its hash is pinned by test).
 */
export const conservadorLiveV5: PolicyVersion = {
  ...conservadorLiveV4,
  policyId: 'conservador-live-v5',
  version: '0.1.0',
  range: { ...conservadorLiveV4.range, increaseToleranceBps: INCREASE_TOLERANCE_BPS },
  session: {
    ...conservadorLiveV4.session,
    grants: [...grantsV5(V4_POOLS.stables, V4_USAGE), ...grantsV5(V4_POOLS.btc, V4_USAGE), ...grantsV5(V4_POOLS.risk, V4_USAGE)],
  },
}

/** Fork-only twin of conservadorLiveV5. */
export const conservadorLabV5: PolicyVersion = { ...conservadorLiveV5, policyId: 'conservador-lab-v5', chain: 'fork' }

