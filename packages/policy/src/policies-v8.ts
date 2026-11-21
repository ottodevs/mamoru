// otto/mamoru#428 (spec 014): v7 without Monad. Owner decision of 21 Nov 2026: no new capital goes to Monad, every Monad
// account brings its money home and Monad's 15 % goes into USDC/cbBTC on Base. Stable (50 %, lending vaults) and Balance
// (35 %, WETH/USDC) are v7's, so the positions an account holds there are not touched; USDC/cbBTC takes money again at
// 15 %. No remote bucket and no bridge-out grant: an account on v8 can never send money to Monad. Not in POLICIES: an
// account reaches it through the renewal (operator v4Target) or a Start, behind the scoped ops flag `base_v8`. Owner
// scope of 21 Nov: every account ends on the newest version, so every earlier Base policy moves to it with one approval
// (a Monad account signs a second one on Monad to bring its money home).
//
// Grants: every one on MamoruActionPolicyV3 alone, as v7's, so the whole approval stays one owner transaction and none
// needs MamoruPauseGate (its only user was v6's bridge-out).
import { vaultSupplyGrant } from './grants.ts'
import { V6_POOLS } from './policies-v6.ts'
import { conservadorLiveV7, V7_VAULTS } from './policies-v7.ts'
import type { PolicyVersion } from './types.ts'
import { exitOnlyV3Grant, manageAnyV3Only, v4CapFormulas, V4_POOLS, type V4PoolSpec, type V4Usage } from './v4-grants.ts'

/** v7's (policies-v7.ts V7_USAGE). */
const V8_USAGE: V4Usage = { enterSwap: 3_000, enterMint: 1_000, manageAny: 32_000 }

/** userOps per vault and approval, as v7's VAULT_USAGE. */
const VAULT_USAGE = 256

/**
 * The Base pools of v8. Stables and Balance as v6/v7. USDC/cbBTC at its 15 % share (v4/v5 sized it for 40 %), with its own
 * daily multiple (2x, as in v4/v5), so a day's entries stay within what the bucket takes.
 */
export const V8_POOLS = {
  stables: V6_POOLS.stables,
  balance: V6_POOLS.balance,
  btc: { ...V4_POOLS.btc, capShareBps: 1500 },
} as const satisfies Record<string, V4PoolSpec>

// v7 without its remote bucket (the key left out, not set to undefined: it is part of the hashed shape).
const { remoteBuckets: _monad, ...v7BaseOnly } = conservadorLiveV7

export const conservadorLiveV8: PolicyVersion = {
  ...v7BaseOnly,
  policyId: 'conservador-live-v8',
  version: '0.1.0',
  buckets: [
    { id: 'stables', preference: 5000, pools: [], vaults: [...V7_VAULTS] },
    // Shown as Balance; the id stays 'risk' so the WETH pool keeps its caps, grant keys and fall-freeze rule (v6).
    { id: 'risk', preference: 3500, pools: ['pool:WETH/USDC/3000'] },
    // Monad's share, back on Base.
    { id: 'btc-usdc', preference: 1500, pools: ['pool:USDC/cbBTC/500'] },
    // Exit only at target 0, as v7: held until the account opts in to its exit.
    { id: 'stables-lp', preference: 0, pools: ['pool:USDC/USDT/100'], exitOptIn: true },
  ],
  session: {
    ...conservadorLiveV7.session,
    caps: [...v4CapFormulas('stables', V8_POOLS.stables), ...v4CapFormulas('risk', V8_POOLS.balance), ...v4CapFormulas('btc', V8_POOLS.btc)],
    grants: [
      ...V7_VAULTS.map((vault) => vaultSupplyGrant({ vault }, VAULT_USAGE)),
      manageAnyV3Only(V8_POOLS.balance, V8_USAGE),
      exitOnlyV3Grant(V8_POOLS.stables, V8_USAGE),
      manageAnyV3Only(V8_POOLS.btc, V8_USAGE),
    ],
  },
}

/** Fork-only twin of conservadorLiveV8. */
export const conservadorLabV8: PolicyVersion = { ...conservadorLiveV8, policyId: 'conservador-lab-v8', chain: 'fork' }

/** The policies an account can move to v8 from: every earlier Base conservador version (v2-v7) and its lab twin. */
export const V8_MIGRATES_FROM: ReadonlySet<string> = new Set(
  ['v2', 'v3', 'v4', 'v5', 'v6', 'v7'].flatMap((v) => [`conservador-live-${v}`, `conservador-lab-${v}`]),
)
