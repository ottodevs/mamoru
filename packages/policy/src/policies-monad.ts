import { pairGrants } from './grants.ts'
import { conservadorV1 } from './policies.ts'
import type { PolicyVersion } from './types.ts'

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

/** Monad mainnet policies by id: resolved by the operator only when it is opted into writing to Monad. */
export const MONAD_LIVE_POLICIES: Record<string, PolicyVersion> = {
  [liveWmonUsdcMonadV1.policyId]: liveWmonUsdcMonadV1,
}
