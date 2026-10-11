import { Hono } from 'hono'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
import { BASE_CHAIN_ID, type Address, type OtherChainFunds, type OtherChainsView } from '@mamoru/domain'
import type { AppEnv } from '../context.ts'
import type { RateLimiter } from '../env.ts'
import { accountNotFound, apiError } from '../errors.ts'
import { ACCOUNT_KEY } from '../onboarding/account.ts'
import { ownedAccount } from './store.ts'

// Wrong-network notice (ticket #117). An owner who sends USDC on Ethereum to the address shown for Base
// sees nothing arrive, because every Mamoru balance is a read of Base. This reads the same address on
// Ethereum so the app can say where the money is. It only reads and only reports: the result has its own
// type, is tagged with the chain id it was read on, and reaches neither D1, the operator nor FundingView.

export type ChainFetch = (input: string, init: RequestInit) => Promise<Response>

export type WatchedChain = { chainId: number; name: string; usdc: Address; multicall3: Address }

/**
 * Chains read for misdirected transfers. USDC is Circle's FiatTokenProxy on Ethereum Mainnet; Multicall3 is at
 * its canonical address there (same code as the entry the Base registry pins).
 */
export const WATCHED_CHAINS: readonly WatchedChain[] = [
  { chainId: 1, name: 'Ethereum', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' },
]

/** Per provider. A read tries at most MAX_PROVIDERS of them, one after the other. */
export const RPC_TIMEOUT_MS = 4_000
export const MAX_PROVIDERS = 3
/** One read per account in this window: the SPA polls, the RPC is not ours. */
export const CACHE_MS = 30_000
/** A read that failed is not repeated before this: an owner cannot spend the RPC quota by asking again. */
export const FAIL_MS = 10_000
/** While a read is under way no second one starts for that account. Longer than every provider timing out in turn, so a read that was abandoned frees itself. */
export const PENDING_MS = RPC_TIMEOUT_MS * MAX_PROVIDERS + 2_000
export const GATE_MAX = 500

const abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getChainId() view returns (uint256)',
  'function getBlockNumber() view returns (uint256)',
  'function getEthBalance(address addr) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
])

const WORD = /^0x[0-9a-f]{64}$/i
const HEX = /^0x([0-9a-f]{2})*$/i

/** A reason this module wrote itself: fixed text, safe to log. Anything else thrown may quote the RPC URL. */
class ReadError extends Error {}

/** One eth_call at the head. Throws on any transport, HTTP or RPC error. */
async function ethCall(fetcher: ChainFetch, url: string, to: Address, data: string): Promise<`0x${string}`> {
  let res: Response
  let body: unknown
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
    body = res.ok ? ((await res.json()) as unknown) : null
  } catch {
    throw new ReadError('rpc unreachable')
  }
  if (!res.ok) throw new ReadError(`rpc http ${res.status}`)
  const answer = body as { result?: unknown; error?: unknown } | null
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer) || answer.error !== undefined) throw new ReadError('rpc call failed')
  if (typeof answer.result !== 'string' || !HEX.test(answer.result) || answer.result === '0x') throw new ReadError('rpc answer is not call data')
  return answer.result as `0x${string}`
}

/**
 * The provider pool from ETHEREUM_RPC_URLS: https URLs separated by commas or white space, tried in the order
 * written. Anything that is not an https URL is dropped, and only the first MAX_PROVIDERS are used.
 */
export function providerUrls(raw: string | undefined): string[] {
  const urls = (raw ?? '').split(/[\s,]+/).filter((u) => {
    try {
      return new URL(u).protocol === 'https:'
    } catch {
      return false
    }
  })
  return [...new Set(urls)].slice(0, MAX_PROVIDERS)
}

type Balances = { block: number; usdc: string; eth: string }

/**
 * One provider. The chain id, the block and both balances come out of ONE EVM execution
 * (Multicall3.aggregate3), so they cannot come from different chains or blocks whatever sits in front of the
 * node: a gateway that sends this call to Base answers chain id 8453 and is refused.
 */
async function readProvider(fetcher: ChainFetch, url: string, chain: WatchedChain, address: Address): Promise<Balances> {
  const own = (functionName: 'getChainId' | 'getBlockNumber') => ({ target: chain.multicall3, allowFailure: true, callData: encodeFunctionData({ abi, functionName }) })
  const data = encodeFunctionData({
    abi,
    functionName: 'aggregate3',
    args: [
      [
        own('getChainId'),
        own('getBlockNumber'),
        { target: chain.multicall3, allowFailure: true, callData: encodeFunctionData({ abi, functionName: 'getEthBalance', args: [address] }) },
        { target: chain.usdc, allowFailure: true, callData: encodeFunctionData({ abi, functionName: 'balanceOf', args: [address] }) },
      ],
    ],
  })
  const raw = await ethCall(fetcher, url, chain.multicall3, data)
  let results: readonly { success: boolean; returnData: `0x${string}` }[]
  try {
    results = decodeFunctionResult({ abi, functionName: 'aggregate3', data: raw })
  } catch {
    throw new ReadError('answer is not an aggregate3 result')
  }
  if (results.length !== 4) throw new ReadError('answer does not have four results')
  // A token address with no code answers success with no data: one full word or it is not a balance.
  const [id, block, eth, usdc] = results.map((r) => {
    if (!r.success || !WORD.test(r.returnData)) throw new ReadError('a read inside the call failed')
    return BigInt(r.returnData)
  }) as [bigint, bigint, bigint, bigint]
  if (id !== BigInt(chain.chainId)) throw new ReadError('rpc is on another chain')
  if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReadError('block number out of range')
  return { block: Number(block), usdc: usdc.toString(), eth: eth.toString() }
}

/**
 * USDC and ETH at `address` on `chain`, from the first provider of the pool that gives a whole answer. Each
 * answer stands on its own (see readProvider): values from two providers are never combined. No provider, or
 * every one failing, is not observed.
 */
export async function readOtherChain(fetcher: ChainFetch, urls: readonly string[], chain: WatchedChain, address: Address, now: Date): Promise<OtherChainFunds> {
  const observedAt = now.toISOString()
  for (const [i, url] of urls.slice(0, MAX_PROVIDERS).entries()) {
    try {
      const found = await readProvider(fetcher, url, chain, address)
      return { chainId: chain.chainId, name: chain.name, status: 'observed', ...found, observedAt }
    } catch (e) {
      // The URL carries a key and a foreign error may quote it: the provider is named by its place in the list, and only this module's own reasons are logged.
      console.error('other chain not observed', chain.chainId, `provider ${i + 1} of ${urls.length}`, e instanceof ReadError ? e.message : 'unexpected error')
    }
  }
  return { chainId: chain.chainId, name: chain.name, status: 'not_observed', observedAt }
}

type Slot = { at: number; state: 'pending' | 'ok' | 'failed'; view?: OtherChainsView }
const LIFETIME = { pending: PENDING_MS, ok: CACHE_MS, failed: FAIL_MS } as const

export type Admission =
  | { kind: 'cached'; view: OtherChainsView }
  /** A read for this account is under way: do not start another. */
  | { kind: 'busy' }
  /** Every slot is live and none is this account's: this read cannot be tracked. */
  | { kind: 'full' }
  | { kind: 'read'; done: (view: OtherChainsView) => void; cancel: () => void }

/**
 * Decides whether a request may read the RPC. It keeps values, never promises: on Workers a promise belongs to
 * the request that created it and may never settle if that request goes away, so nothing here waits on another
 * request. A slot leaves only when its own time is up, so filling the table cannot erase a read under way or a
 * failure's backoff; what a newcomer does when it is full is the caller's decision.
 */
export class ReadGate {
  private readonly slots = new Map<string, Slot>()
  constructor(private readonly max = GATE_MAX) {}

  private live(slot: Slot, now: number): boolean {
    const age = now - slot.at
    return age >= 0 && age < LIFETIME[slot.state]
  }

  admit(key: string, now: number): Admission {
    const hit = this.slots.get(key)
    if (hit && this.live(hit, now)) return hit.view ? { kind: 'cached', view: hit.view } : { kind: 'busy' }
    if (!hit && this.slots.size >= this.max) {
      for (const [k, slot] of this.slots) if (!this.live(slot, now)) this.slots.delete(k)
      if (this.slots.size >= this.max) return { kind: 'full' }
    }
    const slot: Slot = { at: now, state: 'pending' }
    this.slots.set(key, slot)
    return {
      kind: 'read',
      done: (view) => {
        slot.view = view
        slot.state = view.chains.every((ch) => ch.status === 'observed') ? 'ok' : 'failed'
      },
      // The read did not start: give the slot back, unless a later request already replaced it.
      cancel: () => {
        if (this.slots.get(key) === slot) this.slots.delete(key)
      },
    }
  }
}

/** True when the account may read now. Null when there is no limiter or it could not answer: the gate alone decides then. */
async function allowed(limiter: RateLimiter | undefined, key: string): Promise<boolean | null> {
  if (!limiter) return null
  try {
    return (await limiter.limit({ key })).success
  } catch {
    console.error('other chains: rate limiter did not answer')
    return null
  }
}

export function otherChainRoutes(fetcher: ChainFetch, gate = new ReadGate()) {
  const routes = new Hono<AppEnv>()

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
    // Only for an account that lives on Base, and never the chain the account is on: that one is the operator's to read.
    const watched = account.chain_id === BASE_CHAIN_ID ? WATCHED_CHAINS.filter((w) => w.chainId !== account.chain_id) : []
    const view = (chains: OtherChainFunds[]): OtherChainsView => ({ address: account.address, accountChainId: account.chain_id, chains })

    const notRead = () => c.json(view(watched.map((w) => ({ chainId: w.chainId, name: w.name, status: 'not_observed' as const, observedAt: now.toISOString() }))))
    const read = async () => view(await Promise.all(watched.map((w) => readOtherChain(fetcher, providerUrls(c.env.ETHEREUM_RPC_URLS), w, account.address, now))))

    // Two limits. The gate is this isolate's cache: one read per account per window, none while one is under way.
    // The limiter counts an account's reads across isolates. A request that is not read answers not observed,
    // which the SPA shows as nothing; the next poll asks again.
    const admission = gate.admit(account.account_key, now.getTime())
    if (admission.kind === 'cached') return c.json(admission.view)
    if (admission.kind === 'busy') return notRead()
    const ok = await allowed(c.env.OTHER_CHAINS_LIMIT, account.account_key)
    if (admission.kind === 'full') {
      // No room to track this account. With the limiter vouching for its rate it is read anyway, so other accounts
      // filling the table cannot hide its notice. Without a limiter the table is the only bound, and it holds.
      return ok === true ? c.json(await read()) : notRead()
    }
    if (ok === false) {
      admission.cancel()
      return notRead()
    }
    const result = await read()
    admission.done(result)
    return c.json(result)
  })
  return routes
}
