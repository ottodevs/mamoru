import { encodeFunctionData, zeroAddress } from 'viem'
import type { Address, Hex } from '@mamoru/domain'
import { address, erc20Abi } from '@mamoru/registry'
import { burn, collect, decreaseLiquidity } from '@mamoru/uniswap-v3'
import type { MultiSendCall } from '../safe/index.ts'
import { revocationCalls } from '../sessions/index.ts'

export type WalkawayPosition = {
  tokenId: bigint
  /** Liquidity still in the position. 0 skips decreaseLiquidity, which reverts on 0. */
  liquidity: bigint
  amount0Min?: bigint
  amount1Min?: bigint
}

export type WalkawayInput = {
  account: Address
  /** Every grant still active on the account. */
  permissionIds: Hex[]
  positions: WalkawayPosition[]
  /** Address the owner chose. */
  recipient: Address
  /** What the account holds after the collects. 0 skips the transfer. */
  amounts: { USDC: bigint; cbBTC: bigint }
  deadline: bigint
}

export const WALKAWAY_TOKENS = ['USDC', 'cbBTC'] as const

function unique<T>(values: T[], label: string): void {
  if (new Set(values.map(String)).size !== values.length) throw new Error(`duplicate ${label}`)
}

/**
 * Owner walkaway (FR-ACC-009, plan 12.5): revoke every grant, close every
 * position with the account as collect recipient, then move USDC and cbBTC
 * to the owner's address. Pure: no RPC, no signing. The result is meant for
 * multiSendCallOnly inside one Safe execTransaction that any EOA can send.
 */
export function walkawayCalls(input: WalkawayInput): MultiSendCall[] {
  if (input.recipient === zeroAddress) throw new Error('recipient must be set')
  if (input.recipient.toLowerCase() === input.account.toLowerCase()) throw new Error('recipient must not be the account')
  unique(input.permissionIds.map((p) => p.toLowerCase()), 'permissionId')
  unique(input.positions.map((p) => p.tokenId), 'tokenId')

  const close = input.positions.flatMap((p) => [
    ...(p.liquidity > 0n
      ? [
          decreaseLiquidity({
            tokenId: p.tokenId,
            liquidity: p.liquidity,
            amount0Min: p.amount0Min ?? 0n,
            amount1Min: p.amount1Min ?? 0n,
            deadline: input.deadline,
          }),
        ]
      : []),
    collect({ account: input.account, tokenId: p.tokenId }),
    burn(p.tokenId),
  ])

  const transfers = WALKAWAY_TOKENS.filter((t) => input.amounts[t] > 0n).map((t) => ({
    to: address(t),
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [input.recipient, input.amounts[t]] }),
  }))

  return [...revocationCalls(input.permissionIds), ...close.map(({ to, value, data }) => ({ to, value, data })), ...transfers]
}
