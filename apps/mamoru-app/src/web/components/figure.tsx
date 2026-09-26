import type { Figure, Provenance, ReasonCode } from '@mamoru/domain'
import type { ReactNode } from 'react'
import { NOT_OBSERVED } from '../copy/dashboard.ts'
import { formatAmount } from '../lib/format.ts'
import { chipFor } from '../lib/provenance.ts'
import { useScope } from './scope.tsx'

export function ProvenanceChip({ provenance }: { provenance: Provenance }) {
  const chip = chipFor(provenance, useScope())
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-1">
      <span className="chip" data-testid="chip">
        {chip.label}
      </span>
      {chip.stale ? <span className="chip border-alert/40 text-alert-ink">{chip.stale}</span> : null}
    </span>
  )
}

export function Code({ code }: { code: ReasonCode }) {
  return <code className="code">{code}</code>
}

type FigureProps<T> = {
  figure: Figure<T>
  format?: (value: T, unit: string | undefined) => ReactNode
  className?: string
  /** Names the unit beside "Not observed" where several amounts share one row. */
  unitWhenMissing?: boolean
}

function defaultFormat(value: unknown, unit: string | undefined): ReactNode {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return formatAmount(value, unit)
  return String(value)
}

/** One figure with its provenance chip. A null value is "Not observed", never zero. */
export function FigureValue<T>({ figure, format, className, unitWhenMissing = false }: FigureProps<T>) {
  const shown = figure.value === null ? null : (format ?? defaultFormat)(figure.value, figure.unit)
  return (
    <span className={`inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-2 gap-y-1 ${className ?? ''}`}>
      {shown === null && unitWhenMissing && figure.unit ? (
        <span className="font-mono text-[0.75rem] tracking-[0.06em]">{figure.unit}</span>
      ) : null}
      {shown === null ? (
        <span className="text-stone" data-testid="not-observed">
          {NOT_OBSERVED}
        </span>
      ) : (
        <span className="tabular-nums">{shown}</span>
      )}
      <ProvenanceChip provenance={figure.provenance} />
    </span>
  )
}

export function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-1 border-t border-wash py-2 sm:grid-cols-[14rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-stone text-[0.92rem]">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  )
}
