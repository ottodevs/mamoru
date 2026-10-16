// Entry baseline for the yield ledger's "value vs hold" comparison (otto/mamoru#129), built on the snapshot loop
// (#136). The operator has no D1 binding (specs/003-snapshot-loop/spec.md), so this stays in its own small
// state file next to accounts.json, keyed by token id, and is folded into every snapshot GET /snapshot serves.
//
// What "entry" means here: the position's own principal amounts (snapshot.ts's amountsForLiquidity) the first
// time this operator process observes that token id. Not the mint transaction's amounts: this process does not
// index historical events (specs/003-snapshot-loop/spec.md phases 3-4), so a position already open when
// MAMORU_YIELD_LEDGER is first turned on gets its baseline from that moment, not from when it was actually
// opened. Documented, not hidden: a reader compares "value vs hold since this baseline", never "since entry".

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inUsdc } from './chain.ts'
import type { PositionSnapshot, Snapshot } from './snapshot.ts'

export type EntryBaseline = {
  pool: string
  entryBlock: number
  entryDay: string // UTC YYYY-MM-DD
  amount0: string // raw token0 units, decimal string
  amount1: string // raw token1 units, decimal string
  capturedAt: string // ISO
}

const dayOf = (iso: string): string => iso.slice(0, 10)

function key(chainId: number, tokenId: bigint): string {
  return `${chainId}:${tokenId}`
}

/** JSON map of position entry baselines, one 0600 file, written atomically (tmp + rename), same shape as state.ts. */
export class EntryStore {
  readonly file: string
  private map: Record<string, EntryBaseline>

  constructor(dir: string) {
    this.file = join(dir, 'yield-entries.json')
    this.map = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, EntryBaseline>) : {}
  }

  get(chainId: number, tokenId: bigint): EntryBaseline | undefined {
    return this.map[key(chainId, tokenId)]
  }

  /** Stores a baseline only the first time this token id is seen; a later call for the same token id is a no-op. */
  captureIfNew(chainId: number, tokenId: bigint, baseline: EntryBaseline): boolean {
    const k = key(chainId, tokenId)
    if (this.map[k]) return false
    this.map[k] = baseline
    return true
  }

  save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.map, null, 1), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}

/** Entry amounts of a position revalued at the pool's current price: the no-LP, no-harvest baseline. */
export function holdValueUsdc(entry: EntryBaseline, token0: string, token1: string, sqrtPriceX96: bigint): bigint {
  return inUsdc(entry.pool, token0, BigInt(entry.amount0), sqrtPriceX96) + inUsdc(entry.pool, token1, BigInt(entry.amount1), sqrtPriceX96)
}

export type PositionWithHold = PositionSnapshot & { holdValueUsdc: bigint }

/**
 * Captures a baseline for every position not seen before, persists what changed, and returns the snapshot with
 * `holdValueUsdc` added to each position. Call once per read, right after readSnapshot; safe to call every tick,
 * the store only ever writes a token id's first row.
 */
export function withHoldValue(snapshot: Snapshot, store: EntryStore): Snapshot {
  const day = dayOf(snapshot.readAt)
  let changed = false
  const safes = snapshot.safes.map((safe) => ({
    ...safe,
    positions: safe.positions.map((p): PositionWithHold => {
      const poolState = snapshot.pools[p.pool]
      if (store.captureIfNew(snapshot.chainId, p.tokenId, { pool: p.pool, entryBlock: Number(snapshot.block), entryDay: day, amount0: p.amount0.toString(), amount1: p.amount1.toString(), capturedAt: snapshot.readAt })) {
        changed = true
      }
      const entry = store.get(snapshot.chainId, p.tokenId)!
      return { ...p, holdValueUsdc: poolState ? holdValueUsdc(entry, p.token0, p.token1, poolState.sqrtPriceX96) : 0n }
    }),
  }))
  if (changed) store.save()
  return { ...snapshot, safes }
}
