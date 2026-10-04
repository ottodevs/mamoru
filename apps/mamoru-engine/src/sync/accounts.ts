import type { Figure, ReasonCode, TokenHolding } from '@mamoru/domain'
import { multicall3Abi, type Address, type PublicClient } from 'viem'
import { balanceOfAbi } from './abis.ts'
import { valueAt, type Rate } from './math.ts'
import { estimateAt, fig, notObserved, rpcAt, type Anchor } from './provenance.ts'

export type AccountRow = { account_key: string; address: string }

export type AccountTokens = { USDC: Address; cbBTC: Address; WETH: Address }

export type AccountState = { deployed: boolean; tokens: TokenHolding[]; totalValue: string | null }

const ROLES: Record<TokenHolding['token'], TokenHolding['role']> = { USDC: 'plan', cbBTC: 'plan', WETH: 'outside_plan', ETH: 'gas' }

type Amounts = { usdc: bigint; cbbtc: bigint; weth: bigint; eth: bigint }

/** The projection of one account from its balances at `H`, valued in USDC as estimates. */
function stateOf(deployed: boolean, { usdc, cbbtc, weth, eth }: Amounts, anchor: Anchor, rates: ReadonlyMap<string, Rate>): AccountState {
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
  return { deployed, tokens: holdings, totalValue: total === null ? null : total.toString() }
}

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
  return stateOf(code !== undefined && code !== '0x', { usdc, cbbtc, weth, eth }, anchor, rates)
}

/** Accounts per Multicall3 request: four reads each, within the 100 calls a provider takes in one aggregate3. */
export const ACCOUNTS_PER_CALL = 25
/** viem splits a multicall by the bytes of the inner calls' calldata: a group has about 3,600 (100 reads of 36 bytes), so it is one eth_call. The aggregate3 request itself is larger, about 20 kB. */
const GROUP_BATCH_BYTES = 16_384

export type AccountRef = { key: string; address: Address }

/**
 * The state of every account at `H` in one Multicall3 request per ACCOUNTS_PER_CALL accounts, instead of five
 * requests per account. The code of an account is read only until it is known to be deployed (`knownDeployed`:
 * projected as deployed at a safe block, see deployedAccountKeys): a deployed Safe stays deployed. An account with a read that failed, or in a group
 * whose request failed, is left out and keeps its last projection.
 */
export async function readAccountStates(
  client: PublicClient,
  accounts: readonly AccountRef[],
  tokens: AccountTokens,
  anchor: Anchor,
  rates: ReadonlyMap<string, Rate>,
  knownDeployed: ReadonlySet<string>,
): Promise<Map<string, AccountState>> {
  const out = new Map<string, AccountState>()
  const multicall3 = client.chain?.contracts?.multicall3?.address
  const blockNumber = BigInt(anchor.blockNumber)
  if (!multicall3) {
    // No Multicall3 on this chain: one account at a time, as before.
    for (const a of accounts) {
      try {
        out.set(a.key, await readAccountState(client, a.address, tokens, anchor, rates))
      } catch {}
    }
    return out
  }
  for (let i = 0; i < accounts.length; i += ACCOUNTS_PER_CALL) {
    const group = accounts.slice(i, i + ACCOUNTS_PER_CALL)
    const contracts = group.flatMap((a) => [
      { address: multicall3, abi: multicall3Abi, functionName: 'getEthBalance', args: [a.address] } as const,
      ...[tokens.USDC, tokens.cbBTC, tokens.WETH].map((token) => ({ address: token, abi: balanceOfAbi, functionName: 'balanceOf', args: [a.address] }) as const),
    ])
    type Read = { status: 'success'; result: unknown } | { status: 'failure' }
    let results: Read[]
    let codes: (boolean | null)[]
    try {
      ;[results, codes] = await Promise.all([
        client.multicall({ contracts, blockNumber, batchSize: GROUP_BATCH_BYTES, allowFailure: true }) as Promise<Read[]>,
        Promise.all(
          group.map((a) =>
            knownDeployed.has(a.key)
              ? true
              : client.getCode({ address: a.address, blockNumber }).then(
                  (code) => code !== undefined && code !== '0x',
                  () => null,
                ),
          ),
        ),
      ])
    } catch {
      continue
    }
    group.forEach((a, j) => {
      const [eth, usdc, cbbtc, weth] = results.slice(j * 4, j * 4 + 4)
      const deployed = codes[j]
      if (deployed === null || deployed === undefined) return
      if (eth?.status !== 'success' || usdc?.status !== 'success' || cbbtc?.status !== 'success' || weth?.status !== 'success') return
      out.set(a.key, stateOf(deployed, { usdc: usdc.result as bigint, cbbtc: cbbtc.result as bigint, weth: weth.result as bigint, eth: eth.result as bigint }, anchor, rates))
    })
  }
  return out
}
