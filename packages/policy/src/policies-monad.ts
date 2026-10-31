import { pairGrants } from './grants.ts'
import { conservadorV1 } from './policies.ts'
import { INCREASE_TOLERANCE_BPS, conservadorLiveV5 } from './policies-v4.ts'
import type { PolicyVersion } from './types.ts'
import { grantsV3Only, grantsV5, v4CapFormulas, V4_POOLS_MONAD, type V4Usage } from './v4-grants.ts'

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

/**
 * otto/mamoru#61: the Monad MAINNET variant of `labWmonUsdcMonadV1`. Same pool, grants, caps and session as the lab
 * policy; it differs in two things only: it signs for chain 143 itself (`chain: 'monad'`, never a fork id nor the
 * testnet), and its gas reserve is in MON at Monad's gas price (about 100 gwei on 2026-10-23: a userOp's prefund at
 * tight limits is a few tenths of a MON, so 2 MON keeps several in the EntryPoint deposit). The operator resolves it
 * only with MAMORU_CHAIN_WRITES=143 (boot.ts), and only once TimeFramePolicy and UsageLimitPolicy are on Monad at
 * their Base address with their Base code (boot.ts `writeRegistry`).
 */
export const liveWmonUsdcMonadV1: PolicyVersion = {
  ...labWmonUsdcMonadV1,
  policyId: 'live-wmon-usdc-monad-v1',
  chain: 'monad',
  gasReserveWei: 2_000_000_000_000_000_000n,
}

/**
 * otto/mamoru#214: the sleeve's v5-shaped policy, so a paused account is paused on Monad too. Same pool, MON gas reserve
 * and range as `liveWmonUsdcMonadV1` (the range, 3000 ticks / 24 h cooldown, is the Monad lab policy's), with
 * `conservadorLiveV5`'s grants (MamoruActionPolicyV2 and MamoruGasPolicy on every action: guardian pause, budgets) and
 * increase tolerance. One bucket holds everything: the sleeve serves only the v6 Growth bucket, so inside it the whole
 * account is WMON/USDC. The id is 'risk' (the existing union has no 'growth' local bucket, and a WMON pool is the
 * volatile slot the engine already knows), preference 10000 (all of the sleeve's target; the Growth share of the whole
 * account, 15 %, lives in `conservadorLiveV6.remoteBuckets`). Caps are bps of the sleeve account's own cap, all of it
 * (`V4_POOLS_MONAD.growth`, capShareBps 10000). Needs the two contracts of Monad (env: MAMORU_ACTION_POLICY_V2_ADDRESS,
 * MAMORU_GAS_POLICY_ADDRESS); `liveWmonUsdcMonadV1` stays for the sleeves already activated (its hash is pinned).
 */
const V5_MONAD_USAGE: V4Usage = { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }

export const liveWmonUsdcMonadV5: PolicyVersion = {
  ...liveWmonUsdcMonadV1,
  policyId: 'live-wmon-usdc-monad-v5',
  version: '0.1.0',
  buckets: [{ id: 'risk', preference: 10_000, pools: [V4_POOLS_MONAD.growth.pool] }],
  harvest: conservadorLiveV5.harvest,
  execution: conservadorLiveV5.execution,
  range: { ...labWmonUsdcMonadV1.range, increaseToleranceBps: INCREASE_TOLERANCE_BPS },
  session: {
    ...conservadorLiveV5.session,
    caps: v4CapFormulas('growth', V4_POOLS_MONAD.growth),
    grants: grantsV5(V4_POOLS_MONAD.growth, V5_MONAD_USAGE),
  },
}

/**
 * otto/mamoru#251: the policy of the account's own Safe on Monad, whose sessions are committed in its setup (one Base
 * approval provisions it; no owner signature on Monad). `liveWmonUsdcMonadV5`'s pool, range, budgets and usage, with
 * MamoruActionPolicyV3 as the only action policy of every grant (`grantsV3Only`): no UniActionPolicy rule names the
 * account, whose address is a function of these sessions. Caps are the budget pair only, both in USDC, so the setup is
 * a function of the cap it is sized at and nothing else (no price): the Base approval commits to the Safe's address,
 * and the operator deploys that exact initializer later. Needs MamoruActionPolicyV3 on Monad (contractVersion 3).
 */
export const liveWmonUsdcMonadV6: PolicyVersion = {
  ...liveWmonUsdcMonadV5,
  policyId: 'live-wmon-usdc-monad-v6',
  version: '0.1.0',
  session: {
    ...liveWmonUsdcMonadV5.session,
    caps: v4CapFormulas('growth', V4_POOLS_MONAD.growth).filter((f) => f.name === V4_POOLS_MONAD.growth.caps.budgetWindow || f.name === V4_POOLS_MONAD.growth.caps.budgetTotal),
    grants: grantsV3Only(V4_POOLS_MONAD.growth, V5_MONAD_USAGE),
  },
}

/** Fork-only twin of liveWmonUsdcMonadV6. */
export const labWmonUsdcMonadV6: PolicyVersion = { ...liveWmonUsdcMonadV6, policyId: 'lab-wmon-usdc-monad-v6', chain: 'fork' }

/** Fork-only twin of liveWmonUsdcMonadV5 (signs for a lab fork chain id; names still resolve in Monad's registry). */
export const labWmonUsdcMonadV5: PolicyVersion = { ...liveWmonUsdcMonadV5, policyId: 'lab-wmon-usdc-monad-v5', chain: 'fork' }

/**
 * Monad mainnet policies by id: resolved by the operator only when it is opted into writing to Monad. The v5 sleeve
 * policy is deliberately not here: it needs the two Monad contract addresses, so boot.ts resolves it itself and fails closed.
 */
export const MONAD_LIVE_POLICIES: Record<string, PolicyVersion> = {
  [liveWmonUsdcMonadV1.policyId]: liveWmonUsdcMonadV1,
}
