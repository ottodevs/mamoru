import { useSyncExternalStore } from 'react'

/** otto/mamoru#191: one dark notice at the top of the page, gone after `ms`. Shown by a confirmed deposit. */
export type ToastMsg = { text: string; href?: string; linkLabel?: string }

const TOAST_MS = 4_000
let current: ToastMsg | null = null
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export function showToast(msg: ToastMsg, ms = TOAST_MS): void {
  current = msg
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    current = null
    timer = null
    emit()
  }, ms)
  emit()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function Toast() {
  const msg = useSyncExternalStore(subscribe, () => current, () => current)
  if (!msg) return null
  return (
    <div className="fixed inset-x-4 top-9 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-x-5 gap-y-1 bg-ink px-5 py-3 text-paper shadow-lg" role="status" data-testid="toast">
      <span className="flex items-center gap-3 text-[0.98rem]">
        <span className="h-2 w-2 shrink-0 rounded-full bg-[color-mix(in_srgb,var(--color-emerald)_45%,white)]" aria-hidden="true" />
        {msg.text}
      </span>
      {msg.href ? (
        <a className="font-mono text-[0.8rem] tracking-[0.04em] text-paper underline decoration-stone underline-offset-4 hover:decoration-paper" href={msg.href} target="_blank" rel="noreferrer">
          {msg.linkLabel ?? 'View'}
        </a>
      ) : null}
    </div>
  )
}
