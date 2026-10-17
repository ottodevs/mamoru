import type { PriceDivergenceLeg, PriceDivergenceWarning } from '@mamoru/domain'
import { formatBps } from './format.ts'

// otto/mamoru#155: plain-language copy and gating for the withdraw divergence warning. "TWAP" never reaches
// the owner — the sentence below says "fair price over the last 30 minutes" instead (operator's copy, mirrored
// here for the three languages the app ships). No alarmist wording, no exclamation marks, no em dash (Ot's
// voice: a period instead, see "That is X less" below).
//
// Amounts are formatted from the leg's own `decimals` and `token`, never the app's token registry: the leg is
// the authoritative source (the registry may not carry every payout asset, and should not have to).

export type Locale = 'en' | 'es' | 'ja'
const LOCALES: readonly Locale[] = ['en', 'es', 'ja']

/** Browser language to one of the locales this feature ships; anything else falls back to English. */
export function detectLocale(nav: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.language): Locale {
  const prefix = (nav ?? 'en').slice(0, 2).toLowerCase()
  return (LOCALES as readonly string[]).includes(prefix) ? (prefix as Locale) : 'en'
}

/** Base units to a grouped decimal string, truncated to `maxFraction` places (never the full `decimals`, unless asked). */
function formatLegAmount(raw: string, decimals: number, maxFraction: number = Math.min(decimals, 6)): string {
  if (!/^\d+$/.test(raw)) throw new Error(`not an integer amount: ${raw}`)
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '') || '0'
  const fraction = padded.slice(padded.length - decimals, padded.length - decimals + maxFraction).replace(/0+$/, '')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

/**
 * The shortfall at enough precision that a positive amount never reads as a flat zero: try 2 decimals first (or
 * fewer, for a whole-unit token), then up to 6. A shortfall finer than that (a fraction of a cent-equivalent on
 * an 18-decimal token, say) is not spelled out to 18 places; it reads as "less than" the smallest of those 6
 * decimals instead, which still never claims there is no loss.
 */
function formatShortfallAmount(raw: string, decimals: number): string {
  if (raw === '0') return '0'
  const cap = Math.min(decimals, 6)
  for (const fraction of [Math.min(2, cap), cap]) {
    const s = formatLegAmount(raw, decimals, fraction)
    if (!/^0$/.test(s)) return s
  }
  const smallestAtCap = 10n ** BigInt(decimals - cap) // one unit at `cap` decimal places, in base units
  return `< ${formatLegAmount(String(smallestAtCap), decimals, cap)}`
}

type LegCopy = {
  swapBack: (leg: PriceDivergenceLeg) => string
  payout: (leg: PriceDivergenceLeg) => string
}
type ClauseCopy = {
  swapBack: (leg: PriceDivergenceLeg) => string
  payout: (leg: PriceDivergenceLeg) => string
}
type Copy = {
  sentence: LegCopy
  clause: ClauseCopy
  and: string
  checkbox: (loss: string) => string
  why: string
  wait: string
  withdrawAnyway: string
}

const COPY: Record<Locale, Copy> = {
  en: {
    sentence: {
      swapBack: (leg) =>
        `Your account would get at least ${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token} instead of about ${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token} from selling ${leg.sellToken ?? leg.token}. That is ${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token} less (${formatBps(leg.shortfallBps)}).`,
      payout: (leg) =>
        `The recipient would receive at least ${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token} instead of about ${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token}. That is ${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token} less (${formatBps(leg.shortfallBps)}).`,
    },
    clause: {
      swapBack: (leg) => `your account will get about ${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token} less`,
      payout: (leg) => `the recipient will get about ${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token} less`,
    },
    and: ' and ',
    checkbox: (loss) => `I understand ${loss}.`,
    why: 'The price is moving fast right now, so this would settle below the fair price over the last 30 minutes.',
    wait: 'Wait',
    withdrawAnyway: 'Withdraw anyway',
  },
  es: {
    sentence: {
      swapBack: (leg) =>
        `Tu cuenta recibiría al menos ${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token} en vez de unos ${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token} al vender ${leg.sellToken ?? leg.token}. Eso son ${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token} menos (${formatBps(leg.shortfallBps)}).`,
      payout: (leg) =>
        `El destinatario recibiría al menos ${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token} en vez de unos ${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token}. Eso son ${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token} menos (${formatBps(leg.shortfallBps)}).`,
    },
    clause: {
      swapBack: (leg) => `tu cuenta recibirá unos ${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token} menos`,
      payout: (leg) => `el destinatario recibirá unos ${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token} menos`,
    },
    and: ' y ',
    checkbox: (loss) => `Entiendo que ${loss}.`,
    why: 'El precio se está moviendo rápido ahora mismo, así que esto se liquidaría por debajo del precio justo de los últimos 30 minutos.',
    wait: 'Esperar',
    withdrawAnyway: 'Retirar de todas formas',
  },
  ja: {
    sentence: {
      swapBack: (leg) =>
        `${leg.sellToken ?? leg.token}を売却するアカウントは、約${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token}ではなく少なくとも${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token}を受け取ることになります。${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token}少なくなります(${formatBps(leg.shortfallBps)})。`,
      payout: (leg) =>
        `受取人は約${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token}ではなく少なくとも${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token}を受け取ることになります。${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token}少なくなります(${formatBps(leg.shortfallBps)})。`,
    },
    clause: {
      swapBack: (leg) => `アカウントが約${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token}少なく受け取る`,
      payout: (leg) => `受取人が約${formatShortfallAmount(leg.shortfall, leg.decimals)} ${leg.token}少なく受け取る`,
    },
    and: '、',
    checkbox: (loss) => `${loss}ことを理解しています。`,
    why: '今は価格の変動が速いため、直近30分の適正価格より低い価格で成立します。',
    wait: '待つ',
    withdrawAnyway: 'このまま引き出す',
  },
}

/** One plain sentence of consequence per affected leg, with the worst-case numbers, phrased by what that leg is. */
export function divergenceLines(locale: Locale, warning: PriceDivergenceWarning): string[] {
  return warning.legs.map((leg) => (leg.kind === 'swap-back' ? COPY[locale].sentence.swapBack(leg) : COPY[locale].sentence.payout(leg)))
}

export function divergenceWhy(locale: Locale): string {
  return COPY[locale].why
}

/** Repeats each sentence's loss, same number and same token unit, phrased by what each leg is; joined when there is more than one. */
export function divergenceCheckboxLabel(locale: Locale, warning: PriceDivergenceWarning): string {
  const clauses = warning.legs.map((leg) => (leg.kind === 'swap-back' ? COPY[locale].clause.swapBack(leg) : COPY[locale].clause.payout(leg)))
  const joined = clauses.length <= 1 ? (clauses[0] ?? '') : `${clauses.slice(0, -1).join(', ')}${COPY[locale].and}${clauses[clauses.length - 1]}`
  return COPY[locale].checkbox(joined)
}

export function waitLabel(locale: Locale): string {
  return COPY[locale].wait
}

export function withdrawAnywayLabel(locale: Locale): string {
  return COPY[locale].withdrawAnyway
}

/**
 * Confirm stays disabled until the owner ticks the box for THIS exact warning object; busy (preparing/signing)
 * also disables it. Keyed to the warning instance, not its quoteId string: a fresh prepare always returns a new
 * object, so a tick never carries over even if an operator were to (incorrectly) reuse a quoteId. No warning at
 * all never gates anything here, so an operator that never sends one leaves this withdrawal as it behaves today.
 */
export function transferConfirmDisabled(busy: string | null, divergence: PriceDivergenceWarning | undefined, acceptedWarning: PriceDivergenceWarning | null): boolean {
  if (busy !== null) return true
  if (!divergence) return false
  return acceptedWarning !== divergence
}

/**
 * What `approve()` adds to the owner's signature once accepted. Empty when there was no warning, the box was
 * never ticked, or a fresher (or stale-rewarned) prepare replaced the warning object — in every one of those
 * cases the submit goes out exactly as an un-warned transfer does, never a stale acceptance.
 */
export function acceptancePayload(divergence: PriceDivergenceWarning | undefined, acceptedWarning: PriceDivergenceWarning | null): { acceptDivergence: { quoteId: string } } | Record<string, never> {
  return divergence && acceptedWarning === divergence ? { acceptDivergence: { quoteId: divergence.quoteId } } : {}
}
