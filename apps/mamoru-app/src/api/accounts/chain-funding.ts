import { decodeFunctionResult, encodeFunctionData, getAddress, parseAbi } from 'viem'
import type { Context } from 'hono'
import { BASE_CHAIN_ID, type Address, type FundingView } from '@mamoru/domain'
import { address as addressOf, entry, erc20Abi, nonfungiblePositionManagerAbi, registryFor, uniswapV3PoolAbi, type Registry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import type { AppEnv } from '../context.ts'
import type { Db, Env, RateLimiter } from '../env.ts'
import type { AccountRow } from './store.ts'
import { MAX_PROVIDERS, providerUrls, type ChainFetch } from './other-chains.ts'

// otto/mamoru#238: when the Worker cannot get funding from the operator, GET /funding answers with the balance read
// from the chain, marked `source: 'chain'` (FundingView). It values what the operator values (idle tokens and
// positions at pool slot0, tokensOwed included, ETH out) from ONE Multicall3 call, so every figure comes from one
// block of one chain. It never counts an NFT the Safe merely holds: only the position ids the operator's last
// snapshot recorded (account_snapshot_latest), each checked to be the Safe's. Engine state is not read and not made up.

/** Per provider; a read tries at most MAX_PROVIDERS of them, in order. */
export const FUNDING_RPC_TIMEOUT_MS = 5_000
/** Position ids read in one call. A snapshot with more is not read at all (idle only, flagged): never a truncated total. */
export const MAX_LISTED_POSITIONS = 64
/** One read per account in this window: the SPA polls and the RPC is not ours. */
export const FUNDING_CACHE_MS = 30_000
/** A read that failed is not repeated before this. */
export const FUNDING_FAIL_MS = 10_000
// Two requests per provider (the call and the code), each with its own timeout.
export const FUNDING_PENDING_MS = 2 * FUNDING_RPC_TIMEOUT_MS * MAX_PROVIDERS + 2_000
export const FUNDING_GATE_MAX = 500

const Q96 = 1n << 96n
const Q192 = 1n << 192n

const multicallAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getChainId() view returns (uint256)',
  'function getBlockNumber() view returns (uint256)',
  'function getEthBalance(address addr) view returns (uint256)',
])

// ---- the maths, copied from apps/mamoru-operator/src/chain.ts (amountsForLiquidity, inUsdc, positionUsdc) and
// operator.ts (idleTokens). The operator pulls in its whole RPC stack, so the Worker keeps its own copy; the test
// chain-funding.test.ts runs both on the same fixtures and fails if they ever differ.

/** Token amounts of `liquidity` between two ticks at `sqrtPriceX96`. */
export function amountsForLiquidity(sqrtPriceX96: bigint, tickLower: number, tickUpper: number, liquidity: bigint): { amount0: bigint; amount1: bigint } {
  const a = sqrtRatioAtTick(tickLower)
  const b = sqrtRatioAtTick(tickUpper)
  const s = sqrtPriceX96 < a ? a : sqrtPriceX96 > b ? b : sqrtPriceX96
  const amount0 = s < b ? ((liquidity << 96n) * (b - s)) / b / s : 0n
  const amount1 = s > a ? (liquidity * (s - a)) / Q96 : 0n
  return { amount0, amount1 }
}

/** Raw USDC worth `amount` of `token` at the slot0 of `pool` (a USDC pool of `registry`). */
export function inUsdc(pool: string, token: string, amount: bigint, sqrtPriceX96: bigint, registry: Registry): bigint {
  if (token === 'USDC' || amount === 0n) return amount
  const e = entry(pool, registry)
  return e.token0 === 'USDC' ? (amount * Q192) / (sqrtPriceX96 * sqrtPriceX96) : (amount * sqrtPriceX96 * sqrtPriceX96) / Q192
}

export type ChainPosition = {
  tokenId: bigint
  pool: string
  token0: string
  token1: string
  fee: number
  liquidity: bigint
  tickLower: number
  tickUpper: number
  inRange: boolean
  amount0: bigint
  amount1: bigint
  tokensOwed0: bigint
  tokensOwed1: bigint
}

/** Amounts at the current price plus what the position already owes (settled fees, principal of a past decrease). */
export function positionUsdc(p: ChainPosition, sqrtPriceX96: bigint, registry: Registry): bigint {
  return inUsdc(p.pool, p.token0, p.amount0 + p.tokensOwed0, sqrtPriceX96, registry) + inUsdc(p.pool, p.token1, p.amount1 + p.tokensOwed1, sqrtPriceX96, registry)
}

/** Registry pools that pair USDC: the pools a position can be read and valued in. */
export function usdcPools(registry: Registry): string[] {
  return registry.entries.filter((e) => e.kind === 'pool' && (e.token0 === 'USDC' || e.token1 === 'USDC')).map((e) => e.name)
}

export type PoolPrice = { sqrtPriceX96: bigint; tick: number }

/** Every token of the USDC pools the Safe holds outside a position, valued in USDC; USDC first, then by value. */
export function idleTokens(tokens: Record<string, bigint>, prices: Record<string, PoolPrice>, registry: Registry): NonNullable<FundingView['idle']> {
  const out: NonNullable<FundingView['idle']> = []
  for (const [token, amount] of Object.entries(tokens)) {
    if (amount === 0n) continue
    const pool = token === 'USDC' ? undefined : usdcPools(registry).find((p) => prices[p] && (entry(p, registry).token0 === token || entry(p, registry).token1 === token))
    if (token !== 'USDC' && !pool) continue
    const valueUsdc = pool ? inUsdc(pool, token, amount, prices[pool]!.sqrtPriceX96, registry) : amount
    out.push({ token, amount: amount.toString(), decimals: entry(token, registry).decimals ?? 18, valueUsdc: valueUsdc.toString() })
  }
  return out.sort((a, b) => (a.token === 'USDC' ? -1 : b.token === 'USDC' ? 1 : Number(BigInt(b.valueUsdc) - BigInt(a.valueUsdc))))
}

// ---- reading

/** A reason this module wrote itself: fixed text, safe to log. Anything else thrown may quote the RPC URL. */
class ReadError extends Error {}

const HEX = /^0x([0-9a-f]{2})*$/i
const WORD = /^0x[0-9a-f]{64}$/i

async function rpc(fetcher: ChainFetch, url: string, method: string, params: unknown[]): Promise<string> {
  let res: Response
  let body: unknown
  try {
    res = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(FUNDING_RPC_TIMEOUT_MS),
    })
    body = res.ok ? ((await res.json()) as unknown) : null
  } catch {
    throw new ReadError('rpc unreachable')
  }
  if (!res.ok) throw new ReadError(`rpc http ${res.status}`)
  const answer = body as { result?: unknown; error?: unknown } | null
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer) || answer.error !== undefined) throw new ReadError('rpc call failed')
  if (typeof answer.result !== 'string' || !HEX.test(answer.result)) throw new ReadError('rpc answer is not hex')
  return answer.result
}

/** The provider pool for `chainId` from BASE_RPC_URLS / MONAD_RPC_URLS: https URLs, at most MAX_PROVIDERS, in order. */
export function fundingRpcUrls(env: Env, chainId: number): string[] {
  return providerUrls(chainId === BASE_CHAIN_ID ? env.BASE_RPC_URLS : chainId === 143 ? env.MONAD_RPC_URLS : undefined)
}

/** The position ids the operator's last snapshot recorded for this Safe, and when. Null: no snapshot, or one that cannot be read. */
export async function listedPositions(db: Db, chainId: number, safe: Address): Promise<{ ids: bigint[]; at: string } | null> {
  try {
    const row = await db
      .prepare('SELECT positions_json, read_at FROM account_snapshot_latest WHERE chain_id = ? AND address = ?')
      .bind(chainId, safe.toLowerCase())
      .first<{ positions_json: string; read_at: string }>()
    if (!row) return null
    const parsed = JSON.parse(row.positions_json) as unknown
    if (!Array.isArray(parsed)) return null
    const ids = new Set<bigint>()
    for (const p of parsed) {
      const id = (p as { tokenId?: unknown } | null)?.tokenId
      if (typeof id !== 'string' || !/^[0-9]{1,30}$/.test(id)) return null
      ids.add(BigInt(id))
    }
    return { ids: [...ids], at: row.read_at }
  } catch {
    return null
  }
}

export type ChainRead = {
  block: bigint
  deployed: boolean
  eth: bigint
  tokens: Record<string, bigint>
  prices: Record<string, PoolPrice>
  /** Listed ids that are the Safe's now and sit in a USDC pool of the registry. */
  positions: ChainPosition[]
  /**
   * False when the listed ids cannot be trusted as the Safe's whole set of positions: one is the Safe's but could not be
   * valued (a pool outside the registry's USDC pools), one is no longer the Safe's (the snapshot is behind: a position was
   * closed or moved, and its replacement is not listed), or the Safe holds more position NFTs than the ones listed and
   * owned (opened since the snapshot, or sent to it unasked: not told apart, so not counted and not claimed complete).
   */
  valued: boolean
}

/**
 * One provider. The chain id, the block, ETH, every token balance, every pool's slot0 and every listed position
 * (`positions` and `ownerOf`) come out of ONE aggregate3, so they cannot come from different blocks or chains; a
 * gateway that sends this call to another chain answers another chain id and is refused. `ids` that are not the
 * Safe's (moved, burned) are dropped here, never counted.
 */
export async function readProvider(fetcher: ChainFetch, url: string, registry: Registry, safe: Address, ids: readonly bigint[]): Promise<ChainRead> {
  const multicall3 = registry.entries.find((e) => e.name === 'Multicall3')?.address
  if (!multicall3) throw new ReadError('no multicall3 in the registry')
  const npm = addressOf('NonfungiblePositionManager', registry)
  const pools = usdcPools(registry)
  const tokenNames = [...new Set(pools.flatMap((p) => [entry(p, registry).token0!, entry(p, registry).token1!]))]
  type Call = { target: Address; allowFailure: boolean; callData: `0x${string}` }
  const own = (functionName: 'getChainId' | 'getBlockNumber'): Call => ({ target: multicall3, allowFailure: true, callData: encodeFunctionData({ abi: multicallAbi, functionName }) })
  const calls: Call[] = [
    own('getChainId'),
    own('getBlockNumber'),
    { target: multicall3, allowFailure: true, callData: encodeFunctionData({ abi: multicallAbi, functionName: 'getEthBalance', args: [safe] }) },
    ...tokenNames.map((t): Call => ({ target: addressOf(t, registry), allowFailure: true, callData: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [safe] }) })),
    ...pools.map((p): Call => ({ target: addressOf(p, registry), allowFailure: true, callData: encodeFunctionData({ abi: uniswapV3PoolAbi, functionName: 'slot0' }) })),
    { target: npm, allowFailure: true, callData: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [safe] }) },
    ...ids.flatMap((id): Call[] => [
      { target: npm, allowFailure: true, callData: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [id] }) },
      { target: npm, allowFailure: true, callData: encodeFunctionData({ abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', args: [id] }) },
    ]),
  ]
  const raw = await rpc(fetcher, url, 'eth_call', [{ to: multicall3, data: encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [calls] }) }, 'latest'])
  let results: readonly { success: boolean; returnData: `0x${string}` }[]
  try {
    results = decodeFunctionResult({ abi: multicallAbi, functionName: 'aggregate3', data: raw as `0x${string}` })
  } catch {
    throw new ReadError('answer is not an aggregate3 result')
  }
  if (results.length !== calls.length) throw new ReadError('answer does not have one result per call')

  // A token address with no code answers success with no data: one full word or it is not a number.
  const word = (i: number): bigint => {
    const r = results[i]!
    if (!r.success || !WORD.test(r.returnData)) throw new ReadError('a read inside the call failed')
    return BigInt(r.returnData)
  }
  if (word(0) !== BigInt(registry.chainId)) throw new ReadError('rpc is on another chain')
  const block = word(1)
  if (block > BigInt(Number.MAX_SAFE_INTEGER)) throw new ReadError('block number out of range')
  const eth = word(2)
  const tokens: Record<string, bigint> = {}
  tokenNames.forEach((t, i) => {
    tokens[t] = word(3 + i)
  })
  const prices: Record<string, PoolPrice> = {}
  const slotAt = 3 + tokenNames.length
  pools.forEach((p, i) => {
    const r = results[slotAt + i]!
    if (!r.success) throw new ReadError('a read inside the call failed')
    let slot: readonly [bigint, number, ...unknown[]]
    try {
      slot = decodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: 'slot0', data: r.returnData }) as unknown as readonly [bigint, number]
    } catch {
      throw new ReadError('slot0 is not readable')
    }
    prices[p] = { sqrtPriceX96: slot[0], tick: slot[1] }
  })
  // A price of zero is a pool that was never initialised: nothing can be valued against it.
  for (const [token, amount] of Object.entries(tokens)) {
    if (token === 'USDC' || amount === 0n) continue
    const pool = pools.find((p) => entry(p, registry).token0 === token || entry(p, registry).token1 === token)
    if (pool && prices[pool]!.sqrtPriceX96 === 0n) throw new ReadError('a pool has no price')
  }

  const positions: ChainPosition[] = []
  let valued = true
  let owned = 0
  const safeLower = safe.toLowerCase()
  const held = word(slotAt + pools.length)
  const listAt = slotAt + pools.length + 1
  ids.forEach((tokenId, i) => {
    const pos = results[listAt + 2 * i]!
    const owner = results[listAt + 2 * i + 1]!
    // ownerOf reverts for a burned id: not the Safe's. Anything else but the Safe's own address is not its position.
    if (!owner.success) {
      valued = false
      return
    }
    let ownerAddr: string
    try {
      ownerAddr = (decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'ownerOf', data: owner.returnData }) as string).toLowerCase()
    } catch {
      throw new ReadError('ownerOf is not readable')
    }
    if (ownerAddr !== safeLower) {
      valued = false
      return
    }
    owned++
    if (!pos.success) throw new ReadError('a position could not be read')
    let p: readonly unknown[]
    try {
      p = decodeFunctionResult({ abi: nonfungiblePositionManagerAbi, functionName: 'positions', data: pos.returnData }) as readonly unknown[]
    } catch {
      throw new ReadError('positions is not readable')
    }
    const [token0, token1, fee, tickLower, tickUpper, liquidity, tokensOwed0, tokensOwed1] = [p[2] as string, p[3] as string, p[4] as number, p[5] as number, p[6] as number, p[7] as bigint, p[10] as bigint, p[11] as bigint]
    const pool = pools.find((n) => {
      const e = entry(n, registry)
      return token0.toLowerCase() === addressOf(e.token0!, registry).toLowerCase() && token1.toLowerCase() === addressOf(e.token1!, registry).toLowerCase() && fee === e.fee
    })
    if (!pool) {
      valued = false
      return
    }
    const e = entry(pool, registry)
    const price = prices[pool]!
    if (price.sqrtPriceX96 === 0n) throw new ReadError('a pool has no price')
    const { amount0, amount1 } = amountsForLiquidity(price.sqrtPriceX96, tickLower, tickUpper, liquidity)
    positions.push({ tokenId, pool, token0: e.token0!, token1: e.token1!, fee: e.fee!, liquidity, tickLower, tickUpper, inRange: price.tick >= tickLower && price.tick < tickUpper, amount0, amount1, tokensOwed0, tokensOwed1 })
  })

  if (held !== BigInt(owned)) valued = false
  // Same block as everything above, from the same provider.
  const code = await rpc(fetcher, url, 'eth_getCode', [safe, `0x${block.toString(16)}`])
  return { block, deployed: code !== '0x', eth, tokens, prices, positions, valued }
}

/** Reads from the first provider that gives a whole answer; null when there is none or every one fails. Values of two providers are never combined. */
export async function readChain(fetcher: ChainFetch, urls: readonly string[], registry: Registry, safe: Address, ids: readonly bigint[]): Promise<ChainRead | null> {
  for (const [i, url] of urls.slice(0, MAX_PROVIDERS).entries()) {
    try {
      return await readProvider(fetcher, url, registry, safe, ids)
    } catch (e) {
      // The URL carries a key and a foreign error may quote it: the provider is named by its place in the list.
      console.error('funding chain read failed', registry.chainId, `provider ${i + 1} of ${urls.length}`, e instanceof ReadError ? e.message : 'unexpected error')
    }
  }
  return null
}

/**
 * The FundingView of a chain read. `listed`: what the snapshot said (null: nothing usable). Positions are 'listed'
 * only when the snapshot was there and every position of it that is still the Safe's could be valued.
 */
export function fundingFromRead(read: ChainRead, registry: Registry, safe: Address, capUsdc: string, listed: { at: string } | null): FundingView {
  const usdc = read.tokens.USDC ?? 0n
  const known = listed !== null && read.valued
  // Positions are shown only when the list is whole: the app adds them into the total, and a partial set under an
  // "idle only" notice (or as a complete total) would misstate the balance.
  const positions = (known ? [...read.positions] : [])
    .map((p) => ({ p, v: positionUsdc(p, read.prices[p.pool]!.sqrtPriceX96, registry) }))
    .sort((a, b) => (a.v === b.v ? 0 : a.v > b.v ? -1 : 1))
    .map(({ p, v }) => {
      const price = read.prices[p.pool]!.sqrtPriceX96
      const decimals = (t: string) => entry(t, registry).decimals ?? 18
      return {
        tokenId: p.tokenId.toString(),
        pool: p.pool,
        liquidity: p.liquidity.toString(),
        inRange: p.inRange,
        amountUsdc: (p.token0 === 'USDC' ? p.amount0 : p.amount1).toString(),
        amountCbbtc: (p.token0 === 'cbBTC' ? p.amount0 : p.token1 === 'cbBTC' ? p.amount1 : 0n).toString(),
        amounts: [
          { token: p.token0, amount: p.amount0.toString(), decimals: decimals(p.token0), valueUsdc: inUsdc(p.pool, p.token0, p.amount0, price, registry).toString() },
          { token: p.token1, amount: p.amount1.toString(), decimals: decimals(p.token1), valueUsdc: inUsdc(p.pool, p.token1, p.amount1, price, registry).toString() },
        ],
        valueUsdc: v.toString(),
      }
    })
  return {
    address: getAddress(safe),
    deployed: read.deployed,
    block: Number(read.block),
    usdc: usdc.toString(),
    eth: read.eth.toString(),
    capUsdc,
    overCap: null,
    cbbtc: (read.tokens.cbBTC ?? 0n).toString(),
    gasReserveWei: '0',
    active: false,
    idle: idleTokens(read.tokens, read.prices, registry),
    positions,
    source: 'chain',
    chainRead: { positions: known ? 'listed' : 'unknown', listedAt: known ? listed!.at : null },
  }
}

// ---- the route's side: one read per account per window, never an RPC storm

type Slot = { at: number; state: 'pending' | 'ok' | 'failed'; view?: FundingView }
const LIFETIME = { pending: FUNDING_PENDING_MS, ok: FUNDING_CACHE_MS, failed: FUNDING_FAIL_MS } as const

export type FundingAdmission =
  | { kind: 'cached'; view: FundingView }
  /** A read for this account is under way, or one failed a moment ago: do not start another. */
  | { kind: 'busy' }
  | { kind: 'full' }
  | { kind: 'read'; done: (view: FundingView | null, endedAt: number) => void; cancel: () => void }

/**
 * Same idea as ReadGate (other-chains.ts): it keeps values, never promises, a slot leaves only when its own time is
 * up, and what a full table means is the caller's to decide.
 */
export class FundingGate {
  private readonly slots = new Map<string, Slot>()
  constructor(private readonly max = FUNDING_GATE_MAX) {}

  private live(slot: Slot, now: number): boolean {
    const age = now - slot.at
    return age >= 0 && age < LIFETIME[slot.state]
  }

  admit(key: string, now: number): FundingAdmission {
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
      done: (view, endedAt) => {
        slot.at = endedAt
        slot.state = view ? 'ok' : 'failed'
        if (view) slot.view = view
      },
      cancel: () => {
        if (this.slots.get(key) === slot) this.slots.delete(key)
      },
    }
  }
}

export type ChainFunding = { fetch: ChainFetch; gate: FundingGate; capUsdc: string }

async function allowed(limiter: RateLimiter | undefined, key: string): Promise<boolean | null> {
  if (!limiter) return null
  try {
    return (await limiter.limit({ key })).success
  } catch {
    console.error('funding chain read: rate limiter did not answer')
    return null
  }
}

/**
 * The chain-read answer for an account whose operator did not give funding, or null when there is none to give (no
 * RPC secret, every provider failed, a read under way, rate limited): the caller then answers as it did before.
 */
export async function chainFundingResponse(c: Context<AppEnv>, row: AccountRow, deps: ChainFunding): Promise<Response | null> {
  const urls = fundingRpcUrls(c.env, row.chain_id)
  if (urls.length === 0) return null
  let registry: Registry
  try {
    registry = registryFor(row.chain_id)
  } catch {
    return null
  }
  const json = (view: FundingView) => c.json(view, 200, { 'cache-control': 'no-store' })
  const admission = deps.gate.admit(row.account_key, c.var.now().getTime())
  if (admission.kind === 'cached') return json(admission.view)
  if (admission.kind === 'busy') return null
  const ok = await allowed(c.env.FUNDING_CHAIN_LIMIT, row.account_key)
  // A full table cannot track this account: it is read anyway only when the limiter vouches for its rate.
  if (admission.kind === 'full' && ok !== true) return null
  if (admission.kind === 'read' && ok === false) {
    admission.cancel()
    return null
  }
  let view: FundingView | null = null
  try {
    const listed = await listedPositions(c.env.DB, row.chain_id, row.address)
    // Over the cap the snapshot is not read in part: a total of some positions would look like all of them.
    const ids = listed && listed.ids.length <= MAX_LISTED_POSITIONS ? listed.ids : []
    const usable = listed && listed.ids.length <= MAX_LISTED_POSITIONS ? listed : null
    const read = await readChain(deps.fetch, urls, registry, row.address, ids)
    if (read) view = fundingFromRead(read, registry, row.address, deps.capUsdc, usable)
  } catch (e) {
    console.error('funding chain read failed', e instanceof Error ? e.name : 'unexpected error')
  }
  if (admission.kind === 'read') admission.done(view, c.var.now().getTime())
  return view ? json(view) : null
}
