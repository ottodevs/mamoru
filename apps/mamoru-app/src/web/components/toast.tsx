import { useSyncExternalStore } from 'react'
import { BASE_SLEEVE, explorerTx } from '../lib/chain.tsx'
import { usd } from '../lib/money.ts'

/**
 * otto/mamoru#191: one dark notice at the top of the page, gone after `ms`. Shown by a confirmed deposit. The live
 * region is always in the page (a status that appears already filled is not reliably read out), first in the focus
 * order, and the timer stops while the pointer or the focus is on it, so its link can be reached.
 */
export type ToastMsg = { text: string; href?: string; linkLabel?: string }

const TOAST_MS = 4_000
let current: ToastMsg | null = null
let timer: ReturnType<typeof setTimeout> | null = null
// Held while the pointer is over it or the focus is in it; either alone keeps it.
const held = { hover: false, focus: false }
let duration = TOAST_MS
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function arm() {
  if (timer) clearTimeout(timer)
  timer = held.hover || held.focus || !current ? null : setTimeout(() => {
    current = null
    timer = null
    emit()
  }, duration)
}

export function showToast(msg: ToastMsg, ms = TOAST_MS): void {
  current = msg
  duration = ms
  arm()
  emit()
}

function hold(kind: keyof typeof held, on: boolean) {
  held[kind] = on
  arm()
}

/** A wallet transfer Base confirmed, said once with its explorer link. */
export const confirmedCopy = (amount: string) => `Confirmed on Base. ${amount} USDC added.`

export function toastConfirmed(tx: string, raw: bigint): void {
  showToast({ text: confirmedCopy(usd(raw)), href: explorerTx(BASE_SLEEVE, tx), linkLabel: `View on ${BASE_SLEEVE.explorer.name}` })
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function Toast() {
  const msg = useSyncExternalStore(subscribe, () => current, () => current)
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="toast"
      onMouseEnter={() => hold('hover', true)}
      onMouseLeave={() => hold('hover', false)}
      onFocus={() => hold('focus', true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && hold('focus', false)}
    >
      {msg ? (
        <div className="fixed inset-x-4 top-9 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-x-5 gap-y-1 bg-ink px-5 py-3 text-paper shadow-lg">
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
      ) : null}
    </div>
  )
}
