import type { Server } from 'bun'
import { AsyncLocalStorage } from 'node:async_hooks'
import { LATEST_QUIET_MS, ReadCache, blockParam as pinnedBlockParam, isRead, pinnedBlock, type ReadCacheStats } from './read-cache.ts'

const TRACE_TAGS = new Set(['latest', 'pending', 'safe', 'finalized', 'earliest'])
import { classifyRpcError, componentOf, redactSecrets, safeMetrics, type Component, type LogRangeOutcome, type RpcMetrics } from './metrics.ts'
import { HyperSyncError, hypersyncFromEnv, hypersyncLogs, sameLogs, type HyperSyncConfig } from './hypersync.ts'
import { domainOfLabel, nextReset, QuotaBook, quotaExhausted, resetDaysFromEnv, resetFromAnswer } from './quota.ts'

type Req = { jsonrpc: '2.0'; id: unknown; method: string; params?: any[] }

/**
 * Loopback JSON-RPC proxy in front of the upstream provider. It keeps the
 * keyed URL inside this process (viem errors echo the URL they called),
 * splits eth_getLogs into ranges the provider accepts and sends it to the
 * provider that serves the range in the fewest requests, accepting the logs
 * only when an independent provider witnesses the hash of the range's last
 * block.
 */
export const BASE_PUBLIC_FALLBACKS = 'https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org'

type Env = Record<string, string | undefined>

/**
 * otto/mamoru#285: public RPCs for the chains the Base operator also touches (Ethereum for bridge-out, Monad for the v6
 * bridge leg). Probed 2026-11-01 (otto/mamoru-astro#42): each answered chain id, balance and Multicall3. Through the
 * proxy they carry only sends and log witnesses, never a read that decides what to sign.
 */
export const L1_PUBLIC_FALLBACKS = 'https://rpc.mevblocker.io,https://ethereum-rpc.publicnode.com,https://public.1rpc.io/eth,https://eth.drpc.org,https://eth-mainnet.public.blastapi.io'
export const MONAD_PUBLIC_FALLBACKS = 'https://rpc.monad.xyz,https://rpc2.monad.xyz,https://rpc3.monad.xyz,https://monad-mainnet.rpc.sentio.xyz,https://monad-mainnet.drpc.org'

/**
 * otto/mamoru#261: the public list the main proxy takes without MAMORU_RPC_FALLBACKS, by the chain its upstream
 * answers. A chain not listed gets none: another chain's RPCs are never a default (the Monad operator once fell back
 * to Base's and could not witness its logs).
 */
const PUBLIC_FALLBACKS_BY_CHAIN: Readonly<Record<number, string>> = {
  1: L1_PUBLIC_FALLBACKS,
  143: MONAD_PUBLIC_FALLBACKS,
  8453: BASE_PUBLIC_FALLBACKS,
}

/** A JSON-RPC chain id answer: hex, above zero. Anything else is no answer. */
function chainIdAnswer(result: unknown): number | null {
  if (typeof result !== 'string' || !/^0x[0-9a-f]+$/i.test(result)) return null
  const n = Number(result)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * otto/mamoru#261: the chain these RPCs (the upstream and the trusted ones) are on, asked of each until one answers,
 * `attempts` times with a doubling pause, and the URLs that answered it. Two that answer different chains are a
 * misconfiguration and throw; none answering is null. Never names a URL.
 */
export async function proveChain(
  urls: readonly string[],
  o: { send?: (url: string, init: RequestInit) => Promise<Response>; timeoutMs?: number; attempts?: number; pauseMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ chainId: number; proven: string[] } | null> {
  const send = o.send ?? fetch
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const attempts = o.attempts ?? 4
  let pause = o.pauseMs ?? 1_000
  for (let i = 0; i < attempts; i++) {
    if (i > 0) {
      await sleep(pause)
      pause *= 2
    }
    const answers = await Promise.all(
      urls.map((url) =>
        send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(o.timeoutMs ?? 8_000) })
          .then((r) => r.json() as Promise<{ result?: unknown }>)
          .then((j) => chainIdAnswer(j?.result))
          .catch(() => null),
      ),
    )
    const chains = new Set(answers.filter((n): n is number => n !== null))
    if (chains.size > 1) throw new Error('the upstream and trusted RPCs answer different chains')
    const [chainId] = chains
    if (chainId !== undefined) return { chainId, proven: urls.filter((_, j) => answers[j] === chainId) }
  }
  return null
}

/**
 * otto/mamoru#285: how many of these configured RPCs answer a chain id other than `chainId`. One that does not answer
 * does not count (an outage is not a misconfiguration). Never throws, never names a URL.
 */
export async function wrongChainCount(urls: readonly string[], chainId: number, send: (url: string, init: RequestInit) => Promise<Response> = fetch, timeoutMs = 8_000): Promise<number> {
  const answers = await Promise.all(
    urls.map((url) =>
      send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(timeoutMs) })
        .then((r) => r.json() as Promise<{ result?: unknown }>)
        .then((j) => (typeof j?.result === 'string' ? Number(j.result) : null))
        .catch(() => null),
    ),
  )
  return answers.filter((n) => n !== null && n !== chainId).length
}

/** A comma separated URL list from `name`, or `fallback` when unset. Read when called, like the two below. */
export function urlsFromEnv(name: string, fallback: string, env: Env = process.env): string[] {
  return (env[name] ?? fallback).split(',').map((u) => u.trim()).filter(Boolean)
}

/**
 * Read when the proxy starts, never at module load: main.ts fills process.env from the env file after its imports ran.
 * Unset, the public list of `chainId` (otto/mamoru#261); without a chain, none.
 */
export function fallbacksFromEnv(env: Env = process.env, chainId?: number): string[] {
  return urlsFromEnv('MAMORU_RPC_FALLBACKS', chainId === undefined ? '' : (PUBLIC_FALLBACKS_BY_CHAIN[chainId] ?? ''), env)
}

/**
 * Keyed providers the operator trusts as much as the upstream (MAMORU_RPC_TRUSTED, comma separated). Every call
 * except eth_getLogs and sends falls back only among the upstream and these: state, heads, blocks and simulations
 * that decide what the operator signs never come from a public node. Read when the proxy starts.
 */
export function trustedFromEnv(env: Env = process.env): string[] {
  return (env.MAMORU_RPC_TRUSTED ?? '').split(',').map((u) => u.trim()).filter(Boolean)
}

/**
 * otto/mamoru#420: MAMORU_RPC_WEIGHTS="quiknode.pro=3,alchemy.com=1": the share of reads each trusted provider starts,
 * by host-free label (`alchemy.com#2`) or provider domain (`alchemy.com`). A provider not named weighs 1; 0 keeps it
 * out of the spread (it is still a fallback). Read when the proxy starts.
 */
export function weightsFromEnv(env: Env = process.env): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pair of (env.MAMORU_RPC_WEIGHTS ?? '').split(',')) {
    const [label, w] = pair.split('=').map((x) => x.trim())
    const n = Number(w)
    if (label && w && Number.isFinite(n) && n >= 0) out[label.toLowerCase()] = n
  }
  return out
}

/**
 * The block a read is pinned to (#420): the explicit number of a state read or block read (as the read cache knows
 * them), or of a simulation or gas estimate. Null for a tag, a hash or none.
 */
function pinnedAt(msg: { method: string; params?: unknown[] }): bigint | null {
  const n = pinnedBlock(msg)
  if (n !== null) return n
  if (msg.method !== 'eth_simulateV1' && msg.method !== 'eth_estimateGas') return null
  const p = msg.params?.[1]
  return typeof p === 'string' && /^0x[0-9a-fA-F]+$/.test(p) ? BigInt(p) : null
}

/** How long a served head is held when a provider behind it answers a lower tip: the served head never steps back meanwhile. */
const HEAD_HOLD_MS = 30_000

/**
 * otto/mamoru#419: with the read cache on, one tip read serves every head the proxy needs for this long (eth_blockNumber,
 * `latest` blocks, log ranges up to `latest`): every engine and the operator share one head poll. A few blocks, as
 * MAMORU_HEAD_LAG already serves.
 */
export const HEAD_TTL_MS = 1_000

/** How long a block hash answered by a trusted provider may witness a log range: one review's worth of requests. */
const WITNESS_TTL_MS = 15_000

/** A trusted provider serves a log range ahead of every public one when it takes it in at most this many requests. */
const TRUSTED_LOG_MAX_REQUESTS = 4n


/** Calls whose answer decides nothing: a signed transaction is the same bytes whoever relays it. Any provider may take them. */
const ANY_PROVIDER = new Set(['eth_sendRawTransaction'])

function isLoopback(url: string): boolean {
  const h = new URL(url).hostname
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
}

/** Blocks one eth_getLogs may span, by provider host. A host not listed takes any range in one request. */
const LOG_RANGE_BY_HOST: readonly [RegExp, number][] = [
  // Free tier.
  [/(^|\.)alchemy\.com$/i, 10],
  // Recent blocks only; older ranges are refused and fall through.
  [/(^|\.)publicnode\.com$/i, 2_000],
  [/(^|\.)base\.org$/i, 2_000],
  [/(^|\.)drpc\.org$/i, 10_000],
  // QuickNode Build: 10,000 blocks per request (probed 4 Oct); the operator's upstream since 2 Nov (otto/mamoru#305).
  [/(^|\.)quiknode\.pro$/i, 10_000],
  // Monad's public RPCs (rpc*.monad.xyz, monadinfra): "eth_getLogs is limited to a 100 range" (probed 1 Nov). Without it
  // the Monad engine's history read from the Safe's activation to the head was refused once 100 blocks (~40 s) had passed.
  [/(^|\.)monad\.xyz$/i, 100],
  [/(^|\.)monadinfra\.com$/i, 100],
]

/** MAMORU_LOG_RANGES="host=blocks,host=blocks": overrides and additions to the table, matched on the end of the hostname. */
export function logRangesFromEnv(env: Env = process.env): Record<string, number> {
  const out: Record<string, number> = {}
  for (const pair of (env.MAMORU_LOG_RANGES ?? '').split(',')) {
    const [host, blocks] = pair.split('=').map((x) => x.trim())
    if (host && blocks && Number.isInteger(Number(blocks)) && Number(blocks) > 0) out[host.toLowerCase()] = Number(blocks)
  }
  return out
}

/** The widest eth_getLogs range `url` accepts, Infinity when it has no known limit. */
export function logRangeOf(url: string, overrides: Record<string, number> = {}): number {
  const host = new URL(url).hostname.toLowerCase()
  for (const [suffix, blocks] of Object.entries(overrides)) if (host === suffix || host.endsWith(`.${suffix}`)) return blocks
  return LOG_RANGE_BY_HOST.find(([re]) => re.test(host))?.[1] ?? Number.POSITIVE_INFINITY
}

/**
 * A provider that does not serve the method at all (JSON-RPC -32601, or a plan that leaves it out). otto/mamoru#358: on
 * Monad only the keyed Alchemy serves eth_simulateV1; the public upstream's "Method not found" was returned as the answer,
 * so every Monad harvest and entry was discarded EHG_SIM_UNAVAILABLE without the trusted provider ever being asked.
 */
function methodUnserved(e: any): boolean {
  // -32601 first: a revert never carries it, and a provider may add `data` (even null) to it.
  // otto/mamoru#429: -32604 is rpc4.monad.xyz's "this request method is not supported".
  if (e.code === -32601 || e.code === -32604) return true
  // A revert (code 3, or any other error carrying `data`) is the method's real answer, whatever its reason says.
  if (e.code === 3 || e.data != null) return false
  // drpc's free plan: code 35, "method is not available on free plan"; geth's wording without the standard code.
  // otto/mamoru#429: "this request method is not supported" (rpc4.monad.xyz), "eth_simulateV1 is not available on the
  // MONAD_MAINNET" (Alchemy, code -32600), "is available for paid plans only" (Tatum, code -16401).
  return /^(the )?method \S+ (does not exist|is not available)|^method is not available on (your|free|the free) plan|^this request method is not supported|^\S+ is not available on the [A-Z0-9_]+\b|is available for paid plans only/i.test(String(e.message))
}

/** Refusals that are worth a retry or another provider, not a real answer: rate or capacity, or a method this provider does not serve. */
function retriable(status: number, body: any): boolean {
  if (status === 429 || status >= 500) return true
  const e = body?.error
  if (!e) return false
  // otto/mamoru#418: a spent plan (a 402, "insufficient credits") is never the answer: another provider may have one.
  if (quotaExhausted(status, e)) return true
  return e.code === 429 || e.code === -32005 || /rate|capacity|limit exceeded|compute units|too many|throughput|timeout|temporar/i.test(String(e.message)) || methodUnserved(e)
}

function wellFormed(body: any): boolean {
  return !!body && typeof body === 'object' && ('result' in body || (body.error && typeof body.error === 'object'))
}

/** Second-level "public suffixes" where the registrable domain needs the last three labels, not two
 * (co.uk, com.au, ...). Not a full public-suffix list — this only needs to be right for the handful
 * of plausible RPC-provider/CDN domains, not to resolve eTLD+1 for arbitrary hostnames; an unlisted
 * multi-part suffix just collapses one label further than ideal, never leaks one further than safe. */
const MULTI_PART_SUFFIXES = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'co.in', 'co.nz', 'co.kr', 'com.au', 'com.br', 'com.cn'])

const IPV4_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * The registrable domain (eTLD+1) of a hostname: the last two labels, or the last three when the
 * last two form a known multi-part suffix. Some providers put their API key in a subdomain
 * (QuickNode: `<key>.base-mainnet.quiknode.pro`); the full hostname must never become a label, a
 * `/metrics` field, or a line in the persisted ring file — only the registrable domain underneath it.
 * An IPv4 address (the loopback proxy's own upstream in tests) or a bracketed IPv6 address has no
 * "registrable domain" at all and is returned as-is, never split into its dotted octets/groups.
 */
function registrableDomain(raw: string): string {
  // One spelling per host: lower case, no trailing root dot (`host.com.` is `host.com`).
  const hostname = raw.toLowerCase().replace(/\.+$/, '')
  if (IPV4_RE.test(hostname) || hostname.includes(':')) return hostname
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length <= 2) return hostname
  const lastTwo = labels.slice(-2).join('.')
  return labels.slice(-(MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2)).join('.')
}

/**
 * Whether two provider URLs are the same operator: same registrable domain, whatever the scheme, port,
 * path, key or subdomain. Two keys of one provider, or one URL spelled two ways, are not independent.
 */
export function sameOperator(a: string, b: string): boolean {
  return registrableDomain(new URL(a).hostname).toLowerCase() === registrableDomain(new URL(b).hostname).toLowerCase()
}

/** Provider URL -> display label: registrable domain only, `#1`/`#2` suffix when several providers
 * share one (never a subdomain, the path, or a key — see `registrableDomain`). */
export function labelProviders(providers: string[]): Map<string, string> {
  const hosts = providers.map((p) => registrableDomain(new URL(p).hostname))
  const totalPerHost = new Map<string, number>()
  for (const h of hosts) totalPerHost.set(h, (totalPerHost.get(h) ?? 0) + 1)
  const seen = new Map<string, number>()
  const labels = new Map<string, string>()
  providers.forEach((p, i) => {
    const h = hosts[i]!
    if ((totalPerHost.get(h) ?? 0) > 1) {
      const idx = (seen.get(h) ?? 0) + 1
      seen.set(h, idx)
      labels.set(p, `${h}#${idx}`)
    } else labels.set(p, h)
  })
  return labels
}

/** otto/mamoru#459: HyperSync's label in /metrics (rpc counters, log ranges), beside the providers' host labels. */
export const HYPERSYNC_LABEL = 'hypersync'

/** otto/mamoru#459: how long one read of the chain's finalized block serves the log ranges of a proxy. */
const FINALIZED_TTL_MS = 30_000
/** otto/mamoru#459: what a range waits for the finalized block before the providers read it all: most of the deadline is theirs. */
const FINALIZED_WAIT_MS = 5_000

/** `p`, or a throw when `deadline` (ms since the epoch) comes first. */
function withDeadline<T>(p: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no answer within the request deadline')), Math.max(0, deadline - Date.now()))
  })
  return Promise.race([p, late]).finally(() => clearTimeout(timer))
}

/** A whole number from `name`, or `fallback` when unset or not one. */
function wholeFromEnv(name: string, fallback: number, env: Env = process.env): number {
  const v = env[name]
  const n = Number(v)
  return v !== undefined && v.trim() !== '' && Number.isInteger(n) && n >= 0 ? n : fallback
}

export type RpcProxyOptions = {
  /** otto/mamoru#444: tests only; the outage page window (default ALL_DOWN_ALERT_MS). */
  allDownAlertMs?: number
  maxLogRange?: number
  metrics?: RpcMetrics
  /** Fallback providers; default MAMORU_RPC_FALLBACKS, read now. */
  fallbacks?: string[]
  /** eth_getLogs range per host; default MAMORU_LOG_RANGES, read now. */
  logRanges?: Record<string, number>
  /** Keyed fallbacks trusted like the upstream; default MAMORU_RPC_TRUSTED, read now. */
  trusted?: string[]
  /** Split eth_getLogs into maxLogRange chunks on the upstream; default: Alchemy upstream or MAMORU_LOG_RANGE set (a Base setting). */
  chunkLogs?: boolean
  /**
   * otto/mamoru#285: eth_getLogs over a range is served only by the upstream and the trusted providers; public ones only
   * witness. A public node can leave a row out while returning the right block hash, and on Ethereum a missing Safe
   * ExecutionSuccess would mark a conversion that ran as failed.
   */
  trustedLogsOnly?: boolean
  /**
   * otto/mamoru#367: a keyed fallback (MAMORU_RPC_TRUSTED, not the upstream) is never asked for a range it needs more
   * requests than this for. Absent: no limit (Base: the keyed provider serves the archive ranges public ones refuse).
   * On Monad the public RPCs serve the archive, and there a 5000-block history slice fell through to Alchemy free
   * (10 blocks: 500 requests), timed out and spent the hour's keyed budget. Only the keyed one is left out: a ranking
   * of every provider by requests broke all Monad observations (a provider's table range, drpc 10000, is not its plan's).
   */
  keyedLogMaxRequests?: bigint
  /** Review of #398: an eth_getLogs request's deadline (default LOGS_REQUEST_MS, 50 s). */
  logsRequestMs?: number
  /**
   * Blocks behind the tip that `latest` is served at; default MAMORU_HEAD_LAG or 3. 0 for Ethereum and Monad
   * (otto/mamoru#285): a move's send block (`fromBlock`) is read at the tip, so its log scans start where the send is.
   * Terminal decisions on Ethereum read the `finalized` tag, which this proxy passes through unchanged.
   */
  headLag?: bigint
  /** Bun's idle timeout for the loopback server, in seconds (default Bun's 10). Must outlast the request's failover. */
  idleTimeoutSec?: number
  /** Every provider must answer this chain id before it is used (otto/mamoru#285); unset: no check (Base, as before). */
  chainId?: number
  /** URLs already proven on `chainId` (otto/mamoru#261: the boot probe), not asked again. */
  proven?: readonly string[]
  /** Per provider attempt; default 30 s. Shorter than the caller's budget, so a hung provider leaves time for the next (otto/mamoru#285). */
  providerTimeoutMs?: number
  /** How long a trusted block hash may witness a log range; default WITNESS_TTL_MS. Tests shorten it. */
  witnessTtlMs?: number
  /** otto/mamoru#418: providers out of quota, shared by every proxy of the operator; unset: a book of this proxy only, kept in memory. */
  quota?: QuotaBook
  /** otto/mamoru#418: day of the month each provider's quota resets on, by domain; default MAMORU_RPC_QUOTA_RESET_DAY (else the 1st). */
  quotaResetDays?: Record<string, number>
  /** otto/mamoru#420: read weights by label or domain; default MAMORU_RPC_WEIGHTS (else 1 each). */
  weights?: Record<string, number>
  /** Tests: the draw for the weighted spread, in [0, 1). */
  random?: () => number
  /** This proxy's name in /metrics (`chain`, `monad`, `l1`). */
  name?: string
  /** otto/mamoru#419: share identical reads in flight and keep pinned reads under the finalized block (default off; the operator's boot turns it on). */
  readCache?: boolean
  /** otto/mamoru#419: with readCache, how long one tip read serves every head the proxy needs; default HEAD_TTL_MS. */
  headTtlMs?: number
  /**
   * otto/mamoru#459: HyperSync for eth_getLogs ranges, the providers above being the fallback. Default: ENVIO_API_TOKEN
   * and `chainId` (Base, Monad), read now; null turns it off. Never for a loopback upstream (a fork is not mainnet).
   */
  hypersync?: HyperSyncConfig | null
  /** otto/mamoru#459: a range is asked of HyperSync only when it spans more blocks than this; default MAMORU_HYPERSYNC_MIN_BLOCKS or 100. */
  hypersyncMinBlocks?: number
  /**
   * otto/mamoru#459: the last blocks of a HyperSync range read again from the providers and compared (one page, witnessed
   * as every range is); default MAMORU_HYPERSYNC_SPOT_BLOCKS or 10. 0: no comparison when HyperSync covers the range.
   */
  hypersyncSpotBlocks?: number
  /** otto/mamoru#459: tests only; how long a range waits for the finalized block (default FINALIZED_WAIT_MS). */
  finalizedWaitMs?: number
  /** Tests: the upstream transport. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

/**
 * Everything that is not a visible character: controls, format and invisible characters (zero width, bidi marks,
 * soft hyphen and the rest of Unicode's default-ignorable set), unassigned and private-use code points, lone
 * surrogates, and every kind of space and line separator.
 */
const UNPRINTABLE_RE = /[\p{C}\p{Z}\p{Default_Ignorable_Code_Point}]+/gu
/** A word that could be part of an address: a path or scheme (`/`, `\`), userinfo (`@`), or a dot anywhere in it. */
const ADDRESS_PART_RE = /[\/\\@.]/
/** A plain decimal such as `1.5`, with the punctuation a sentence may put around it. */
const DECIMAL_RE = /^[([]?\d+\.\d+[)\],;:]?$/
/** How much of a provider's message is read at all: the rest is dropped before any pattern runs over it. */
const PROVIDER_WORDS_READ = 2000

/**
 * A provider's own words, fit for one journal line. The text is theirs, not ours, so it is read word by word:
 * whatever is not a visible character becomes a space (one message is one line, and cannot write a second one,
 * move the terminal or hide text), and any word that could be part of an endpoint address is dropped whole,
 * however the address was split: a key can sit in a hostname, a path or the userinfo, which `redactSecrets` alone
 * would keep. A dot is enough, at either end of a word too, so a word that closes a sentence with a period is
 * dropped with it: node refusals do not use them. A message that is not text says nothing: an object is not serialised.
 */
export function providerWords(message: unknown): string {
  if (typeof message !== 'string') return '(no text)'
  const words = message.slice(0, PROVIDER_WORDS_READ).replace(UNPRINTABLE_RE, ' ').split(' ').filter(Boolean)
  // A message cut short may end in half a word, with the part that gave it away as an address left behind.
  if (message.length > PROVIDER_WORDS_READ) words.pop()
  return redactSecrets(words.map((w) => (ADDRESS_PART_RE.test(w) && !DECIMAL_RE.test(w) ? '[redacted]' : w)).join(' '))
}

/** otto/mamoru#398: waits before asking a rate-limited log chunk again of the same provider (then it fails as before). */
export const RATE_RETRY_MS = [300, 1_000]
/** otto/mamoru#398: how long into an eth_getLogs request a rate-limited upstream chunk may still be asked again (the caller times out at 60 s). */
const RATE_RETRY_WINDOW_MS = 10_000
/** How long a retry waits for its answer. */
const RATE_RETRY_ASK_MS = 5_000
/** An eth_getLogs request's own deadline, under the engine client's 60 s timeout. */
const LOGS_REQUEST_MS = 50_000
/** An answer about the range itself, never a rate: asking again gets the same refusal. */
const RANGE_REFUSAL = /result|response size|block range|range (is )?too|exceeds/i

/**
 * otto/mamoru#444: a complete JSON-RPC 2.0 response: version, id, and exactly one of result or an error object with a
 * numeric code and a string message. Anything else from a provider is not an answer.
 */
export function isRpcEnvelope(json: any): boolean {
  if (!json || typeof json !== 'object' || json.jsonrpc !== '2.0' || !('id' in json)) return false
  if (('result' in json) === ('error' in json)) return false
  return !('error' in json) || (!!json.error && typeof json.error.code === 'number' && typeof json.error.message === 'string')
}

/** otto/mamoru#444: how long no provider of a proxy may go without a good answer before ops is paged. */
export const ALL_DOWN_ALERT_MS = 5 * 60_000

/**
 * otto/mamoru#444 (SPOF audit #11, post-mortem #13): one page when no provider of this proxy has given a good answer for
 * ALL_DOWN_ALERT_MS while it was being asked (failures, refusals, or every provider out of quota), and one line when an
 * answer comes back. Only fixed text and provider labels: never a URL.
 */
export class OutageWatch {
  /** Start of the current run of unanswered requests (null: the last request was answered, or none failed yet). */
  private failingSince: number | null = null
  private lastEvent: number
  private paged = false
  constructor(
    private readonly name: string,
    private readonly states: () => string,
    private readonly alertMs: number = ALL_DOWN_ALERT_MS,
    now: number = Date.now(),
  ) {
    this.lastEvent = now
  }

  ok(now: number = Date.now()): void {
    if (this.paged) console.error(`[rpc] ${this.name}: providers answer again after ${Math.round((now - (this.failingSince ?? now)) / 1000)} s without one`)
    this.paged = false
    this.failingSince = null
    this.lastEvent = now
  }

  /**
   * One request no provider answered. The run starts at the first failure after an answer, or after a quiet spell
   * longer than the window (no requests is not an outage): it pages only once failures have run unbroken for alertMs.
   */
  failed(now: number = Date.now()): void {
    if (this.failingSince === null || now - this.lastEvent > this.alertMs) this.failingSince = now
    this.lastEvent = now
    if (this.paged || now - this.failingSince < this.alertMs) return
    this.paged = true
    console.error(`[alert] rpc ${this.name}: no provider has answered for ${Math.round((now - this.failingSince) / 60_000)} min; reads and sends wait (${this.states()})`)
  }

  /** Whether a page is out (an outage not yet answered). */
  down(): boolean {
    return this.paged
  }
}

export function startRpcProxy(upstream: string, opts: RpcProxyOptions = {}): { url: string; stop: () => void; cacheStats: () => ReadCacheStats | null } {
  const providerTimeoutMs = opts.providerTimeoutMs ?? 30_000
  const rawSend = opts.fetch ?? fetch
  // otto/mamoru#285: with `chainId`, every provider proves its chain before its first use. Another chain shuts it
  // out for good (the proxy fails over as for an outage); no answer leaves it unproven, to be asked again next time.
  const proven = new Map<string, Promise<boolean>>((opts.proven ?? []).map((url) => [url, Promise.resolve(true)]))
  const onChain = (url: string): Promise<boolean> => {
    if (opts.chainId === undefined) return Promise.resolve(true)
    let p = proven.get(url)
    if (!p) {
      p = rawSend(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(providerTimeoutMs) })
        .then((r) => r.json() as Promise<{ result?: unknown }>)
        .then((j) => {
          if (typeof j?.result !== 'string') throw new Error('no chain id')
          const ok = Number(j.result) === opts.chainId
          if (!ok) console.error(`[rpc] a provider answered chain ${Number(j.result)}, not ${opts.chainId}: never used`)
          return ok
        })
        .catch(() => {
          proven.delete(url)
          return false
        })
      proven.set(url, p)
    }
    return p
  }
  const send = async (url: string, init: RequestInit): Promise<Response> =>
    (await onChain(url)) ? rawSend(url, init) : Response.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'provider not on this chain' } }, { status: 503 })
  const fallbacks = opts.fallbacks ?? fallbacksFromEnv(process.env, opts.chainId)
  const maxLogRange = opts.maxLogRange ?? Number(process.env.MAMORU_LOG_RANGE ?? 10)
  const metrics = opts.metrics
  const quota = opts.quota ?? new QuotaBook()
  const resetDays = opts.quotaResetDays ?? resetDaysFromEnv()
  /**
   * otto/mamoru#418: a refusal that says the quota is spent parks the provider until its reset (the time its answer
   * gives, else its cycle's: Alchemy the first of the month, UTC); any good answer clears it. #420: an ordinary rate
   * limit or a failure takes it out of the read spread for a few seconds (a method it does not serve does not).
   */
  // The name goes into the page: a short word only, never something a caller could put a URL in.
  const proxyName = /^[a-z0-9_-]{1,24}$/i.test(opts.name ?? 'chain') ? (opts.name ?? 'chain') : 'proxy'
  // Labels and states only (quota.providers never holds a URL): which providers are spent, cooling or merely failing.
  const outage = new OutageWatch(proxyName, () => quota.providers().filter((p) => p.proxy === proxyName).map((p) => `${p.label} ${p.state}${p.until ? ` until ${p.until}` : ''}`).join(', ') || 'no provider', opts.allDownAlertMs)
  const noteQuota = (url: string, sentAt: number, status: number | undefined, err: any, retryAfter?: string | null, envelope = false) => {
    // otto/mamoru#444, decided apart from the backoff below: an answer is an HTTP 200 carrying a complete JSON-RPC
    // response that is neither a spent quota nor a retriable refusal (a revert, an unserved method or a range refusal
    // are answers: the provider is up). Every provider refusing to serve for 5 min is an outage for the operator, since
    // its reads and sends get nothing, so a retriable refusal counts as no answer.
    const answered = status === 200 && envelope && !(err && (quotaExhausted(status, err) || retriable(status, { error: err })))
    if (answered) outage.ok()
    else outage.failed()
    if (!err) return quota.clear(url, sentAt)
    const label = labelOf(url)
    if (quotaExhausted(status, err)) {
      const now = Date.now()
      quota.mark(url, label, providerWords(err?.message).slice(0, 60), resetFromAnswer(err?.message, retryAfter, now) ?? nextReset(domainOfLabel(label), now, resetDays), now)
    } else if (!methodUnserved(err) && !RANGE_REFUSAL.test(String(err?.message ?? '')) && (status === undefined || retriable(status, { error: err }))) quota.backoff(url, label, classifyRpcError(status, err) === 'rateCapacity' ? 'burst_limited' : 'failing')
  }

  /**
   * The providers of `list` not out of quota. When every one is, only one request a minute asks one of them (a refusal
   * misread as a quota, or a plan raised, is found within the minute); every other request gets an empty list and fails
   * at once: there is nowhere else a decision read may come from, and asking a spent plan again answers nothing.
   */
  const live = <T>(list: T[], urlOf: (x: T) => string): T[] => {
    const up = list.filter((x) => !quota.skip(urlOf(x)))
    if (up.length || !list.length) return up
    const probe = quota.probeOne(list.map(urlOf))
    return probe === null ? [] : list.filter((x) => urlOf(x) === probe)
  }
  /** The answer when every provider of a call is out of quota: when the first of them resets. Never names a URL. */
  const allSpent = (urls: readonly string[], id: unknown) => {
    outage.failed()
    const at = Math.min(...urls.map((u) => quota.until(u) ?? Number.POSITIVE_INFINITY))
    return { jsonrpc: '2.0', id: id ?? null, error: { code: 429, message: `every provider for this call is out of quota${Number.isFinite(at) ? ` until ${new Date(at).toISOString()}` : ''}` } }
  }
  /** The component that made the request being served: the path the proxy was called on (`/c/<component>`), for the counters only. */
  const caller = new AsyncLocalStorage<Component>()
  let id = 0
  const local = isLoopback(upstream)
  // Chunk getLogs for Alchemy (free tier: 10 blocks) or when MAMORU_LOG_RANGE is set; otherwise the range goes as is.
  const chunkLogs = opts.chunkLogs ?? (/alchemy/i.test(new URL(upstream).hostname) || !!process.env.MAMORU_LOG_RANGE)
  const trustedFallbacks = (opts.trusted ?? trustedFromEnv()).filter((t) => t !== upstream)
  /** The upstream and the trusted keyed providers: the only ones a decision read may come from. */
  const trusted = local ? [upstream] : [upstream, ...trustedFallbacks]
  /**
   * Every provider, trusted first: eth_getLogs over a range (witnessed) and sends may use any of them. Trusted first
   * also means a trusted provider wins a tie between log providers and is asked first as a witness.
   */
  const providers = local ? [upstream] : [...trusted, ...fallbacks.filter((f) => !trusted.includes(f))]
  const labels = labelProviders(providers)
  const labelOf = (url: string) => labels.get(url) ?? registrableDomain(new URL(url).hostname)
  for (const url of providers) quota.register(url, labelOf(url), proxyName)
  /** otto/mamoru#420: each trusted provider's read weight, by its label first, then its domain; 1 when not named. */
  const weightTable = opts.weights ?? weightsFromEnv()
  const weightOf = (url: string): number => {
    const label = labelOf(url).toLowerCase()
    return weightTable[label] ?? weightTable[domainOfLabel(label)] ?? 1
  }
  const random = opts.random ?? Math.random
  /**
   * otto/mamoru#420: the highest block each provider has shown it has (its eth_blockNumber, a block it returned). A read
   * pinned to block N starts only at a provider that has shown N: the head the proxy served came from one provider, and a
   * provider behind it would answer the same decision on a block it does not have ("0x", null, "header not found").
   */
  const tips = new Map<string, bigint>()
  const noteTip = (url: string, n: unknown) => {
    if (typeof n !== 'string' || !/^0x[0-9a-fA-F]+$/.test(n)) return
    const v = BigInt(n)
    if ((tips.get(url) ?? -1n) < v) tips.set(url, v)
  }
  /**
   * A provider that answers a read pinned to block `at` as one that does not have it ("header not found", a null block):
   * after a reorg or behind a load balancer, its tip is put back under `at`, so the next reads pinned there start elsewhere.
   */
  const unseen = (url: string, at: bigint, method: string, json: any) => {
    const missing = /header not found|block not found|unknown block|missing trie node|block .*not (found|available)/i.test(String(json?.error?.message ?? '')) || (method === 'eth_getBlockByNumber' && json && 'result' in json && json.result === null)
    if (missing && (tips.get(url) ?? -1n) >= at) tips.set(url, at - 1n)
  }
  const logRanges = opts.logRanges ?? logRangesFromEnv()
  // otto/mamoru#459: HyperSync first for wide log ranges on Base and Monad. A loopback upstream is a fork: never.
  const hyper = local ? null : opts.hypersync === undefined ? hypersyncFromEnv(opts.chainId) : opts.hypersync
  const hyperMinBlocks = opts.hypersyncMinBlocks ?? wholeFromEnv('MAMORU_HYPERSYNC_MIN_BLOCKS', 100)
  const hyperSpotBlocks = opts.hypersyncSpotBlocks ?? wholeFromEnv('MAMORU_HYPERSYNC_SPOT_BLOCKS', 10)
  // The upstream keeps its setting (Alchemy or MAMORU_LOG_RANGE: chunks of maxLogRange); every other provider has its own range.
  const logProviders = providers.map((url, i) => ({ url, logRange: i === 0 && chunkLogs ? maxLogRange : logRangeOf(url, logRanges) }))
  async function post(url: string, body: unknown, timeoutMs = providerTimeoutMs): Promise<{ status: number; json: any; retryAfter: string | null }> {
    const res = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
    let json: any = null
    try {
      json = await res.json()
    } catch {}
    return { status: res.status, json, retryAfter: res.headers?.get?.('retry-after') ?? null }
  }
  /**
   * otto/mamoru#420: the provider that answered each head the proxy served, by block number (the last HEAD_SOURCES).
   * A decision reads the head once and pins every read and its guard simulation to it: they all start at the provider
   * that gave that head, so one decision sees one provider's view of that block, never two forks of it. The spread is
   * by head: each eth_blockNumber is drawn by weight.
   */
  const headSource = new Map<string, string>()
  const HEAD_SOURCES = 512
  // The first provider to give a head keeps it: a decision that already read it is pinned there.
  const noteHeadSource = (n: bigint, url: string) => {
    if (headSource.has(String(n))) return
    headSource.set(String(n), url)
    while (headSource.size > HEAD_SOURCES) headSource.delete(headSource.keys().next().value as string)
  }
  /**
   * otto/mamoru#420: the order a read tries the trusted providers in. A read pinned to a head the proxy served starts at
   * the provider that served it, while that one is not cooling. Otherwise the first is drawn by weight among those not
   * cooling (burst limit, failure) that, for a read pinned to a block, have shown that block; the rest follow in the
   * configured order, those of weight 0 last. No provider eligible: the configured order, as before.
   */
  function spread(base: string[], at: bigint | null): string[] {
    const w = base.map((u) => (quota.cooling(u) || (at !== null && (tips.get(u) ?? -1n) < at) ? 0 : weightOf(u)))
    const sticky = at === null ? undefined : headSource.get(String(at))
    const s = sticky === undefined ? -1 : base.indexOf(sticky)
    // Still has the block (not put back under it by a "header not found" since) and not cooling.
    if (s >= 0 && !quota.cooling(sticky!) && (tips.get(sticky!) ?? -1n) >= at!) return [sticky!, ...base.filter((_, j) => j !== s && w[j]! > 0), ...base.filter((_, j) => j !== s && w[j]! <= 0)]
    const total = w.reduce((a, b) => a + b, 0)
    if (!(total > 0)) return demote(base)
    let r = random() * total
    let pick = w.findIndex((x) => x > 0)
    for (let i = 0; i < base.length; i++) {
      if (w[i]! <= 0) continue
      pick = i
      if ((r -= w[i]!) < 0) break
    }
    return [base[pick]!, ...base.filter((_, j) => j !== pick && w[j]! > 0), ...base.filter((_, j) => j !== pick && w[j]! <= 0)]
  }
  /** The configured order with the providers in a short backoff moved to the end (still tried, after the others). */
  const demote = (base: string[]): string[] => [...base.filter((u) => !quota.cooling(u)), ...base.filter((u) => quota.cooling(u))]
  /**
   * Block hashes a trusted provider answered in the last WITNESS_TTL_MS, by block number: the engine reads the
   * blocks of its observation through raw() right before it asks for logs, and that answer can witness a log
   * range served by another operator without asking the same provider for the same block again. Only trusted
   * providers reach raw() for blocks; an entry older than the TTL is not used. A reorg inside the TTL can at
   * worst make a stale hash accept logs of the old fork from a provider still on it: the observation's own
   * final hash check on its pinned block, made after the logs, is what rejects that view.
   */
  const witnessTtl = opts.witnessTtlMs ?? WITNESS_TTL_MS
  const recent = new Map<string, { url: string; hash: string; at: number }>()
  function remember(url: string, block: unknown): void {
    const b = block as { number?: unknown; hash?: unknown } | null
    if (!b || typeof b.number !== 'string' || typeof b.hash !== 'string') return
    const at = Date.now()
    for (const [k, v] of recent) if (at - v.at >= witnessTtl) recent.delete(k)
    recent.set(String(BigInt(b.number)), { url, hash: b.hash, at })
  }
  /**
   * On a rate/capacity refusal, move to the next provider at once; two passes over the list. The list is the
   * trusted providers, or every provider for a send. Always returns a result/error object.
   */
  async function raw(body: any, isChunk = false, start = 0, answered?: { url?: string }): Promise<any> {
    let last: any = null
    const isSend = ANY_PROVIDER.has(body?.method)
    const pool = isSend ? providers : trusted
    const base = live(pool, (u) => u)
    if (!base.length) return allSpent(pool, body?.id)
    // `start` rotates the list: a retry asks the next provider first. Sends and reads by tag or hash (nonces, receipts)
    // keep the exact configured order (#420); only a read pinned to a block, and the head itself, are spread.
    const at = pinnedAt(body ?? {})
    const spreads = start === 0 && !isSend && ((at !== null && isRead(body.method)) || body?.method === 'eth_blockNumber')
    let list = spreads ? spread(base, at) : [...base.slice(start % base.length), ...base.slice(0, start % base.length)]
    // In the spread, a spent provider let through to be asked again (its daily recheck, its reset) goes first, or it may
    // never be drawn. Elsewhere it waits its turn in the configured order.
    if (spreads && list.some((u) => quota.down(u))) list = [...list.filter((u) => quota.down(u)), ...list.filter((u) => !quota.down(u))]
    // The one request of a minute that asks a spent provider again (see `live`) is one request, not two passes.
    const all = base.length === 1 && pool.every((u) => quota.down(u)) ? list : [...list, ...list]
    for (const [pi, url] of all.entries()) {
      const label = labelOf(url)
      const tries = 1
      if (pi === list.length) await Bun.sleep(250)
      for (let attempt = 0; attempt < tries; attempt++) {
        try {
          const sentAt = Date.now()
          const r = await post(url, body)
          if (metrics) safeMetrics(() => metrics.recordRequest(label, body.method, isChunk, Date.now(), caller.getStore()))
          const errObj = r.json?.error ?? (wellFormed(r.json) ? undefined : { code: -32603, message: `upstream HTTP ${r.status}` })
          if (errObj && metrics) safeMetrics(() => metrics.recordError(label, body.method, classifyRpcError(r.status, errObj)))
          noteQuota(url, sentAt, r.status, errObj, r.retryAfter, isRpcEnvelope(r.json))
          if (at !== null) unseen(url, at, body.method, r.json)
          if (wellFormed(r.json) && !retriable(r.status, r.json)) {
            if (body.method === 'eth_getBlockByNumber') remember(url, r.json.result)
            if (body.method === 'eth_blockNumber') noteTip(url, r.json.result)
            else if (body.method === 'eth_getBlockByNumber') noteTip(url, r.json.result?.number)
            if (answered) answered.url = url
            return r.json
          }
          last = errObj
        } catch (e) {
          if (metrics) safeMetrics(() => metrics.recordRequest(label, body.method, isChunk, Date.now(), caller.getStore()))
          last = { code: -32603, message: (e as Error).message.split('\n')[0] }
          quota.backoff(url, label, 'failing')
          outage.failed() // otto/mamoru#444: unreachable or timed out is no answer
          if (metrics) safeMetrics(() => metrics.recordError(label, body.method, classifyRpcError(undefined, last)))
        }
        if (attempt + 1 < tries) await Bun.sleep(400 * 2 ** attempt)
      }
      const next = all[pi + 1]
      if (next !== undefined && next !== url && metrics) safeMetrics(() => metrics.recordFallback(label, body.method))
      if (pi === 0 && list.length > 1 && process.env.MAMORU_RPC_LOG) console.log(`[rpc] ${body?.method} falling back after: ${providerWords(last?.message).slice(0, 120)}`)
    }
    return { jsonrpc: '2.0', id: body?.id ?? null, error: { code: typeof last?.code === 'number' ? last.code : -32603, message: String(last?.message ?? 'upstream unavailable') } }
  }
  async function one(method: string, params: unknown[], isChunk = false): Promise<any> {
    const r = await raw({ jsonrpc: '2.0', id: ++id, method, params }, isChunk)
    if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error })
    return r.result
  }
  const toNum = async (tag: unknown): Promise<bigint> => {
    if (typeof tag === 'string' && tag.startsWith('0x')) return BigInt(tag)
    if (tag === undefined || tag === 'latest' || tag === 'pending') return head()
    const b = await one('eth_getBlockByNumber', [tag, false])
    return BigInt(b.number)
  }
  type LogProvider = (typeof logProviders)[number]
  const hex = (n: bigint) => `0x${n.toString(16)}`
  /** One request to one provider, no fallback: the result, or a throw carrying the RPC error. */
  async function ask(url: string, method: string, params: unknown[], isChunk = false, timeoutMs = providerTimeoutMs): Promise<any> {
    const label = labelOf(url)
    let r: { status: number; json: any; retryAfter: string | null }
    const sentAt = Date.now()
    try {
      r = await post(url, { jsonrpc: '2.0', id: ++id, method, params }, timeoutMs)
    } catch (e) {
      const rpc = { code: -32603, message: (e as Error).message.split('\n')[0] }
      if (metrics) safeMetrics(() => (metrics.recordRequest(label, method, isChunk, Date.now(), caller.getStore()), metrics.recordError(label, method, classifyRpcError(undefined, rpc))))
      outage.failed() // otto/mamoru#444: unreachable or timed out is no answer
      throw Object.assign(new Error(String(rpc.message)), { rpc })
    }
    if (metrics) safeMetrics(() => metrics.recordRequest(label, method, isChunk, Date.now(), caller.getStore()))
    const rpc = r.json?.error ?? (wellFormed(r.json) ? undefined : { code: -32603, message: `upstream HTTP ${r.status}` })
    noteQuota(url, sentAt, r.status, rpc, r.retryAfter, isRpcEnvelope(r.json))
    if (!rpc) {
      if (method === 'eth_getBlockByNumber') noteTip(url, r.json.result?.number)
      return r.json.result
    }
    if (metrics) safeMetrics(() => metrics.recordError(label, method, classifyRpcError(r.status, rpc)))
    throw Object.assign(new Error(String(rpc.message)), { rpc, status: r.status })
  }
  const ranges = (from: bigint, to: bigint, size: number): [bigint, bigint][] => {
    if (!Number.isFinite(size)) return [[from, to]]
    const out: [bigint, bigint][] = []
    for (let a = from; a <= to; a += BigInt(size)) {
      const b = a + BigInt(size) - 1n
      out.push([a, b < to ? b : to])
    }
    return out
  }
  const byBlockAndIndex = (a: any, b: any) => {
    if (a?.blockNumber == null || b?.blockNumber == null) return 0
    const [x, y] = [BigInt(a.blockNumber), BigInt(b.blockNumber)]
    return x === y ? Number(BigInt(a.logIndex) - BigInt(b.logIndex)) : x < y ? -1 : 1
  }
  type Rejection = Exclude<LogRangeOutcome, 'accepted'>
  const fail = (message: string, reason: Rejection = 'provider_error') => Object.assign(new Error(message), { rpc: { code: -32603, message }, reason })
  /** otto/mamoru#398 (review): what a provider ask may wait inside an eth_getLogs request's deadline, never past it. */
  /** Review of #398: past the request's deadline nothing more is asked, of this provider or another. */
  const inTime = (deadline?: number) => {
    if (deadline !== undefined && Date.now() >= deadline) throw fail('eth_getLogs: no provider answered within the request deadline')
  }
  // Every ask of an eth_getLogs request takes its timeout here, so none starts past the deadline (review of #398).
  const leftOf = (deadline?: number): number => {
    if (deadline === undefined) return providerTimeoutMs
    const left = deadline - Date.now()
    if (left <= 0) throw fail('eth_getLogs: no provider answered within the request deadline')
    return Math.min(providerTimeoutMs, left)
  }
  /**
   * otto/mamoru#398: one chunk, asked again of the upstream after a short wait when it answers that it is over its rate
   * (a per-second limit, gone a moment later). Live 12 Nov on Base: the upstream rate-limited ~10% of a catch-up's chunks,
   * each failed the whole range, and the public fallbacks cannot serve archive ranges, so the read never ended. Only the
   * upstream: a fallback over its rate is passed over at once, as before, so a range every provider refuses fails fast.
   */
  async function chunkFrom(p: LogProvider, filter: any, a: bigint, b: bigint, isChunk: boolean, retryUntil: number | null, deadline?: number): Promise<unknown> {
    for (let k = 0; ; k++) {
      if (k > 0) inTime(deadline)
      try {
        // A retry waits for its answer at most RATE_RETRY_ASK_MS: it never holds the range much past the retry window.
        return await ask(p.url, 'eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }], isChunk, k === 0 ? leftOf(deadline) : Math.min(leftOf(deadline), RATE_RETRY_ASK_MS))
      } catch (e) {
        // Review of #398: only within the request's retry window (the caller times out at 60 s), only in the first pass over
        // the providers, and never for an answer about the range itself (too many results, too wide).
        // A spent plan (#418) is no rate: asking again in a second gets the same refusal.
        const overRate = classifyRpcError((e as any).status, (e as any).rpc) === 'rateCapacity' && !RANGE_REFUSAL.test(String((e as any).rpc?.message ?? '')) && !quotaExhausted((e as any).status, (e as any).rpc)
        if (retryUntil === null || p.url !== upstream || k >= RATE_RETRY_MS.length || Date.now() + RATE_RETRY_MS[k]! >= retryUntil || !overRate) throw e
        await Bun.sleep(RATE_RETRY_MS[k]!)
      }
    }
  }
  /** The whole range from one provider, in chunks it accepts. Any failed chunk fails the provider: providers are never mixed inside one range. */
  async function logsFrom(p: LogProvider, filter: any, from: bigint, to: bigint, retryUntil: number | null = null, deadline?: number): Promise<unknown[]> {
    const chunks = ranges(from, to, p.logRange)
    const out: unknown[] = []
    for (let i = 0; i < chunks.length; i += 4) {
      inTime(deadline)
      const part = await Promise.all(chunks.slice(i, i + 4).map(([a, b]) => chunkFrom(p, filter, a, b, chunks.length > 1, retryUntil, deadline)))
      for (const logs of part) {
        if (!Array.isArray(logs)) throw fail('eth_getLogs answered no list')
        out.push(...logs)
      }
    }
    return out.sort(byBlockAndIndex)
  }
  /** Witness answers of one incoming request, by block number: ranges of that request ending at the same block share them. Never kept longer. */
  type Witnessed = Map<string, { url: string; hash: string }>
  const blockHash = async (url: string, n: bigint, deadline?: number): Promise<string | null> => (await ask(url, 'eth_getBlockByNumber', [hex(n), false], false, leftOf(deadline)))?.hash ?? null
  /**
   * The hash of block `n` from a provider other than `p`, asked directly: no fallback chain that could land
   * on `p` itself. Logs from the upstream are witnessed by the fallbacks in order; logs from a fallback by the
   * upstream first, then the other fallbacks. A witness that fails or does not have the block yet is skipped;
   * the first one that has it decides. Null when none has it.
   */
  async function witnessHash(p: LogProvider, n: bigint, seen: Witnessed, deadline?: number): Promise<string | null> {
    const known = seen.get(String(n))
    if (known && !sameOperator(known.url, p.url)) return known.hash
    // A block a trusted provider of another operator answered moments ago (see `recent`).
    const cached = recent.get(String(n))
    if (cached && Date.now() - cached.at < witnessTtl && Date.now() >= cached.at && !sameOperator(cached.url, p.url)) {
      seen.set(String(n), { url: cached.url, hash: cached.hash })
      return cached.hash
    }
    // Independence is by operator, not by URL: another key or another spelling of the same provider is no witness.
    // Witnesses out of quota are passed over, unless every one is (#418, as for the providers of the range).
    for (const w of live(logProviders.filter((x) => !sameOperator(x.url, p.url)), (x) => x.url)) {
      const hash = await blockHash(w.url, n, deadline).catch(() => null)
      if (!hash) continue
      seen.set(String(n), { url: w.url, hash })
      return hash
    }
    return null
  }
  /**
   * Logs and state must come from the same chain view, proven and not assumed. A range read from a provider
   * counts only if, asked after the read, that provider has the range's last block and an independent witness
   * has it with the same hash: a provider that is behind does not know the block, one on another fork has
   * another hash. Nothing is remembered about a provider beyond the block hashes of the last WITNESS_TTL_MS (see
   * `recent`), and the upstream is held to the same rule. One direct block read on the provider and, unless a
   * trusted provider of another operator just answered that block, one on the witness per range.
   */
  async function verifiedLogs(p: LogProvider, filter: any, from: bigint, to: bigint, seen: Witnessed, retryUntil: number | null = null, deadline?: number): Promise<unknown[]> {
    const logs = await logsFrom(p, filter, from, to, retryUntil, deadline)
    inTime(deadline)
    const own = await blockHash(p.url, to, deadline)
    if (!own) throw fail(`provider does not have block ${to}: its logs for the range may be incomplete`)
    // A local fork is one node and the only provider: there is no witness by construction, and its own block is the check.
    if (local) return logs
    inTime(deadline)
    const witness = await witnessHash(p, to, seen, deadline)
    if (!witness) throw fail(`no other provider has block ${to} to witness the logs`, 'no_witness')
    if (own.toLowerCase() !== witness.toLowerCase()) throw fail(`provider and witness have another block ${to}: the logs may be from another chain view`, 'hash_mismatch')
    return logs
  }
  async function getLogs(msg: Req, seen: Witnessed): Promise<unknown> {
    const filter = { ...(msg.params?.[0] ?? {}) }
    // Logs of one block by hash: from a trusted provider only, which needs no witness (a public node could leave rows out).
    if (filter.blockHash) return one('eth_getLogs', [filter])
    // A remote upstream alone could only witness itself: no logs are read at all.
    if (!local && !logProviders.some((w) => !sameOperator(w.url, upstream))) {
      if (metrics) safeMetrics(() => metrics.recordLogRange(labelOf(upstream), 'no_witness'))
      throw fail('eth_getLogs needs a provider from another operator to witness the range: set MAMORU_RPC_FALLBACKS', 'no_witness')
    }
    const from = await toNum(filter.fromBlock ?? 'latest')
    const to = await toNum(filter.toBlock ?? 'latest')
    if (from > to) return []
    // Review of #398: the whole request answers within LOGS_REQUEST_MS, every ask in it bounded by what is left (the caller
    // times out at 60 s; before, sequential provider asks of up to 30 s each could outlast it). HyperSync's share included.
    const deadline = Date.now() + (opts.logsRequestMs ?? LOGS_REQUEST_MS)
    if (hyper && to - from + 1n > BigInt(hyperMinBlocks)) {
      const logs = await hyperRange(filter, from, to, seen, deadline)
      if (logs) return logs
    }
    return providerLogs(filter, from, to, seen, deadline)
  }
  /**
   * otto/mamoru#459: the chain's finalized block, read from the trusted providers and kept FINALIZED_TTL_MS. Null when
   * it cannot be read (then the whole range is the providers'). A failed read is not kept.
   */
  let finalizedRead: { p: Promise<bigint | null>; at: number } | null = null
  function finalizedBlock(deadline: number): Promise<bigint | null> {
    const now = Date.now()
    if (!finalizedRead || now - finalizedRead.at >= FINALIZED_TTL_MS || now < finalizedRead.at) {
      const mine: { p: Promise<bigint | null>; at: number } = {
        at: now,
        p: one('eth_getBlockByNumber', ['finalized', false]).then((b: any) => (typeof b?.number === 'string' && /^0x[0-9a-fA-F]+$/.test(b.number) ? BigInt(b.number) : null)).catch(() => null),
      }
      mine.p.then((n) => {
        if (n === null && finalizedRead === mine) finalizedRead = null
      })
      finalizedRead = mine
    }
    // A short wait, never the request's deadline: a slow answer leaves the providers the time to read the whole range.
    const wait = Date.now() + (opts.finalizedWaitMs ?? FINALIZED_WAIT_MS)
    return withDeadline(finalizedRead.p, wait < deadline ? wait : deadline).catch(() => null)
  }
  /**
   * otto/mamoru#459: HyperSync reads only finalized history, [from, min(finalized, its archive, to)]: no reorg reaches
   * it, so what it answered there is the chain. The providers read everything above, together with the last
   * `hyperSpotBlocks` blocks of HyperSync's part, witnessed as every range is; those blocks must hold the same logs,
   * field by field, or HyperSync is not believed for this request and the whole range comes from the providers. Null
   * when HyperSync is not used (finalized unknown, too few finalized blocks) or gave nothing usable (refused, over
   * this minute's budget, timed out): the caller asks the providers. A provider failure throws as it would without HyperSync.
   */
  async function hyperRange(filter: any, from: bigint, to: bigint, seen: Witnessed, deadline: number): Promise<unknown[] | null> {
    const component = caller.getStore()
    const finalized = await finalizedBlock(deadline)
    if (finalized === null) {
      if (process.env.MAMORU_RPC_LOG) console.log('[rpc] eth_getLogs hypersync: finalized block unknown; read from the RPC providers')
      return null
    }
    const hyperTo = finalized < to ? finalized : to
    // A finalized part the providers read in a page or two is not worth a HyperSync request of the minute's budget.
    if (hyperTo < from || hyperTo - from + 1n <= BigInt(hyperMinBlocks)) return null
    let read: Awaited<ReturnType<typeof hypersyncLogs>>
    try {
      // At most a third of the request's time: the providers keep enough of it when HyperSync fails.
      read = await hypersyncLogs(hyper!, filter, from, hyperTo, {
        deadline: Math.min(deadline, Date.now() + Math.floor((deadline - Date.now()) / 3)),
        onRequest: (page) => {
          if (metrics) safeMetrics(() => metrics.recordRequest(HYPERSYNC_LABEL, 'eth_getLogs', page > 0, Date.now(), component))
        },
      })
    } catch (e) {
      const kind = e instanceof HyperSyncError ? e.kind : 'http'
      // A spent budget or an unsupported filter sent nothing: there is no error of HyperSync's to count.
      const asked = !(e instanceof HyperSyncError) || e.status !== undefined || kind === 'timeout' || kind === 'answer' || kind === 'http'
      if (metrics && asked) safeMetrics(() => (metrics.recordError(HYPERSYNC_LABEL, 'eth_getLogs', kind === 'rate' ? 'rateCapacity' : kind === 'timeout' ? 'timeout' : 'other'), metrics.recordLogRange(HYPERSYNC_LABEL, 'provider_error'), metrics.recordFallback(HYPERSYNC_LABEL, 'eth_getLogs')))
      if (process.env.MAMORU_RPC_LOG || (e instanceof HyperSyncError && e.status === 429)) console.log(`[rpc] eth_getLogs hypersync: ${e instanceof HyperSyncError ? e.message : 'failed'}; read from the RPC providers`)
      return null
    }
    if (read.covered < from) return null
    // The providers read what HyperSync did not (above finalized, past its archive) and its last blocks, to compare.
    const spotFrom = read.covered + 1n - BigInt(hyperSpotBlocks)
    const tailFrom = spotFrom > from ? spotFrom : from
    const tail = tailFrom <= to ? await providerLogs(filter, tailFrom, to, seen, deadline) : []
    const inOverlap = (l: any) => BigInt(l.blockNumber) >= tailFrom && BigInt(l.blockNumber) <= read.covered
    if (!sameLogs(read.logs.filter(inOverlap), tail.filter(inOverlap))) {
      console.warn(`[rpc] eth_getLogs hypersync: logs of blocks ${tailFrom} to ${read.covered} differ from the RPC providers'; this range is read from them`)
      if (metrics) safeMetrics(() => (metrics.recordLogRange(HYPERSYNC_LABEL, 'hash_mismatch'), metrics.recordFallback(HYPERSYNC_LABEL, 'eth_getLogs')))
      const head = tailFrom > from ? await providerLogs(filter, from, tailFrom - 1n, seen, deadline) : []
      return [...head, ...tail]
    }
    if (metrics) safeMetrics(() => metrics.recordLogRange(HYPERSYNC_LABEL, 'accepted'))
    return [...read.logs.filter((l) => BigInt(l.blockNumber) < tailFrom), ...tail]
  }
  /** The range from the RPC providers, witnessed (the path every range took before HyperSync). */
  async function providerLogs(filter: any, from: bigint, to: bigint, seen: Witnessed, deadline: number): Promise<unknown[]> {
    // A trusted provider that serves the range in a few requests goes first. Then the fewest requests, the
    // configured order breaking ties: a public provider (witnessed) serves logs only after those, or when the
    // trusted ones would need many small requests (Alchemy free: 10 blocks each). Two passes, as for every other call.
    // otto/mamoru#398: rate-limited upstream chunks are asked again only this early in the request.
    const retryUntil = Date.now() + RATE_RETRY_WINDOW_MS
    // Retries end before the deadline does, whatever the two are set to.
    const retryWindow = retryUntil < deadline ? retryUntil : deadline
    const span = to - from + 1n
    const requests = (p: LogProvider) => (Number.isFinite(p.logRange) ? (span + BigInt(p.logRange) - 1n) / BigInt(p.logRange) : 1n)
    const tier = (p: LogProvider, n: bigint) => (trusted.includes(p.url) && n <= TRUSTED_LOG_MAX_REQUESTS ? 0 : 1)
    const allowed = logProviders
      .filter((p) => !opts.trustedLogsOnly || trusted.includes(p.url))
      .map((p, i) => { const n = requests(p); return { p, i, n, t: tier(p, n) } })
    // Where set, never the keyed fallback for a range that takes it many requests (#367).
    const cap = opts.keyedLogMaxRequests
    const order = live(cap === undefined ? allowed : allowed.filter((x) => !trustedFallbacks.includes(x.p.url) || x.n <= cap), (x) => x.p.url).sort((a, b) => a.t - b.t || (a.n === b.n ? a.i - b.i : a.n < b.n ? -1 : 1))
    let last: any = order.length ? null : allSpent(allowed.map((x) => x.p.url), null).error
    // What the caller is told when nothing is accepted: a range that was read but not witnessed says more than a provider being down.
    let unwitnessed: any = null
    // The one request of a minute that asks a spent provider again (see `live`) is one pass, as in raw().
    const probing = order.length === 1 && allowed.every((x) => quota.down(x.p.url))
    for (const [k, { p }] of (probing ? order : [...order, ...order]).entries()) {
      if (k === order.length && Date.now() + 250 < deadline) await Bun.sleep(250)
      const label = labelOf(p.url)
      try {
        if (Date.now() >= deadline) {
          last ??= { code: -32603, message: 'eth_getLogs: no provider answered within the request deadline' }
          break
        }
        const logs = await verifiedLogs(p, filter, from, to, seen, k < order.length ? retryWindow : null, deadline)
        if (metrics) safeMetrics(() => metrics.recordLogRange(label, 'accepted'))
        return logs
      } catch (e) {
        last = (e as any).rpc ?? { code: -32603, message: (e as Error).message.split('\n')[0] }
        const reason: Rejection = (e as any).reason ?? 'provider_error'
        if (reason !== 'provider_error') unwitnessed = last
        if (metrics) safeMetrics(() => (metrics.recordLogRange(label, reason), logProviders.length > 1 && metrics.recordFallback(label, 'eth_getLogs')))
        if (process.env.MAMORU_RPC_LOG) console.log(`[rpc] eth_getLogs ${label} rejected (${reason}): ${providerWords(last?.message).slice(0, 120)}`)
      }
    }
    last = unwitnessed ?? last
    throw Object.assign(new Error(String(last?.message ?? 'upstream unavailable')), { rpc: { code: typeof last?.code === 'number' ? last.code : -32603, message: String(last?.message ?? 'upstream unavailable') } })
  }
  // A load-balanced provider answers from nodes a block or two apart: a head read from one node and a call pinned
  // to it on another gives "0x", null fields or "block not found". Serve `latest` a few blocks behind the tip.
  const lag = opts.headLag ?? BigInt(process.env.MAMORU_HEAD_LAG ?? 3)
  /**
   * otto/mamoru#420: the head comes from whichever trusted provider the spread drew, so a provider a block behind
   * another could step the served head back. For HEAD_HOLD_MS a lower answer serves the last head again: every read
   * pinned to it starts at a provider that has shown that block (see `tips`). Past that the provider's answer is taken
   * as is, so one wrong answer cannot hold the head for longer.
   */
  let served: { n: bigint; at: number } | null = null
  const headTtl = opts.readCache === true ? (opts.headTtlMs ?? HEAD_TTL_MS) : 0
  let tipRead: { p: Promise<bigint>; at: number } | null = null
  let headShared = 0
  function head(): Promise<bigint> {
    const now = Date.now()
    if (tipRead && now - tipRead.at < headTtl && now >= tipRead.at) {
      headShared++
      return tipRead.p
    }
    const p = readHead()
    if (headTtl > 0) {
      const mine = { p, at: now }
      tipRead = mine
      // A failed read is never served again.
      p.catch(() => {
        if (tipRead === mine) tipRead = null
      })
    }
    return p
  }
  async function readHead(): Promise<bigint> {
    const answered: { url?: string } = {}
    const r = await raw({ jsonrpc: '2.0', id: ++id, method: 'eth_blockNumber', params: [] }, false, 0, answered)
    if (r.error) throw Object.assign(new Error(r.error.message), { rpc: r.error })
    const tip = BigInt(r.result)
    cache?.noteHead(tip)
    const now = Date.now()
    const n = tip - lag
    if (served && n < served.n && now - served.at < HEAD_HOLD_MS && now >= served.at) return served.n
    served = { n, at: now }
    if (answered.url) noteHeadSource(n, answered.url)
    return n
  }
  const cache = opts.readCache !== true ? null : new ReadCache(() => one('eth_getBlockByNumber', ['finalized', false]))
  // otto/mamoru#419: MAMORU_RPC_TRACE_SAMPLE=N logs one request in N with its component, method, block tag and, for a
  // call, its target and selector: enough to name the code that makes it, never a URL, a key or calldata past 4 bytes.
  const traceEvery = Number(process.env.MAMORU_RPC_TRACE_SAMPLE ?? 0)
  let traced = 0
  const trace = (msg: Req) => {
    if (!(traceEvery > 0) || ++traced % traceEvery !== 0) return
    const p = msg.params ?? []
    const call = msg.method === 'eth_call' || msg.method === 'eth_estimateGas' ? (p[0] as { to?: unknown; data?: unknown; input?: unknown } | undefined) : undefined
    const data = String(call?.data ?? call?.input ?? '')
    // Only a block param, and only as one of the named tags or "n" (a number): nothing else a request carries is logged.
    const b = pinnedBlockParam(msg)
    const tag = b === undefined ? '-' : typeof b === 'string' && TRACE_TAGS.has(b) ? b : 'n'
    const to = typeof call?.to === 'string' && /^0x[0-9a-fA-F]{40}$/.test(call.to) ? call.to.toLowerCase() : '?'
    const sel = /^0x[0-9a-fA-F]{8}/.test(data) ? data.slice(0, 10) : '?'
    const method = /^[a-zA-Z0-9_]{1,40}$/.test(msg.method) ? msg.method : '?'
    console.log(`[rpc-trace] ${caller.getStore() ?? 'unlabelled'} ${method} ${tag}${call ? ` ${to} ${sel}` : ''}`)
  }
  async function handle(msg: Req, seen: Witnessed): Promise<unknown> {
    trace(msg)
    // otto/mamoru#419: every provider this proxy uses proved `chainId` before its first request (see onChain): the
    // answer is known, and asking for it again (observe() does on every review) proves nothing more.
    // A send drops every kept latest answer before it goes out and quiets the layer until it is settled (read-cache.ts).
    if (cache && msg.method === 'eth_sendRawTransaction') cache.changed(LATEST_QUIET_MS)
    if (msg.method === 'eth_chainId' && opts.chainId !== undefined && cache) return { jsonrpc: '2.0', id: msg.id, result: `0x${opts.chainId.toString(16)}` }
    const kept = cache?.hit(msg)
    if (kept !== undefined) return { ...(kept as object), id: msg.id }
    const r = cache ? { ...((await cache.run(msg, () => handleInner(msg, seen))) as object), id: msg.id } : await handleInner(msg, seen)
    // Answered: dropped again, quiet from now. A transaction found mined changes state too: nothing from before is served.
    if (cache && msg.method === 'eth_sendRawTransaction') cache.changed(LATEST_QUIET_MS)
    else if (cache && msg.method === 'eth_getTransactionReceipt' && (r as any)?.result) cache.changed()
    // Name the call behind an invalid-params refusal: the engine only sees the message.
    const e = (r as any)?.error
    if (e && msg.method === 'eth_sendRawTransaction') {
      // Why a provider refused a transaction: the sender only sees a generic message (viem folds -32000 into
      // "Missing or invalid parameters"). The provider's words, never the transaction; a log line never costs the answer.
      try {
        console.log(`[rpc] eth_sendRawTransaction refused (${typeof e.code === 'number' ? e.code : '?'}): ${providerWords(e.message)}`)
      } catch {}
    } else if (e && (e.code === -32602 || /invalid param/i.test(String(e.message)))) console.log(`[rpc] ${msg.method} refused (${e.code}): ${redactSecrets(JSON.stringify(msg.params ?? [])).slice(0, 300)}`)
    return r
  }
  async function handleInner(msg: Req, seen: Witnessed): Promise<unknown> {
    try {
      if (msg.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: msg.id, result: `0x${(await head()).toString(16)}` }
      if (msg.method === 'eth_getBlockByNumber' && (msg.params?.[0] === 'latest' || msg.params?.[0] === 'pending')) {
        return { jsonrpc: '2.0', id: msg.id, result: await one('eth_getBlockByNumber', [`0x${(await head()).toString(16)}`, msg.params?.[1] ?? false]) }
      }
      if (msg.method === 'eth_getLogs') return { jsonrpc: '2.0', id: msg.id, result: await getLogs(msg, seen) }
      let r = await raw({ ...msg })
      // A block by number that this node does not have yet comes back null: ask again.
      // Each retry starts at the next trusted provider: another node of the upstream, or a trusted fallback, may have it.
      for (let i = 0; i < 3 && msg.method.startsWith('eth_getBlockBy') && r && 'result' in r && r.result === null; i++) {
        await Bun.sleep(700)
        r = await raw({ ...msg }, false, i + 1)
      }
      return { ...r, id: msg.id }
    } catch (e) {
      const rpc = (e as any).rpc ?? { code: -32603, message: (e as Error).message.split('\n')[0] }
      return { jsonrpc: '2.0', id: msg.id, error: rpc }
    }
  }
  const server: Server<undefined> = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Bun closes a connection idle this long, a pending handler included: it must outlast the request's whole failover.
    ...(opts.idleTimeoutSec !== undefined ? { idleTimeout: opts.idleTimeoutSec } : {}),
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const payload = (await req.json()) as Req | Req[]
      const seen: Witnessed = new Map()
      const answer = () => (Array.isArray(payload) ? Promise.all(payload.map((m) => handle(m, seen))) : handle(payload, seen))
      return Response.json(await caller.run(componentOf(new URL(req.url).pathname), answer))
    },
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true), cacheStats: (): ReadCacheStats | null => (cache ? { ...cache.snapshot(), headShared } : null) }
}
