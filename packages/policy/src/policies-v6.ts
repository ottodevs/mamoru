// otto/mamoru#201, #213: the first policy whose account spans two chains. Owner decisions of 26-27 Oct 2026: 50 % Stable
// (USDC/USDT on Base; lending replaces it in a later version), 35 % Balance (WETH/USDC on Base, no cbBTC), 15 % Growth
// (WMON/USDC on Monad, served by the account's own Safe on Monad, #251). USDC/cbBTC stays only as an exit for accounts moving in. Not in POLICIES: no account can activate it until the
// sleeve activation (#214) and the cross-chain allocator (#215) exist.
import { bridgeOutGrant, CCTP_DOMAIN_MONAD } from './grants.ts'
import { INCREASE_TOLERANCE_BPS, conservadorLiveV5 } from './policies-v4.ts'
import { liveWmonUsdcMonadV6 } from './policies-monad.ts'
import type { CapFormula, PolicyVersion } from './types.ts'
import { exitOnlyV5Grant, manageAnyV3Only, v4CapFormulas, V4_POOLS, type V4PoolSpec, type V4Usage } from './v4-grants.ts'

const V6_USAGE: V4Usage = { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }

/**
 * The two Base pools of v6. Stables as in v4/v5. WETH/USDC moves from 10 % to 35 %, so its cap share follows; its
 * daily window takes btc's 2x (the 40 % bucket's), not risk's 3x, so a day's turnover through it stays near v5's.
 */
export const V6_POOLS = {
  stables: V4_POOLS.stables,
  balance: { ...V4_POOLS.risk, capShareBps: 3500, windowMultiple: 2 },
} as const satisfies Record<string, V4PoolSpec>

/**
 * Bridge caps, bps of the account cap: one call moves at most the Growth share plus room for a top-up (20 %); one
 * approval at most half the cap over its year (a deposit's 15 %, the top-ups and the rebalances after them). No fee
 * cap: bridge-out pins the CCTP fee to 0.
 */
const BRIDGE_CAPS: CapFormula[] = [
  { name: 'bridgePerCall', asset: 'USDC', bpsOfDeposit: 2000 },
  { name: 'bridgeTotal', asset: 'USDC', bpsOfDeposit: 5000 },
]

export const conservadorLiveV6: PolicyVersion = {
  ...conservadorLiveV5,
  policyId: 'conservador-live-v6',
  version: '0.1.0',
  buckets: [
    { id: 'stables', preference: 5000, pools: ['pool:USDC/USDT/100'] },
    // Shown as Balance; the id stays 'risk' so the WETH pool keeps its caps, grant keys and fall-freeze rule.
    { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] },
    // Exit only: an account moving from v2-v5 still holds USDC/cbBTC positions. Target 0, so `reduce` empties them and
    // the idle cbBTC is sold back to savings. Its only grant is exit-only manage-any (no mint, no increase, no USDC
    // approval) and `rerangeOf` never re-ranges a bucket at preference 0, so nothing new goes in.
    { id: 'btc-usdc', preference: 0, pools: ['pool:USDC/cbBTC/500'] },
  ],
  remoteBuckets: [{ id: 'growth', preference: 1500, chainId: 143, pools: ['pool:WMON/USDC/3000'], policyId: liveWmonUsdcMonadV6.policyId }],
  range: { ...conservadorLiveV5.range, increaseToleranceBps: INCREASE_TOLERANCE_BPS },
  session: {
    ...conservadorLiveV5.session,
    caps: [...v4CapFormulas('stables', V6_POOLS.stables), ...v4CapFormulas('risk', V6_POOLS.balance), ...v4CapFormulas('btc', V4_POOLS.btc), ...BRIDGE_CAPS],
    // otto/mamoru#251: MamoruActionPolicyV3 the only action policy of the two pools' grants, one manage-any per pool: the
    // whole approval is one owner transaction (v5's grants took four on 29 Oct 2026). The cbBTC exit keeps UniActionPolicy
    // beside V3 (GPT-6 review r2 P1 4): its swap rule sells cbBTC for USDC only, so no allowance another session leaves
    // on the router can buy cbBTC back through it. Bridge-out keeps UniActionPolicy (its recipient is the account's Safe on
    // Monad, another address) and MamoruPauseGate, bound to V3's guardian pause.
    grants: [
      manageAnyV3Only(V6_POOLS.stables, V6_USAGE),
      manageAnyV3Only(V6_POOLS.balance, V6_USAGE),
      exitOnlyV5Grant(V4_POOLS.btc, V6_USAGE.manageAny),
      bridgeOutGrant({ destinationDomain: CCTP_DOMAIN_MONAD, caps: { perCall: 'bridgePerCall', total: 'bridgeTotal' } }, 64),
    ],
  },
}

/** Fork-only twin of conservadorLiveV6. */
export const conservadorLabV6: PolicyVersion = { ...conservadorLiveV6, policyId: 'conservador-lab-v6', chain: 'fork' }

/** Every bucket's preference, local and remote: the denominator of a bucket's target share of the account. */
export function preferenceTotal(policy: Pick<PolicyVersion, 'buckets' | 'remoteBuckets'>): number {
  return policy.buckets.reduce((s, b) => s + b.preference, 0) + (policy.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0)
}

