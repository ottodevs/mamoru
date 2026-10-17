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

/**
 * Base units to a grouped decimal string at `maxFraction` places, TRUNCATED (never rounded up). Used for what
 * the owner would receive ("at least X", "about Y"): truncating can only understate a received amount, never
 * overstate it, which is the conservative direction for a figure framed as a floor or an estimate.
 */
function formatLegAmount(raw: string, decimals: number, maxFraction: number = Math.min(decimals, 6)): string {
  if (!/^\d+$/.test(raw)) throw new Error(`not an integer amount: ${raw}`)
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '') || '0'
  const fraction = padded.slice(padded.length - decimals, padded.length - decimals + maxFraction).replace(/0+$/, '')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return fraction ? `${grouped}.${fraction}` : grouped
}

/** True when `raw` has no fractional information beyond `cap` decimal places, i.e. showing it there is exact. */
function isExactAt(raw: string, decimals: number, cap: number): boolean {
  const unit = 10n ** BigInt(decimals - cap)
  return BigInt(raw) % unit === 0n
}

/** Base units to a grouped decimal string at `maxFraction` places, ROUNDED UP to the next representable value. */
function ceilLegAmount(raw: string, decimals: number, maxFraction: number): string {
  const unit = 10n ** BigInt(decimals - maxFraction) // one displayed increment, in base units
  const value = BigInt(raw)
  const remainder = value % unit
  const ceiled = remainder === 0n ? value : value + (unit - remainder)
  return formatLegAmount(ceiled.toString(), decimals, maxFraction)
}

/**
 * The shortfall (a loss the owner is accepting) is never displayed below its true value: this is the one amount
 * in the warning that must round the conservative way, up, so a reader can never end up more surprised than
 * what they were shown. An exact value is untouched (there is no remainder to round away); a value with a
 * remainder at the normal 2-decimal precision (or fewer, for a whole-unit token) is bumped up to the next cent.
 *
 * A shortfall too small to show even at that precision is not ceiling'd into a wildly overstated "0.01": the
 * exact value is shown instead when it needs no more than 4 decimal places (still truthful, still short).
 * Finer than that, two cases remain, and they are NOT the same number: a shortfall that is still at least one
 * whole unit at that 4-decimal precision is ceiled there too (so, say, 0.00012345 reads as "0.0002", never a
 * "less than 0.0001" that would itself understate it); only a shortfall genuinely smaller than that smallest
 * unit (0.00009, say) reads as "less than" it — and "less than X" is used ONLY when the true value is strictly
 * below X, never as a stand-in ceiling for a value that has already passed it.
 */
function formatShortfallAmount(raw: string, decimals: number): string {
  if (raw === '0') return '0'
  const primary = Math.min(2, decimals)
  if (formatLegAmount(raw, decimals, primary) !== '0') {
    return ceilLegAmount(raw, decimals, primary)
  }
  const fineCap = Math.min(decimals, 4)
  if (isExactAt(raw, decimals, fineCap)) {
    return formatLegAmount(raw, decimals, fineCap)
  }
  const smallestAtFineCap = 10n ** BigInt(decimals - fineCap)
  if (BigInt(raw) < smallestAtFineCap) {
    return `< ${formatLegAmount(String(smallestAtFineCap), decimals, fineCap)}`
  }
  return ceilLegAmount(raw, decimals, fineCap)
}

/** Ceiling division for non-negative bigints: the smallest integer not less than a/b (b > 0). */
function ceilDiv(a: bigint, b: bigint): bigint {
  return a <= 0n ? 0n : (a + b - 1n) / b
}

/**
 * The percentage, like the amount, is never displayed below the true loss: ceiled to the next basis point. A
 * true value under 1 bp (0.01%) is not ceiled up to a full "0.01%", which would read as more precise than it
 * is for what is really a dust-level percentage; it reads as "< 0.01%" instead, the same "less than, never a
 * false ceiling" rule `formatShortfallAmount` uses for amounts.
 */
function formatShortfallPercent(shortfall: bigint, fair: bigint): string {
  if (shortfall <= 0n || fair <= 0n) return formatBps(0)
  if (shortfall * 10_000n < fair) return '< 0.01%'
  return formatBps(Number(ceilDiv(shortfall * 10_000n, fair)))
}

/**
 * otto/mamoru#155 (security review on 1c54819): neither `leg.shortfall` nor `leg.shortfallBps` is trusted alone.
 * The shortfall is always re-derived here from `fairAmount` and `minAmount` — the signed/binding floor — and
 * only the larger (worse, more conservative) of that computation and whatever the operator reported is ever
 * shown; the operator's figure can only make the displayed loss bigger, never smaller. Clamped to `fairAmount`
 * so a garbled operator value can't inflate the headline past the whole amount at stake. The percentage is not
 * taken from the operator at all: it is always arithmetic on the shortfall this function already settled on, so
 * the dollar figure and the percentage can never disagree with each other.
 */
function legShortfall(leg: PriceDivergenceLeg): { amount: string; percent: string } {
  const fair = BigInt(leg.fairAmount)
  const min = BigInt(leg.minAmount)
  const computed = fair > min ? fair - min : 0n
  let reported = 0n
  try {
    const r = BigInt(leg.shortfall)
    if (r > 0n) reported = r
  } catch {
    reported = 0n
  }
  const worst = computed > reported ? computed : reported
  const shortfall = worst > fair ? fair : worst
  return { amount: shortfall.toString(), percent: formatShortfallPercent(shortfall, fair) }
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
      swapBack: (leg) => {
        const { amount, percent } = legShortfall(leg)
        return `Your account would get at least ${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token} instead of about ${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token} from selling ${leg.sellToken ?? leg.token}. That is ${formatShortfallAmount(amount, leg.decimals)} ${leg.token} less (${percent}).`
      },
      payout: (leg) => {
        const { amount, percent } = legShortfall(leg)
        return `The recipient would receive at least ${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token} instead of about ${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token}. That is ${formatShortfallAmount(amount, leg.decimals)} ${leg.token} less (${percent}).`
      },
    },
    clause: {
      swapBack: (leg) => `your account will get about ${formatShortfallAmount(legShortfall(leg).amount, leg.decimals)} ${leg.token} less`,
      payout: (leg) => `the recipient will get about ${formatShortfallAmount(legShortfall(leg).amount, leg.decimals)} ${leg.token} less`,
    },
    and: ' and ',
    checkbox: (loss) => `I understand ${loss}.`,
    why: 'The price is moving fast right now, so this would settle below the fair price over the last 30 minutes.',
    wait: 'Wait',
    withdrawAnyway: 'Withdraw anyway',
  },
  es: {
    sentence: {
      swapBack: (leg) => {
        const { amount, percent } = legShortfall(leg)
        return `Tu cuenta recibiría al menos ${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token} en vez de unos ${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token} al vender ${leg.sellToken ?? leg.token}. Eso son ${formatShortfallAmount(amount, leg.decimals)} ${leg.token} menos (${percent}).`
      },
      payout: (leg) => {
        const { amount, percent } = legShortfall(leg)
        return `El destinatario recibiría al menos ${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token} en vez de unos ${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token}. Eso son ${formatShortfallAmount(amount, leg.decimals)} ${leg.token} menos (${percent}).`
      },
    },
    clause: {
      swapBack: (leg) => `tu cuenta recibirá unos ${formatShortfallAmount(legShortfall(leg).amount, leg.decimals)} ${leg.token} menos`,
      payout: (leg) => `el destinatario recibirá unos ${formatShortfallAmount(legShortfall(leg).amount, leg.decimals)} ${leg.token} menos`,
    },
    and: ' y ',
    checkbox: (loss) => `Entiendo que ${loss}.`,
    why: 'El precio se está moviendo rápido ahora mismo, así que esto se liquidaría por debajo del precio justo de los últimos 30 minutos.',
    wait: 'Esperar',
    withdrawAnyway: 'Retirar de todas formas',
  },
  ja: {
    sentence: {
      swapBack: (leg) => {
        const { amount, percent } = legShortfall(leg)
        return `${leg.sellToken ?? leg.token}を売却するアカウントは、約${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token}ではなく少なくとも${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token}を受け取ることになります。${formatShortfallAmount(amount, leg.decimals)} ${leg.token}少なくなります(${percent})。`
      },
      payout: (leg) => {
        const { amount, percent } = legShortfall(leg)
        return `受取人は約${formatLegAmount(leg.fairAmount, leg.decimals)} ${leg.token}ではなく少なくとも${formatLegAmount(leg.minAmount, leg.decimals)} ${leg.token}を受け取ることになります。${formatShortfallAmount(amount, leg.decimals)} ${leg.token}少なくなります(${percent})。`
      },
    },
    clause: {
      swapBack: (leg) => `アカウントが約${formatShortfallAmount(legShortfall(leg).amount, leg.decimals)} ${leg.token}少なく受け取る`,
      payout: (leg) => `受取人が約${formatShortfallAmount(legShortfall(leg).amount, leg.decimals)} ${leg.token}少なく受け取る`,
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

// otto/mamoru#155 (security review on 1c54819): the API client boundary validates a prepare response's
// `divergence` before anything downstream (gating, formatting, rendering) ever sees it. An operator is already
// trusted for a lot, but a malformed warning must never crash the Review mid-withdrawal or silently fail open
// (gate nothing when a real divergence was meant to be flagged) — the client rejects the whole prepare instead,
// which leaves nothing prepared and nothing submittable (see client.ts's use of this).

const INT_STRING = /^\d+$/

function isValidLeg(leg: unknown): leg is PriceDivergenceLeg {
  if (typeof leg !== 'object' || leg === null) return false
  const l = leg as Record<string, unknown>
  if (l.kind !== 'swap-back' && l.kind !== 'payout') return false
  if (typeof l.token !== 'string' || l.token.length === 0) return false
  if (l.sellToken !== undefined && (typeof l.sellToken !== 'string' || l.sellToken.length === 0)) return false
  if (typeof l.decimals !== 'number' || !Number.isInteger(l.decimals) || l.decimals < 0 || l.decimals > 36) return false
  for (const field of ['fairAmount', 'quotedAmount', 'minAmount', 'shortfall'] as const) {
    if (typeof l[field] !== 'string' || !INT_STRING.test(l[field] as string)) return false
  }
  if (typeof l.shortfallBps !== 'number' || !Number.isInteger(l.shortfallBps) || l.shortfallBps < 0) return false
  try {
    const fair = BigInt(l.fairAmount as string)
    const min = BigInt(l.minAmount as string)
    if (min < 0n || min > fair) return false
  } catch {
    return false
  }
  return true
}

/** Integer strings, 0 ≤ minAmount ≤ fairAmount per leg, integer 0 ≤ decimals ≤ 36 per leg, at least one leg. */
export function isValidPriceDivergence(d: unknown): d is PriceDivergenceWarning {
  if (typeof d !== 'object' || d === null) return false
  const w = d as Record<string, unknown>
  if (w.code !== 'PRICE_DIVERGENCE') return false
  if (!Array.isArray(w.legs) || w.legs.length < 1) return false
  if (!w.legs.every(isValidLeg)) return false
  if (typeof w.shortfallUsdc !== 'string' || !INT_STRING.test(w.shortfallUsdc)) return false
  if (typeof w.quoteId !== 'string' || w.quoteId.length === 0) return false
  return true
}
