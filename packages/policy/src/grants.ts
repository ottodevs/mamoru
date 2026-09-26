import type { GrantTemplate } from './types.ts'

const APPROVE = 'approve(address,uint256)'
const EXACT_INPUT_SINGLE = 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'
const MINT = 'mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))'
const DECREASE = 'decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))'
const COLLECT = 'collect((uint256,address,uint128,uint128))'
const BURN = 'burn(uint256)'

export type PairSpec = {
  /** Savings asset, spent to enter and received on conversion. */
  stable: string
  /** The other token of the pool. */
  volatile: string
  token0: string
  token1: string
  fee: number
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
export function pairGrants(p: PairSpec, usage: { enterSwap: number; enterMint: number; manage: number }): GrantTemplate[] {
  const c = p.caps
  return [
    {
      name: 'enter-swap',
      perPosition: false,
      usageLimit: usage.enterSwap,
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
      ],
    },
    {
      name: 'enter-mint',
      perPosition: false,
      usageLimit: usage.enterMint,
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
      usageLimit: usage.manage,
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
      ],
    },
  ]
}
