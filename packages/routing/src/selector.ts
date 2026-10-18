import type { Adapter, AdapterDeps, Quote, QuoteRequest, SigningMode } from './types.ts'
import { RouteError } from './errors.ts'

export type QuoteFailure = { provider: string; code: string; message: string }

export type QuoteRun = {
  quotes: Quote[]
  failures: QuoteFailure[]
}

/** Calls every adapter that `supports` the request, in parallel, and never throws: a provider that is down,
 * refuses the amount, or refuses the recipient check shows up in `failures`, not as an exception that would hide
 * every other provider's quote. */
export async function quoteAll(req: QuoteRequest, adapters: readonly Adapter[], deps?: AdapterDeps): Promise<QuoteRun> {
  const applicable = adapters.filter((a) => a.supports(req))
  const results = await Promise.all(
    applicable.map(async (a) => {
      try {
        return { ok: true as const, quote: await a.quote(req, deps) }
      } catch (e) {
        if (e instanceof RouteError) return { ok: false as const, failure: { provider: e.provider, code: e.code, message: e.message } }
        return { ok: false as const, failure: { provider: a.name, code: 'UNKNOWN', message: e instanceof Error ? e.message : String(e) } }
      }
    }),
  )
  const quotes: Quote[] = []
  const failures: QuoteFailure[] = []
  for (const r of results) (r.ok ? quotes.push(r.quote) : failures.push(r.failure))
  return { quotes, failures }
}

export type SelectOptions = {
  /** Keep only quotes signable in this mode. Omit to consider every mode (useful for a UI that shows both). */
  mode?: SigningMode
}

/** otto/mamoru#181: "a selector that picks the best route ... by net output per direction ... and signing mode".
 * Net output is `amountOut` — every quote here moves the same asset in the same `amountIn`, so the provider that
 * leaves the account with the most of it on the other side is strictly the best one, full stop; `fee` and `etaSec`
 * are shown to the owner but do not need their own weighting. Ties (two providers landing on the same amountOut)
 * go to whichever arrives sooner. */
export function selectBest(quotes: readonly Quote[], opts: SelectOptions = {}): Quote | null {
  const pool = opts.mode === undefined ? quotes : quotes.filter((q) => q.mode === opts.mode)
  if (pool.length === 0) return null
  return pool.reduce((best, q) => {
    if (q.amountOut > best.amountOut) return q
    if (q.amountOut === best.amountOut && q.etaSec < best.etaSec) return q
    return best
  })
}

/** Ranks every quote best-first, same ordering as `selectBest`. Lets a caller show "Across — fastest, 2nd best
 * output" style comparisons instead of only the single winner. */
export function rank(quotes: readonly Quote[], opts: SelectOptions = {}): Quote[] {
  const pool = opts.mode === undefined ? quotes : quotes.filter((q) => q.mode === opts.mode)
  return [...pool].sort((a, b) => (b.amountOut === a.amountOut ? a.etaSec - b.etaSec : b.amountOut > a.amountOut ? 1 : -1))
}
