import { pairGrants } from './grants.ts'
import { conservadorV1 } from './policies.ts'
import { INCREASE_TOLERANCE_BPS, conservadorLiveV5 } from './policies-v4.ts'
import type { PolicyVersion } from './types.ts'
import { manageAnyV3Only, v4CapFormulas, V4_POOLS_MONAD, type V4Usage } from './v4-grants.ts'

/**
 * otto/mamoru#65: the Monad lab policy. One pair, WMON/USDC 0.30% on Uniswap V3 (the sleeve of
 * `research/monad/monad-sleeve-research-2026-10-02`), with the same grant shapes, caps and session as
 * `labWethUsdcV1` on Base: enter-swap, enter-mint and a per-position manage. Every name resolves in the Monad
 * registry (`sourceChainId: 143`) and it signs only for a lab fork chain id (`chain: 'fork'`), never for Monad
 * mainnet: going live on Monad is a policy of its own once TimeFramePolicy and UsageLimitPolicy are deployed
 * there (otto/mamoru#62). Kept out of POLICIES, whose hashes are pinned and whose names resolve on Base.
 */
export const labWmonUsdcMonadV1: PolicyVersion = {
  ...conservadorV1,
  policyId: 'lab-wmon-usdc-monad-v1',
  version: '1.0.0',
  chain: 'fork',
  sourceChainId: 143,
  buckets: [
    { id: 'stables', preference: 5000, pools: [] },
    { id: 'btc-usdc', preference: 4000, pools: [] },
    { id: 'risk', preference: 1000, pools: ['pool:WMON/USDC/3000'] },
  ],
  range: { widthTicks: 3000, adjust: 'on_out_of_range', cooldownSeconds: 86_400 },
  session: {
    ...conservadorV1.session,
    caps: [
      { name: 'usdcSwapPerCall', asset: 'USDC', bpsOfDeposit: 2500 },
      { name: 'usdcSwapTotal', asset: 'USDC', bpsOfDeposit: 5000 },
      { name: 'wmonMint', asset: 'WMON', bpsOfDeposit: 5500 },
      { name: 'usdcMint', asset: 'USDC', bpsOfDeposit: 5000 },
      { name: 'wmonConvertPerCall', asset: 'WMON', bpsOfDeposit: 5500 },
      { name: 'wmonConvertTotal', asset: 'WMON', bpsOfDeposit: 5500 },
    ],
    grants: pairGrants(
      {
        stable: 'USDC',
        volatile: 'WMON',
        token0: 'WMON',
        token1: 'USDC',
        fee: 3000,
        caps: {
          stableSwapPerCall: 'usdcSwapPerCall',
          stableSwapTotal: 'usdcSwapTotal',
          mint0: 'wmonMint',
          mint1: 'usdcMint',
          volatileConvertPerCall: 'wmonConvertPerCall',
          volatileConvertTotal: 'wmonConvertTotal',
        },
      },
      { enterSwap: 8, enterMint: 8, manage: 64 },
    ),
  },
}

/** Lab policies of Monad by id, resolved by the operator next to POLICIES (boot.ts `resolveNamedPolicy`). */
export const MONAD_LAB_POLICIES: Record<string, PolicyVersion> = {
  [labWmonUsdcMonadV1.policyId]: labWmonUsdcMonadV1,
}

/** Usage of the account's own Safe on Monad: v5's three grants (enter-swap, enter-mint, manage-any), carried by one session. */
const V6_MONAD_USAGE: V4Usage = { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }

/**
 * otto/mamoru#251: the policy of the account's own Safe on Monad, whose sessions are committed in its setup (one Base
 * approval provisions it; no owner signature on Monad). WMON/USDC 0.30 % (`V4_POOLS_MONAD.growth`), the Monad lab's range,
 * v5's harvest, execution, budgets and usage, with
 * MamoruActionPolicyV3 as the only action policy (`manageAnyV3Only`: one session for the pool): no UniActionPolicy
 * rule names the account, whose address is a function of this session. Caps are the budget pair only, both in USDC, so the setup is
 * a function of the cap it is sized at and nothing else (no price): the Base approval commits to the Safe's address,
 * and the operator deploys that exact initializer later. Needs MamoruActionPolicyV3 on Monad (contractVersion 3).
 */
export const liveWmonUsdcMonadV6: PolicyVersion = {
  ...labWmonUsdcMonadV1,
  policyId: 'live-wmon-usdc-monad-v6',
  version: '0.1.0',
  // Signs for chain 143 itself; the gas reserve in MON at Monad's gas price (about 100 gwei on 2026-10-23: a userOp's
  // prefund at tight limits is a few tenths of a MON, so 2 MON keeps several in the EntryPoint deposit).
  chain: 'monad',
  gasReserveWei: 2_000_000_000_000_000_000n,
  // One bucket holds everything: the Safe serves only v6's Growth bucket, so inside it the whole account is WMON/USDC. The
  // id is 'risk' (the volatile slot the engine knows), preference 10000; the 15 % of the whole account lives in
  // `conservadorLiveV6.remoteBuckets` and the bridge caps.
  buckets: [{ id: 'risk', preference: 10_000, pools: [V4_POOLS_MONAD.growth.pool] }],
  harvest: conservadorLiveV5.harvest,
  execution: conservadorLiveV5.execution,
  range: { ...labWmonUsdcMonadV1.range, increaseToleranceBps: INCREASE_TOLERANCE_BPS },
  session: {
    ...conservadorLiveV5.session,
    caps: v4CapFormulas('growth', V4_POOLS_MONAD.growth).filter((f) => f.name === V4_POOLS_MONAD.growth.caps.budgetWindow || f.name === V4_POOLS_MONAD.growth.caps.budgetTotal),
    grants: [manageAnyV3Only(V4_POOLS_MONAD.growth, V6_MONAD_USAGE)],
  },
}

/** Fork-only twin of liveWmonUsdcMonadV6. */
export const labWmonUsdcMonadV6: PolicyVersion = { ...liveWmonUsdcMonadV6, policyId: 'lab-wmon-usdc-monad-v6', chain: 'fork' }
