// Spec 007 (otto/mamoru#151), task T2: production v4 grant builders. Ports
// packages/scenarios/action-policy/v4-grant.ts (T1, test-only fixture scaffolding for one hardcoded pool) into
// `packages/policy` as the real builder, generalized to any pool and merging `manage-any`/`convert-any` into one
// grant (spec 007 "Grant changes it implies (T2)": "manage-any and convert-any can merge into one session per
// pool, which halves the enable gas"). Nothing here is wired into `POLICIES` (policies.ts) or the live operator:
// the deployed MamoruActionPolicy address is always an explicit parameter, never a registry entry or a constant,
// because the contract "is not deployed anywhere" (spec 007 "What to build").
//
// This module intentionally does not import from `@mamoru/account` (which imports from this package): the final
// `toSmartSession(grant, { policy, initData })` wrap (packages/account/sessions, extended for T2 with an optional
// second action policy) happens at the call site — the fork scenario (t2-fork.ts) today, the operator's
// activation code at T7. Keeping that import direction one-way avoids a circular package dependency.
import { encodeAbiParameters } from 'viem'
import type { Address, Hex } from '@mamoru/domain'
import { address, type RegistryName } from '@mamoru/registry'
import type { ActionRuleTemplate, CapFormula, GrantName, GrantTemplate, ParamRuleTemplate, PolicyVersion, ResolvedActionRule, SessionGrant } from './types.ts'

// ---------------------------------------------------------------- signatures (as grants.ts spells them)
// Kept local, like the T1 fixture did: this module must stand on its own so v2/v3 (grants.ts, policies.ts, both
// with open PRs elsewhere) are never touched by a v4 change.
const APPROVE_SIG = 'approve(address,uint256)'
const EXACT_INPUT_SINGLE_SIG = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'
const MINT_SIG = 'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))'
const DECREASE_SIG = 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))'
const COLLECT_SIG = 'collect((uint256,address,uint128,uint128))'
const BURN_SIG = 'burn(uint256)'

// ---------------------------------------------------------------- MamoruActionPolicy.Init encoding
// Mirrors contracts/action-policy/src/MamoruActionPolicy.sol's `Init` struct field for field. A unit test
// (v4-grants.test.ts) round-trips this against the Foundry build artifact's ABI.

export type MamoruInit = {
  /** The one Uniswap v3 pool this Init covers (an on-chain pool address, not a registry name). */
  pool: Address
  twapWindow: number
  bandTicks: number
  /** Account-wide: a higher generation here retires every lower-generation config of the account, all pools. */
  generation: bigint
  budgetWindow: number
  perWindow0: bigint
  perWindow1: bigint
  total0: bigint
  total1: bigint
}

const MAMORU_INIT_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'pool', type: 'address' },
      { name: 'twapWindow', type: 'uint32' },
      { name: 'bandTicks', type: 'uint24' },
      { name: 'generation', type: 'uint64' },
      { name: 'budgetWindow', type: 'uint32' },
      { name: 'perWindow0', type: 'uint128' },
      { name: 'perWindow1', type: 'uint128' },
      { name: 'total0', type: 'uint128' },
      { name: 'total1', type: 'uint128' },
    ],
  },
] as const

/** `abi.encode(Init)`: a static struct, so this is exactly what Solidity's `abi.decode(data, (Init))` expects. */
export function encodeMamoruInit(i: MamoruInit): Hex {
  return encodeAbiParameters(MAMORU_INIT_TUPLE, [i])
}

// ---------------------------------------------------------------- v4 pool table (spec 007 "Parameters")

export type V4PoolSpec = {
  /** Registry name of the Uniswap v3 pool (multi-pool policies key the session by `name:pool`, see grants.ts grantKey). */
  pool: RegistryName
  stable: RegistryName
  volatile: RegistryName
  token0: RegistryName
  token1: RegistryName
  fee: number
  /** MamoruActionPolicy.Init.bandTicks (spec 007 "Parameters" table). */
  bandTicks: number
  /**
   * Cp: this pool's share of the account cap, in bps of the deposit (spec 007 "Parameters": "`C_p` the pool's
   * share of the account cap"). Set to the live buckets' preference (conservadorLiveV2: stables 50%, btc-usdc 40%,
   * risk 10%) so `W_p = 1 x C_p` and `T_p = 3 x C_p` resolve to the same shares the account already runs at.
   */
  capShareBps: number
  /** Cap formula names this pool's grants reference (resolved to raw units by `computeCaps`, see instantiate.ts). */
  caps: {
    stableSwapPerCall: string
    stableSwapTotal: string
    mint0: string
    mint1: string
    volatileConvertPerCall: string
    volatileConvertTotal: string
    /** MamoruActionPolicy.Init budgets (spec 007 "Parameters": W_p = 1xCp, T_p = 3xCp, token0/token1 separately). */
    budgetWindow0: string
    budgetWindow1: string
    budgetTotal0: string
    budgetTotal1: string
  }
}

function v4Caps(prefix: string): V4PoolSpec['caps'] {
  const n = (s: string) => `${prefix}${s}`
  return {
    stableSwapPerCall: n('SwapPerCall'),
    stableSwapTotal: n('SwapTotal'),
    mint0: n('Mint0'),
    mint1: n('Mint1'),
    volatileConvertPerCall: n('ConvertPerCall'),
    volatileConvertTotal: n('ConvertTotal'),
    budgetWindow0: n('BudgetWindow0'),
    budgetWindow1: n('BudgetWindow1'),
    budgetTotal0: n('BudgetTotal0'),
    budgetTotal1: n('BudgetTotal1'),
  }
}

/**
 * Per-pool UniActionPolicy sizing for v4 (per-call / cumulative caps, harmless alongside MamoruActionPolicy's own
 * budget): a placeholder 1x/2x of the pool's cap share, not the #149 Lab-measured sizing v2/v3 use. T5 (spec 007
 * Tasks) retunes these against 2024-2026 data the same way #149 did; nothing here binds a leaked key's loss, which
 * is MamoruActionPolicy's job.
 */
export function v4CapFormulas(prefix: string, p: Omit<V4PoolSpec, 'caps'>): CapFormula[] {
  const c = v4Caps(prefix)
  return [
    { name: c.stableSwapPerCall, asset: p.stable, bpsOfDeposit: p.capShareBps },
    { name: c.stableSwapTotal, asset: p.stable, bpsOfDeposit: p.capShareBps * 2 },
    { name: c.mint0, asset: p.token0, bpsOfDeposit: p.capShareBps * 2 },
    { name: c.mint1, asset: p.token1, bpsOfDeposit: p.capShareBps * 2 },
    { name: c.volatileConvertPerCall, asset: p.volatile, bpsOfDeposit: p.capShareBps * 2 },
    { name: c.volatileConvertTotal, asset: p.volatile, bpsOfDeposit: p.capShareBps * 2 },
    // W_p = 1 x C_p, T_p = 3 x C_p (spec 007 "Parameters"), per token.
    { name: c.budgetWindow0, asset: p.token0, bpsOfDeposit: p.capShareBps },
    { name: c.budgetWindow1, asset: p.token1, bpsOfDeposit: p.capShareBps },
    { name: c.budgetTotal0, asset: p.token0, bpsOfDeposit: p.capShareBps * 3 },
    { name: c.budgetTotal1, asset: p.token1, bpsOfDeposit: p.capShareBps * 3 },
  ]
}

function v4Pool(pool: RegistryName, stable: RegistryName, volatile: RegistryName, token0: RegistryName, token1: RegistryName, fee: number, bandTicks: number, capShareBps: number, prefix: string): V4PoolSpec {
  return { pool, stable, volatile, token0, token1, fee, bandTicks, capShareBps, caps: v4Caps(prefix) }
}

/** The three pools of conservadorLiveV2, with the v4 band ticks and cap shares of spec 007's "Parameters" table. */
export const V4_POOLS = {
  stables: v4Pool('pool:USDC/USDT/100', 'USDC', 'USDT', 'USDC', 'USDT', 100, 10, 5000, 'stables'),
  btc: v4Pool('pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 'USDC', 'cbBTC', 500, 100, 4000, 'btc'),
  risk: v4Pool('pool:WETH/USDC/3000', 'USDC', 'WETH', 'WETH', 'USDC', 3000, 100, 1000, 'risk'),
} as const satisfies Record<string, V4PoolSpec>

export const TWAP_WINDOW_SECONDS = 1800 // spec 007 "Parameters": = execution.twapWindowSeconds
export const BUDGET_WINDOW_SECONDS = 86_400 // spec 007 "Parameters": 1 day

/** MamoruActionPolicy.Init for `p` at `generation`, from a resolved Caps object (see `v4CapFormulas` / `computeCaps`). */
export function mamoruInitFor(p: V4PoolSpec, generation: bigint, caps: Record<string, bigint>, opts: { twapWindow?: number; budgetWindow?: number } = {}): MamoruInit {
  const need = (name: string): bigint => {
    const v = caps[name]
    if (v === undefined) throw new Error(`mamoruInitFor: missing cap ${name} (pool ${p.pool})`)
    return v
  }
  return {
    pool: address(p.pool),
    twapWindow: opts.twapWindow ?? TWAP_WINDOW_SECONDS,
    bandTicks: p.bandTicks,
    generation,
    budgetWindow: opts.budgetWindow ?? BUDGET_WINDOW_SECONDS,
    perWindow0: need(p.caps.budgetWindow0),
    perWindow1: need(p.caps.budgetWindow1),
    total0: need(p.caps.budgetTotal0),
    total1: need(p.caps.budgetTotal1),
  }
}

// ---------------------------------------------------------------- v4 grant templates
// Unlike pairGrants/manageAnyGrants (grants.ts), actions here never carry the `sqrtPriceLimitX96 EQUAL 0` rule
// (spec 007: "the swap rule sqrtPriceLimitX96 EQUAL 0 goes" — MamoruActionPolicy._swapOk refuses a zero limit, so
// a policy-compliant swap needs a non-zero one at the band edge). Mint and the approvals that fund it still name
// the NonfungiblePositionManager here (a template has no address for the not-yet-deployed policy to carry, spec
// 007 "the policy contract address is a parameter"); `retargetToPolicy` rewrites them once the grant is resolved.

function approveRule(spenderRegistryName: RegistryName, capName: string): ActionRuleTemplate['params'] {
  return [
    { field: 'spender', index: 0, condition: 'EQUAL', ref: spenderRegistryName, denial: 'POLICY_DENIED_APPROVAL' },
    { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${capName}`, denial: 'POLICY_DENIED_APPROVAL' },
  ]
}

/** v4 `enter-swap`: approve unchanged; swap drops the price-limit-zero rule (amountOutMinimum > 0 stays). */
function enterSwapV4Actions(p: V4PoolSpec): ActionRuleTemplate[] {
  return [
    { target: p.stable, signature: APPROVE_SIG, params: approveRule('SwapRouter02', p.caps.stableSwapPerCall) },
    {
      target: 'SwapRouter02',
      signature: EXACT_INPUT_SINGLE_SIG,
      params: [
        { field: 'tokenIn', index: 0, condition: 'EQUAL', ref: p.stable, denial: 'POLICY_DENIED_TARGET' },
        { field: 'tokenOut', index: 1, condition: 'EQUAL', ref: p.volatile, denial: 'POLICY_DENIED_TARGET' },
        { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
        { field: 'recipient', index: 3, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
        { field: 'amountIn', index: 4, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.stableSwapPerCall}`, cumulative: `cap:${p.caps.stableSwapTotal}`, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'amountOutMinimum', index: 5, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
      ],
    },
  ]
}

/** v4 `enter-mint`: same shape as pairGrants' enter-mint; `retargetToPolicy` moves the approvals and mint's target. */
function enterMintV4Actions(p: V4PoolSpec): ActionRuleTemplate[] {
  return [
    { target: p.token0, signature: APPROVE_SIG, params: approveRule('NonfungiblePositionManager', p.caps.mint0) },
    { target: p.token1, signature: APPROVE_SIG, params: approveRule('NonfungiblePositionManager', p.caps.mint1) },
    {
      target: 'NonfungiblePositionManager',
      signature: MINT_SIG,
      params: [
        { field: 'token0', index: 0, condition: 'EQUAL', ref: p.token0, denial: 'POLICY_DENIED_TARGET' },
        { field: 'token1', index: 1, condition: 'EQUAL', ref: p.token1, denial: 'POLICY_DENIED_TARGET' },
        { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
        { field: 'amount0Desired', index: 5, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.mint0}`, cumulative: `cap:${p.caps.mint0}`, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'amount1Desired', index: 6, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.mint1}`, cumulative: `cap:${p.caps.mint1}`, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'amount0Min', index: 7, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'amount1Min', index: 8, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'recipient', index: 9, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
      ],
    },
  ]
}

/**
 * v4 `manage-any`: manage-any and convert-any merged (spec 007 "Grant changes it implies (T2)"), one `collect`
 * instead of two. Decrease/collect/burn unchanged (any tokenId at the UniActionPolicy layer; MamoruActionPolicy
 * adds the admitted-set + ownership check). Mint and the non-volatile token's approval are retargeted to the
 * policy, same as enter-mint.
 *
 * The volatile token's approve is shared by two flows now that it merges with convert-any: minting (spender ends
 * up the policy, see `retargetToPolicy`) and the harvest swap (spender the router). SmartSession keys an action
 * by `(target, selector)` only (grants.ts manageAnyGrants' own comment: "the volatile token's approve goes to the
 * manager for a mint and to the router for a conversion, which one session cannot hold twice"), so this merge can
 * carry only ONE `approve` action for that token — and UniActionPolicy's `EQUAL` condition on one field cannot
 * express "spender is router OR policy". So this one action gets no `spender` rule at the UniActionPolicy layer;
 * MamoruActionPolicy's own `checkAction` already restricts it to exactly `ROUTER` or `address(this)`
 * (contracts/action-policy/src/MamoruActionPolicy.sol, the APPROVE branch), and every policy of an action must
 * pass (spec 007 "How SmartSession calls it"), so the restriction still holds — just enforced by the second
 * policy instead of the first. The amount cap still applies (`volatileConvertPerCall`, same magnitude as the mint
 * caps in this policy's sizing). 7 actions total (one fewer than a naive decrease/collect/burn/approve/approve/
 * mint/approve/swap merge would have, exactly because of that one shared approve).
 */
function manageAnyV4Actions(p: V4PoolSpec): ActionRuleTemplate[] {
  const stableCap = p.stable === p.token0 ? p.caps.mint0 : p.caps.mint1
  return [
    { target: 'NonfungiblePositionManager', signature: DECREASE_SIG, params: [{ field: 'tokenId', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_POSITION' }] },
    { target: 'NonfungiblePositionManager', signature: COLLECT_SIG, params: [{ field: 'recipient', index: 1, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' }] },
    { target: 'NonfungiblePositionManager', signature: BURN_SIG, params: [{ field: 'tokenId', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_POSITION' }] },
    // The stable (non-volatile) token's approve: minting only, so it keeps a fixed spender rule (-> NPM in the
    // template, retargeted to the policy below).
    { target: p.stable, signature: APPROVE_SIG, params: approveRule('NonfungiblePositionManager', stableCap) },
    // The volatile token's approve: shared by mint and harvest (see the function doc above) — amount cap only.
    { target: p.volatile, signature: APPROVE_SIG, params: [{ field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.volatileConvertPerCall}`, denial: 'POLICY_DENIED_APPROVAL' }] },
    {
      target: 'NonfungiblePositionManager',
      signature: MINT_SIG,
      params: [
        { field: 'token0', index: 0, condition: 'EQUAL', ref: p.token0, denial: 'POLICY_DENIED_TARGET' },
        { field: 'token1', index: 1, condition: 'EQUAL', ref: p.token1, denial: 'POLICY_DENIED_TARGET' },
        { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
        { field: 'amount0Desired', index: 5, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.mint0}`, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'amount1Desired', index: 6, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.mint1}`, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'recipient', index: 9, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
      ],
    },
    {
      target: 'SwapRouter02',
      signature: EXACT_INPUT_SINGLE_SIG,
      params: [
        { field: 'tokenIn', index: 0, condition: 'EQUAL', ref: p.volatile, denial: 'POLICY_DENIED_TARGET' },
        { field: 'tokenOut', index: 1, condition: 'EQUAL', ref: p.stable, denial: 'POLICY_DENIED_TARGET' },
        { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
        { field: 'recipient', index: 3, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
        { field: 'amountIn', index: 4, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.volatileConvertPerCall}`, cumulative: `cap:${p.caps.volatileConvertTotal}`, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'amountOutMinimum', index: 5, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
      ],
    },
  ]
}

export function enterSwapV4Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  return { name: 'enter-swap', pool: p.pool, perPosition: false, usageLimit, actions: enterSwapV4Actions(p) }
}

export function enterMintV4Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  return { name: 'enter-mint', pool: p.pool, perPosition: false, usageLimit, actions: enterMintV4Actions(p) }
}

/** The merged manage-any (spec 007: subsumes convert-any; the per-position `manage` grant is unnecessary in v4). */
export function manageAnyV4Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  return { name: 'manage-any', pool: p.pool, perPosition: false, usageLimit, actions: manageAnyV4Actions(p) }
}

export type V4Usage = { enterSwap: number; enterMint: number; manageAny: number }

/** The three v4 grants of one pool: enter-swap, enter-mint, manage-any (merged). No per-position `manage`. */
export function grantsV4(p: V4PoolSpec, usage: V4Usage): GrantTemplate[] {
  return [enterSwapV4Grant(p, usage.enterSwap), enterMintV4Grant(p, usage.enterMint), manageAnyV4Grant(p, usage.manageAny)]
}

// ---------------------------------------------------------------- engine wiring (spec 007 T3)

/**
 * Attaches a deployed MamoruActionPolicy to a v4 `PolicyVersion` for the engine (spec 007 T3): `prepareCalls`
 * (packages/scenarios/driver/engine.ts) only builds v4-bounded calls for a pool listed in the result's
 * `actionPolicy.bandTicksByPool`. The address is always an explicit parameter here, never a registry entry or a
 * constant (same discipline as `retargetToPolicy` above) — the caller passes the address it deployed (or was
 * told to use) and the `V4PoolSpec[]` whose `bandTicks` the engine narrows from. Does not mutate `policy`.
 */
export function withActionPolicy(policy: PolicyVersion, mamoruPolicy: Address, pools: readonly V4PoolSpec[], bandFactorBps?: number): PolicyVersion {
  const bandTicksByPool: Partial<Record<RegistryName, number>> = {}
  for (const p of pools) bandTicksByPool[p.pool] = p.bandTicks
  return { ...policy, actionPolicy: { address: mamoruPolicy, bandTicksByPool, ...(bandFactorBps !== undefined ? { bandFactorBps } : {}) } }
}

// ---------------------------------------------------------------- retargeting (template -> policy address)

/**
 * After `instantiateGrant` resolves a v4 template against the registry (mint and its approvals still pointing at
 * the NonfungiblePositionManager), rewrite them to the deployed MamoruActionPolicy: `mint`'s target, and the
 * `spender` of any approval that currently names the position manager (never the router-spender approvals of
 * enter-swap or the harvest leg of manage-any, left untouched). Spec 007: "`manage-any` names
 * `MamoruActionPolicy.mint` and approves the policy, not the NonfungiblePositionManager; `enter-mint` the same."
 */
export function retargetToPolicy(grant: SessionGrant, mamoruPolicy: Address): SessionGrant {
  const npm = BigInt(address('NonfungiblePositionManager'))
  const policyRef = BigInt(mamoruPolicy)
  const actions: ResolvedActionRule[] = grant.actions.map((a) => {
    if (a.signature === MINT_SIG) return { ...a, targetAddress: mamoruPolicy }
    if (a.signature === APPROVE_SIG) {
      const i = a.params.findIndex((p) => p.field === 'spender' && p.ref === npm)
      if (i === -1) return a
      return { ...a, params: a.params.map((p, j) => (j === i ? { ...p, ref: policyRef } : p)) }
    }
    return a
  })
  return { ...grant, actions }
}

// ---------------------------------------------------------------- gas model + splitter (spec 007 Tasks T2 (b))
//
// `enableSessions` (and a renewal's `enableSessions` + `removeSession` batch) run as one owner-executed Base L2
// transaction, not a userOp: Base's per-transaction gas cap is 2^24 (16,777,216). `splitSessionsByGas` partitions
// whole sessions (an `enableSessions` call enables complete Session structs; one session's actions cannot be
// split across transactions) into ordered batches that each stay under `ceilingGas`, so T7's renewal flow can
// send them as N owner transactions.
//
// `packages/scenarios/action-policy/t2-fork.ts` measured the full 3-pool v4 grant set (9 sessions, 36 actions: 12
// per pool — 2 enter-swap + 3 enter-mint + 7 manage-any) on a Base fork (block 51,811,000). With
// DEFAULT_GAS_CEILING, the splitter always made 2 transactions (the exact split point moves with the model's
// `perActionGas`, since it bin-packs by estimated, not actual, gas — see `splitBatches`). One run's batches of 24
// and 12 actions measured:
//   first enable (cold):  24 actions -> 14,142,119 gas (589,255/action); 12 actions -> 7,089,827 gas (590,819/action)
//   renewal (gen 2):      24 actions -> 13,815,287 gas (575,637/action); 12 actions -> 6,942,279 gas (578,523/action)
// and a second run (same grant set, `perActionGas` already recalibrated — different split, 17 + 19 actions)
// measured 10,654,181 and 10,584,005 gas for first enable, 13,815,299 and 6,942,279 for renewal. Every transaction
// of every run landed comfortably under Base's 2^24 cap (worst observed 14,142,119, 84% of it). Per-action gas is
// not perfectly uniform across action types (enter-swap vs. manage-any's mint/decrease/collect/burn differ in how
// much UniActionPolicy and MamoruActionPolicy storage they touch), so a batch's real gas can run several percent
// either side of this flat model's estimate — which is why t2-fork.ts's pass/fail check compares against Base's
// real 2^24 cap, not the model's own `DEFAULT_GAS_CEILING` target. `perSessionGas: 0`: across both runs, gas
// tracked action count closely (e.g. 24:12 actions was 14.14M:7.09M gas, 1.995:1) with no material fixed
// per-session cost showing up next to the per-action one. `perActionGas: 590_000n` is the first run's measured
// first-enable average (589,776, the more expensive case) rounded up for a small margin.

export type V4GasModel = { perActionGas: bigint; perSessionGas: bigint }

/** Calibrated from the fork measurement above (first enable, cold slots — the more expensive case). */
export const DEFAULT_GAS_MODEL: V4GasModel = { perActionGas: 590_000n, perSessionGas: 0n }

/** Renewals measure a little cheaper (warmer storage slots) — see the measurement comment above. */
export const RENEWAL_GAS_MODEL: V4GasModel = { perActionGas: 579_000n, perSessionGas: 0n }

/** Base's per-transaction gas cap is 2^24 = 16,777,216; the default ceiling keeps a margin under it. */
export const DEFAULT_GAS_CEILING = 14_000_000n

export function estimateSessionGas(actionCount: number, model: V4GasModel = DEFAULT_GAS_MODEL): bigint {
  return model.perSessionGas + model.perActionGas * BigInt(actionCount)
}

/**
 * Greedy, order-preserving bin packing: fills the current batch until the next item would push it over
 * `ceiling`, then starts a new one. Throws if a single item alone is already over the ceiling (it cannot be
 * split further at this level — see the file comment).
 */
export function splitBatches<T>(items: readonly T[], gasOf: (item: T) => bigint, ceiling: bigint = DEFAULT_GAS_CEILING): T[][] {
  const batches: T[][] = []
  let current: T[] = []
  let currentGas = 0n
  for (const item of items) {
    const g = gasOf(item)
    if (g > ceiling) throw new Error(`splitBatches: one item alone needs ${g} gas, over the ceiling ${ceiling}`)
    if (current.length > 0 && currentGas + g > ceiling) {
      batches.push(current)
      current = []
      currentGas = 0n
    }
    current.push(item)
    currentGas += g
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * `splitBatches` specialized to anything action-shaped (a `SmartSessionStruct`, or a `{ actions }` label pair):
 * no `@mamoru/account` import needed, so this package's dependency graph stays one-way (see the file header).
 */
export function splitSessionsByGas<T extends { actions: readonly unknown[] }>(
  sessions: readonly T[],
  model: V4GasModel = DEFAULT_GAS_MODEL,
  ceiling: bigint = DEFAULT_GAS_CEILING,
): T[][] {
  return splitBatches(sessions, (s) => estimateSessionGas(s.actions.length, model), ceiling)
}

// re-export so consumers that only need the param rule type don't have to reach into types.ts directly
export type { ParamRuleTemplate, GrantName }
