import { Hono } from 'hono'
import { BASE_CHAIN_ID, type Address, type OtherChainFunds, type OtherChainsView } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import { accountNotFound, apiError } from '../errors.ts'
import { ACCOUNT_KEY } from '../onboarding/account.ts'
import { ownedAccount } from './store.ts'

// Wrong-network notice (ticket #117). An owner who sends USDC on Ethereum to the address shown for Base
// sees nothing arrive, because every Mamoru balance is a read of Base. This reads the same address on
// Ethereum so the app can say where the money is. It only reads and only reports: the result has its own
// type, is tagged with the chain id it was read on, and reaches neither D1, the operator nor FundingView.

export type ChainFetch = (input: string, init: RequestInit) => Promise<Response>

export type WatchedChain = { chainId: number; name: string; usdc: Address }

/** Chains read for misdirected transfers. USDC is Circle's FiatTokenProxy on Ethereum Mainnet. */
export const WATCHED_CHAINS: readonly WatchedChain[] = [{ chainId: 1, name: 'Ethereum', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' }]

export const RPC_TIMEOUT_MS = 8_000
/** One read per address in this window: the SPA polls, the RPC is not ours. */
export const CACHE_MS = 30_000
const CACHE_MAX = 500

const QUANTITY = /^0x(0|[1-9a-f][0-9a-f]*)$/i
const WORD = /^0x[0-9a-f]{64}$/i
const BALANCE_OF = '0x70a08231'

type RpcCall = { method: string; params: unknown[] }

/** A JSON-RPC batch, answers in the order asked. Throws on any transport, HTTP or RPC error and on a missing answer. */
async function rpcBatch(fetcher: ChainFetch, url: string, calls: RpcCall[]): Promise<unknown[]> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(calls.map((c, id) => ({ jsonrpc: '2.0', id, method: c.method, params: c.params }))),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`rpc http ${res.status}`)
  const body = (await res.json()) as unknown
  if (!Array.isArray(body)) throw new Error('rpc answer is not a batch')
  return calls.map((_, id) => {
    const item = (body as { id?: unknown; result?: unknown; error?: unknown }[]).find((r) => r?.id === id)
    if (!item || item.error !== undefined || item.result === undefined) throw new Error(`rpc call ${id} failed`)
    return item.result
  })
}

function quantity(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !QUANTITY.test(v)) throw new Error(`${what} is not a quantity`)
  return BigInt(v)
}

/**
 * USDC and ETH at `address` on `chain`, both at one block. The node must say it is `chain` first:
 * a URL that points anywhere else (Base included) reads as not observed, never as a balance.
 */
export async function readOtherChain(fetcher: ChainFetch, url: string | undefined, chain: WatchedChain, address: Address, now: Date): Promise<OtherChainFunds> {
  const observedAt = now.toISOString()
  const missing: OtherChainFunds = { chainId: chain.chainId, name: chain.name, status: 'not_observed', observedAt }
  if (!url) return missing
  try {
    const [id, head] = await rpcBatch(fetcher, url, [
      { method: 'eth_chainId', params: [] },
      { method: 'eth_blockNumber', params: [] },
    ])
    if (quantity(id, 'chain id') !== BigInt(chain.chainId)) throw new Error('rpc is on another chain')
    const block = quantity(head, 'block number')
    const tag = `0x${block.toString(16)}`
    const [again, usdc, eth] = await rpcBatch(fetcher, url, [
      { method: 'eth_chainId', params: [] },
      { method: 'eth_call', params: [{ to: chain.usdc, data: `${BALANCE_OF}${address.slice(2).toLowerCase().padStart(64, '0')}` }, tag] },
      { method: 'eth_getBalance', params: [address, tag] },
    ])
    if (quantity(again, 'chain id') !== BigInt(chain.chainId)) throw new Error('rpc is on another chain')
    if (typeof usdc !== 'string' || !WORD.test(usdc)) throw new Error('balanceOf is not one word')
    return { chainId: chain.chainId, name: chain.name, status: 'observed', block: Number(block), usdc: BigInt(usdc).toString(), eth: quantity(eth, 'balance').toString(), observedAt }
  } catch (e) {
    // The URL may carry a key: log the reason only.
    console.error('other chain not observed', chain.chainId, e instanceof Error ? e.message : String(e))
    return missing
  }
}

export function otherChainRoutes(fetcher: ChainFetch) {
  const routes = new Hono<AppEnv>()
  const cache = new Map<string, { at: number; view: OtherChainsView }>()

  // TEN: same ownership rule as the dashboard. The address read is the account's own, taken from its row.
  routes.get('/:accountKey/other-chains', async (c) => {
    const session = await c.var.auth.current(c)
    if (!session) return apiError(c, 401, 'Sign in first.', 'AUTH_REQUIRED')
    const accountKey = c.req.param('accountKey')
    if (!ACCOUNT_KEY.test(accountKey)) return accountNotFound(c)
    const account = await ownedAccount(c.env.DB, session.userId, accountKey)
    if (!account) return accountNotFound(c)
    c.set('accountKey', account.account_key)

    const now = c.var.now()
    const hit = cache.get(account.account_key)
    if (hit && now.getTime() - hit.at >= 0 && now.getTime() - hit.at < CACHE_MS) return c.json(hit.view)

    // Only for an account that lives on Base, and never the chain the account is on: that one is the operator's to read.
    const watched = account.chain_id === BASE_CHAIN_ID ? WATCHED_CHAINS.filter((w) => w.chainId !== account.chain_id) : []
    const chains = await Promise.all(watched.map((w) => readOtherChain(fetcher, c.env.ETHEREUM_RPC_URL, w, account.address, now)))
    const view: OtherChainsView = { address: account.address, accountChainId: account.chain_id, chains }
    if (chains.length > 0 && chains.every((ch) => ch.status === 'observed')) {
      if (cache.size >= CACHE_MAX) cache.clear()
      cache.set(account.account_key, { at: now.getTime(), view })
    }
    return c.json(view)
  })
  return routes
}
