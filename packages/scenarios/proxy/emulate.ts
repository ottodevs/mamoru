// otto/mamoru#273: anvil answers everything a real provider refuses (eth_simulateV1 in full, any getLogs range, a
// future block) and reads from the node that took the write. This layer sits in front of it and answers as a recorded
// Monad provider does. The recorded facts are data (profiles/<chain>.json, refreshed by probe-profile.ts); the
// failure modes that depend on load (429, a node behind) are options, seeded so a run repeats.

export type RpcError = { code: number; message: string }
export type RpcMsg = { jsonrpc: '2.0'; id: unknown; method: string; params?: unknown[] }
type Json = { result?: unknown; error?: RpcError; [k: string]: unknown }
export type Forward = (msg: RpcMsg) => Promise<Json>

/** What one provider endpoint was seen to do. `refusedParams` match on `params[path]` strictly equal to `equals`. */
export type EndpointProfile = {
  refusedMethods: Record<string, RpcError>
  refusedParams: { method: string; path: (string | number)[]; equals: unknown; error: RpcError }[]
  /** eth_simulateV1 reports gasUsed = the gas limit of the call (Monad). */
  simulateGasUsedIsLimit: boolean
  /** eth_simulateV1 refuses a `from` that has code, with this error. */
  simulateSenderNotEoa: RpcError | null
  /** eth_getLogs: widest `toBlock - fromBlock` accepted, and the error past it. */
  getLogs: { maxSpan: number; error: RpcError } | null
  /** A read at a block the node does not have yet. */
  unknownBlock: RpcError | null
}

export type ChainProfile = { chain: string; recordedAt: string; endpoints: Record<string, EndpointProfile> }

export type Chaos = {
  seed?: number
  /** Share of HTTP requests answered 429, 0..1. */
  rate429?: number
  /** After a write, the next `requests` reads see a head `blocks` behind (latest/pending reads only). */
  lag?: { blocks: number; requests: number }
}

export type Emulation = { endpoint: EndpointProfile; chaos?: Chaos }

const MAX_AGE_DAYS = 7

/** Throws, naming the command that refreshes it, when the profile is older than 7 days (or dated in the future by >1 day). */
export function assertProfileFresh(profile: Pick<ChainProfile, 'chain' | 'recordedAt'>, now = new Date()): void {
  const at = Date.parse(profile.recordedAt)
  if (!Number.isFinite(at)) throw new Error(`PROFILE_STALE: ${profile.chain} profile has no valid recordedAt (${profile.recordedAt}). Refresh: bun run scenarios:probe-profile ${profile.chain}`)
  const days = (now.getTime() - at) / 86_400_000
  if (days > MAX_AGE_DAYS) {
    throw new Error(`PROFILE_STALE: ${profile.chain} RPC profile was recorded ${profile.recordedAt} (${Math.floor(days)} days ago, max ${MAX_AGE_DAYS}). Refresh it read-only: bun run scenarios:probe-profile ${profile.chain}`)
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Index of the block parameter, for the reads that take one. */
const BLOCK_PARAM: Record<string, number> = {
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getCode: 1,
  eth_getBalance: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_simulateV1: 1,
}
const WRITES = new Set(['eth_sendRawTransaction', 'eth_sendTransaction'])
const rpcError = (id: unknown, e: RpcError) => ({ jsonrpc: '2.0', id, error: e })
const isHex = (x: unknown): x is string => typeof x === 'string' && /^0x[0-9a-f]+$/i.test(x)
const at = (v: unknown, path: (string | number)[]): unknown => path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string | number, unknown>)[k] : undefined), v)

export type Emulator = {
  /** True when this HTTP request is to be answered 429. Call once per HTTP request. */
  rateLimited: () => boolean
  handle: (msg: RpcMsg, forward: Forward) => Promise<Json>
  stats: () => { rateLimited: number; lagged: number; refused: number }
}

export function createEmulator({ endpoint: ep, chaos = {} }: Emulation): Emulator {
  const rnd = mulberry32(chaos.seed ?? 1)
  const counts = { rateLimited: 0, lagged: 0, refused: 0 }
  let lagLeft = 0
  const refuse = (msg: RpcMsg, e: RpcError) => {
    counts.refused++
    return rpcError(msg.id, e)
  }
  const head = async (forward: Forward): Promise<number> => Number(BigInt(((await forward({ jsonrpc: '2.0', id: 0, method: 'eth_blockNumber', params: [] })).result as string) ?? '0x0'))

  async function handle(msg: RpcMsg, forward: Forward): Promise<Json> {
    const params = msg.params ?? []
    const refusedM = ep.refusedMethods[msg.method]
    if (refusedM) return refuse(msg, refusedM)
    for (const r of ep.refusedParams) if (r.method === msg.method && at(params, r.path) === r.equals) return refuse(msg, r.error)

    if (msg.method === 'eth_getLogs' && ep.getLogs) {
      const f = (params[0] ?? {}) as { fromBlock?: string; toBlock?: string }
      if (isHex(f.fromBlock) || isHex(f.toBlock) || f.fromBlock === 'earliest') {
        const from = f.fromBlock === 'earliest' ? 0 : isHex(f.fromBlock) ? Number(BigInt(f.fromBlock)) : await head(forward)
        const to = isHex(f.toBlock) ? Number(BigInt(f.toBlock)) : await head(forward)
        if (to - from > ep.getLogs.maxSpan) return refuse(msg, ep.getLogs.error)
      }
    }

    const bi = BLOCK_PARAM[msg.method]
    let out = msg
    if (bi !== undefined) {
      const tag = params[bi]
      if (ep.unknownBlock && isHex(tag) && Number(BigInt(tag)) > (await head(forward))) return refuse(msg, ep.unknownBlock)
      if (lagLeft > 0 && (tag === undefined || tag === 'latest' || tag === 'pending')) {
        lagLeft--
        counts.lagged++
        const p = [...params]
        p[bi] = `0x${Math.max(0, (await head(forward)) - (chaos.lag?.blocks ?? 0)).toString(16)}`
        out = { ...msg, params: p }
      }
    } else if (msg.method === 'eth_blockNumber' && lagLeft > 0) {
      lagLeft--
      counts.lagged++
      return { jsonrpc: '2.0', id: msg.id, result: `0x${Math.max(0, (await head(forward)) - (chaos.lag?.blocks ?? 0)).toString(16)}` }
    }

    if (msg.method === 'eth_simulateV1') {
      const calls = ((params[0] as { blockStateCalls?: { calls?: { from?: string; gas?: string }[] }[] } | undefined)?.blockStateCalls ?? []).flatMap((b) => b.calls ?? [])
      if (ep.simulateSenderNotEoa) {
        for (const c of calls) {
          if (!c.from) continue
          const code = (await forward({ jsonrpc: '2.0', id: 0, method: 'eth_getCode', params: [c.from, 'latest'] })).result
          if (typeof code === 'string' && code !== '0x') return refuse(msg, ep.simulateSenderNotEoa)
        }
      }
      const res = await forward(out)
      if (ep.simulateGasUsedIsLimit && Array.isArray(res.result)) {
        res.result = (res.result as { gasUsed?: string; calls?: { gasUsed?: string }[] }[]).map((blk, bIdx) => {
          const given = (((params[0] as { blockStateCalls?: { calls?: { gas?: string }[] }[] }).blockStateCalls ?? [])[bIdx]?.calls ?? []).map((c) => c.gas)
          let total = 0n
          const cs = (blk.calls ?? []).map((c, i) => {
            const g = given[i]
            if (isHex(g)) {
              total += BigInt(g)
              return { ...c, gasUsed: g }
            }
            total += BigInt(c.gasUsed ?? '0x0')
            return c
          })
          return { ...blk, calls: cs, gasUsed: `0x${total.toString(16)}` }
        })
      }
      return res
    }

    const res = await forward(out)
    if (WRITES.has(msg.method) && chaos.lag) lagLeft = chaos.lag.requests
    return res
  }

  return {
    rateLimited: () => {
      const hit = (chaos.rate429 ?? 0) > 0 && rnd() < (chaos.rate429 ?? 0)
      if (hit) counts.rateLimited++
      return hit
    },
    handle,
    stats: () => ({ ...counts }),
  }
}
