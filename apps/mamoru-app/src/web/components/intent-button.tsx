import type { DashboardPayload } from '@mamoru/domain'
import { DEPOSITS_CLOSED_NOTHING, INTENTS_UNAVAILABLE } from '../copy/dashboard.ts'

// v1 production has no session and no capital, so intents are disabled with the reason (dashboard.md §7.3).
export function IntentButton({ label, fundsGate }: { label: string; fundsGate: DashboardPayload['account']['fundsGate'] }) {
  const closed = fundsGate === 'closed'
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="act" disabled aria-disabled="true">
        {label}
      </button>
      <span className="text-[0.85rem] text-stone">{closed ? DEPOSITS_CLOSED_NOTHING : INTENTS_UNAVAILABLE}</span>
    </span>
  )
}
