import type { Hex0x } from '@mamoru/domain'
import type { Address, PublicClient } from 'viem'
import { poolEventsAbi } from './abis.ts'

/** Largest eth_getLogs range per request; the public Base RPC rejects wide ranges. */
export const RPC_LOGS_MAX_RANGE = 500

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
export async function readPoolEvents(client: PublicClient, pool: Address, from: number, to: number): Promise<{ events: PoolEvent[]; requests: number }> {
  const ranges = chunks(from, to, RPC_LOGS_MAX_RANGE)
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
