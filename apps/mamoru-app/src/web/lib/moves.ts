import type { OpView } from '@mamoru/domain'
import { decimalsOf, formatAmount } from './format.ts'
import { usd } from './money.ts'
import { pairLabel, poolTokens } from './positions.ts'

// otto/mamoru#219: a range move is three engine ops (close the position, adjust the tokens, open in range) that the
// history used to show as three unrelated rows. Here they become one entry with its reason, its steps and its cost.

export type Step = NonNullable<OpView['step']>

const STEPS: readonly Step[] = ['enter_swap', 'enter_mint', 'increase_liquidity', 'harvest', 'convert', 'rerange', 'reduce', 'close_position']

/** The engine's op kind: the row's own `step`, or the opId suffix on rows stored before it existed. Null for owner ops. */
export function stepOf(op: OpView): Step | null {
  if (op.step) return op.step
  if (!op.opId.startsWith('eng-')) return null
  return STEPS.find((s) => op.opId.endsWith(`-${s}`)) ?? null
}

export type Move = {
  /** The closing op's id: stable across polls. */
  id: string
  pool: string | undefined
  /** Oldest first: the close, any swaps, then the open (once it happened). */
  ops: OpView[]
  close: OpView
  open: OpView | null
  why: OpView['why']
  /** The newest step's time: where the entry sorts. */
  updatedAt: string
  /** No open came: a newer close in the pool took over, or the window passed. Failed steps never reach the history. */
  stalled?: boolean
}

export type Entry = { type: 'op'; op: OpView } | { type: 'move'; move: Move }

/** Steps of a move that follow its close: later than this, a swap or an open in the pool is a different decision. */
export const MOVE_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Folds every range move into one entry. A move starts at a `rerange` and takes, in the same pool and within
 * MOVE_WINDOW_MS, the swaps that follow it and the open (mint or add) that ends it. Input in any order, output
 * newest first like historyOps.
 */
export function historyEntries(ops: readonly OpView[], now: number = Date.now()): Entry[] {
  // Chain order first (block), then time: `updatedAt` is rewritten on every state change and can reorder steps.
  const asc = [...ops].sort((a, b) => (a.block !== undefined && b.block !== undefined && a.block !== b.block ? a.block - b.block : a.updatedAt.localeCompare(b.updatedAt)))
  const open = new Map<string, Move>()
  const taken = new Set<string>()
  const moves: Move[] = []
  const stall = (m: Move | undefined) => {
    if (m && !m.open) m.stalled = true
  }
  for (const op of asc) {
    const step = stepOf(op)
    // Rows stored before pools were tagged (#131) cannot be told apart: they stay single rows.
    if (!op.pool) continue
    const key = op.pool
    if (step === 'rerange') {
      stall(open.get(key))
      const m: Move = { id: op.opId, pool: op.pool, ops: [op], close: op, open: null, why: op.why, updatedAt: op.updatedAt }
      moves.push(m)
      taken.add(op.opId)
      open.set(key, m)
      continue
    }
    const m = open.get(key)
    if (!m || (step !== 'enter_swap' && step !== 'enter_mint' && step !== 'increase_liquidity')) continue
    if (Date.parse(op.updatedAt) - Date.parse(m.close.updatedAt) > MOVE_WINDOW_MS) {
      stall(m)
      open.delete(key)
      continue
    }
    m.ops.push(op)
    m.updatedAt = op.updatedAt
    taken.add(op.opId)
    if (step !== 'enter_swap') {
      m.open = op
      open.delete(key)
    }
  }
  for (const m of open.values()) if (now - Date.parse(m.close.updatedAt) > MOVE_WINDOW_MS) stall(m)
  const entries: Entry[] = [...ops.filter((o) => !taken.has(o.opId)).map((op): Entry => ({ type: 'op', op })), ...moves.map((move): Entry => ({ type: 'move', move }))]
  const at = (e: Entry) => (e.type === 'op' ? e.op.updatedAt : e.move.updatedAt)
  return entries.sort((a, b) => at(b).localeCompare(at(a)))
}

const pair = (pool: string | undefined) => pairLabel(pool).replace(/ /g, '')

/** Settled when its open is confirmed; stalled when a step failed or no open came in time; else still moving. */
export function moveState(m: Move): 'done' | 'pending' | 'stalled' {
  if (m.open?.state === 'confirmed') return 'done'
  if (m.stalled || m.ops.some((o) => o.state === 'failed')) return 'stalled'
  return 'pending'
}

/** The history line of a move. */
export function moveLine(m: Move): string {
  const s = moveState(m)
  if (s === 'stalled') return `Closed your ${pair(m.pool)} range, not reopened yet`
  return s === 'done' ? `Moved your ${pair(m.pool)} range` : `Moving your ${pair(m.pool)} range`
}

/** Why the range moved, in plain words. Rows stored before the engine said why get the general rule. */
export function moveReason(why: OpView['why']): string {
  if (why === 'out') return 'The price left your range. Outside it, the money stops earning fees, so Mamoru closed the position and opened a new one around the current price.'
  if (why === 'edge') return 'The price came close to the edge of your range. Mamoru moved the range so the money keeps earning if the price goes on.'
  if (why === 'widen') return 'Prices got more volatile. Mamoru widened the range so it keeps earning through larger moves.'
  return 'Mamoru moves a range when the price leaves it or comes close to its edge: outside the range, the money stops earning fees.'
}

/** One line per step, in the words of the move. */
export function stepLine(op: OpView, why?: OpView['why']): string {
  const done = op.state === 'confirmed'
  switch (stepOf(op)) {
    case 'rerange':
      if (why === 'out') return done ? 'Closed the out-of-range position' : 'Closing the out-of-range position'
      if (why === 'edge') return done ? 'Closed the position near the edge of its range' : 'Closing the position near the edge of its range'
      return done ? 'Closed the old position' : 'Closing the old position'
    case 'enter_swap': {
      const out = op.amountOut && op.tokenOut ? `about ${formatAmount(op.amountOut, op.tokenOut)}` : op.tokenOut
      const what = op.tokenIn && op.tokenOut ? `: ${op.amountIn ? formatAmount(op.amountIn, op.tokenIn) : op.tokenIn} to ${out}` : ''
      return `${done ? 'Adjusted' : 'Adjusting'} the token amounts${what}`
    }
    case 'enter_mint':
      return done ? 'Opened a position in range' : 'Opening a position in range'
    case 'increase_liquidity':
      return done ? 'Added to the position in range' : 'Adding to the position in range'
    default:
      return done ? 'Done' : 'In progress'
  }
}

/** Gas a set of ops paid: USDC when every one is priced, else ETH; null when no receipt was read yet. */
export function gasOf(ops: readonly OpView[]): { usdc: bigint | null; wei: bigint; count: number } | null {
  const read = ops.filter((o) => o.facts)
  if (!read.length) return null
  const wei = read.reduce((s, o) => s + BigInt(o.facts!.gasWei), 0n)
  const priced = read.every((o) => o.facts!.gasUsdc !== undefined)
  return { usdc: priced ? read.reduce((s, o) => s + BigInt(o.facts!.gasUsdc!), 0n) : null, wei, count: read.length }
}

/** "0.044 USDC" under a dime (gas is cents: two decimals would hide it), "1.20 USDC" above; the ETH amount when unpriced. */
export function gasLabel(g: NonNullable<ReturnType<typeof gasOf>>, native: 'ETH' | 'MON' | string = 'ETH'): string {
  // MON is 18 decimals like ETH; formatAmount knows ETH's, so format as ETH and name the chain's own asset.
  if (g.usdc === null) return `${formatAmount(g.wei.toString(), 'ETH').replace(/ ETH$/, '')} ${native}`
  return `${small(g.usdc)} USDC`
}

/** Raw USDC as "0.013" under 0.10 (three decimals, "< 0.001" below), else the usual two. */
export function small(raw: bigint): string {
  if (raw >= 100_000n) return usd(raw)
  if (raw > 0n && raw < 1_000n) return '< 0.001'
  return `0.${(raw / 1_000n).toString().padStart(3, '0')}`
}

/** Fees the closing op collected, in USDC, when every fee of it is priced. */
export function feesOf(op: OpView): bigint | null {
  const fees = op.facts?.fees
  if (!fees) return null
  if (fees.some((f) => f.usdc === undefined)) return null
  return fees.reduce((s, f) => s + BigInt(f.usdc!), 0n)
}

/**
 * A range as prices: the pool's other token in USDC ("0.9989 – 1.0030 USDC per USDT"); for a pool without USDC,
 * token1 per token0. Null when the row has no ticks or the registry lacks the decimals.
 */
export function rangeLabel(pool: string | undefined, tickLower: number | undefined, tickUpper: number | undefined): string | null {
  if (tickLower === undefined || tickUpper === undefined) return null
  const [t0, t1] = poolTokens(pool)
  const d0 = decimalsOf(t0)
  const d1 = decimalsOf(t1)
  if (d0 === undefined || d1 === undefined) return null
  // Human price of token0 in token1 at a tick.
  const p = (tick: number) => Math.pow(1.0001, tick) * Math.pow(10, d0 - d1)
  let lo: number, hi: number, unit: string
  if (t0 === 'USDC') {
    lo = 1 / p(tickUpper)
    hi = 1 / p(tickLower)
    unit = `USDC per ${t1}`
  } else {
    lo = p(tickLower)
    hi = p(tickUpper)
    unit = `${t1} per ${t0}`
  }
  // Both ends with the same decimals: four significant digits of the lower one (0.9948 – 0.9989, 2,250 – 2,410).
  const digits = lo >= 1000 || !(lo > 0) ? 0 : Math.max(0, 3 - Math.floor(Math.log10(lo)))
  return `${price(lo, digits)} – ${price(hi, digits)} ${unit}`
}

function price(n: number, digits: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
