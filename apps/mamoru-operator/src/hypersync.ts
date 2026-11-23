/**
 * otto/mamoru#459: eth_getLogs ranges read from Envio HyperSync (POST /query), the RPC pool being the fallback.
 *
 * HyperSync answers a wide range in one or a few requests where the RPC providers need hundreds of pages (Monad's
 * public RPCs cap a range at 100 blocks). Only logs come from here: calls, receipts, gas estimates and sends stay on
 * the RPC providers. The token is read from ENVIO_API_TOKEN and travels only in the Authorization header; nothing
 * here writes it to a log, an error or a metric. Unset, nothing is asked of HyperSync.
 *
 * The free plan allows 15 requests a minute per token, shared by every process that holds it (the Base and the Monad
 * operator). Each process keeps under its own budget (MAMORU_HYPERSYNC_RPM, default 6) and a refusal for rate pauses
 * HyperSync for the rest of the minute: that read, and every one until then, goes to the RPC providers.
 */

type Env = Record<string, string | undefined>

/** HyperSync per chain: Base and Monad only. Another chain (Ethereum for bridge-out) keeps its RPC providers. */
export const HYPERSYNC_URLS: Readonly<Record<number, string>> = {
  8453: 'https://8453.hypersync.xyz',
  143: 'https://143.hypersync.xyz',
}

/** Requests a minute one process may send (the free token allows 15 a minute for both operators together). */
export const DEFAULT_HYPERSYNC_RPM = 6
/** How long one HyperSync request may take before the read goes to the RPC providers. */
export const HYPERSYNC_REQUEST_MS = 10_000
/** Pages one range may take before it goes to the RPC providers instead (each page is one request of the minute's budget). */
export const HYPERSYNC_MAX_PAGES = 4
/** A soft cap on the logs of one page (the server may exceed it to finish a block group). */
const MAX_NUM_LOGS = 20_000
/** A refusal for rate without a time to wait: the rest of the free plan's minute. */
const RATE_PAUSE_MS = 60_000

const LOG_FIELDS = ['block_number', 'block_hash', 'transaction_hash', 'transaction_index', 'log_index', 'address', 'data', 'topic0', 'topic1', 'topic2', 'topic3', 'removed'] as const

/**
 * Requests a minute for this process, over a sliding minute. `take` never waits: an empty budget sends the read to
 * the RPC providers. `pause` holds every request until the time a refusal for rate gave.
 */
export class MinuteLimiter {
  private sent: number[] = []
  private pausedUntil = 0
  constructor(readonly rpm: number) {}

  take(now: number = Date.now()): boolean {
    if (now < this.pausedUntil) return false
    this.sent = this.sent.filter((t) => now - t < 60_000 && t <= now)
    if (this.sent.length >= this.rpm) return false
    this.sent.push(now)
    return true
  }

  pause(until: number): void {
    if (until > this.pausedUntil) this.pausedUntil = until
  }

  paused(now: number = Date.now()): boolean {
    return now < this.pausedUntil
  }
}

/** MAMORU_HYPERSYNC_RPM, a whole number of requests a minute; anything else is the default. */
export function rpmFromEnv(env: Env = process.env): number {
  const n = Number(env.MAMORU_HYPERSYNC_RPM)
  return env.MAMORU_HYPERSYNC_RPM !== undefined && env.MAMORU_HYPERSYNC_RPM.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : DEFAULT_HYPERSYNC_RPM
}

/** One limiter for the whole process: the Base operator's main and Monad proxies share it. */
let processLimiter: MinuteLimiter | null = null
export function sharedLimiter(env: Env = process.env): MinuteLimiter {
  return (processLimiter ??= new MinuteLimiter(rpmFromEnv(env)))
}

export type HyperSyncConfig = {
  url: string
  token: string
  limiter: MinuteLimiter
  /** Tests: the transport. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
  requestMs?: number
  maxPages?: number
}

/**
 * HyperSync for `chainId`, or null: no token (ENVIO_API_TOKEN), a chain without HyperSync, or MAMORU_HYPERSYNC=off.
 * Read when the proxy starts, never at module load (main.ts fills process.env from the env file after its imports).
 */
export function hypersyncFromEnv(chainId: number | undefined, env: Env = process.env): HyperSyncConfig | null {
  const token = env.ENVIO_API_TOKEN?.trim()
  if (!token || chainId === undefined || /^(off|0|false)$/i.test(env.MAMORU_HYPERSYNC ?? '')) return null
  const url = HYPERSYNC_URLS[chainId]
  if (!url) return null
  return { url, token, limiter: sharedLimiter(env) }
}

/** Why a HyperSync read gave nothing usable. `rate`: refused for rate, or this process's budget is spent. */
export type HyperSyncFailure = 'rate' | 'timeout' | 'http' | 'answer' | 'unsupported'
export class HyperSyncError extends Error {
  constructor(
    readonly kind: HyperSyncFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message)
  }
}

/** A log as eth_getLogs answers it (quantities in hex). */
export type RpcLog = {
  address: string
  topics: string[]
  data: string
  blockNumber: string
  blockHash: string
  transactionHash: string
  transactionIndex: string
  logIndex: string
  removed: boolean
}

type Filter = { address?: unknown; topics?: unknown }
type Selection = { address: string[]; topics: string[][] }

const HEX = /^0x[0-9a-fA-F]*$/

/**
 * An eth_getLogs filter as a HyperSync log selection, or null when it cannot be one exactly (a value that is not hex,
 * more than four topics) or would select every log of the chain (no address and no topic).
 */
export function selectionOf(filter: Filter): Selection | null {
  const list = (v: unknown): string[] | null => {
    if (v === undefined || v === null) return []
    const xs = Array.isArray(v) ? v : [v]
    return xs.every((x) => typeof x === 'string' && HEX.test(x)) ? (xs as string[]).map((x) => x.toLowerCase()) : null
  }
  const address = list(filter.address)
  if (address === null) return null
  const raw = filter.topics ?? []
  if (!Array.isArray(raw) || raw.length > 4) return null
  const topics: string[][] = []
  for (const t of raw) {
    const one = list(t)
    if (one === null) return null
    topics.push(one)
  }
  while (topics.length && topics[topics.length - 1]!.length === 0) topics.pop()
  if (!address.length && !topics.length) return null
  return { address, topics }
}

const quantity = (v: unknown): string => {
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return `0x${v.toString(16)}`
  if (typeof v === 'string' && /^0x[0-9a-fA-F]+$/.test(v)) return `0x${BigInt(v).toString(16)}`
  throw new HyperSyncError('answer', 'HyperSync answered a log without a number where one belongs')
}
const hexField = (v: unknown): string => {
  if (typeof v === 'string' && HEX.test(v)) return v.toLowerCase()
  throw new HyperSyncError('answer', 'HyperSync answered a log without a hex field where one belongs')
}

/** One HyperSync log in the shape eth_getLogs gives it. */
export function toRpcLog(l: any): RpcLog {
  if (!l || typeof l !== 'object') throw new HyperSyncError('answer', 'HyperSync answered a log that is not an object')
  const topics: string[] = []
  for (const k of ['topic0', 'topic1', 'topic2', 'topic3']) {
    if (l[k] === null || l[k] === undefined) break
    topics.push(hexField(l[k]))
  }
  return {
    address: hexField(l.address),
    topics,
    data: l.data === null || l.data === undefined ? '0x' : hexField(l.data),
    blockNumber: quantity(l.block_number),
    blockHash: hexField(l.block_hash),
    transactionHash: hexField(l.transaction_hash),
    transactionIndex: quantity(l.transaction_index),
    logIndex: quantity(l.log_index),
    removed: false,
  }
}

/** The seconds a refusal for rate says to wait (Retry-After, else x-ratelimit-reset), in ms; null when it says none. */
function waitOf(res: Response): number | null {
  for (const name of ['retry-after', 'x-ratelimit-reset']) {
    const v = Number(res.headers?.get?.(name))
    if (Number.isFinite(v) && v > 0 && v <= 3_600) return v * 1_000
  }
  return null
}

export type HyperSyncRead = {
  logs: RpcLog[]
  /** The last block read in full (inclusive): `to`, or less when HyperSync's archive ends before it. Below `from`: none. */
  covered: bigint
  requests: number
}

/**
 * The logs of `filter` over the blocks `from` to `to`, both inclusive as in eth_getLogs (HyperSync's `to_block` is
 * exclusive: `to + 1` is sent). Pages follow `next_block`; reading stops where HyperSync's archive ends, and `covered`
 * says where that was. Throws a HyperSyncError on a refusal, a timeout, an answer it cannot read, a spent budget or
 * more than `maxPages` pages; a refusal for rate pauses the limiter. `onRequest` hears every request sent, `deadline`
 * bounds every request's wait.
 */
export async function hypersyncLogs(
  cfg: HyperSyncConfig,
  filter: Filter,
  from: bigint,
  to: bigint,
  o: { deadline?: number; onRequest?: (page: number) => void; now?: () => number } = {},
): Promise<HyperSyncRead> {
  const selection = selectionOf(filter)
  if (!selection) throw new HyperSyncError('unsupported', 'this filter has no exact HyperSync selection')
  const send = cfg.fetch ?? fetch
  const now = o.now ?? Date.now
  const maxPages = cfg.maxPages ?? HYPERSYNC_MAX_PAGES
  const end = to + 1n
  const logs: RpcLog[] = []
  let next = from
  let page = 0
  while (next < end) {
    if (page >= maxPages) throw new HyperSyncError('answer', `HyperSync needs more than ${maxPages} pages for this range`)
    if (!cfg.limiter.take(now())) throw new HyperSyncError('rate', 'HyperSync budget of this minute is spent')
    const left = o.deadline === undefined ? Number.POSITIVE_INFINITY : o.deadline - now()
    const timeout = Math.min(cfg.requestMs ?? HYPERSYNC_REQUEST_MS, left)
    if (!(timeout > 0)) throw new HyperSyncError('timeout', 'no time left for HyperSync in this request')
    const body = {
      from_block: Number(next),
      to_block: Number(end),
      logs: [selection],
      field_selection: { log: LOG_FIELDS },
      max_num_logs: MAX_NUM_LOGS,
    }
    o.onRequest?.(page)
    page++
    let res: Response
    try {
      res = await send(`${cfg.url}/query`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      })
    } catch (e) {
      const name = (e as Error)?.name
      throw new HyperSyncError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'http', name === 'TimeoutError' || name === 'AbortError' ? 'HyperSync did not answer in time' : 'HyperSync could not be reached')
    }
    if (res.status === 429) {
      cfg.limiter.pause(now() + (waitOf(res) ?? RATE_PAUSE_MS))
      throw new HyperSyncError('rate', 'HyperSync refused for rate', 429)
    }
    if (!res.ok) throw new HyperSyncError('http', `HyperSync answered HTTP ${res.status}`, res.status)
    let j: any
    try {
      j = await res.json()
    } catch {
      throw new HyperSyncError('answer', 'HyperSync answered no JSON')
    }
    const chunks = Array.isArray(j?.data) ? j.data : j?.data && typeof j.data === 'object' ? [j.data] : null
    if (!chunks) throw new HyperSyncError('answer', 'HyperSync answered no data')
    for (const c of chunks) for (const l of Array.isArray(c?.logs) ? c.logs : []) logs.push(toRpcLog(l))
    const nb = j?.next_block
    if (typeof nb !== 'number' || !Number.isSafeInteger(nb)) throw new HyperSyncError('answer', 'HyperSync answered no next block')
    const archive = typeof j?.archive_height === 'number' && Number.isSafeInteger(j.archive_height) ? BigInt(j.archive_height) : null
    if (BigInt(nb) <= next) {
      // No progress is only an answer when the archive ends before the block asked for: what was read is all there is.
      if (archive !== null && archive < next) break
      throw new HyperSyncError('answer', 'HyperSync made no progress')
    }
    next = BigInt(nb)
    // The archive ends before the range: the rest is not there yet (the caller reads it from the RPC providers).
    if (archive !== null && next > archive) break
  }
  const covered = next - 1n < to ? next - 1n : to
  // A log past what the archive covers (or past the range) is not counted: the caller reads those blocks elsewhere.
  const kept = logs.filter((l) => {
    const b = BigInt(l.blockNumber)
    return b >= from && b <= covered
  })
  kept.sort((a, b) => {
    const [x, y] = [BigInt(a.blockNumber), BigInt(b.blockNumber)]
    return x === y ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : x < y ? -1 : 1
  })
  return { logs: kept, covered, requests: page }
}

/** The identity of a log for comparing two sources: every field eth_getLogs gives, numbers as numbers, hex in lower case. */
export function logKey(l: any): string {
  const n = (v: unknown) => {
    try {
      return BigInt(v as string).toString()
    } catch {
      return String(v)
    }
  }
  const s = (v: unknown) => String(v ?? '').toLowerCase()
  return [n(l?.blockNumber), n(l?.logIndex), s(l?.blockHash), s(l?.transactionHash), s(l?.address), (Array.isArray(l?.topics) ? l.topics : []).map(s).join(','), s(l?.data)].join('|')
}

/** Whether two lists hold the same logs (order aside). */
export function sameLogs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  const x = a.map(logKey).sort()
  const y = b.map(logKey).sort()
  return x.every((k, i) => k === y[i])
}
