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

/**
 * QuickNode API credits per clock hour (otto/mamoru#305), the same rule for the other keyed provider: the Build plan's
 * 80M credits a month spent evenly (80M / 720 h is about 111k). 0 turns it off; an empty or invalid value is the default.
 */
export const DEFAULT_KEYED_CREDITS_PER_HOUR = 110_000

export function keyedCreditsBudgetFromEnv(env: Env = process.env): number {
  const raw = env.MAMORU_KEYED_CREDITS_PER_HOUR?.trim()
  if (!raw) return DEFAULT_KEYED_CREDITS_PER_HOUR
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 && !Object.is(n, -0) ? n : DEFAULT_KEYED_CREDITS_PER_HOUR
}

/** Whether this clock hour's budget is spent. Asked by the loops that can wait; owner operations never ask. */
export type RpcBudget = { over(now?: number): boolean; readonly cuPerHour: number; readonly creditsPerHour: number }

/**
 * The budget is on everything billed this clock hour, whatever the provider label: no routing changes, the
 * operator only does less. Either keyed provider over its own limit (Alchemy CU, QuickNode credits) is over.
 * Nothing is remembered across hours.
 */
export function rpcBudget(
  metrics: Pick<RpcMetrics, 'cuThisHour' | 'creditsThisHour'>,
  cuPerHour: number = keyedBudgetFromEnv(),
  creditsPerHour: number = keyedCreditsBudgetFromEnv(),
): RpcBudget {
  return {
    cuPerHour,
    creditsPerHour,
    over: (now = Date.now()) => (cuPerHour > 0 && metrics.cuThisHour(now) >= cuPerHour) || (creditsPerHour > 0 && metrics.creditsThisHour(now) >= creditsPerHour),
  }
}
