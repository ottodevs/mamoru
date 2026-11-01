// otto/mamoru#210: v6 with the Stable bucket in lending. Owner decisions of 26-27 Oct 2026 (dailies): 50 % Stable as
// USDC supplied to ERC-4626 vaults on Base, Morpho gtUSDCp first and Aave waBasUSDC second (different protocol and
// collateral: the Morpho USDC vaults lend almost all against cbBTC), 35 % Balance in WETH/USDC, 15 % Growth on Monad.
// The Lab case is #186 (specs/004-loss-control/results/stables-4626-2026-10-23.md). USDC/USDT stays as an exit only, as
// USDC/cbBTC does since v6. Not in POLICIES: an account reaches it only through the `vaults_v7` renewal (boot.ts
// resolveV7Policy, operator v4Target), never as the default policy.
//
// Grants (coordinator decision, 1 Nov 2026): v6's set on MamoruActionPolicyV3 (#251) plus one vault-family session per
// vault, also on V3 alone, so the whole approval stays one owner transaction and no grant needs MamoruPauseGate but v6's
// bridge-out. v6 itself is not touched.
import { vaultSupplyGrant } from './grants.ts'
import { conservadorLiveV6, V6_POOLS } from './policies-v6.ts'
import type { PolicyVersion } from './types.ts'
import { exitOnlyV3Grant, exitOnlyV5Grant, manageAnyV3Only, V4_POOLS, type V4Usage } from './v4-grants.ts'

/** The stables bucket's vaults, in the order the engine fills them (Ot, 27 Oct: both, Morpho first). */
export const V7_VAULTS = ['vault:gtUSDCp', 'vault:waBasUSDC'] as const

/** userOps per vault and approval: a deposit and a redeem a week for a year, with room for harvest batches (#178). */
const VAULT_USAGE = 256

/** v6's (policies-v6.ts V6_USAGE). */
const V7_USAGE: V4Usage = { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }

export const conservadorLiveV7: PolicyVersion = {
  ...conservadorLiveV6,
  policyId: 'conservador-live-v7',
  version: '0.1.0',
  buckets: [
    { id: 'stables', preference: 5000, pools: [], vaults: [...V7_VAULTS] },
    // Shown as Balance; the id stays 'risk' so the WETH pool keeps its caps, grant keys and fall-freeze rule (v6).
    { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] },
    // Exit only, both at target 0. Their only grant is an exit-only manage-any (no mint, no increase, no USDC approval),
    // so nothing new goes in. USDC/USDT is held until the account opts in to its exit (`exitOptIn`, decide's
    // `exitPreferenceZero`): Ot has not decided between an automatic and an opt-in migration, so it is opt-in for now.
    // USDC/cbBTC behaves as in v6.
    { id: 'stables-lp', preference: 0, pools: ['pool:USDC/USDT/100'], exitOptIn: true },
    { id: 'btc-usdc', preference: 0, pools: ['pool:USDC/cbBTC/500'] },
  ],
  session: {
    ...conservadorLiveV6.session,
    // v6's: USDC/USDT and USDC/cbBTC keep theirs for the exit, WETH/USDC and the bridge as in v6. The vault grants add
    // none (V3 caps no vault amount).
    caps: conservadorLiveV6.session.caps,
    grants: [
      ...V7_VAULTS.map((vault) => vaultSupplyGrant({ vault }, VAULT_USAGE)),
      manageAnyV3Only(V6_POOLS.balance, V7_USAGE),
      // v6's V3 manage-any of USDC/USDT without its way in (V3 alone: one owner transaction from v5 too, t10-fork.ts).
      exitOnlyV3Grant(V4_POOLS.stables, V7_USAGE),
      // v6's own cbBTC exit, unchanged (UniActionPolicy beside V3: it only sells cbBTC).
      exitOnlyV5Grant(V4_POOLS.btc, V7_USAGE.manageAny),
      ...conservadorLiveV6.session.grants.filter((g) => g.name === 'bridge-out'),
    ],
  },
}

/** Fork-only twin of conservadorLiveV7. */
export const conservadorLabV7: PolicyVersion = { ...conservadorLiveV7, policyId: 'conservador-lab-v7', chain: 'fork' }
