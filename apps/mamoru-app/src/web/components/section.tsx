import type { ReactNode } from 'react'
import { TRY_AGAIN } from '../copy/dashboard.ts'

export function Section({ id, title, question, children }: { id: string; title: string; question?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="w-full scroll-mt-20 border-t border-wash py-6">
      <h2 id={`${id}-title`} className="m-0 text-[1.15rem] font-bold tracking-[0.01em]">
        {title}
      </h2>
      {question ? <p className="mt-1 mb-0 text-[0.88rem] text-stone">{question}</p> : null}
      <div className="mt-3 grid gap-3">{children}</div>
    </section>
  )
}

export function SubTitle({ children }: { children: ReactNode }) {
  return <h3 className="kicker mt-3">{children}</h3>
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 text-stone" data-testid="empty">
      {children}
    </p>
  )
}

export function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 border border-alert/50 bg-alert/5 px-3 py-2 text-[0.9rem] text-alert-ink">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="btn btn-ghost min-w-0 px-3 py-1 text-[0.72rem]" onClick={onRetry}>
          {TRY_AGAIN}
        </button>
      ) : null}
    </div>
  )
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" className="grid gap-2">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="h-4 animate-pulse bg-wash/60" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  )
}
