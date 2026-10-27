// otto/mamoru#210: v6 with the Stable bucket in lending. Owner decisions of 26-27 Oct 2026 (dailies): 50 % Stable as
// USDC supplied to ERC-4626 vaults on Base, Morpho gtUSDCp first and Aave waBasUSDC second (different protocol and
// collateral: the Morpho USDC vaults lend almost all against cbBTC), 35 % Balance in WETH/USDC, 15 % Growth on Monad.
// The Lab case is #186 (specs/004-loss-control/results/stables-4626-2026-10-23.md). USDC/USDT stays as an exit only, as
// USDC/cbBTC does since v6. Not in POLICIES: nothing can activate it until decide, the engine and the owner's exit know
// vaults (#210 S2-S4).
import { vaultSupplyGrant } from './grants.ts'
import { conservadorLiveV6, V6_POOLS } from './policies-v6.ts'
import type { CapFormula, PolicyVersion } from './types.ts'
import { exitOnlyV5Grant, V4_POOLS } from './v4-grants.ts'

/** The stables bucket's vaults, in the order the engine fills them. */
export const V7_VAULTS = ['vault:gtUSDCp', 'vault:waBasUSDC'] as const

/**
 * Deposit caps, bps of the account cap: one call at most the Stable share plus room for a top-up and the USDC an exit
 * from USDC/USDT or USDC/cbBTC frees (60 %); one approval at most twice the cap over its year (the first fill, top-ups,
 * and money that leaves for a rebalance and comes back). The redeem has no amount cap: it can only pay the account.
 */
const VAULT_CAPS: CapFormula[] = [
  { name: 'vaultPerCall', asset: 'USDC', bpsOfDeposit: 6000 },
  { name: 'vaultTotal', asset: 'USDC', bpsOfDeposit: 20_000 },
]

/** userOps per vault and approval: a deposit and a redeem a week for a year, with room for harvest batches (#178). */
const VAULT_USAGE = 256

const V7_EXIT_USAGE = 32_000

export const conservadorLiveV7: PolicyVersion = {
  ...conservadorLiveV6,
  policyId: 'conservador-live-v7',
  version: '0.1.0',
  // #186: at live relayer cost a deposit earns its two operations back in about a month from ~40 USDC.
  vaultMinDeposit: 40_000_000n,
  buckets: [
    { id: 'stables', preference: 5000, pools: [], vaults: [...V7_VAULTS] },
    { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] },
    // Exit only, both at target 0: `reduce` empties them and the idle USDT and cbBTC are sold back to savings. Their
    // only grant is exit-only manage-any (no mint, no increase, no USDC approval), so nothing new goes in.
    { id: 'stables-lp', preference: 0, pools: ['pool:USDC/USDT/100'] },
    { id: 'btc-usdc', preference: 0, pools: ['pool:USDC/cbBTC/500'] },
  ],
  session: {
    ...conservadorLiveV6.session,
    // v6's: USDC/USDT and USDC/cbBTC keep theirs for the exit, WETH/USDC and the bridge as in v6.
    caps: [...conservadorLiveV6.session.caps, ...VAULT_CAPS],
    grants: [
      ...V7_VAULTS.map((vault) => vaultSupplyGrant({ vault, caps: { perCall: 'vaultPerCall', total: 'vaultTotal' } }, VAULT_USAGE)),
      ...conservadorLiveV6.session.grants.filter((g) => g.pool === V6_POOLS.balance.pool || g.name === 'bridge-out'),
      exitOnlyV5Grant(V4_POOLS.stables, V7_EXIT_USAGE),
      exitOnlyV5Grant(V4_POOLS.btc, V7_EXIT_USAGE),
    ],
  },
}

/** Fork-only twin of conservadorLiveV7. */
export const conservadorLabV7: PolicyVersion = { ...conservadorLiveV7, policyId: 'conservador-lab-v7', chain: 'fork' }
