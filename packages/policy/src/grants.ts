import type { GrantName, GrantTemplate, UsageTier } from './types.ts'

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

/** The key of the grant `name` that covers `pool` in this policy (plain `name` for single-pair policies). */
export function grantKeyFor(policy: { session: { grants: GrantTemplate[] } }, name: GrantName, pool: string): string {
  const t = policy.session.grants.find((g) => g.name === name && g.pool === pool) ?? policy.session.grants.find((g) => g.name === name && !g.pool)
  if (!t) throw new Error(`no ${name} grant for ${pool}`)
  return grantKey(t)
}

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

const DEPOSIT_FOR_BURN = 'depositForBurn(uint256,uint32,bytes32,address,bytes32,uint256,uint32)'

/** Circle CCTP V2 domain of Monad (MessageTransmitterV2.localDomain() on chain 143, read 2026-10-27). */
export const CCTP_DOMAIN_MONAD = 15n

export type BridgeOutSpec = {
  /** CCTP V2 domain the USDC is minted on. */
  destinationDomain: bigint
  caps: { perCall: string; total: string; maxFee: string }
}

/**
 * otto/mamoru#213: the session key may move savings to the account's sleeve on another chain, and nowhere else. CCTP
 * V2 burns USDC here and mints the same amount there, less at most `maxFee`, so every rule is a fixed-position word:
 * the minted USDC goes to this same account address (`mintRecipient`, the sleeve shares the Safe address), to one
 * domain, with no hook and an open `destinationCaller` (anyone may relay the mint; a pinned caller could only stall
 * it). Across `depositV3` is not offered to the key: its `outputAmount` is a separate word no rule can tie to
 * `inputAmount`, so a leaked key could hand a relayer the difference. A leaked key here can at most pay `maxFee` per
 * call, within the usage limit, and every burned cent lands on the account's own address on the destination chain.
 * Plain UniActionPolicy: MamoruActionPolicy knows only the Uniswap calls, so this grant is never retargeted to it.
 */
export function bridgeOutGrant(p: BridgeOutSpec, usage: Usage): GrantTemplate {
  return {
    name: 'bridge-out',
    perPosition: false,
    ...usageOf(usage),
    actions: [
      {
        target: 'USDC',
        signature: APPROVE,
        params: [
          { field: 'spender', index: 0, condition: 'EQUAL', ref: 'TokenMessengerV2', denial: 'POLICY_DENIED_APPROVAL' },
          { field: 'amount', index: 1, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.perCall}`, denial: 'POLICY_DENIED_APPROVAL' },
        ],
      },
      {
        target: 'TokenMessengerV2',
        signature: DEPOSIT_FOR_BURN,
        params: [
          { field: 'amount', index: 0, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.perCall}`, cumulative: `cap:${p.caps.total}`, denial: 'POLICY_DENIED_AMOUNT' },
          { field: 'destinationDomain', index: 1, condition: 'EQUAL', ref: p.destinationDomain, denial: 'POLICY_DENIED_TARGET' },
          { field: 'mintRecipient', index: 2, condition: 'EQUAL', ref: 'ACCOUNT', denial: 'POLICY_DENIED_RECIPIENT' },
          { field: 'burnToken', index: 3, condition: 'EQUAL', ref: 'USDC', denial: 'POLICY_DENIED_TARGET' },
          { field: 'destinationCaller', index: 4, condition: 'EQUAL', ref: 0n, denial: 'POLICY_DENIED_TARGET' },
          { field: 'maxFee', index: 5, condition: 'LESS_THAN_OR_EQUAL', ref: `cap:${p.caps.maxFee}`, denial: 'POLICY_DENIED_AMOUNT' },
        ],
      },
    ],
  }
}
