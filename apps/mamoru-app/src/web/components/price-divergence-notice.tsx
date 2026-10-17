import type { PriceDivergenceWarning } from '@mamoru/domain'
import { useId } from 'react'
import { detectLocale, divergenceCheckboxLabel, divergenceLines, divergenceWhy, type Locale } from '../lib/price-divergence.ts'

/**
 * The withdrawal would settle meaningfully below the fair price. Reuses the same alert box StopDialog already
 * uses (`--color-alert`, see styles.css) — no new visual style, no exclamation marks, no new icon set. Ticking
 * the box is the deliberate confirmation the dialog's "Withdraw anyway" button waits on (otto/mamoru#155).
 */
export function PriceDivergenceNotice({
  warning,
  accepted,
  onAcceptedChange,
  locale = detectLocale(),
}: {
  warning: PriceDivergenceWarning
  accepted: boolean
  onAcceptedChange: (v: boolean) => void
  locale?: Locale
}) {
  const id = useId()
  return (
    <div
      className="mt-1 grid gap-2 border border-[color-mix(in_srgb,#9b2c2c_55%,var(--color-wash))] bg-[color-mix(in_srgb,#9b2c2c_8%,var(--color-paper))] px-[0.7rem] py-[0.6rem] text-[0.88rem] leading-[1.4] text-alert-ink"
      role="status"
      data-testid="price-divergence"
    >
      {divergenceLines(locale, warning).map((line, i) => (
        <p className="m-0" key={i}>
          {line}
        </p>
      ))}
      <p className="m-0 text-stone">{divergenceWhy(locale)}</p>
      <label className="mt-1 flex items-start gap-2 text-ink" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          className="mt-[0.2rem]"
          checked={accepted}
          onChange={(e) => onAcceptedChange(e.target.checked)}
          data-testid="price-divergence-accept"
        />
        <span>{divergenceCheckboxLabel(locale, warning)}</span>
      </label>
    </div>
  )
}
