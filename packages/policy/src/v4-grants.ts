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
import { decodeAbiParameters, encodeAbiParameters } from 'viem'
import type { Address, Hex } from '@mamoru/domain'
import { BASE_CHAIN_ID } from '@mamoru/domain'
import { baseRegistry, address, registryFor, type Registry, type RegistryName } from '@mamoru/registry'
import { computeCaps } from './instantiate.ts'
import type { ActionRuleTemplate, CapFormula, GasCaps, GrantName, GrantTemplate, ParamRuleTemplate, PolicyVersion, ResolvedActionRule, SessionGrant } from './types.ts'

// ---------------------------------------------------------------- signatures (as grants.ts spells them)
// Kept local, like the T1 fixture did: this module must stand on its own so v2/v3 (grants.ts, policies.ts, both
// with open PRs elsewhere) are never touched by a v4 change.
const APPROVE_SIG = 'approve(address,uint256)'
const EXACT_INPUT_SINGLE_SIG = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'
const MINT_SIG = 'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))'
const DECREASE_SIG = 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))'
const COLLECT_SIG = 'collect((uint256,address,uint128,uint128))'
const BURN_SIG = 'burn(uint256)'
/** MamoruActionPolicyV2.increase(IncreaseLiquidityParams) (otto/mamoru#171): the policy's own, not the manager's increaseLiquidity. */
export const POLICY_INCREASE_SIG = 'increase((uint256,uint256,uint256,uint256,uint256,uint256))'
/** SwapRouter02.multicall(uint256,bytes[]): the engine's swap deadline (otto/mamoru#140). */
const MULTICALL_DEADLINE_SIG = 'multicall(uint256,bytes[])'

// ---------------------------------------------------------------- MamoruActionPolicy.Init encoding
// Mirrors contracts/action-policy/src/MamoruActionPolicy.sol's `Init` struct field for field. A unit test
// (v4-grants.test.ts) round-trips this against the Foundry build artifact's ABI.

export type MamoruInit = {
  /** The one Uniswap v3 pool this Init covers (an on-chain pool address, not a registry name). */
  pool: Address
  /** Long TWAP, seconds (= execution.twapWindowSeconds). */
  twapWindow: number
  /** Short TWAP, seconds (T6 M-1): the range uses the safer of the two. */
  twapShortWindow: number
  bandTicks: number
  /** Account-wide: a higher generation here retires every lower-generation config of the account, all pools. */
  generation: bigint
  /** T6 H-1: fixed reference the range is clipped to (tick), +- `anchorBand` ticks; anchorBand 0 = none. */
  anchorTick: number
  anchorBand: number
  /** Budget unit: false = token0, true = token1 — always the pool's stable token (T6 M-2). */
  budgetIn1: boolean
  /** Seconds for the bucket to refill from empty (T6 M-3). */
  budgetWindow: number
  /** Bucket capacity (W_p), in the budget unit. */
  perWindow: bigint
  /** Per-approval total (T_p), in the budget unit. */
  total: bigint
  /** Positions minted outside this deployment that the owner admits at enable (T6 M-4). MamoruActionPolicyV2 only:
   * an entry with REVOKE_FLAG set revokes that tokenId instead (LeftClaw M-4); admission otherwise survives renewals. */
  admit: readonly bigint[]
}

/** MamoruActionPolicyV2.REVOKE_FLAG: `tokenId | REVOKE_FLAG` in `Init.admit` revokes the position (V2 only; V1 would
 * read it as a tokenId and revert the enable). */
export const REVOKE_FLAG = 1n << 255n

export const MAMORU_INIT_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'pool', type: 'address' },
      { name: 'twapWindow', type: 'uint32' },
      { name: 'twapShortWindow', type: 'uint32' },
      { name: 'bandTicks', type: 'uint24' },
      { name: 'generation', type: 'uint64' },
      { name: 'anchorTick', type: 'int24' },
      { name: 'anchorBand', type: 'uint24' },
      { name: 'budgetIn1', type: 'bool' },
      { name: 'budgetWindow', type: 'uint32' },
      { name: 'perWindow', type: 'uint128' },
      { name: 'total', type: 'uint128' },
      { name: 'admit', type: 'uint256[]' },
    ],
  },
] as const

/** `abi.encode(Init)`: a dynamic struct (the `admit` array), encoded as one tuple, which is exactly what Solidity's
 * `abi.decode(data, (Init))` expects. */
export function encodeMamoruInit(i: MamoruInit): Hex {
  return encodeAbiParameters(MAMORU_INIT_TUPLE, [i])
}

/** `abi.decode(initData, (Init))`, for the guard in `toSmartSession` (it checks the Init's pool against the grant). */
export function decodeMamoruInit(data: Hex): MamoruInit {
  const [i] = decodeAbiParameters(MAMORU_INIT_TUPLE, data)
  return i
}

/** MamoruActionPolicyV3.FAMILY_UNISWAP_AT_SETUP: the first word of a setup-mode Init. */
export const FAMILY_UNISWAP_AT_SETUP = 3n

const SETUP_INIT_PARAMS = [{ type: 'uint256' }, ...MAMORU_INIT_TUPLE] as const

/**
 * otto/mamoru#251: MamoruActionPolicyV3's setup mode, `abi.encode(FAMILY_UNISWAP_AT_SETUP, Init)`, for a session
 * committed in the Safe setup. The enable reads no live market state (the ring and the M-5 depth run at the first
 * priced action instead), so the initializer deploys the same way on any later day. Only for the account's first
 * config of a pool, and never with `admit` (the contract refuses both: BadInit 14, 13).
 */
export function encodeMamoruInitAtSetup(i: MamoruInit): Hex {
  if (i.admit.length) throw new Error('encodeMamoruInitAtSetup: setup mode admits no position')
  return encodeAbiParameters(SETUP_INIT_PARAMS, [FAMILY_UNISWAP_AT_SETUP, i])
}

/** The Init in either encoding (`abi.encode(Init)`, whose first word is 0x20, or setup mode). */
export function decodeMamoruInitAny(data: Hex): { init: MamoruInit; atSetup: boolean } {
  if (BigInt(data.slice(0, 66)) === FAMILY_UNISWAP_AT_SETUP) {
    const [, init] = decodeAbiParameters(SETUP_INIT_PARAMS, data)
    return { init, atSetup: true }
  }
  return { init: decodeMamoruInit(data), atSetup: false }
}

// ---------------------------------------------------------------- MamoruGasPolicy.Caps (T6 L-1, T7 P1 2 and 4)

export const GAS_CAPS_TUPLE = [
  {
    type: 'tuple',
    components: [
      { name: 'maxPriorityFeePerGas', type: 'uint64' },
      { name: 'maxVerificationGasLimit', type: 'uint32' },
      { name: 'maxCallGasLimit', type: 'uint32' },
      { name: 'maxPreVerificationGas', type: 'uint32' },
      { name: 'maxFeePerGas', type: 'uint64' },
    ],
  },
] as const

/** `abi.encode(Caps)`: a static struct, five words. */
export function encodeGasCaps(c: GasCaps): Hex {
  return encodeAbiParameters(GAS_CAPS_TUPLE, [
    {
      maxPriorityFeePerGas: c.maxPriorityFeePerGas,
      maxVerificationGasLimit: Number(c.maxVerificationGasLimit),
      maxCallGasLimit: Number(c.maxCallGasLimit),
      maxPreVerificationGas: Number(c.maxPreVerificationGas),
      maxFeePerGas: c.maxFeePerGas,
    },
  ])
}

export function decodeGasCaps(data: Hex): GasCaps {
  const [c] = decodeAbiParameters(GAS_CAPS_TUPLE, data)
  return {
    maxPriorityFeePerGas: c.maxPriorityFeePerGas,
    maxVerificationGasLimit: BigInt(c.maxVerificationGasLimit),
    maxCallGasLimit: BigInt(c.maxCallGasLimit),
    maxPreVerificationGas: BigInt(c.maxPreVerificationGas),
    maxFeePerGas: c.maxFeePerGas,
  }
}

/**
 * The gas caps every v4 session is enabled with (owner-signed). The engine's userOps (packages/scenarios/driver/
 * engine.ts: LAB_GAS_LIMITS 3M / 2M / 100k, priority 1e6 wei, maxFeePerGas 2 x basefee + priority) fit under them at
 * Base basefees up to ~0.0495 gwei (about 10x the usual 0.005); above that the engine waits (GAS_PRICE_OVER_CAP).
 * What a leaked key can make the Safe pay per op: `maxGasCostPerOp(V4_GAS_CAPS)` = 0.1 gwei x 5.2M gas = 5.2e14 wei.
 */
export const V4_GAS_CAPS: GasCaps = {
  maxPriorityFeePerGas: 10_000_000n,
  maxVerificationGasLimit: 3_000_000n,
  maxCallGasLimit: 2_000_000n,
  maxPreVerificationGas: 200_000n,
  maxFeePerGas: 100_000_000n,
}

/**
 * otto/mamoru#214: the gas caps of the Monad sleeve's sessions. V4_GAS_CAPS prices gas in Base's 0.005-0.05 gwei; Monad
 * ran about 100 gwei on 2026-10-23, so under Base's 0.1 gwei cap the engine would wait forever (GAS_PRICE_OVER_CAP).
 * Same limits as Base (3M / 2M / 200k) and the same 10x headroom over the usual price: maxFeePerGas 1,000 gwei,
 * priority 1 gwei (the engine tips 1e6 wei). What a leaked key makes the Safe pay per op:
 * `maxGasCostPerOp(MONAD_GAS_CAPS)` = 1,000 gwei x 5.2M gas = 5.2 MON (the gas reserve is 2 MON, so a cap hit is still
 * bounded by what the Safe holds). Monad charges the gas limit, not gas used, which is why the limits stay tight.
 */
export const MONAD_GAS_CAPS: GasCaps = {
  maxPriorityFeePerGas: 1_000_000_000n,
  maxVerificationGasLimit: 3_000_000n,
  maxCallGasLimit: 2_000_000n,
  maxPreVerificationGas: 200_000n,
  maxFeePerGas: 1_000_000_000_000n,
}

/** MamoruGasPolicy.maxCostPerOp: the EntryPoint prefund at the capped price and limits, the most one op takes. */
export function maxGasCostPerOp(c: GasCaps): bigint {
  return c.maxFeePerGas * (c.maxVerificationGasLimit + c.maxCallGasLimit + c.maxPreVerificationGas)
}

/** Caps MamoruGasPolicy.initializeWithMultiplexer would accept (it reverts BadInit otherwise). */
export function validGasCaps(c: GasCaps): boolean {
  return c.maxPriorityFeePerGas > 0n && c.maxVerificationGasLimit > 0n && c.maxCallGasLimit > 0n && c.maxPreVerificationGas > 0n && c.maxFeePerGas >= c.maxPriorityFeePerGas
}

// ---------------------------------------------------------------- v4 pool table (spec 007 "Parameters")

export type V4PoolSpec = {
  /**
   * otto/mamoru#214: the chain whose registry resolves this pool's names (the pool, its tokens, the position manager).
   * Absent: Base (8453), which every pool before Monad is; left out of them so nothing about them changes.
   */
  sourceChainId?: number
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
  /**
   * MamoruActionPolicy budgets as multiples of Cp (otto/mamoru#151, Ot 18-Oct on the T5 Lab report
   * specs/007-onchain-action-policy/results/t5-bands-2026-10-18.md): W_p per day clears every peak day the Lab
   * measured (stables 4.85x, btc 1.94x, risk 2.38x); T_p per approval at 10x bounds a leaked key's loss near 13% of
   * the cap (spec 007's formula) where 3x ran out within weeks. Usage-triggered renewal asks for a tap before T_p binds.
   * T6 (M-2): one value budget per pool in the pool's stable token, swaps and mints of both tokens summed — not
   * one budget per token, which let ~2x the multiple cross.
   */
  windowMultiple: number
  totalMultiple: number
  /**
   * MamoruActionPolicy.Init.anchorTick/anchorBand (T6 H-1): a fixed price the range is clipped to. Only the stables
   * pool has one (parity, tick 0, +- 40 ticks): pushing USDC/USDT far for a block costs ~25 USDC, so its TWAPs can
   * be moved cheaply; the anchor bounds what that buys. Measurement in
   * specs/007-onchain-action-policy/results/t6-fixes-2026-10-18.md.
   */
  anchor?: { tick: number; band: number }
  /** Cap formula names this pool's grants reference (resolved to raw units by `computeCaps`, see instantiate.ts). */
  caps: {
    stableSwapPerCall: string
    stableSwapTotal: string
    mint0: string
    mint1: string
    /** Cumulative mint per approval (T_p): the per-call caps above stay small, the total follows the approval. */
    mint0Total: string
    mint1Total: string
    volatileConvertPerCall: string
    volatileConvertTotal: string
    /** MamoruActionPolicy.Init budgets in the stable token (spec 007 "Parameters": W_p, T_p; T6 M-2: one per pool). */
    budgetWindow: string
    budgetTotal: string
  }
}

function v4Caps(prefix: string): V4PoolSpec['caps'] {
  const n = (s: string) => `${prefix}${s}`
  return {
    stableSwapPerCall: n('SwapPerCall'),
    stableSwapTotal: n('SwapTotal'),
    mint0: n('Mint0'),
    mint1: n('Mint1'),
    mint0Total: n('Mint0Total'),
    mint1Total: n('Mint1Total'),
    volatileConvertPerCall: n('ConvertPerCall'),
    volatileConvertTotal: n('ConvertTotal'),
    budgetWindow: n('BudgetWindow'),
    budgetTotal: n('BudgetTotal'),
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
    // Cumulative grant-level caps follow the approval's T_p, so MamoruActionPolicy's budgets (measured in T5) are the
    // ones that bind; a 2x cumulative here would stall the engine within weeks, as T5 showed for 3x.
    { name: c.stableSwapTotal, asset: p.stable, bpsOfDeposit: p.capShareBps * p.totalMultiple },
    { name: c.mint0, asset: p.token0, bpsOfDeposit: p.capShareBps * 2 },
    { name: c.mint1, asset: p.token1, bpsOfDeposit: p.capShareBps * 2 },
    { name: c.mint0Total, asset: p.token0, bpsOfDeposit: p.capShareBps * p.totalMultiple },
    { name: c.mint1Total, asset: p.token1, bpsOfDeposit: p.capShareBps * p.totalMultiple },
    { name: c.volatileConvertPerCall, asset: p.volatile, bpsOfDeposit: p.capShareBps * 2 },
    { name: c.volatileConvertTotal, asset: p.volatile, bpsOfDeposit: p.capShareBps * p.totalMultiple },
    // W_p = windowMultiple x C_p per day, T_p = totalMultiple x C_p per approval (T5, Ot 18-Oct): one value budget
    // per pool in the stable token, both tokens summed at the policy's range edge (T6 M-2).
    { name: c.budgetWindow, asset: p.stable, bpsOfDeposit: p.capShareBps * p.windowMultiple },
    { name: c.budgetTotal, asset: p.stable, bpsOfDeposit: p.capShareBps * p.totalMultiple },
  ]
}

function v4Pool(pool: RegistryName, stable: RegistryName, volatile: RegistryName, token0: RegistryName, token1: RegistryName, fee: number, bandTicks: number, capShareBps: number, windowMultiple: number, totalMultiple: number, anchor: { tick: number; band: number } | undefined, prefix: string): V4PoolSpec {
  return { pool, stable, volatile, token0, token1, fee, bandTicks, capShareBps, windowMultiple, totalMultiple, ...(anchor ? { anchor } : {}), caps: v4Caps(prefix) }
}

/**
 * The three pools of conservadorLiveV2, with the v4 band ticks and cap shares of spec 007's "Parameters" table.
 * The stables pool's range is clipped to parity +- 40 ticks (T6 H-1): USDC and USDT both have 6 decimals, so
 * parity is tick 0 (the pool sat at tick 14 at Base block 52,700,000).
 */
export const V4_POOLS = {
  stables: v4Pool('pool:USDC/USDT/100', 'USDC', 'USDT', 'USDC', 'USDT', 100, 10, 5000, 5, 10, { tick: 0, band: 40 }, 'stables'),
  btc: v4Pool('pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 'USDC', 'cbBTC', 500, 100, 4000, 2, 10, undefined, 'btc'),
  risk: v4Pool('pool:WETH/USDC/3000', 'USDC', 'WETH', 'WETH', 'USDC', 3000, 100, 1000, 3, 10, undefined, 'risk'),
} as const satisfies Record<string, V4PoolSpec>

/**
 * otto/mamoru#214: the Monad sleeve's pool, WMON/USDC 0.30 % (token0 WMON, token1 USDC: the budget unit is token1, as
 * for WETH/USDC). The sleeve holds only the Growth bucket, 15 % of the account (v6, #201), and its caps are bps of the
 * cap of the sleeve account (its own Safe; the operator signs `capOf(sleeve)`), like Base's are of the account's:
 * - capShareBps 10000: the pool's share of the cap it is signed against is the bucket's share, and inside the sleeve
 *   the one bucket is all of it. The Growth 15 % of the user's account lives in the v6 remote bucket and the bridge caps,
 *   not here: 1500 would apply it twice and stall the first entry (swap about half, mint all) under a 15 % swap cap.
 * - windowMultiple 3, totalMultiple 10: the multiples of the volatile Base pool (WETH/USDC, risk), the closest pair the
 *   Lab measured (#151 T5: peak day 2.38x its share, so 3x clears it; 10x per approval bounds a leaked key near the
 *   spec's 13 % of the cap where 3x ran out within weeks). WMON is more volatile than WETH, so no lower multiple. What
 *   caps the funds at risk is not this budget (it counts swap and mint value, which churns) but the bridge: v6 lets at
 *   most 20 % of the cap cross per call and 50 % per approval, so the sleeve never holds more than that.
 * - bandTicks 100 (1 % either side of the 30 and 5 minute averages, as WETH/USDC): the band bounds how far a swap or a
 *   mint may sit from the market; the pool is the same fee tier and the engine's own max TWAP deviation is 100 ticks.
 *   Nothing measured on Monad argues for a different one yet; a tighter band would stall the engine on WMON's gaps.
 * - no anchor: WMON/USDC has no peg to clip to.
 */
export const V4_POOLS_MONAD = {
  growth: { ...v4Pool('pool:WMON/USDC/3000', 'USDC', 'WMON', 'WMON', 'USDC', 3000, 100, 10_000, 3, 10, undefined, 'growth'), sourceChainId: 143 },
} as const satisfies Record<string, V4PoolSpec>

export const TWAP_WINDOW_SECONDS = 1800 // spec 007 "Parameters": = execution.twapWindowSeconds
export const TWAP_SHORT_WINDOW_SECONDS = 300 // T6 M-1: the short TWAP of the range
export const BUDGET_WINDOW_SECONDS = 86_400 // spec 007 "Parameters": 1 day

/** The budget unit of `p`: its stable token, as `Init.budgetIn1`. */
export function budgetIn1(p: Pick<V4PoolSpec, 'stable' | 'token0' | 'token1'>): boolean {
  if (p.stable !== p.token0 && p.stable !== p.token1) throw new Error(`budgetIn1: ${p.stable} is neither token of the pool`)
  return p.stable === p.token1
}

/**
 * MamoruActionPolicy.Init for `p` at `generation`, from a resolved Caps object (see `v4CapFormulas` / `computeCaps`).
 * `opts.admit` (T6 M-4): tokenIds of this pool the account already holds (minted by v2/v3 grants, the owner, or an
 * earlier policy deployment) that the owner admits with this enable; every action of every session of the pool in
 * one generation must carry the same Init (the contract refuses a same-generation config that differs, except
 * `admit`).
 */
export function mamoruInitFor(
  p: V4PoolSpec,
  generation: bigint,
  caps: Record<string, bigint>,
  opts: { twapWindow?: number; twapShortWindow?: number; budgetWindow?: number; admit?: readonly bigint[] } = {},
): MamoruInit {
  // The pool address is read from the registry of the pool's own chain (Base unless the spec names another).
  const registry = p.sourceChainId === undefined || p.sourceChainId === BASE_CHAIN_ID ? baseRegistry : registryFor(p.sourceChainId)
  const need = (name: string): bigint => {
    const v = caps[name]
    if (v === undefined) throw new Error(`mamoruInitFor: missing cap ${name} (pool ${p.pool})`)
    return v
  }
  return {
    pool: address(p.pool, registry),
    twapWindow: opts.twapWindow ?? TWAP_WINDOW_SECONDS,
    twapShortWindow: opts.twapShortWindow ?? TWAP_SHORT_WINDOW_SECONDS,
    bandTicks: p.bandTicks,
    generation,
    anchorTick: p.anchor?.tick ?? 0,
    anchorBand: p.anchor?.band ?? 0,
    budgetIn1: budgetIn1(p),
    budgetWindow: opts.budgetWindow ?? BUDGET_WINDOW_SECONDS,
    perWindow: need(p.caps.budgetWindow),
    total: need(p.caps.budgetTotal),
    admit: opts.admit ?? [],
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
        { field: 'amount0Desired', index: 5, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.mint0}`, cumulative: `cap:${p.caps.mint0Total}`, denial: 'POLICY_DENIED_AMOUNT' },
        { field: 'amount1Desired', index: 6, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.mint1}`, cumulative: `cap:${p.caps.mint1Total}`, denial: 'POLICY_DENIED_AMOUNT' },
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

// ---------------------------------------------------------------- v5 grant templates (MamoruActionPolicyV2)
// Spec 007 (otto/mamoru#151, #171): the v4 grants plus two actions only MamoruActionPolicyV2 can carry. The v4
// builders above are untouched, so conservador-live-v4 and its hash do not change.

/**
 * The swap deadline (otto/mamoru#140), `SwapRouter02.multicall(deadline, [])`, with the same UniActionPolicy rules as
 * the v2/v3 grants (grants.ts SWAP_DEADLINE: deadline > 0, the array offset 0x40 and length 0) and, unlike them,
 * MamoruActionPolicyV2 next to it: V2 accepts only that exact empty encoding, after its generation and guardian-pause
 * checks, so a paused or retired grant cannot spend uses on it. V1 (the deployed v4 policy) refuses it, which is why
 * the v4 grants never had it.
 */
function swapDeadlineV5Action(): ActionRuleTemplate {
  return {
    target: 'SwapRouter02',
    signature: MULTICALL_DEADLINE_SIG,
    params: [
      { field: 'deadline', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
      { field: 'dataOffset', index: 1, condition: 'EQUAL', ref: 64n, denial: 'POLICY_DENIED_TARGET' },
      { field: 'dataLength', index: 2, condition: 'EQUAL', ref: 0n, denial: 'POLICY_DENIED_TARGET' },
    ],
  }
}

/**
 * otto/mamoru#171: add to a held position through MamoruActionPolicyV2.increase, never the manager's increaseLiquidity
 * (which does not check who owns the tokenId). The template names the position manager as a placeholder target, like
 * mint (a template has no address for the policy); `retargetToPolicy` points it at the deployed policy and the guard in
 * `toSmartSession` refuses a grant where it does not. Left un-retargeted it could not do anything either: the manager
 * has no `increase` function. UniActionPolicy keeps what it can express: a tokenId, the per-call amount caps of a mint,
 * positive minimums; the policy adds admission + ownership, the spot check at execution and the value budget.
 */
function increaseV5Action(p: V4PoolSpec): ActionRuleTemplate {
  return {
    target: 'NonfungiblePositionManager',
    signature: POLICY_INCREASE_SIG,
    params: [
      { field: 'tokenId', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_POSITION' },
      { field: 'amount0Desired', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.mint0}`, denial: 'POLICY_DENIED_AMOUNT' },
      { field: 'amount1Desired', index: 2, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.mint1}`, denial: 'POLICY_DENIED_AMOUNT' },
      { field: 'amount0Min', index: 3, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
      { field: 'amount1Min', index: 4, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
    ],
  }
}

/** v5 `enter-swap`: v4's approve and swap, then the swap deadline under the policy. */
export function enterSwapV5Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  return { name: 'enter-swap', pool: p.pool, perPosition: false, usageLimit, actions: [...enterSwapV4Actions(p), swapDeadlineV5Action()], requiresActionPolicy: true }
}

/** v5 `manage-any`: v4's seven actions, then increase through the policy and the swap deadline (its harvest swap). */
export function manageAnyV5Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  return { name: 'manage-any', pool: p.pool, perPosition: false, usageLimit, actions: [...manageAnyV4Actions(p), increaseV5Action(p), swapDeadlineV5Action()], requiresActionPolicy: true }
}

/** The three v5 grants of one pool: enter-swap (+deadline), enter-mint (as v4), manage-any (+increase, +deadline). */
export function grantsV5(p: V4PoolSpec, usage: V4Usage): GrantTemplate[] {
  return [enterSwapV5Grant(p, usage.enterSwap), enterMintV4Grant(p, usage.enterMint), manageAnyV5Grant(p, usage.manageAny)]
}

/**
 * otto/mamoru#251: one pool's grant under MamoruActionPolicyV3 alone: a single manage-any carrying every action of v5's
 * enter-swap, enter-mint and manage-any (each target and selector once), with no UniActionPolicy rule. V3 itself pins every
 * recipient to the account, the tokens, fee and approval spenders to the pool (the router or V3), mint and increase to
 * itself, and the value to the pool's budget (contracts/action-policy/src/MamoruActionPolicyV3.sol), so the three grants'
 * rules no longer tell them apart: one session per pool, whose usage is theirs together. Measured on a Base fork, one such
 * session takes ~2.7M gas to enable against ~6.7M for a v5 session (V3SetupFork.t.sol, operator logs of 29 Oct 2026),
 * which is what lets a whole v6 approval fit one owner transaction. `grantKeyFor` hands it out for enter-swap and enter-mint.
 */
export function manageAnyV3Only(p: V4PoolSpec, usage: V4Usage): GrantTemplate {
  const seen = new Set<string>()
  const actions = grantsV5(p, usage)
    .flatMap((g) => g.actions)
    .filter((a) => {
      const k = `${a.target}|${a.signature}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .map((a) => ({ ...a, params: [] }))
  return { name: 'manage-any', pool: p.pool, perPosition: false, usageLimit: usage.enterSwap + usage.enterMint + usage.manageAny, actions, requiresActionPolicy: true, actionPolicyOnly: true }
}

/** otto/mamoru#251: `exitOnlyV5Grant` under V3 alone: no mint, no increase, no approval of the stable token, no param rule. */
export function exitOnlyV3Only(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  const g = exitOnlyV5Grant(p, usageLimit)
  return { ...g, actions: g.actions.map((a) => ({ ...a, params: [] })), actionPolicyOnly: true }
}

/**
 * otto/mamoru#213: manage-any without a way in, for a pool a policy keeps only so its accounts can leave it (v6's
 * USDC/cbBTC at preference 0). It decreases, collects, burns and sells the volatile token for the stable one; it has no
 * mint, no increase and no approval of the stable token, so neither the engine nor a leaked key can put money into
 * the pool through it. Same key and caps as manage-any, under MamoruActionPolicy as every v5 grant.
 */
export function exitOnlyV5Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  const g = manageAnyV5Grant(p, usageLimit)
  const enters = (a: GrantTemplate['actions'][number]) => a.signature === MINT_SIG || a.signature === POLICY_INCREASE_SIG || (a.signature === APPROVE_SIG && a.target === p.stable)
  return { ...g, actions: g.actions.filter((a) => !enters(a)) }
}

/** The policy can add to a held position in `pool` (otto/mamoru#171): its manage-any there carries the policy's increase. */
export function hasIncrease(policy: { session: { grants: readonly GrantTemplate[] } }, pool: string): boolean {
  return policy.session.grants.some((g) => g.name === 'manage-any' && g.pool === pool && g.actions.some((a) => a.signature === POLICY_INCREASE_SIG))
}

export function enterSwapV4Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  return { name: 'enter-swap', pool: p.pool, perPosition: false, usageLimit, actions: enterSwapV4Actions(p), requiresActionPolicy: true }
}

export function enterMintV4Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  return { name: 'enter-mint', pool: p.pool, perPosition: false, usageLimit, actions: enterMintV4Actions(p), requiresActionPolicy: true }
}

/** The merged manage-any (spec 007: subsumes convert-any; the per-position `manage` grant is unnecessary in v4). */
export function manageAnyV4Grant(p: V4PoolSpec, usageLimit: number): GrantTemplate {
  return { name: 'manage-any', pool: p.pool, perPosition: false, usageLimit, actions: manageAnyV4Actions(p), requiresActionPolicy: true }
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
 *
 * Spec 007 (#151) T4: `opts.caps` (a resolved `Caps` object, same as `mamoruInitFor`'s own second argument) also
 * fills `actionPolicy.budgetsByPool` from each pool's `budgetWindow0/1`/`budgetTotal0/1` cap formulas, so precheck
 * can mirror checkAction's budget check too. Omitted: `budgetsByPool` stays unset, same as before this option
 * existed (precheck then skips the budget mirror for every pool, fail safe).
 */
export function withActionPolicy(
  policy: PolicyVersion,
  mamoruPolicy: Address,
  pools: readonly V4PoolSpec[],
  opts: { bandFactorBps?: number; caps?: Record<string, bigint>; budgetWindowSeconds?: number; twapShortWindowSeconds?: number; gasPolicy?: { address: Address; caps: GasCaps }; contractVersion?: 2 | 3; pauseGate?: Address } = {},
): PolicyVersion {
  const bandTicksByPool: Partial<Record<RegistryName, number>> = {}
  const anchorByPool: Partial<Record<RegistryName, { tick: number; band: number }>> = {}
  const budgetsByPool: Partial<Record<RegistryName, { windowSeconds: number; in1: boolean; perWindow: bigint; total: bigint }>> = {}
  for (const p of pools) {
    bandTicksByPool[p.pool] = p.bandTicks
    if (p.anchor) anchorByPool[p.pool] = p.anchor
    if (opts.caps) {
      const need = (name: string): bigint => {
        const v = opts.caps![name]
        if (v === undefined) throw new Error(`withActionPolicy: missing cap ${name} (pool ${p.pool})`)
        return v
      }
      budgetsByPool[p.pool] = {
        windowSeconds: opts.budgetWindowSeconds ?? BUDGET_WINDOW_SECONDS,
        in1: budgetIn1(p),
        perWindow: need(p.caps.budgetWindow),
        total: need(p.caps.budgetTotal),
      }
    }
  }
  return {
    ...policy,
    actionPolicy: {
      address: mamoruPolicy,
      bandTicksByPool,
      anchorByPool,
      twapShortWindowSeconds: opts.twapShortWindowSeconds ?? TWAP_SHORT_WINDOW_SECONDS,
      ...(opts.bandFactorBps !== undefined ? { bandFactorBps: opts.bandFactorBps } : {}),
      ...(opts.caps ? { budgetsByPool } : {}),
      ...(opts.gasPolicy ? { gasPolicy: opts.gasPolicy } : {}),
      ...(opts.contractVersion ? { contractVersion: opts.contractVersion } : {}),
      ...(opts.pauseGate ? { pauseGate: opts.pauseGate } : {}),
    },
  }
}

/**
 * The MamoruActionPolicy budget caps (W_p, T_p per pool) of `policy` at an account cap: they are all in the pool's
 * stable token (USDC), so no price is needed — the same values the owner signs into every Init of that cap. T7: the
 * operator sizes each v4 account's engine budgets with this (precheck mirror, usage-triggered renewal).
 */
export function v4BudgetCaps(policy: PolicyVersion, capUsdc: bigint): Record<string, bigint> {
  return computeCaps({ ...policy, session: { ...policy.session, caps: policy.session.caps.filter((f) => f.asset === 'USDC') } }, capUsdc, {})
}

/**
 * T7 (e): how much of a pool's per-approval budget (T_p) is spent, in bps, from `MamoruActionPolicy.budgetLeft`'s
 * second value (`totalLeft`) and the Init's `total`. The operator offers a renewal once it reaches USAGE_RENEW_BPS,
 * before the budget binds (spec 007 "A usage-triggered renewal asks the owner before T_p binds").
 */
export function budgetUsedBps(total: bigint, totalLeft: bigint): number {
  if (total <= 0n) return 10_000
  const spent = totalLeft >= total ? 0n : total - totalLeft
  return Number((spent * 10_000n) / total)
}

// ---------------------------------------------------------------- retargeting (template -> policy address)

/**
 * After `instantiateGrant` resolves a v4 template against the registry (mint and its approvals still pointing at
 * the NonfungiblePositionManager), rewrite them to the deployed MamoruActionPolicy: `mint`'s target (and, v5, `increase`'s), and the
 * `spender` of any approval that currently names the position manager (never the router-spender approvals of
 * enter-swap or the harvest leg of manage-any, left untouched). Spec 007: "`manage-any` names
 * `MamoruActionPolicy.mint` and approves the policy, not the NonfungiblePositionManager; `enter-mint` the same."
 */
export function retargetToPolicy(grant: SessionGrant, mamoruPolicy: Address, registry: Registry = baseRegistry): SessionGrant {
  // otto/mamoru#213: bridge-out is not a Uniswap call; MamoruActionPolicy would refuse it, so it never gets one.
  if (grant.requiresPauseGate) throw new Error(`retargetToPolicy: ${grant.name} takes MamoruPauseGate, never MamoruActionPolicy`)
  const npm = BigInt(address('NonfungiblePositionManager', registry))
  const policyRef = BigInt(mamoruPolicy)
  const actions: ResolvedActionRule[] = grant.actions.map((a) => {
    if (a.signature === MINT_SIG || a.signature === POLICY_INCREASE_SIG) return { ...a, targetAddress: mamoruPolicy }
    if (a.signature === APPROVE_SIG) {
      const i = a.params.findIndex((p) => p.field === 'spender' && p.ref === npm)
      if (i === -1) return a
      return { ...a, params: a.params.map((p, j) => (j === i ? { ...p, ref: policyRef } : p)) }
    }
    return a
  })
  // A retargeted mint/approve points AT the deployed policy: `toSmartSession` must never encode this grant without
  // that same policy as its second action policy (the authorization-parity guard, see `GrantTemplate.requiresActionPolicy`).
  // T7 (P1 3): the address is recorded so the guard can bind the second policy to it.
  return { ...grant, actions, requiresActionPolicy: true, actionPolicy: mamoruPolicy }
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

// ---------------------------------------------------------------- T7: one approval in consecutive owner transactions

/** Order a v4 approval enables its grants in: buckets by preference (highest first), and in each pool enter-swap,
 * enter-mint, manage-any. With the full 3-pool set and DEFAULT_GAS_CEILING this is two transactions: stables and the
 * btc entries first (17 actions), the btc manage-any and risk after (19). */
const V4_GRANT_ORDER = ['enter-swap', 'enter-mint', 'manage-any']

export function orderV4Keys(policy: PolicyVersion, keys: readonly string[]): string[] {
  const pools = [...policy.buckets].sort((a, b) => b.preference - a.preference).flatMap((b) => b.pools)
  const rank = (k: string): number => {
    const [name, ...rest] = k.split(':')
    const pool = rest.join(':')
    const pi = pools.indexOf(pool as RegistryName)
    return (pi === -1 ? pools.length : pi) * V4_GRANT_ORDER.length + Math.max(0, V4_GRANT_ORDER.indexOf(name!))
  }
  return [...keys].sort((a, b) => rank(a) - rank(b))
}

/**
 * Spec 007 T7 (c): the grant keys of one v4 approval split into consecutive owner transactions with
 * `splitSessionsByGas` (whole sessions, in `orderV4Keys` order). `overheadGas` is what the first transaction carries
 * besides `enableSessions` (the trust/attest calls of an activation, the `removeSession`s of a renewal); it is taken
 * off that transaction's ceiling. The operator sends `[0]` now; the rest are the account's missing grants, each added
 * by its own owner approval (the extend route) once the one before has landed.
 */
export function splitV4Keys(policy: PolicyVersion, keys: readonly string[], opts: { model?: V4GasModel; ceiling?: bigint; overheadGas?: bigint } = {}): string[][] {
  const ordered = orderV4Keys(policy, keys)
  const actions = (k: string) => policy.session.grants.find((g) => grantKeyOf(g) === k)?.actions.length ?? 0
  const ceiling = opts.ceiling ?? DEFAULT_GAS_CEILING
  const items = ordered.map((k) => ({ key: k, actions: Array.from({ length: actions(k) }) }))
  const first = splitSessionsByGas(items, opts.model, ceiling - (opts.overheadGas ?? 0n))[0] ?? []
  const rest = splitSessionsByGas(items.slice(first.length), opts.model, ceiling)
  return [first, ...rest].filter((b) => b.length > 0).map((b) => b.map((i) => i.key))
}

/**
 * otto/mamoru#151: the gas one owner transaction of a v4/v5 approval may take, by SIMULATION: about 2.2M under Base's
 * 2^24 = 16,777,216 per-transaction cap, for the relayer's estimate margin and state drift between the prepare and
 * the landing. The static model (`DEFAULT_GAS_MODEL`, 590k per action) only seeds the search; it no longer decides how
 * many transactions an approval takes.
 */
export const V4_TX_GAS_TARGET = 14_500_000n

/**
 * otto/mamoru#151: the longest prefix of `ordered` (whole sessions, in order) whose SIMULATED owner transaction stays at
 * or under `target`. Starts at `guess` (the static model's split), then grows one session at a time while the next
 * prefix still simulates under `target`, or shrinks while it does not. `simulate` answers null when the transaction
 * cannot be simulated (an undeployed Safe): then the static guess stands, as before. Never more than one simulation per
 * prefix length. Returns `n` = 0 when not even one session fits.
 */
export async function fitPrefixBySimulation(
  ordered: readonly string[],
  guess: number,
  simulate: (keys: string[]) => Promise<bigint | null>,
  target: bigint = V4_TX_GAS_TARGET,
): Promise<{ n: number; gas: bigint | null; simulated: boolean }> {
  if (!ordered.length) return { n: 0, gas: null, simulated: false }
  let n = Math.min(Math.max(guess, 1), ordered.length)
  const seen = new Map<number, bigint | null>()
  const sim = async (k: number) => {
    if (!seen.has(k)) seen.set(k, await simulate(ordered.slice(0, k)))
    return seen.get(k)!
  }
  let gas = await sim(n)
  if (gas === null) return { n, gas: null, simulated: false }
  if (gas <= target) {
    while (n < ordered.length) {
      const next = await sim(n + 1)
      if (next === null || next > target) break
      n += 1
      gas = next
    }
    return { n, gas, simulated: true }
  }
  while (n > 1) {
    n -= 1
    gas = (await sim(n))!
    if (gas === null) return { n, gas: null, simulated: false }
    if (gas <= target) return { n, gas, simulated: true }
  }
  return { n: 0, gas, simulated: true }
}

/** The static model calibrated on one simulated transaction: its gas less `overheadGas`, per action (never below 1). */
export function calibratedGasModel(gas: bigint, overheadGas: bigint, actions: number): V4GasModel {
  const per = actions > 0 && gas > overheadGas ? (gas - overheadGas + BigInt(actions) - 1n) / BigInt(actions) : DEFAULT_GAS_MODEL.perActionGas
  return { perActionGas: per > 0n ? per : 1n, perSessionGas: 0n }
}

function grantKeyOf(t: { name: string; pool?: string }): string {
  return t.pool ? `${t.name}:${t.pool}` : t.name
}

/** The V4PoolSpec of a pool, by registry name and chain (Base unless `sourceChainId` says otherwise; undefined for a pool that chain's v4 table does not have). */
export function v4PoolOf(pool: string | undefined, sourceChainId: number = BASE_CHAIN_ID): V4PoolSpec | undefined {
  return v4PoolsOn(sourceChainId).find((p) => p.pool === pool)
}

/** Every v4 pool spec of a chain. */
export function v4PoolsOn(sourceChainId: number = BASE_CHAIN_ID): V4PoolSpec[] {
  const all: V4PoolSpec[] = [...Object.values(V4_POOLS), ...Object.values(V4_POOLS_MONAD)]
  return all.filter((p) => (p.sourceChainId ?? BASE_CHAIN_ID) === sourceChainId)
}

// re-export so consumers that only need the param rule type don't have to reach into types.ts directly
export type { ParamRuleTemplate, GrantName }
