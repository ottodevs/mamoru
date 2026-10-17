import type { PriceDivergenceLeg, PriceDivergenceWarning } from '@mamoru/domain'
import { formatAmount, formatBps } from './format.ts'
import { usd } from './money.ts'

// otto/mamoru#155: plain-language copy and gating for the withdraw divergence warning. "TWAP" never reaches
// the owner — the sentence below says "fair price over the last 30 minutes" instead (operator's copy, mirrored
// here for the three languages the app ships). No alarmist wording, no exclamation marks.

export type Locale = 'en' | 'es' | 'ja'
const LOCALES: readonly Locale[] = ['en', 'es', 'ja']

/** Browser language to one of the locales this feature ships; anything else falls back to English. */
export function detectLocale(nav: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language): Locale {
  const prefix = (nav ?? 'en').slice(0, 2).toLowerCase()
  return (LOCALES as readonly string[]).includes(prefix) ? (prefix as Locale) : 'en'
}

type Copy = {
  leg: (leg: PriceDivergenceLeg) => string
  why: string
  checkbox: (shortfallUsd: string) => string
  wait: string
  withdrawAnyway: string
}

const COPY: Record<Locale, Copy> = {
  en: {
    leg: (leg) =>
      `You would receive about ${formatAmount(leg.quotedAmount, leg.token)} instead of about ${formatAmount(leg.fairAmount, leg.token)} — ${formatAmount(leg.shortfall, leg.token)} less (${formatBps(leg.shortfallBps)}).`,
    why: 'The price is moving fast right now, so this would settle below the fair price over the last 30 minutes.',
    checkbox: (shortfallUsd) => `I understand I will receive about $${shortfallUsd} less.`,
    wait: 'Wait',
    withdrawAnyway: 'Withdraw anyway',
  },
  es: {
    leg: (leg) =>
      `Recibirías unos ${formatAmount(leg.quotedAmount, leg.token)} en vez de unos ${formatAmount(leg.fairAmount, leg.token)} — ${formatAmount(leg.shortfall, leg.token)} menos (${formatBps(leg.shortfallBps)}).`,
    why: 'El precio se está moviendo rápido ahora mismo, así que esto se liquidaría por debajo del precio justo de los últimos 30 minutos.',
    checkbox: (shortfallUsd) => `Entiendo que recibiré unos $${shortfallUsd} menos.`,
    wait: 'Esperar',
    withdrawAnyway: 'Retirar de todas formas',
  },
  ja: {
    leg: (leg) =>
      `約${formatAmount(leg.fairAmount, leg.token)}ではなく約${formatAmount(leg.quotedAmount, leg.token)}を受け取ることになります — ${formatAmount(leg.shortfall, leg.token)}少なくなります(${formatBps(leg.shortfallBps)})。`,
    why: '今は価格の変動が速いため、直近30分の適正価格より低い価格で成立します。',
    checkbox: (shortfallUsd) => `約$${shortfallUsd}少なく受け取ることを理解しています。`,
    wait: '待つ',
    withdrawAnyway: 'このまま引き出す',
  },
}

/** One plain sentence of consequence per affected leg, with the numbers. */
export function divergenceLines(locale: Locale, warning: PriceDivergenceWarning): string[] {
  return warning.legs.map((leg) => COPY[locale].leg(leg))
}

export function divergenceWhy(locale: Locale): string {
  return COPY[locale].why
}

export function divergenceCheckboxLabel(locale: Locale, warning: PriceDivergenceWarning): string {
  return COPY[locale].checkbox(usd(warning.shortfallUsdc))
}

export function waitLabel(locale: Locale): string {
  return COPY[locale].wait
}

export function withdrawAnywayLabel(locale: Locale): string {
  return COPY[locale].withdrawAnyway
}

/**
 * Confirm stays disabled until the owner ticks the box for THIS warning (acceptedQuoteId matches it exactly);
 * busy (preparing/signing) also disables it. No warning at all never gates anything here, so an operator that
 * never sends one leaves this withdrawal exactly as it behaves today.
 */
export function transferConfirmDisabled(busy: string | null, divergence: PriceDivergenceWarning | undefined, acceptedQuoteId: string | null): boolean {
  if (busy !== null) return true
  if (!divergence) return false
  return acceptedQuoteId !== divergence.quoteId
}

/**
 * What `approve()` adds to the owner's signature once accepted. Empty when there was no warning, the box was
 * never ticked, or a fresher prepare moved the quoteId past what was ticked — in every one of those cases the
 * submit goes out exactly as an un-warned transfer does, never a stale acceptance.
 */
export function acceptancePayload(divergence: PriceDivergenceWarning | undefined, acceptedQuoteId: string | null): { acceptDivergence: { quoteId: string } } | Record<string, never> {
  return divergence && acceptedQuoteId === divergence.quoteId ? { acceptDivergence: { quoteId: divergence.quoteId } } : {}
}
