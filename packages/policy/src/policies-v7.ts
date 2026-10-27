// otto/mamoru#225: one passkey prompt per approval on Base. conservadorLiveV6 with each pool's grants merged into one
// session (`mergeGrants`, v4-grants.ts): stables and Balance one session each instead of three, the USDC/cbBTC exit one
// as before, bridge-out unchanged. The whole set (activation, renewal, or the move from any earlier version) is ONE owner
// transaction (`session.oneTransaction`), measured on a Base fork in
// specs/007-onchain-action-policy/results/merged-grants-2026-10-27.md. Same contracts as v6 (MamoruActionPolicyV2,
// MamoruGasPolicy, MamoruPauseGate), same buckets, caps, budgets and gas caps; v6 itself is unchanged (its hash is pinned
// by test). Not in POLICIES, like v6: offered as a renewal target only, behind the `merged_grants_v7` ops flag.
import { bridgeOutGrant, CCTP_DOMAIN_MONAD } from './grants.ts'
import { conservadorLiveV6, V6_POOLS } from './policies-v6.ts'
import type { PolicyVersion } from './types.ts'
import { exitOnlyV7Grant, poolGrantV7, V4_POOLS, type V4Usage } from './v4-grants.ts'

/** v6's usage limits; each pool session takes the sum of its three (36,000), the exit one manage-any's. */
const V7_USAGE: V4Usage = { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }

export const conservadorLiveV7: PolicyVersion = {
  ...conservadorLiveV6,
  policyId: 'conservador-live-v7',
  version: '0.1.0',
  session: {
    ...conservadorLiveV6.session,
    grants: [
      poolGrantV7(V6_POOLS.stables, V7_USAGE),
      poolGrantV7(V6_POOLS.balance, V7_USAGE),
      exitOnlyV7Grant(V4_POOLS.btc, V7_USAGE.manageAny),
      bridgeOutGrant({ destinationDomain: CCTP_DOMAIN_MONAD, caps: { perCall: 'bridgePerCall', total: 'bridgeTotal' } }, 64),
    ],
    oneTransaction: true,
  },
}

/** Fork-only twin of conservadorLiveV7. */
export const conservadorLabV7: PolicyVersion = { ...conservadorLiveV7, policyId: 'conservador-lab-v7', chain: 'fork' }

/** The approval of `policy` is one owner transaction, never split (otto/mamoru#225). */
export function oneTransaction(policy: Pick<PolicyVersion, 'session'>): boolean {
  return policy.session.oneTransaction === true
}
