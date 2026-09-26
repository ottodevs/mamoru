import type { Figure, ReasonCode, TokenHolding } from '@mamoru/domain'
import type { Address, PublicClient } from 'viem'
import { balanceOfAbi } from './abis.ts'
import { valueAt, type Rate } from './math.ts'
import { estimateAt, fig, notObserved, rpcAt, type Anchor } from './provenance.ts'

export type AccountRow = { account_key: string; address: string }

export type AccountTokens = { USDC: Address; cbBTC: Address; WETH: Address }

export type AccountState = { deployed: boolean; tokens: TokenHolding[]; totalValue: string | null }

const ROLES: Record<TokenHolding['token'], TokenHolding['role']> = { USDC: 'plan', cbBTC: 'plan', WETH: 'outside_plan', ETH: 'gas' }

/** Code, native balance and plan token balances of one account at `H`, valued in USDC as estimates. */
export async function readAccountState(
  client: PublicClient,
  account: Address,
  tokens: AccountTokens,
  anchor: Anchor,
  rates: ReadonlyMap<string, Rate>,
): Promise<AccountState> {
  const blockNumber = BigInt(anchor.blockNumber)
  const bal = (token: Address) => client.readContract({ address: token, abi: balanceOfAbi, functionName: 'balanceOf', args: [account], blockNumber })
  const [code, usdc, cbbtc, weth, eth] = await Promise.all([
    client.getCode({ address: account, blockNumber }),
    bal(tokens.USDC),
    bal(tokens.cbBTC),
    bal(tokens.WETH),
    client.getBalance({ address: account, blockNumber }),
  ])
  const amounts: [TokenHolding['token'], bigint][] = [['USDC', usdc], ['cbBTC', cbbtc], ['WETH', weth], ['ETH', eth]]
  let total: bigint | null = 0n
  const holdings = amounts.map(([token, amount]): TokenHolding => {
    // Native ETH is valued at the WETH rate.
    const rate = rates.get(token === 'ETH' ? 'WETH' : token)
    let value: Figure<string>
    if (rate) {
      const v = valueAt(amount, rate)
      value = fig(v.toString(), estimateAt(anchor), 'USDC')
      if (total !== null) total += v
    } else {
      value = notObserved(anchor, 'EHG_QUOTE_UNAVAILABLE', 'USDC', 'estimate')
      total = null
    }
    const holding: TokenHolding = { token, role: ROLES[token], amount: fig(amount.toString(), rpcAt(anchor), token), value }
    const code: ReasonCode | undefined = token === 'WETH' && amount > 0n ? 'OBS_UNMANAGED_ASSET' : undefined
    if (code) holding.code = code
    return holding
  })
  return { deployed: code !== undefined && code !== '0x', tokens: holdings, totalValue: total === null ? null : total.toString() }
}
