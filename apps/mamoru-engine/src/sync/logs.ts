import type { Hex0x } from '@mamoru/domain'
import type { Address, PublicClient } from 'viem'
import type { LogSource } from './client.ts'
import { poolEventsAbi } from './abis.ts'

type RowBase = { block: number; blockHash: Hex0x; txHash: Hex0x; logIndex: number }

export type SwapEvent = RowBase & {
  kind: 'swap'
  sender: Address
  recipient: Address
  amount0: bigint
  amount1: bigint
  sqrtPriceX96: bigint
  liquidity: bigint
  tick: number
}

export type LiquidityEvent = RowBase & {
  kind: 'mint' | 'burn'
  owner: Address
  tickLower: number
  tickUpper: number
  amount: bigint
  amount0: bigint
  amount1: bigint
}

export type PoolEvent = SwapEvent | LiquidityEvent

export function chunks(from: number, to: number, size: number): [number, number][] {
  const out: [number, number][] = []
  for (let a = from; a <= to; a += size) out.push([a, Math.min(a + size - 1, to)])
  return out
}

/** Swap, Mint and Burn of one pool in [from, to], ascending by block and log index. */
export async function readPoolEvents(client: PublicClient, pool: Address, from: number, to: number, maxRange = 500): Promise<{ events: PoolEvent[]; requests: number }> {
  const ranges = chunks(from, to, maxRange)
  const pages = await Promise.all(
    ranges.map(([a, b]) =>
      client.getLogs({ address: pool, events: poolEventsAbi, fromBlock: BigInt(a), toBlock: BigInt(b), strict: true }),
    ),
  )
  const events: PoolEvent[] = []
  for (const log of pages.flat()) {
    if (log.blockNumber === null || log.blockHash === null || log.transactionHash === null || log.logIndex === null) continue
    const base: RowBase = { block: Number(log.blockNumber), blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.logIndex }
    if (log.eventName === 'Swap') {
      const a = log.args
      events.push({ ...base, kind: 'swap', sender: a.sender, recipient: a.recipient, amount0: a.amount0, amount1: a.amount1, sqrtPriceX96: a.sqrtPriceX96, liquidity: a.liquidity, tick: a.tick })
    } else {
      const a = log.args
      const owner = a.owner
      events.push({ ...base, kind: log.eventName === 'Mint' ? 'mint' : 'burn', owner, tickLower: a.tickLower, tickUpper: a.tickUpper, amount: a.amount, amount0: a.amount0, amount1: a.amount1 })
    }
  }
  events.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex)
  return { events, requests: ranges.length }
}

/** Error class, HTTP status and JSON-RPC code of a failed read. Never the message: it can carry the URL. */
export function errorInfo(err: unknown): { error: string; status?: number; code?: number } {
  const out: { error: string; status?: number; code?: number } = { error: err instanceof Error ? err.name : 'unknown' }
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
    const o = e as { status?: unknown; code?: unknown }
    if (out.status === undefined && typeof o.status === 'number') out.status = o.status
    if (out.code === undefined && typeof o.code === 'number') out.code = o.code
  }
  return out
}

export type LogsRead = { events: PoolEvent[]; requests: number; source: string; fromBlock: number; failures: ({ source: string } & ReturnType<typeof errorInfo>)[] }

/** Pool events from the first source that answers the whole range. Throws when every source fails. */
export async function readPoolEventsFrom(sources: LogSource[], pool: Address, from: number, to: number): Promise<LogsRead> {
  const failures: LogsRead['failures'] = []
  let requests = 0
  for (const s of sources) {
    const start = s.maxWindow ? Math.max(from, to - s.maxWindow + 1) : from
    try {
      const r = await readPoolEvents(s.client, pool, start, to, s.maxRange)
      return { events: r.events, requests: requests + r.requests, source: s.name, fromBlock: start, failures }
    } catch (err) {
      requests += chunks(start, to, s.maxRange).length
      failures.push({ source: s.name, ...errorInfo(err) })
    }
  }
  throw Object.assign(new Error('every log source failed'), { name: 'LogSourcesFailed', failures })
}
