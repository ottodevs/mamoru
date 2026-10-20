import { netOutput } from './pricing.ts'
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

/**
 * otto/mamoru#181: "a selector that picks the best route ... by net output per direction ... and signing mode".
 *
 * otto/mamoru#181 CORRECTION (review round 3, 20 Oct 2026): an earlier version ranked by raw `amountOut`. That
 * understates the true cost of a route that also attaches a native-asset `value` — two quotes landing on the
 * same `amountOut` are not equally good if one of them also drains the account's native balance on the source
 * chain (deBridge's order-creation fee is the live example this round). Ranking is now by `netOutput` (see
 * pricing.ts): `amountOut` minus that native cost, priced with a deliberately conservative (high, stated)
 * rate. A route whose native cost cannot be priced at all (pricing.ts returns `null` — e.g. a nonzero value on
 * a Monad-sourced quote, which has no stated MON price) is treated as worse than every route with a KNOWN cost,
 * including a known cost of exactly its own amountOut-equivalent, not silently priced at zero: comparing two
 * unpriced quotes falls back to amountOut, since there is nothing else to go on, but an unpriced quote never
 * outranks a priced one. This directly satisfies "never prefer a route that charges native value over one that
 * does not, unless its advantage exceeds that value at a conservative price": a zero-value route always has a
 * net output of exactly its amountOut; a value-charging route must beat that same number after its cost is
 * subtracted (or, if unpriceable, cannot win at all).
 */
function comparableValue(q: Quote): { net: bigint; priced: boolean } {
  const net = netOutput(q)
  return net === null ? { net: q.amountOut, priced: false } : { net, priced: true }
}

/** -1 if a ranks ahead of b, 1 if behind, 0 if tied. Priced beats unpriced regardless of the numbers; within
 * the same priced-ness, higher net output wins; a tie on net output goes to whichever arrives sooner. */
function compareQuotes(a: Quote, b: Quote): number {
  const av = comparableValue(a)
  const bv = comparableValue(b)
  if (av.priced !== bv.priced) return av.priced ? -1 : 1
  if (av.net !== bv.net) return av.net > bv.net ? -1 : 1
  return a.etaSec - b.etaSec
}

export function selectBest(quotes: readonly Quote[], opts: SelectOptions = {}): Quote | null {
  const pool = opts.mode === undefined ? quotes : quotes.filter((q) => q.mode === opts.mode)
  if (pool.length === 0) return null
  return pool.reduce((best, q) => (compareQuotes(q, best) < 0 ? q : best))
}

/** Ranks every quote best-first, same ordering as `selectBest`. Lets a caller show "Across — fastest, 2nd best
 * net output" style comparisons instead of only the single winner. */
export function rank(quotes: readonly Quote[], opts: SelectOptions = {}): Quote[] {
  const pool = opts.mode === undefined ? quotes : quotes.filter((q) => q.mode === opts.mode)
  return [...pool].sort(compareQuotes)
}
