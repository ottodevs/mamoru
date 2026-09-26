import { ReasonError, type Hex0x } from '@mamoru/domain'
import type { PublicClient } from 'viem'

export type BlockRef = { number: number; hash: Hex0x; timestamp: number }
export type Head = { latest: BlockRef; safe: BlockRef }

/** Latest and safe blocks with hashes. The safe block is `H`, the anchor of every read (plan §23.3). */
export async function readHead(client: PublicClient, chainId: number): Promise<Head> {
  let actual: number
  let latest, safe
  try {
    ;[actual, latest, safe] = await Promise.all([
      client.getChainId(),
      client.getBlock({ blockTag: 'latest' }),
      client.getBlock({ blockTag: 'safe' }),
    ])
  } catch (err) {
    throw new ReasonError('OBS_RPC_UNAVAILABLE', err instanceof Error ? err.name : undefined)
  }
  if (actual !== chainId) throw new ReasonError('OBS_CHAIN_MISMATCH', String(actual))
  if (latest.hash === null || safe.hash === null || latest.number === null || safe.number === null) {
    throw new ReasonError('OBS_BLOCK_INCONSISTENT', 'pending block')
  }
  return {
    latest: { number: Number(latest.number), hash: latest.hash, timestamp: Number(latest.timestamp) },
    safe: { number: Number(safe.number), hash: safe.hash, timestamp: Number(safe.timestamp) },
  }
}
