import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { usd } from '../lib/money.ts'

/** Server render has no layout pass: the plain effect there, the layout one in the browser (no flash of the end value). */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 4)

/**
 * A number that glides to each new value instead of jumping (#226). The first render shows the value itself (server
 * render and tests read it); with `countUp` the browser starts it from 0 before the first paint. Reduced motion: no glide.
 */
export function useTween(value: number, { ms = 900, countUp = false }: { ms?: number; countUp?: boolean } = {}): number {
  const [shown, setShown] = useState(value)
  const from = useRef(countUp ? 0 : value)
  const frame = useRef(0)
  useIsoLayoutEffect(() => {
    const start = from.current
    if (reducedMotion() || start === value) {
      from.current = value
      setShown(value)
      return
    }
    setShown(start)
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms)
      const v = start + (value - start) * easeOut(t)
      from.current = v
      setShown(v)
      if (t < 1) frame.current = requestAnimationFrame(step)
    }
    frame.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame.current)
  }, [value, ms])
  return shown
}

/** The previous value of a prop, so a change can say which way it went. */
function useDirection(value: number): { dir: 'up' | 'down' | null; n: number } {
  const prev = useRef(value)
  const [tick, setTick] = useState<{ dir: 'up' | 'down' | null; n: number }>({ dir: null, n: 0 })
  useEffect(() => {
    const prior = prev.current
    if (value === prior) return
    prev.current = value
    setTick((t) => ({ dir: value > prior ? 'up' : 'down', n: t.n + 1 }))
  }, [value])
  return tick
}

/**
 * A USDC amount in base units, gliding between readings, with a short glow on each change: green when it grew,
 * ink when it fell. The text is always a valid `usd()` string, so a screen reader never hears a half-way figure
 * as anything but a number.
 */
export function TweenUsd({ raw, prefix = '', countUp = false, className }: { raw: bigint | string; prefix?: string; countUp?: boolean; className?: string }) {
  const target = Number(raw)
  const v = useTween(target, { countUp })
  const { dir, n } = useDirection(target)
  return (
    <span key={n} className={`num-tick${dir ? ` num-${dir}` : ''}${className ? ` ${className}` : ''}`}>
      {prefix + usd(BigInt(Math.round(v)))}
    </span>
  )
}

/** A percentage with one decimal, gliding like TweenUsd. */
export function TweenPct({ value, countUp = false }: { value: number; countUp?: boolean }) {
  const v = useTween(value, { countUp, ms: 1100 })
  const { dir, n } = useDirection(value)
  return (
    <span key={n} className={`num-tick${dir ? ` num-${dir}` : ''}`}>
      {`${v.toFixed(1)}%`}
    </span>
  )
}

/** One chevron for every fold on Home: a thin stroke in a ring, turning half a turn when it opens. */
export function Chevron({ open, dir = 'down' }: { open?: boolean; dir?: 'down' | 'right' }) {
  return (
    <span className={`chev${open ? ' is-open' : ''}${dir === 'right' ? ' chev-right' : ''}`} aria-hidden="true">
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 5.25 7 8.75l3.5-3.5" />
      </svg>
    </span>
  )
}

/**
 * A panel whose whole head is the control (#226): tap anywhere on it to open or close. The body slides open on a
 * grid track (0fr to 1fr) so its real height animates, and is inert while closed. `status` sits under the head and
 * stays visible either way (the engine's line is news, not detail).
 */
export function Fold({
  head,
  status,
  children,
  defaultOpen = false,
  className = '',
  testId,
  labelledBy,
}: {
  head: ReactNode
  status?: ReactNode
  children: ReactNode
  defaultOpen?: boolean
  className?: string
  testId?: string
  labelledBy?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  // The default follows the data (History opens once its few events arrive) until the owner taps the head.
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current) setOpen(defaultOpen)
  }, [defaultOpen])
  const id = useId()
  return (
    <section className={`panel${open ? ' is-open' : ''} ${className}`.trim()} data-testid={testId} data-open={open ? 'true' : 'false'} aria-labelledby={labelledBy}>
      <button type="button" className="panel-head" aria-expanded={open} aria-controls={id} onClick={() => {
          touched.current = true
          setOpen((o) => !o)
        }}>
        <span className="panel-head-main">{head}</span>
        <Chevron open={open} />
      </button>
      {status}
      <div id={id} className="panel-body" inert={!open}>
        <div className="panel-inner">{children}</div>
      </div>
    </section>
  )
}

/** "4 s", "1 min": how long ago the last reading landed, short enough for a pill. */
function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  return `${Math.floor(s / 60)} min`
}

/**
 * The page is live (#226): a pill by the brand with a ring that fills until the next reading, how long ago the
 * last one landed, and a tap to read now. While the read is down it says so instead.
 */
export function LiveSync({ updatedAt, intervalMs, fetching, down, onRefresh }: { updatedAt: number; intervalMs: number; fetching: boolean; down: boolean; onRefresh: () => void }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const age = updatedAt ? now - updatedAt : 0
  const label = down ? 'Offline · retrying' : fetching || !updatedAt ? 'Updating' : `Live · ${since(age)} ago`
  return (
    <button type="button" className={`live${down ? ' is-down' : ''}${fetching ? ' is-fetching' : ''}`} onClick={onRefresh} aria-label={`${label}. Refresh now`} data-testid="live-sync">
      <svg className="live-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6" className="live-track" />
        {/* Restarted on every reading: the ring fills over the poll interval, so the wait for the next one shows. */}
        <circle key={updatedAt} cx="8" cy="8" r="6" className="live-fill" pathLength={1} style={{ animationDuration: `${intervalMs}ms` }} />
        <circle cx="8" cy="8" r="2.2" className="live-core" />
      </svg>
      <span className="live-label">{label}</span>
    </button>
  )
}

function standalone(): boolean {
  if (typeof window === 'undefined') return false
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

const PULL_AT = 72

/**
 * Pull down from the top to read everything again (#226). Only where the browser has no pull-to-refresh of its own:
 * the app added to the home screen (standalone). The mark turns with the pull and spins while the reads run.
 */
export function PullToRefresh({ onRefresh }: { onRefresh: () => Promise<unknown> }) {
  const [pull, setPull] = useState(0)
  const [busy, setBusy] = useState(false)
  const start = useRef<number | null>(null)
  const pulled = useRef(0)
  const busyRef = useRef(false)
  const refresh = useRef(onRefresh)
  refresh.current = onRefresh
  useEffect(() => {
    if (!standalone()) return
    const down = (e: TouchEvent) => {
      // Not while a dialog is open: its own scroll must never reload the page behind it.
      start.current = window.scrollY <= 0 && !busyRef.current && !document.querySelector('dialog[open]') ? e.touches[0]!.clientY : null
    }
    const move = (e: TouchEvent) => {
      if (start.current === null) return
      // The gesture scrolled the page first: it is a scroll, not a pull.
      if (window.scrollY > 0) {
        start.current = null
        pulled.current = 0
        setPull(0)
        return
      }
      const dy = e.touches[0]!.clientY - start.current
      // Resistance: the indicator moves less than the finger, and never past twice the trigger.
      pulled.current = dy > 0 ? Math.min(PULL_AT * 2, dy * 0.55) : 0
      setPull(pulled.current)
    }
    const up = () => {
      if (start.current === null) return
      start.current = null
      if (pulled.current >= PULL_AT) {
        busyRef.current = true
        setBusy(true)
        navigator.vibrate?.(8)
        void refresh.current().catch(() => undefined).finally(() => {
          busyRef.current = false
          setBusy(false)
        })
      }
      pulled.current = 0
      setPull(0)
    }
    window.addEventListener('touchstart', down, { passive: true })
    window.addEventListener('touchmove', move, { passive: true })
    window.addEventListener('touchend', up)
    window.addEventListener('touchcancel', up)
    return () => {
      window.removeEventListener('touchstart', down)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', up)
      window.removeEventListener('touchcancel', up)
    }
  }, [])
  const shown = busy ? PULL_AT : pull
  if (!shown) return null
  const ready = pull >= PULL_AT
  return (
    <div className={`ptr${busy ? ' is-busy' : ''}${ready ? ' is-ready' : ''}`} style={{ transform: `translate(-50%, ${shown - 44}px)` }} role="status" aria-label={busy ? 'Refreshing' : 'Pull to refresh'}>
      <img src="/mark-two-stones.png" width={22} height={22} alt="" style={busy ? undefined : { transform: `rotate(${(pull / PULL_AT) * 300}deg)` }} />
    </div>
  )
}
