import type { DashboardPayload } from '@mamoru/domain'
import { DEPOSITS_CLOSED_NOTHING, INTENTS_UNAVAILABLE } from '../copy/dashboard.ts'

type FundsGate = DashboardPayload['account']['fundsGate']

export function intentsReason(fundsGate: FundsGate): string {
  return fundsGate === 'closed' ? DEPOSITS_CLOSED_NOTHING : INTENTS_UNAVAILABLE
}

// v1 production has no session and no capital, so intents are disabled with the reason (dashboard.md §7.3).
export function IntentButton({ label, fundsGate, reason = true }: { label: string; fundsGate: FundsGate; reason?: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="act" disabled aria-disabled="true">
        {label}
      </button>
      {reason ? <span className="text-[0.85rem] text-stone">{intentsReason(fundsGate)}</span> : null}
    </span>
  )
}
