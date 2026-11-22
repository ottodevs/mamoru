// otto/mamoru#438: the operator's word on an account's flows (account_flow_cover) and the rule that turns it into a
// complete net deposited. Writer: one row per chain and account, replaced on every pull. Reader: coverComplete, used by
// value-series.ts. When in doubt the answer is partial: a reader shows n/a then, never a baseline that can claim a
// false gain.
import type { Db } from './env.ts'

export type FlowCoverWire = { from: number; through?: number; open: string[]; mints: { block: number; t: number; usdc: string }[] }
type Resolve = (chainId: number, address: string) => Promise<{ accountKey: string } | null>

const UPSERT = `INSERT INTO account_flow_cover (chain_id, account_key, from_block, through_block, open_json, mints_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(chain_id, account_key) DO UPDATE SET from_block = excluded.from_block, through_block = excluded.through_block,
  open_json = excluded.open_json, mints_json = excluded.mints_json, updated_at = excluded.updated_at`

const int = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
function valid(c: FlowCoverWire | undefined): c is FlowCoverWire {
  return !!c && int(c.from) && (c.through === undefined || int(c.through)) && Array.isArray(c.open) && c.open.every((r) => typeof r === 'string') && Array.isArray(c.mints) && c.mints.every((m) => int(m?.block) && int(m?.t) && typeof m?.usdc === 'string' && /^\d+$/.test(m.usdc))
}

/** Replaces the cover row of every account of the snapshot that carries one. Call only after its flows were written. */
export async function writeCover(db: Db, snapshot: { chainId: number; receipts?: { safe: string; cover?: FlowCoverWire }[] }, now: Date, resolve: Resolve): Promise<number> {
  const stmts = []
  for (const r of snapshot.receipts ?? []) {
    // A malformed cover is not written: the row left behind falls behind the next read and reads as partial.
    if (!valid(r.cover)) continue
    const account = await resolve(snapshot.chainId, r.safe.toLowerCase())
    if (!account) continue
    const c = r.cover
    stmts.push(db.prepare(UPSERT).bind(snapshot.chainId, account.accountKey, c.from, c.through ?? null, JSON.stringify(c.open), JSON.stringify(c.mints), now.toISOString()))
  }
  if (stmts.length) await db.batch(stmts)
  return stmts.length
}

export const BASE_CHAIN = 8453
export const MONAD_CHAIN = 143
const DAY_S = 86_400
/** First-day tolerance: the day's yield and rounding, never a missing deposit of any size that matters. */
const TOLERANCE_ABS = 1_000_000
const TOLERANCE_REL = 100

/** One chain with value: its first UTC day in account_daily (block of the day's first read, close) and its latest read block. */
export type ChainValue = { chainId: number; firstDay: string; firstBlock: number; firstClose: number; latestBlock: number | null }
export type CoverRow = { chain_id: number; from_block: number; through_block: number | null; open_json: string; mints_json: string }
export type CoverFlow = { kind: 'in' | 'out' | 'gap'; t_s: number; usd: number; chain_id: number }
export type CoverBridge = { direction: 'out' | 'home'; amount_usdc: number; state: string; burn_at: string | null; minted_block: number | null }

/** The chain a bridge leaves from and the one it mints on: 'out' Base to Monad, 'home' Monad to Base. */
const legs = (b: CoverBridge) => (b.direction === 'out' ? { src: BASE_CHAIN, dst: MONAD_CHAIN } : { src: MONAD_CHAIN, dst: BASE_CHAIN })

/**
 * Whether the recorded flows are the whole story, per chain with value. Each chain needs:
 * 1. a cover row with nothing open, from a block at or before the chain's first read (the first value instant, in that
 *    chain's own blocks: a deposit earlier the same day is not covered by a cover from later that day);
 * 2. through the chain's latest read (a pull that failed to write flows, or a cover no longer sent, falls behind);
 * 3. every mint matched by a transfer between the owner's own Safes minted on that chain in that block (a CCTP mint
 *    from elsewhere is money the flows do not hold);
 * 4. the first day's close explained by what reached the chain by the end of that day: in - out + mints - bridges out
 *    burned by then, within max(1 USDC, 1 %). A deposit made before the cover (a Safe funded before the deposit look
 *    began) is still in that close, or left through a recorded withdrawal, so it shows up here.
 * And no chain may hold flows without value rows (its money would sit in the baseline and not in the value).
 * `bridges` null: the bridges table cannot be read; complete only with no mint to match and no bridge to count.
 */
export function coverComplete(chains: readonly ChainValue[], flows: readonly CoverFlow[], covers: ReadonlyMap<number, CoverRow>, bridges: readonly CoverBridge[] | null): { complete: boolean; why?: string } {
  if (!chains.length) return { complete: false, why: 'no-value' }
  const valued = new Set(chains.map((c) => c.chainId))
  for (const f of flows) if ((f.kind === 'in' || f.kind === 'out') && !valued.has(f.chain_id)) return { complete: false, why: `flows-without-value:${f.chain_id}` }
  for (const [chain, row] of covers) if (!valued.has(chain) && parse<unknown[]>(row.mints_json)?.length) return { complete: false, why: `mints-without-value:${chain}` }
  for (const c of chains) {
    const row = covers.get(c.chainId)
    if (!row) return { complete: false, why: `no-cover:${c.chainId}` }
    const open = parse<string[]>(row.open_json)
    const mints = parse<{ block: number; t: number; usdc: string }[]>(row.mints_json)
    if (!Array.isArray(open) || !Array.isArray(mints)) return { complete: false, why: `bad-cover:${c.chainId}` }
    if (open.length) return { complete: false, why: `open:${c.chainId}:${open[0]}` }
    if (row.from_block > c.firstBlock) return { complete: false, why: `cover-late:${c.chainId}` }
    if (row.through_block === null || c.latestBlock === null || row.through_block < c.latestBlock) return { complete: false, why: `cover-behind:${c.chainId}` }
    if (mints.length && !bridges) return { complete: false, why: `bridges-unknown:${c.chainId}` }
    for (const m of mints) if (!bridges!.some((b) => legs(b).dst === c.chainId && b.minted_block === m.block)) return { complete: false, why: `mint-unmatched:${c.chainId}:${m.block}` }
    const end = Date.parse(`${c.firstDay}T00:00:00.000Z`) / 1000 + DAY_S - 1
    let explained = 0
    for (const f of flows) if (f.chain_id === c.chainId && f.t_s <= end) explained += f.kind === 'in' ? f.usd : f.kind === 'out' ? -f.usd : 0
    for (const m of mints) if (m.t <= end) explained += Number(m.usdc)
    for (const b of bridges ?? []) {
      if (legs(b).src !== c.chainId || (b.state !== 'burned' && b.state !== 'minted')) continue
      // A burn with no time is taken as before the day ends: the stricter reading.
      const t = b.burn_at === null ? -Infinity : Date.parse(b.burn_at) / 1000
      if (!(t > end)) explained -= b.amount_usdc
    }
    if (c.firstClose > explained + Math.max(TOLERANCE_ABS, Math.abs(explained) / TOLERANCE_REL)) return { complete: false, why: `first-day-unexplained:${c.chainId}` }
  }
  return { complete: true }
}

function parse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

const missing = (e: unknown) => /no such table/i.test(e instanceof Error ? e.message : String(e))

/** The cover rows of the owner's sleeves by chain; empty when the table is not migrated yet. */
export async function coversOf(db: Db, sleeves: readonly { chain_id: number; account_key: string }[]): Promise<Map<number, CoverRow>> {
  const out = new Map<number, CoverRow>()
  for (const s of sleeves) {
    try {
      const row = await db.prepare('SELECT chain_id, from_block, through_block, open_json, mints_json FROM account_flow_cover WHERE chain_id = ? AND account_key = ?').bind(s.chain_id, s.account_key).first<CoverRow>()
      if (row) out.set(s.chain_id, row)
    } catch (e) {
      if (!missing(e)) throw e
    }
  }
  return out
}

/** The owner's CCTP transfers between its Safes (keyed by the Base account); null when they cannot be read. */
export async function bridgesOf(db: Db, sleeves: readonly { chain_id: number; account_key: string }[]): Promise<CoverBridge[] | null> {
  const base = sleeves.find((s) => s.chain_id === BASE_CHAIN)
  if (!base) return []
  try {
    return (await db.prepare('SELECT direction, amount_usdc, state, burn_at, minted_block FROM yield_ledger_bridges WHERE account_key = ?').bind(base.account_key).all<CoverBridge>()).results
  } catch (e) {
    if (!missing(e)) throw e
    return null
  }
}
