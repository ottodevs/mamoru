import { Hono } from 'hono'
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem'
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

export type WatchedChain = { chainId: number; name: string; usdc: Address; multicall3: Address }

/**
 * Chains read for misdirected transfers. USDC is Circle's FiatTokenProxy on Ethereum Mainnet; Multicall3 is at
 * its canonical address there (same code as the entry the Base registry pins).
 */
export const WATCHED_CHAINS: readonly WatchedChain[] = [
  { chainId: 1, name: 'Ethereum', usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' },
]

export const RPC_TIMEOUT_MS = 8_000
/** One read per account in this window: the SPA polls, the RPC is not ours. */
export const CACHE_MS = 30_000
/** A read that failed is not repeated before this: an owner cannot spend the RPC quota by asking again. */
export const FAIL_MS = 10_000
/** While a read is under way no second one starts for that account. Longer than the RPC timeout, so a read that was abandoned frees itself. */
export const PENDING_MS = RPC_TIMEOUT_MS + 2_000
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
 * USDC and ETH at `address` on `chain`. The chain id, the block and both balances come out of ONE EVM
 * execution (Multicall3.aggregate3), so they cannot come from different chains or blocks whatever sits in
 * front of the node: a gateway that sends this call to Base answers chain id 8453 and reads as not observed.
 */
export async function readOtherChain(fetcher: ChainFetch, url: string | undefined, chain: WatchedChain, address: Address, now: Date): Promise<OtherChainFunds> {
  const observedAt = now.toISOString()
  const missing: OtherChainFunds = { chainId: chain.chainId, name: chain.name, status: 'not_observed', observedAt }
  if (!url) return missing
  try {
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
    return { chainId: chain.chainId, name: chain.name, status: 'observed', block: Number(block), usdc: usdc.toString(), eth: eth.toString(), observedAt }
  } catch (e) {
    // The URL may carry a key and a foreign error may quote it: only this module's own reasons are logged.
    console.error('other chain not observed', chain.chainId, e instanceof ReadError ? e.message : 'unexpected error')
    return missing
  }
}

type Slot = { at: number; state: 'pending' | 'ok' | 'failed'; view?: OtherChainsView }
const LIFETIME = { pending: PENDING_MS, ok: CACHE_MS, failed: FAIL_MS } as const

export type Admission =
  | { kind: 'cached'; view: OtherChainsView }
  /** A read for this account is under way, or there is no room to track another one: do not read now. */
  | { kind: 'wait' }
  | { kind: 'read'; done: (view: OtherChainsView) => void }

/**
 * Decides whether a request may read the RPC. It keeps values, never promises: on Workers a promise belongs to
 * the request that created it and may never settle if that request goes away, so nothing here waits on another
 * request. A slot leaves only when its own time is up; when every slot is live a new account is told to wait,
 * so filling the table cannot erase a read under way or a failure's backoff.
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
    if (hit && this.live(hit, now)) return hit.view ? { kind: 'cached', view: hit.view } : { kind: 'wait' }
    if (!hit && this.slots.size >= this.max) {
      for (const [k, slot] of this.slots) if (!this.live(slot, now)) this.slots.delete(k)
      if (this.slots.size >= this.max) return { kind: 'wait' }
    }
    const slot: Slot = { at: now, state: 'pending' }
    this.slots.set(key, slot)
    return {
      kind: 'read',
      done: (view) => {
        slot.view = view
        slot.state = view.chains.every((ch) => ch.status === 'observed') ? 'ok' : 'failed'
      },
    }
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

    const admission = gate.admit(account.account_key, now.getTime())
    if (admission.kind === 'cached') return c.json(admission.view)
    // Not read this time: said as not observed, which the SPA shows as nothing. The next poll asks again.
    if (admission.kind === 'wait') return c.json(view(watched.map((w) => ({ chainId: w.chainId, name: w.name, status: 'not_observed' as const, observedAt: now.toISOString() }))))

    const read = view(await Promise.all(watched.map((w) => readOtherChain(fetcher, c.env.ETHEREUM_RPC_URL, w, account.address, now))))
    admission.done(read)
    return c.json(read)
  })
  return routes
}
