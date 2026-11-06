// otto/mamoru#376 (spec 011 §8, T-CAP-07): after the chain refuses a spending op for a spending limit (V4 24 h / 30 day /
// budget, or a V3 session policy), the engine stops sending spending ops for that account until the limit can have
// moved. Retrying every review would pay a failed op each time. One probe every SPEND_HOLD_PROBE_MS at most (≤ 4 failed
// ops a day per account), whatever the reason; a probe that lands lifts the hold. Exits, collects, reduces, redeems and
// bridges are not spends here and are never held. No UI message (Ot and Brais, 6 Nov): the operator log says it once.
import { toFunctionSelector } from 'viem'
import type { Proposal } from '@mamoru/decide'

export const SPEND_HOLD_PROBE_MS = 6 * 3600_000

/** The refusals that mean "a spending limit is used up". Selectors as they appear in revert data. */
const DENIALS: Record<string, string> = Object.fromEntries(
  [
    ['Cap24hExceeded', 'function Cap24hExceeded(uint256,uint256)'],
    ['Cap30Exceeded', 'function Cap30Exceeded(uint256,uint256)'],
    ['BudgetExceeded', 'function BudgetExceeded(address,uint256)'],
    // Smart Sessions: an action policy (UniActionPolicy's cumulative caps on V3) refused the call.
    ['PolicyViolation', 'function PolicyViolation(bytes32,address)'],
  ].map(([name, sig]) => [toFunctionSelector(sig!).slice(2).toLowerCase(), name!]),
)

/** The limit a failure text names (by selector in its revert data, or by name), or null. */
export function spendDenialOf(text: string | undefined): string | null {
  if (!text) return null
  const t = text.toLowerCase()
  for (const [sel, name] of Object.entries(DENIALS)) if (t.includes(sel) || t.includes(name.toLowerCase())) return name
  return null
}

/** Ops the policies charge against a spending limit: swaps, entries and top-ups, re-ranges (they mint), vault deposits. */
export function isSpend(p: Pick<Proposal, 'kind'>): boolean {
  return p.kind === 'enter_swap' || p.kind === 'enter_mint' || p.kind === 'increase_liquidity' || p.kind === 'rerange' || p.kind === 'vault_deposit'
}

type Hold = { since: number; probedAt: number; reason: string }

export class SpendHold {
  private readonly held = new Map<string, Hold>()

  constructor(private readonly probeMs = SPEND_HOLD_PROBE_MS) {}

  /** Whether a proposal may go now. A held account lets one spend through per probe interval (the probe). */
  admit(key: string, p: Pick<Proposal, 'kind'>, now: number): boolean {
    if (!isSpend(p)) return true
    const h = this.held.get(key)
    if (!h) return true
    if (now - h.probedAt < this.probeMs) return false
    h.probedAt = now
    return true
  }

  /** A spend was refused for `reason`. True the first time (the caller logs it once per hold). */
  denied(key: string, reason: string, now: number): boolean {
    const h = this.held.get(key)
    if (h) {
      h.probedAt = now
      h.reason = reason
      return false
    }
    this.held.set(key, { since: now, probedAt: now, reason })
    return true
  }

  /** A spend landed: the limit has room again. True when this lifted a hold. */
  landed(key: string): boolean {
    return this.held.delete(key)
  }

  of(key: string): Readonly<Hold> | undefined {
    return this.held.get(key)
  }
}
