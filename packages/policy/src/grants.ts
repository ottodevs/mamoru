import type { ActionPolicyTemplate, GrantName, GrantRole, GrantTemplate, UsageTier } from './types.ts'

/** A grant's usage limit: one number for every account, or tiers by account cap (#149). */
export type Usage = number | readonly UsageTier[]

function usageOf(u: Usage): Pick<GrantTemplate, 'usageLimit' | 'usageByCap'> {
  if (typeof u === 'number') return { usageLimit: u }
  if (!u.length) throw new Error('usage tiers: none given')
  for (let i = 1; i < u.length; i++) if (u[i]!.upToUsdc <= u[i - 1]!.upToUsdc) throw new Error('usage tiers: upToUsdc must ascend')
  return { usageLimit: u[0]!.usageLimit, usageByCap: u }
}

const APPROVE = 'approve(address,uint256)'
const EXACT_INPUT_SINGLE = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'
const MINT = 'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))'
const DECREASE = 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))'
const COLLECT = 'collect((uint256,address,uint128,uint128))'
const BURN = 'burn(uint256)'
/** MamoruActionPolicy.increase(IncreaseLiquidityParams), 0x4110c363: not the position manager's increaseLiquidity. */
const POLICY_INCREASE = 'increase((uint256,uint256,uint256,uint256,uint256,uint256))'
const MULTICALL_DEADLINE = 'multicall(uint256,bytes[])'

/**
 * otto/mamoru#140: an on-chain expiry for every engine swap. SwapRouter02.multicall(deadline, []) reverts once the
 * block is past `deadline` and otherwise does nothing; the engine puts it in the same batch as the swap, so a signed
 * userOp a bundler holds back cannot swap after it. The rules pin the array to empty (its offset is the third word,
 * its length 0): the call can carry nothing to execute, so it widens no scope. Smart Sessions has no per-userOp
 * expiry the session key could set (TimeFramePolicy is fixed at the grant), so this is the bound that holds.
 */
const SWAP_DEADLINE = {
  target: 'SwapRouter02',
  signature: MULTICALL_DEADLINE,
  params: [
    { field: 'deadline', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
    { field: 'dataOffset', index: 1, condition: 'EQUAL', ref: 64n, denial: 'POLICY_DENIED_TARGET' },
    { field: 'dataLength', index: 2, condition: 'EQUAL', ref: 0n, denial: 'POLICY_DENIED_TARGET' },
  ],
} as const

function swapDeadline(): GrantTemplate['actions'][number] {
  return { ...SWAP_DEADLINE, params: SWAP_DEADLINE.params.map((r) => ({ ...r })) }
}

export type PairSpec = {
  /** Savings asset, spent to enter and received on conversion. */
  stable: string
  /** The other token of the pool. */
  volatile: string
  token0: string
  token1: string
  fee: number
  /** Registry name of the pool; set on multi-pool policies so each pair's grants get their own session key. */
  pool?: string
  caps: {
    stableSwapPerCall: string
    stableSwapTotal: string
    mint0: string
    mint1: string
    volatileConvertPerCall: string
    volatileConvertTotal: string
  }
}

/**
 * The three grants of plan section 12.2. `manage` is per position: Smart
 * Sessions has no set membership, so each managed tokenId gets its own grant
 * with `tokenId EQUAL <id>`. The owner activates it only for an id this
 * session minted with enter-mint (plan section 12.4).
 */
export function pairGrants(p: PairSpec, usage: { enterSwap: Usage; enterMint: Usage; manage: Usage }): GrantTemplate[] {
  const c = p.caps
  const templates: GrantTemplate[] = [
    {
      name: 'enter-swap',
      perPosition: false,
      ...usageOf(usage.enterSwap),
      actions: [
        {
          target: p.stable,
          signature: APPROVE,
          params: [
            { field: 'spender', index: 0, condition: 'EQUAL', ref: 'SwapRouter02', denial: 'POLICY_DENIED_APPROVAL' },
            { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.stableSwapPerCall}`, denial: 'POLICY_DENIED_APPROVAL' },
          ],
        },
        {
          target: 'SwapRouter02',
          signature: EXACT_INPUT_SINGLE,
          params: [
            { field: 'tokenIn', index: 0, condition: 'EQUAL', ref: p.stable, denial: 'POLICY_DENIED_TARGET' },
            { field: 'tokenOut', index: 1, condition: 'EQUAL', ref: p.volatile, denial: 'POLICY_DENIED_TARGET' },
            { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
            { field: 'recipient', index: 3, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
            {
              field: 'amountIn',
              index: 4,
              condition: 'LESS_THAN_OR_EQUAL',
              ref: `cap:${c.stableSwapPerCall}`,
              cumulative: `cap:${c.stableSwapTotal}`,
              denial: 'POLICY_DENIED_AMOUNT',
            },
            { field: 'amountOutMinimum', index: 5, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
            { field: 'sqrtPriceLimitX96', index: 6, condition: 'EQUAL', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
          ],
        },
        swapDeadline(),
      ],
    },
    {
      name: 'enter-mint',
      perPosition: false,
      ...usageOf(usage.enterMint),
      actions: [
        {
          target: p.token0,
          signature: APPROVE,
          params: [
            { field: 'spender', index: 0, condition: 'EQUAL', ref: 'NonfungiblePositionManager', denial: 'POLICY_DENIED_APPROVAL' },
            { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.mint0}`, denial: 'POLICY_DENIED_APPROVAL' },
          ],
        },
        {
          target: p.token1,
          signature: APPROVE,
          params: [
            { field: 'spender', index: 0, condition: 'EQUAL', ref: 'NonfungiblePositionManager', denial: 'POLICY_DENIED_APPROVAL' },
            { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.mint1}`, denial: 'POLICY_DENIED_APPROVAL' },
          ],
        },
        {
          target: 'NonfungiblePositionManager',
          signature: MINT,
          params: [
            { field: 'token0', index: 0, condition: 'EQUAL', ref: p.token0, denial: 'POLICY_DENIED_TARGET' },
            { field: 'token1', index: 1, condition: 'EQUAL', ref: p.token1, denial: 'POLICY_DENIED_TARGET' },
            { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
            {
              field: 'amount0Desired',
              index: 5,
              condition: 'LESS_THAN_OR_EQUAL',
              ref: `cap:${c.mint0}`,
              cumulative: `cap:${c.mint0}`,
              denial: 'POLICY_DENIED_AMOUNT',
            },
            {
              field: 'amount1Desired',
              index: 6,
              condition: 'LESS_THAN_OR_EQUAL',
              ref: `cap:${c.mint1}`,
              cumulative: `cap:${c.mint1}`,
              denial: 'POLICY_DENIED_AMOUNT',
            },
            { field: 'amount0Min', index: 7, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
            { field: 'amount1Min', index: 8, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
            { field: 'recipient', index: 9, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
          ],
        },
      ],
    },
    {
      name: 'manage',
      perPosition: true,
      ...usageOf(usage.manage),
      actions: [
        {
          target: 'NonfungiblePositionManager',
          signature: DECREASE,
          params: [{ field: 'tokenId', index: 0, condition: 'EQUAL', ref: 'tokenId', denial: 'POLICY_DENIED_POSITION' }],
        },
        {
          target: 'NonfungiblePositionManager',
          signature: COLLECT,
          params: [
            { field: 'tokenId', index: 0, condition: 'EQUAL', ref: 'tokenId', denial: 'POLICY_DENIED_POSITION' },
            { field: 'recipient', index: 1, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
          ],
        },
        {
          target: 'NonfungiblePositionManager',
          signature: BURN,
          params: [{ field: 'tokenId', index: 0, condition: 'EQUAL', ref: 'tokenId', denial: 'POLICY_DENIED_POSITION' }],
        },
        {
          target: p.volatile,
          signature: APPROVE,
          params: [
            { field: 'spender', index: 0, condition: 'EQUAL', ref: 'SwapRouter02', denial: 'POLICY_DENIED_APPROVAL' },
            { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.volatileConvertPerCall}`, denial: 'POLICY_DENIED_APPROVAL' },
          ],
        },
        {
          target: 'SwapRouter02',
          signature: EXACT_INPUT_SINGLE,
          params: [
            { field: 'tokenIn', index: 0, condition: 'EQUAL', ref: p.volatile, denial: 'POLICY_DENIED_TARGET' },
            { field: 'tokenOut', index: 1, condition: 'EQUAL', ref: p.stable, denial: 'POLICY_DENIED_TARGET' },
            { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
            { field: 'recipient', index: 3, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
            {
              field: 'amountIn',
              index: 4,
              condition: 'LESS_THAN_OR_EQUAL',
              ref: `cap:${c.volatileConvertPerCall}`,
              cumulative: `cap:${c.volatileConvertTotal}`,
              denial: 'POLICY_DENIED_AMOUNT',
            },
            { field: 'amountOutMinimum', index: 5, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
            { field: 'sqrtPriceLimitX96', index: 6, condition: 'EQUAL', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
          ],
        },
        swapDeadline(),
      ],
    },
  ]
  return p.pool ? templates.map((t) => ({ ...t, pool: p.pool })) : templates
}

/** Session key of a grant: its name, or `name:pool` for the per-pair grants of a multi-pool policy. */
export function grantKey(t: { name: GrantName; pool?: string }): string {
  return t.pool ? `${t.name}:${t.pool}` : t.name
}

/**
 * The key of the grant that covers `role` in `pool` under this policy (plain `name` for single-pair policies). Under a
 * v4 policy (spec 007) the pool's one `engine` grant covers every role; a v1/v2 policy has none, so its keys are the
 * ones they always were.
 */
export function grantKeyFor(policy: { session: { grants: GrantTemplate[] } }, name: GrantName | GrantRole, pool: string): string {
  const gs = policy.session.grants
  const t = gs.find((g) => g.name === name && g.pool === pool) ?? gs.find((g) => g.name === name && !g.pool) ?? (ENGINE_ROLES.includes(name as GrantRole) ? gs.find((g) => g.name === 'engine' && g.pool === pool) : undefined)
  if (!t) throw new Error(`no ${name} grant for ${pool}`)
  return grantKey(t)
}

const ENGINE_ROLES: readonly GrantRole[] = ['enter-swap', 'enter-mint', 'manage-any', 'convert-any', 'increase']

/**
 * Live manage grants (owner decision 2026-09-26), enabled in the one
 * activation batch next to the enter grants, for any position of the pair
 * the Safe holds. Nothing in them can move a token or a position out of the
 * Safe: `collect` and `mint` pin `recipient` to the account, the swap pins
 * its recipient and both tokens, approvals name only the position manager or
 * the router with a per-call cap. `decreaseLiquidity` and `burn` take any
 * tokenId: the manager reverts for an id the Safe does not own, and neither
 * call pays anything out (burn needs an empty position).
 *
 * Two grants because Smart Sessions keys an action by target and selector:
 * the volatile token's `approve` goes to the manager for a mint and to the
 * router for a conversion, which one session cannot hold twice.
 * - `manage-any`: re-range, reduce and re-mint (decrease, collect, burn, mint).
 * - `convert-any`: harvest (collect, then volatile -> savings asset).
 */
export function manageAnyGrants(p: PairSpec, usage: { manage: Usage; convert: Usage }): GrantTemplate[] {
  const c = p.caps
  const collectToAccount = {
    target: 'NonfungiblePositionManager',
    signature: COLLECT,
    params: [{ field: 'recipient', index: 1, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' }],
  } as const
  const templates: GrantTemplate[] = [
    {
      name: 'manage-any',
      perPosition: false,
      ...usageOf(usage.manage),
      actions: [
        // UniActionPolicy refuses an action with no rule (PolicyNotInitialized): `tokenId > 0` admits any id.
        { target: 'NonfungiblePositionManager', signature: DECREASE, params: [{ field: 'tokenId', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_POSITION' }] },
        { ...collectToAccount, params: [...collectToAccount.params] },
        { target: 'NonfungiblePositionManager', signature: BURN, params: [{ field: 'tokenId', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_POSITION' }] },
        {
          target: p.token0,
          signature: APPROVE,
          params: [
            { field: 'spender', index: 0, condition: 'EQUAL', ref: 'NonfungiblePositionManager', denial: 'POLICY_DENIED_APPROVAL' },
            { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.mint0}`, denial: 'POLICY_DENIED_APPROVAL' },
          ],
        },
        {
          target: p.token1,
          signature: APPROVE,
          params: [
            { field: 'spender', index: 0, condition: 'EQUAL', ref: 'NonfungiblePositionManager', denial: 'POLICY_DENIED_APPROVAL' },
            { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.mint1}`, denial: 'POLICY_DENIED_APPROVAL' },
          ],
        },
        {
          target: 'NonfungiblePositionManager',
          signature: MINT,
          params: [
            { field: 'token0', index: 0, condition: 'EQUAL', ref: p.token0, denial: 'POLICY_DENIED_TARGET' },
            { field: 'token1', index: 1, condition: 'EQUAL', ref: p.token1, denial: 'POLICY_DENIED_TARGET' },
            { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
            { field: 'amount0Desired', index: 5, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.mint0}`, denial: 'POLICY_DENIED_AMOUNT' },
            { field: 'amount1Desired', index: 6, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.mint1}`, denial: 'POLICY_DENIED_AMOUNT' },
            { field: 'recipient', index: 9, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
          ],
        },
      ],
    },
    {
      name: 'convert-any',
      perPosition: false,
      ...usageOf(usage.convert),
      actions: [
        { ...collectToAccount, params: [...collectToAccount.params] },
        {
          target: p.volatile,
          signature: APPROVE,
          params: [
            { field: 'spender', index: 0, condition: 'EQUAL', ref: 'SwapRouter02', denial: 'POLICY_DENIED_APPROVAL' },
            { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.volatileConvertPerCall}`, denial: 'POLICY_DENIED_APPROVAL' },
          ],
        },
        {
          target: 'SwapRouter02',
          signature: EXACT_INPUT_SINGLE,
          params: [
            { field: 'tokenIn', index: 0, condition: 'EQUAL', ref: p.volatile, denial: 'POLICY_DENIED_TARGET' },
            { field: 'tokenOut', index: 1, condition: 'EQUAL', ref: p.stable, denial: 'POLICY_DENIED_TARGET' },
            { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
            { field: 'recipient', index: 3, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
            { field: 'amountIn', index: 4, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${c.volatileConvertPerCall}`, denial: 'POLICY_DENIED_AMOUNT' },
            { field: 'amountOutMinimum', index: 5, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
            { field: 'sqrtPriceLimitX96', index: 6, condition: 'EQUAL', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
          ],
        },
        swapDeadline(),
      ],
    },
  ]
  return p.pool ? templates.map((t) => ({ ...t, pool: p.pool })) : templates
}

/**
 * Spec 007 (otto/mamoru#151), policy v4: ONE session per pool for everything the engine does there, with
 * MamoruActionPolicy next to UniActionPolicy on every action (but the swap deadline, `uniOnly`). What a leaked key can do
 * is bounded on chain by the policy, not by splitting grants: prices within `bandTicks` of the pool's TWAP, only
 * positions minted through the policy for this account and still owned by it, token0/token1 spend per window and per
 * approval. UniActionPolicy keeps what it can express: recipients pinned to the account, pool tokens and fee, per-call
 * caps. Smart Sessions keys an action by target and selector, so one approve per token serves both spenders (the router
 * for a swap, the policy for a mint or an increase): the policy refuses any other spender, the position manager
 * included. One swap action takes both directions (the policy pins the pair).
 *
 * - mint names MamoruActionPolicy.mint (the manager's selector), which mints to the account and admits the tokenId;
 * - increase names MamoruActionPolicy.increase (otto/mamoru#171), which adds only to an admitted position the account
 *   still owns: no grant per position, ever;
 * - the swap has no `sqrtPriceLimitX96 EQUAL 0` rule: the policy requires a non-zero limit inside its band.
 */
export function engineGrants(p: PairSpec & { pool: string }, usage: Usage, ap: Omit<ActionPolicyTemplate, 'pool'>): GrantTemplate[] {
  const w0 = ap.perWindow0
  const w1 = ap.perWindow1
  const either = `cap:${w0.slice(4)}|${w1.slice(4)}` as const
  const action = (target: string, signature: string, params: GrantTemplate['actions'][number]['params']) => ({ target, signature, params })
  return [
    {
      name: 'engine',
      pool: p.pool,
      perPosition: false,
      ...usageOf(usage),
      actionPolicy: { pool: p.pool, ...ap },
      actions: [
        action(p.token0, APPROVE, [{ field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: w0, denial: 'POLICY_DENIED_APPROVAL' }]),
        action(p.token1, APPROVE, [{ field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: w1, denial: 'POLICY_DENIED_APPROVAL' }]),
        action('SwapRouter02', EXACT_INPUT_SINGLE, [
          { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
          { field: 'recipient', index: 3, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
          { field: 'amountIn', index: 4, condition: 'LESS_THAN_OR_EQUAL', ref: either, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'amountOutMinimum', index: 5, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
        ]),
        { ...swapDeadline(), uniOnly: true },
        action('MamoruActionPolicy', MINT, [
          { field: 'token0', index: 0, condition: 'EQUAL', ref: p.token0, denial: 'POLICY_DENIED_TARGET' },
          { field: 'token1', index: 1, condition: 'EQUAL', ref: p.token1, denial: 'POLICY_DENIED_TARGET' },
          { field: 'fee', index: 2, condition: 'EQUAL', ref: BigInt(p.fee), denial: 'POLICY_DENIED_TARGET' },
          { field: 'amount0Desired', index: 5, condition: 'LESS_THAN_OR_EQUAL', ref: w0, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'amount1Desired', index: 6, condition: 'LESS_THAN_OR_EQUAL', ref: w1, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'amount0Min', index: 7, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'amount1Min', index: 8, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'recipient', index: 9, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
        ]),
        action('MamoruActionPolicy', POLICY_INCREASE, [
          { field: 'tokenId', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_POSITION' },
          { field: 'amount0Desired', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: w0, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'amount1Desired', index: 2, condition: 'LESS_THAN_OR_EQUAL', ref: w1, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'amount0Min', index: 3, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'amount1Min', index: 4, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_AMOUNT' },
        ]),
        // UniActionPolicy refuses an action with no rule (PolicyNotInitialized): `tokenId > 0`; the policy admits only its own.
        action('NonfungiblePositionManager', DECREASE, [{ field: 'tokenId', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_POSITION' }]),
        action('NonfungiblePositionManager', COLLECT, [{ field: 'recipient', index: 1, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' }]),
        action('NonfungiblePositionManager', BURN, [{ field: 'tokenId', index: 0, condition: 'GREATER_THAN', ref: 0n, denial: 'POLICY_DENIED_POSITION' }]),
      ],
    },
  ]
}

/** The policy can add to a held position in `pool` (otto/mamoru#171): only a v4 `engine` grant can (spec 007). */
export function hasIncrease(policy: { session: { grants: GrantTemplate[] } }, pool: string): boolean {
  return policy.session.grants.some((g) => g.name === 'engine' && g.pool === pool)
}

/** Spec 007: the policy's grants carry MamoruActionPolicy (v4). */
export function usesActionPolicy(policy: { session: { grants: GrantTemplate[] } }): boolean {
  return policy.session.grants.some((g) => g.actionPolicy !== undefined)
}
