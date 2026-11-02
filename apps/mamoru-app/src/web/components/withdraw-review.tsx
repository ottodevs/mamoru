import type { ReactNode } from 'react'
import { signatureCopy } from '../lib/signature.ts'
import { CARD_LINK } from '../routes/onboarding.tsx'

/**
 * otto/mamoru#295 (Brais, v4): the withdraw signature screen. What is signed comes first, as the amount and where it
 * goes, right above the button; "only your passkey" is one line under it. The whole signed sentence stays behind
 * "What you sign" (#41). `children` (the swap quote, the price-divergence notice) sit between the destination and the
 * button, since they change what is signed.
 */
export function WithdrawReview({
  amount,
  asset,
  address,
  name,
  chain,
  scope,
  busy,
  error,
  cancelLabel,
  confirmLabel,
  confirmDisabled = false,
  onApprove,
  onCancel,
  children,
}: {
  /** Exact decimal amount, as typed or as Max filled it. */
  amount: string
  asset: string
  address: string
  name?: string | null
  chain: string
  scope: ReactNode
  busy: string | null
  error: string | null
  cancelLabel?: string
  confirmLabel?: string
  confirmDisabled?: boolean
  onApprove: () => void
  onCancel: () => void
  children?: ReactNode
}) {
  const copy = signatureCopy.withdrawCard
  return (
    <div className="grid min-w-0 gap-3 [overflow-wrap:anywhere]" data-testid="review">
      <p className="ob-step m-0 uppercase" aria-hidden="true">
        {copy.eyebrow}
      </p>
      <p className="m-0 text-[clamp(2rem,9vw,3rem)] leading-none tabular-nums" data-testid="withdraw-amount">
        {amount} {asset}
      </p>
      {/* The whole destination stays in view above the button, never only its ends: a look-alike address with the
          same first and last characters (address poisoning) must be visible before the passkey signs. */}
      <div className="grid gap-1" data-testid="withdraw-to">
        <p className="m-0 font-mono text-[0.9rem] text-stone">
          {copy.to} {name ? `${name} · ` : ''}
          {chain}
        </p>
        <p className="m-0 font-mono text-[0.82rem] break-all" data-testid="withdraw-address">
          {address}
        </p>
      </div>
      {children}
      <p className="m-0 mt-1 grid grid-cols-[1.6rem_1fr] leading-snug">
        <span className="text-emerald" aria-hidden="true">
          ✓
        </span>
        <span>{copy.only}</span>
      </p>
      <details data-testid="sign-details">
        <summary className={`${CARD_LINK} cursor-pointer`}>{copy.details}</summary>
        <div className="mt-2 grid gap-2 text-[0.88rem] leading-[1.45]">
          <p className="m-0" data-testid="sign-scope">
            {scope}
          </p>
        </div>
      </details>
      <div role="status" aria-live="polite">
        {error ? <p className="err">{error}</p> : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-4">
        <button type="button" className={CARD_LINK} onClick={() => onCancel()} disabled={busy !== null}>
          {cancelLabel ?? copy.cancel}
        </button>
        <button type="button" className="ob-btn solid shrink-0" onClick={() => onApprove()} disabled={busy !== null || confirmDisabled}>
          {busy === 'signing' ? 'Waiting for passkey' : (confirmLabel ?? copy.action)}
        </button>
      </div>
    </div>
  )
}
