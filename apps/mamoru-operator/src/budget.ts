import type { RpcMetrics } from './metrics.ts'

type Env = Record<string, string | undefined>

/**
 * CU the keyed provider may be charged per clock hour before the background loops slow down. The default spends
 * a 30M CU month evenly (30M / 720 h). 0 turns the limit off; an empty or invalid value is the default.
 */
export const DEFAULT_KEYED_CU_PER_HOUR = 40_000

export function keyedBudgetFromEnv(env: Env = process.env): number {
  const raw = env.MAMORU_KEYED_CU_PER_HOUR?.trim()
  if (!raw) return DEFAULT_KEYED_CU_PER_HOUR
  const n = Number(raw)
  // -0 ("-0", or a negative that underflows) is not a way to turn the limit off.
  return Number.isFinite(n) && n >= 0 && !Object.is(n, -0) ? n : DEFAULT_KEYED_CU_PER_HOUR
}

/** Whether this clock hour's budget is spent. Asked by the loops that can wait; owner operations never ask. */
export type RpcBudget = { over(now?: number): boolean; readonly cuPerHour: number }

/**
 * The budget is on everything billed this clock hour, whatever the provider label: no routing changes, the
 * operator only does less. Nothing is remembered across hours.
 */
export function rpcBudget(metrics: Pick<RpcMetrics, 'cuThisHour'>, cuPerHour: number = keyedBudgetFromEnv()): RpcBudget {
  return { cuPerHour, over: (now = Date.now()) => cuPerHour > 0 && metrics.cuThisHour(now) >= cuPerHour }
}
