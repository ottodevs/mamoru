import type { Server } from 'bun'
import { AsyncLocalStorage } from 'node:async_hooks'
import { classifyRpcError, componentOf, redactSecrets, safeMetrics, type Component, type LogRangeOutcome, type RpcMetrics } from './metrics.ts'

type Req = { jsonrpc: '2.0'; id: unknown; method: string; params?: any[] }

/**
 * Loopback JSON-RPC proxy in front of the upstream provider. It keeps the
 * keyed URL inside this process (viem errors echo the URL they called),
 * splits eth_getLogs into ranges the provider accepts and sends it to the
 * provider that serves the range in the fewest requests, accepting the logs
 * only when an independent provider witnesses the hash of the range's last
 * block.
 */
const DEFAULT_FALLBACKS = 'https://base-rpc.publicnode.com,https://base.drpc.org,https://mainnet.base.org'

type Env = Record<string, string | undefined>

/** Read when the proxy starts, never at module load: main.ts fills process.env from the env file after its imports ran. */
export function fallbacksFromEnv(env: Env = process.env): string[] {
  return (env.MAMORU_RPC_FALLBACKS ?? DEFAULT_FALLBACKS).split(',').map((u) => u.trim()).filter(Boolean)
}

/**
 * Keyed providers the operator trusts as much as the upstream (MAMORU_RPC_TRUSTED, comma separated). Every call
 * except eth_getLogs and sends falls back only among the upstream and these: state, heads, blocks and simulations
 * that decide what the operator signs never come from a public node. Read when the proxy starts.
 */
export function trustedFromEnv(env: Env = process.env): string[] {
  return (env.MAMORU_RPC_TRUSTED ?? '').split(',').map((u) => u.trim()).filter(Boolean)
}

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

/** Rate or capacity refusals that are worth a retry or another provider, not a real answer. */
function retriable(status: number, body: any): boolean {
  if (status === 429 || status >= 500) return true
  const e = body?.error
  if (!e) return false
  return e.code === 429 || e.code === -32005 || /rate|capacity|limit exceeded|compute units|too many|throughput|timeout|temporar/i.test(String(e.message))
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

export type RpcProxyOptions = {
  maxLogRange?: number
  metrics?: RpcMetrics
  /** Fallback providers; default MAMORU_RPC_FALLBACKS, read now. */
  fallbacks?: string[]
  /** eth_getLogs range per host; default MAMORU_LOG_RANGES, read now. */
  logRanges?: Record<string, number>
  /** Keyed fallbacks trusted like the upstream; default MAMORU_RPC_TRUSTED, read now. */
  trusted?: string[]
  /** How long a trusted block hash may witness a log range; default WITNESS_TTL_MS. Tests shorten it. */
  witnessTtlMs?: number
  /** Tests: the upstream transport. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>
}

const ANY_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g
/** How much of a provider's message is read at all: the rest is dropped before any pattern runs over it. */
const PROVIDER_WORDS_READ = 2000

/**
 * A provider's own words, fit for one journal line. The text is theirs, not ours, so: a URL goes whole (a key can
 * sit in the hostname, which `redactSecrets` keeps), and control characters and line separators become a space
 * (one message is one line, and cannot write a second one or move the terminal).
 */
export function providerWords(message: unknown): string {
  const read = typeof message === 'string' ? message.slice(0, PROVIDER_WORDS_READ).replace(ANY_URL_RE, '[url]') : message
  return redactSecrets(read).replace(ANY_URL_RE, '[url]').replace(CONTROL_RE, ' ')
}

export function startRpcProxy(upstream: string, opts: RpcProxyOptions = {}): { url: string; stop: () => void } {
  const send = opts.fetch ?? fetch
  const fallbacks = opts.fallbacks ?? fallbacksFromEnv()
  const maxLogRange = opts.maxLogRange ?? Number(process.env.MAMORU_LOG_RANGE ?? 10)
  const metrics = opts.metrics
  /** The component that made the request being served: the path the proxy was called on (`/c/<component>`), for the counters only. */
  const caller = new AsyncLocalStorage<Component>()
  let id = 0
  const local = isLoopback(upstream)
  // Chunk getLogs for Alchemy (free tier: 10 blocks) or when MAMORU_LOG_RANGE is set; otherwise the range goes as is.
  const chunkLogs = /alchemy/i.test(new URL(upstream).hostname) || !!process.env.MAMORU_LOG_RANGE
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
  const logRanges = opts.logRanges ?? logRangesFromEnv()
  // The upstream keeps its setting (Alchemy or MAMORU_LOG_RANGE: chunks of maxLogRange); every other provider has its own range.
  const logProviders = providers.map((url, i) => ({ url, logRange: i === 0 && chunkLogs ? maxLogRange : logRangeOf(url, logRanges) }))
  async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await send(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) })
    let json: any = null
    try {
      json = await res.json()
    } catch {}
    return { status: res.status, json }
  }
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
  async function raw(body: any, isChunk = false, start = 0): Promise<any> {
    let last: any = null
    const base = ANY_PROVIDER.has(body?.method) ? providers : trusted
    // `start` rotates the list: a retry asks the next provider first.
    const list = [...base.slice(start % base.length), ...base.slice(0, start % base.length)]
    const all = [...list, ...list]
    for (const [pi, url] of all.entries()) {
      const label = labelOf(url)
      const tries = 1
      if (pi === list.length) await Bun.sleep(250)
      for (let attempt = 0; attempt < tries; attempt++) {
        try {
          const r = await post(url, body)
          if (metrics) safeMetrics(() => metrics.recordRequest(label, body.method, isChunk, Date.now(), caller.getStore()))
          const errObj = r.json?.error ?? (wellFormed(r.json) ? undefined : { code: -32603, message: `upstream HTTP ${r.status}` })
          if (errObj && metrics) safeMetrics(() => metrics.recordError(label, body.method, classifyRpcError(r.status, errObj)))
          if (wellFormed(r.json) && !retriable(r.status, r.json)) {
            if (body.method === 'eth_getBlockByNumber') remember(url, r.json.result)
            return r.json
          }
          last = errObj
        } catch (e) {
          if (metrics) safeMetrics(() => metrics.recordRequest(label, body.method, isChunk, Date.now(), caller.getStore()))
          last = { code: -32603, message: (e as Error).message.split('\n')[0] }
          if (metrics) safeMetrics(() => metrics.recordError(label, body.method, classifyRpcError(undefined, last)))
        }
        if (attempt + 1 < tries) await Bun.sleep(400 * 2 ** attempt)
      }
      const next = all[pi + 1]
      if (next !== undefined && next !== url && metrics) safeMetrics(() => metrics.recordFallback(label, body.method))
      if (pi === 0 && list.length > 1 && process.env.MAMORU_RPC_LOG) console.log(`[rpc] ${body?.method} falling back after: ${redactSecrets(last?.message).slice(0, 120)}`)
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
  async function ask(url: string, method: string, params: unknown[], isChunk = false): Promise<any> {
    const label = labelOf(url)
    let r: { status: number; json: any }
    try {
      r = await post(url, { jsonrpc: '2.0', id: ++id, method, params })
    } catch (e) {
      const rpc = { code: -32603, message: (e as Error).message.split('\n')[0] }
      if (metrics) safeMetrics(() => (metrics.recordRequest(label, method, isChunk, Date.now(), caller.getStore()), metrics.recordError(label, method, classifyRpcError(undefined, rpc))))
      throw Object.assign(new Error(String(rpc.message)), { rpc })
    }
    if (metrics) safeMetrics(() => metrics.recordRequest(label, method, isChunk, Date.now(), caller.getStore()))
    const rpc = r.json?.error ?? (wellFormed(r.json) ? undefined : { code: -32603, message: `upstream HTTP ${r.status}` })
    if (!rpc) return r.json.result
    if (metrics) safeMetrics(() => metrics.recordError(label, method, classifyRpcError(r.status, rpc)))
    throw Object.assign(new Error(String(rpc.message)), { rpc })
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
  /** The whole range from one provider, in chunks it accepts. Any failed chunk fails the provider: providers are never mixed inside one range. */
  async function logsFrom(p: LogProvider, filter: any, from: bigint, to: bigint): Promise<unknown[]> {
    const chunks = ranges(from, to, p.logRange)
    const out: unknown[] = []
    for (let i = 0; i < chunks.length; i += 4) {
      const part = await Promise.all(chunks.slice(i, i + 4).map(([a, b]) => ask(p.url, 'eth_getLogs', [{ ...filter, fromBlock: hex(a), toBlock: hex(b) }], chunks.length > 1)))
      for (const logs of part) {
        if (!Array.isArray(logs)) throw fail('eth_getLogs answered no list')
        out.push(...logs)
      }
    }
    return out.sort(byBlockAndIndex)
  }
  /** Witness answers of one incoming request, by block number: ranges of that request ending at the same block share them. Never kept longer. */
  type Witnessed = Map<string, { url: string; hash: string }>
  const blockHash = async (url: string, n: bigint): Promise<string | null> => (await ask(url, 'eth_getBlockByNumber', [hex(n), false]))?.hash ?? null
  /**
   * The hash of block `n` from a provider other than `p`, asked directly: no fallback chain that could land
   * on `p` itself. Logs from the upstream are witnessed by the fallbacks in order; logs from a fallback by the
   * upstream first, then the other fallbacks. A witness that fails or does not have the block yet is skipped;
   * the first one that has it decides. Null when none has it.
   */
  async function witnessHash(p: LogProvider, n: bigint, seen: Witnessed): Promise<string | null> {
    const known = seen.get(String(n))
    if (known && !sameOperator(known.url, p.url)) return known.hash
    // A block a trusted provider of another operator answered moments ago (see `recent`).
    const cached = recent.get(String(n))
    if (cached && Date.now() - cached.at < witnessTtl && Date.now() >= cached.at && !sameOperator(cached.url, p.url)) {
      seen.set(String(n), { url: cached.url, hash: cached.hash })
      return cached.hash
    }
    for (const w of logProviders) {
      // Independence is by operator, not by URL: another key or another spelling of the same provider is no witness.
      if (sameOperator(w.url, p.url)) continue
      const hash = await blockHash(w.url, n).catch(() => null)
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
  async function verifiedLogs(p: LogProvider, filter: any, from: bigint, to: bigint, seen: Witnessed): Promise<unknown[]> {
    const logs = await logsFrom(p, filter, from, to)
    const own = await blockHash(p.url, to)
    if (!own) throw fail(`provider does not have block ${to}: its logs for the range may be incomplete`)
    // A local fork is one node and the only provider: there is no witness by construction, and its own block is the check.
    if (local) return logs
    const witness = await witnessHash(p, to, seen)
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
    // A trusted provider that serves the range in a few requests goes first. Then the fewest requests, the
    // configured order breaking ties: a public provider (witnessed) serves logs only after those, or when the
    // trusted ones would need many small requests (Alchemy free: 10 blocks each). Two passes, as for every other call.
    const span = to - from + 1n
    const requests = (p: LogProvider) => (Number.isFinite(p.logRange) ? (span + BigInt(p.logRange) - 1n) / BigInt(p.logRange) : 1n)
    const tier = (p: LogProvider, n: bigint) => (trusted.includes(p.url) && n <= TRUSTED_LOG_MAX_REQUESTS ? 0 : 1)
    const order = logProviders
      .map((p, i) => { const n = requests(p); return { p, i, n, t: tier(p, n) } })
      .sort((a, b) => a.t - b.t || (a.n === b.n ? a.i - b.i : a.n < b.n ? -1 : 1))
    let last: any = null
    // What the caller is told when nothing is accepted: a range that was read but not witnessed says more than a provider being down.
    let unwitnessed: any = null
    for (const [k, { p }] of [...order, ...order].entries()) {
      if (k === order.length) await Bun.sleep(250)
      const label = labelOf(p.url)
      try {
        const logs = await verifiedLogs(p, filter, from, to, seen)
        if (metrics) safeMetrics(() => metrics.recordLogRange(label, 'accepted'))
        return logs
      } catch (e) {
        last = (e as any).rpc ?? { code: -32603, message: (e as Error).message.split('\n')[0] }
        const reason: Rejection = (e as any).reason ?? 'provider_error'
        if (reason !== 'provider_error') unwitnessed = last
        if (metrics) safeMetrics(() => (metrics.recordLogRange(label, reason), logProviders.length > 1 && metrics.recordFallback(label, 'eth_getLogs')))
        if (process.env.MAMORU_RPC_LOG) console.log(`[rpc] eth_getLogs ${label} rejected (${reason}): ${redactSecrets(String(last?.message)).slice(0, 120)}`)
      }
    }
    last = unwitnessed ?? last
    throw Object.assign(new Error(String(last?.message ?? 'upstream unavailable')), { rpc: { code: typeof last?.code === 'number' ? last.code : -32603, message: String(last?.message ?? 'upstream unavailable') } })
  }
  // A load-balanced provider answers from nodes a block or two apart: a head read from one node and a call pinned
  // to it on another gives "0x", null fields or "block not found". Serve `latest` a few blocks behind the tip.
  const lag = BigInt(process.env.MAMORU_HEAD_LAG ?? 3)
  async function head(): Promise<bigint> {
    const n = BigInt(await one('eth_blockNumber', [])) - lag
    return n
  }
  async function handle(msg: Req, seen: Witnessed): Promise<unknown> {
    const r = await handleInner(msg, seen)
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
    async fetch(req) {
      if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })
      const payload = (await req.json()) as Req | Req[]
      const seen: Witnessed = new Map()
      const answer = () => (Array.isArray(payload) ? Promise.all(payload.map((m) => handle(m, seen))) : handle(payload, seen))
      return Response.json(await caller.run(componentOf(new URL(req.url).pathname), answer))
    },
  })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}
