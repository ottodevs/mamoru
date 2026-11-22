// otto/mamoru#418: each keyed provider's use in its quota cycle against a monthly budget, with one alert at 70% and one
// at 90% carrying a forecast of the day the budget runs out at the current rate. Before this the only warning was the
// provider's own email after the quota was gone. Counted by provider domain (the host-free label without its `#n`),
// because a plan's quota is shared by every key under it.
import { cuFor, logErr, QUICKNODE_CREDITS_PER_CALL } from './metrics.ts'
import { cycleStart, domainOfLabel, nextReset, resetDaysFromEnv } from './quota.ts'

type Env = Record<string, string | undefined>

/**
 * Monthly budgets by provider domain when MAMORU_RPC_MONTHLY_BUDGET leaves them out: Alchemy's free tier (30M CU) and
 * QuickNode Build (80M API credits, otto/mamoru#305).
 */
export const DEFAULT_MONTHLY_BUDGETS: Readonly<Record<string, number>> = { 'alchemy.com': 30_000_000, 'quiknode.pro': 80_000_000 }

/** Fractions of the budget at which ops is paged, once each per cycle. */
export const BUDGET_ALERTS = [0.7, 0.9] as const

/**
 * MAMORU_RPC_MONTHLY_BUDGET="alchemy.com=30000000,quiknode.pro=80000000": the units each provider may use in one quota
 * cycle (Alchemy CU, QuickNode credits, requests for any other). Merged over the defaults; 0 turns a budget off.
 */
export function budgetsFromEnv(env: Env = process.env): Record<string, number> {
  const out: Record<string, number> = { ...DEFAULT_MONTHLY_BUDGETS }
  for (const pair of (env.MAMORU_RPC_MONTHLY_BUDGET ?? '').split(',')) {
    const [host, units] = pair.split('=').map((x) => x.trim())
    const n = Number(units)
    if (host && units && Number.isFinite(n) && n >= 0) out[host.toLowerCase()] = n
  }
  for (const [k, v] of Object.entries(out)) if (v === 0) delete out[k]
  return out
}

export type BudgetUnit = 'cu' | 'credits' | 'requests'

export function unitOf(domain: string): BudgetUnit {
  return /alchemy/i.test(domain) ? 'cu' : /quiknode\.pro/i.test(domain) ? 'credits' : 'requests'
}

/** What one request to `domain` costs in its budget unit: Alchemy's per-method CU, QuickNode's flat credits, else 1. */
export function unitsFor(domain: string, method: string): number {
  const u = unitOf(domain)
  return u === 'cu' ? cuFor(method) : u === 'credits' ? QUICKNODE_CREDITS_PER_CALL : 1
}

/** `start`: the cycle's start. `since`: when this cycle's count began (later than `start` when the counter is new). */
type Period = { start: number; since: number; units: number; alerted: number }

export type BudgetSnapshot = {
  provider: string
  unit: BudgetUnit
  used: number
  budget: number | null
  usedPct: number | null
  cycleStart: string
  resetAt: string
  /** The count began after the cycle did: `used` misses what came before `countedSince`. */
  countedSince: string
  /** When the budget runs out at the cycle's average rate so far; null when not before the reset, or no budget. */
  forecastExhaustedAt: string | null
}[]

const MAX_DOMAINS = 32
const MIN_RATE_WINDOW_MS = 60 * 60_000

export class BudgetBook {
  private periods = new Map<string, Period>()

  constructor(
    private readonly budgets: Record<string, number> = budgetsFromEnv(),
    private readonly resetDays: Record<string, number> = resetDaysFromEnv(),
  ) {}

  load(raw: unknown): void {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [d, p] of Object.entries(raw as Record<string, Partial<Period>>)) {
      if (this.periods.size >= MAX_DOMAINS) break
      if (!p || ![p.start, p.since, p.units, p.alerted].every((x) => typeof x === 'number' && Number.isFinite(x))) continue
      this.periods.set(d, { start: p.start!, since: p.since!, units: p.units!, alerted: p.alerted! })
    }
  }

  toJSON(): Record<string, Period> {
    return Object.fromEntries(this.periods)
  }

  /** One request to the provider labelled `label`. True when it crossed an alert line (the caller saves at once). */
  record(label: string, method: string, now: number = Date.now()): boolean {
    const domain = domainOfLabel(label)
    const p = this.period(domain, now)
    if (!p) return false
    p.units += unitsFor(domain, method)
    const budget = this.budgets[domain]
    if (!budget) return false
    const crossed = BUDGET_ALERTS.filter((f) => p.units >= f * budget && p.alerted < f).at(-1)
    if (crossed === undefined) return false
    p.alerted = crossed
    const forecast = this.forecast(domain, p, budget, now)
    const reset = nextReset(domain, now, this.resetDays)
    // One journal line, under the redactor's length cap: the forecast and the reset must not be cut off.
    const day = (t: number) => new Date(t).toISOString().slice(0, 10)
    logErr(
      '[alert]',
      `RPC provider ${domain} at ${Math.floor((p.units / budget) * 100)}% of its monthly budget (${p.units}/${budget} ${unitOf(domain)} since ${day(p.since)}): ` +
        (forecast === null ? `lasts to its reset ${day(reset)}` : `spent ~${new Date(forecast).toISOString().slice(0, 16)}Z at this rate, resets ${day(reset)}`),
    )
    return true
  }

  snapshot(now: number = Date.now()): BudgetSnapshot {
    const out: BudgetSnapshot = []
    const domains = new Set([...this.periods.keys(), ...Object.keys(this.budgets)])
    for (const domain of [...domains].sort()) {
      const start = cycleStart(domain, now, this.resetDays)
      const kept = this.periods.get(domain)
      const p = kept && kept.start === start ? kept : { start, since: now, units: 0, alerted: 0 }
      const budget = this.budgets[domain] ?? null
      const forecast = budget ? this.forecast(domain, p, budget, now) : null
      out.push({
        provider: domain,
        unit: unitOf(domain),
        used: p.units,
        budget,
        usedPct: budget ? Math.round((p.units / budget) * 1000) / 10 : null,
        cycleStart: new Date(start).toISOString(),
        resetAt: new Date(nextReset(domain, now, this.resetDays)).toISOString(),
        countedSince: new Date(Math.max(p.since, start)).toISOString(),
        forecastExhaustedAt: forecast === null ? null : new Date(forecast).toISOString(),
      })
    }
    return out
  }

  /** This cycle's period of `domain`, started afresh at a reset. Null past MAX_DOMAINS new domains (the rest are not counted). */
  private period(domain: string, now: number): Period | null {
    const start = cycleStart(domain, now, this.resetDays)
    let p = this.periods.get(domain)
    if (!p && this.periods.size >= MAX_DOMAINS) return null
    if (!p || p.start !== start) this.periods.set(domain, (p = { start, since: now, units: 0, alerted: 0 }))
    return p
  }

  /** When `budget` is reached at the average rate since the count began; null if not before the reset. */
  private forecast(domain: string, p: Period, budget: number, now: number): number | null {
    if (p.units >= budget) return now
    const from = Math.max(p.since, p.start)
    const rate = p.units / Math.max(now - from, MIN_RATE_WINDOW_MS)
    if (!(rate > 0)) return null
    const at = now + (budget - p.units) / rate
    return at < nextReset(domain, now, this.resetDays) ? Math.round(at) : null
  }
}
