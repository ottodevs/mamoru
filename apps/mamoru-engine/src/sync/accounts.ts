import type { Figure, ReasonCode, TokenHolding } from '@mamoru/domain'
import { multicall3Abi, type Address, type PublicClient } from 'viem'
import type { DeployedProjection } from '../d1.ts'
import { balanceOfAbi, blockHashAbi } from './abis.ts'
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

/** Blocks of earlier projections whose hash is asked for in a run, fewer than the reads of one account. Every account read in a run shares its block, so this is one in practice. */
const VOUCHED_BLOCKS_PER_RUN = 3

/**
 * The state of every account at `H` in one Multicall3 request per ACCOUNTS_PER_CALL accounts, instead of five
 * requests per account. The code of an account is read only until it is known to be deployed: a deployed Safe
 * stays deployed, but only on the chain where it was seen. `projected` are the accounts last projected as
 * deployed, with the block and hash of that projection; a row vouches for the code only if that block still has
 * that hash as seen from `H`. The hashes ride in the first request (Multicall3.getBlockHash, in place of one
 * account's reads), so a steady run asks nothing more. A projection whose block was replaced (a safe block
 * follows L1, and L1 can reorg), or is more than 256 blocks back, vouches for nothing and that code is read again.
 * An account with a read that failed, or in a group whose request failed, is left out and keeps its last projection.
 */
export async function readAccountStates(
  client: PublicClient,
  accounts: readonly AccountRef[],
  tokens: AccountTokens,
  anchor: Anchor,
  rates: ReadonlyMap<string, Rate>,
  projected: readonly DeployedProjection[],
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
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const byBlock = new Map<number, DeployedProjection[]>()
  for (const r of projected) byBlock.set(r.block, [...(byBlock.get(r.block) ?? []), r])
  // A projection at this very block needs no question (BLOCKHASH does not answer for the block it runs in): the anchor's hash is in hand.
  const vouched = new Set<string>((byBlock.get(anchor.blockNumber) ?? []).filter((r) => same(r.blockHash, anchor.blockHash)).map((r) => r.accountKey))
  byBlock.delete(anchor.blockNumber)
  // Earlier blocks, the most shared first. Asked until one request answers; then never again.
  let asked: number[] | null = [...byBlock.keys()].sort((a, b) => byBlock.get(b)!.length - byBlock.get(a)!.length || b - a).slice(0, VOUCHED_BLOCKS_PER_RUN)
  if (asked.length === 0) asked = null
  for (let i = 0; i < accounts.length; ) {
    const hashes = asked ?? []
    const group = accounts.slice(i, i + ACCOUNTS_PER_CALL - (hashes.length > 0 ? 1 : 0))
    i += group.length
    const contracts = [
      ...hashes.map((n) => ({ address: multicall3, abi: blockHashAbi, functionName: 'getBlockHash', args: [BigInt(n)] }) as const),
      ...group.flatMap((a) => [
        { address: multicall3, abi: multicall3Abi, functionName: 'getEthBalance', args: [a.address] } as const,
        ...[tokens.USDC, tokens.cbBTC, tokens.WETH].map((token) => ({ address: token, abi: balanceOfAbi, functionName: 'balanceOf', args: [a.address] }) as const),
      ]),
    ]
    type Read = { status: 'success'; result: unknown } | { status: 'failure' }
    let results: Read[]
    let codes: (boolean | null)[]
    try {
      const all = (await client.multicall({ contracts, blockNumber, batchSize: GROUP_BATCH_BYTES, allowFailure: true })) as Read[]
      hashes.forEach((n, h) => {
        const r = all[h]
        if (r?.status !== 'success' || typeof r.result !== 'string') return
        for (const p of byBlock.get(n)!) if (same(p.blockHash, r.result)) vouched.add(p.accountKey)
      })
      asked = null
      results = all.slice(hashes.length)
      codes = await Promise.all(
        group.map((a) =>
          vouched.has(a.key)
            ? true
            : client.getCode({ address: a.address, blockNumber }).then(
                (code) => code !== undefined && code !== '0x',
                () => null,
              ),
        ),
      )
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
