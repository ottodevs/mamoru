import { Link } from '@tanstack/react-router'
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { encodeQr, qrPath } from '../lib/qr.ts'
import { explorerTx, useChain } from '../lib/chain.tsx'

export function Brand() {
  return (
    <Link to="/" className="brand">
      <img src="/mark-two-stones.png" width={36} height={36} alt="" />
      <span>Mamoru</span>
    </Link>
  )
}

export function Qr({ text, size = 176 }: { text: string; size?: number }) {
  const m = useMemo(() => encodeQr(text), [text])
  return (
    <div className="qr w-fit" data-testid="qr">
      <svg width={size} height={size} viewBox={`0 0 ${m.length} ${m.length}`} shapeRendering="crispEdges" role="img" aria-label="QR code of your address">
        <path d={qrPath(m)} fill="var(--color-ink)" />
      </svg>
    </div>
  )
}

export function Copy({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!done) return
    const t = setTimeout(() => setDone(false), 1600)
    return () => clearTimeout(t)
  }, [done])
  return (
    <button
      type="button"
      className="chipbtn"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => setDone(true),
          () => undefined,
        )
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}

/** Address in groups of four, so it can be read back and compared. */
export function AddressBlock({ address }: { address: string }) {
  const groups = address.slice(2).match(/.{1,4}/g) ?? []
  return (
    <p className="m-0 font-mono text-[1.02rem] leading-[1.6] tracking-[0.02em] break-all sm:text-[1.15rem]" data-testid="address">
      <span className="text-stone">0x</span>
      {groups.map((g, i) => (
        <span key={i} className={i % 2 ? 'text-stone' : undefined}>
          {g}
        </span>
      ))}
    </p>
  )
}

/** The tx on the explorer of the sleeve's chain (Basescan on Base, Monadscan on Monad; otto/mamoru#67). */
export function BasescanLink({ tx }: { tx: string }) {
  const chain = useChain()
  return (
    <a
      href={explorerTx(chain, tx)}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-stone hover:text-emerald"
      aria-label={`View on ${chain.explorer.name}`}
      title={`View on ${chain.explorer.name}`}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
      </svg>
    </a>
  )
}

/**
 * Native modal dialog driven by React state. Closes on Escape and on a backdrop click. It opens with the focus on its
 * title (otto/mamoru#176), not on its first control: the reader starts at the top, and Enter or Space confirms
 * nothing by accident; Tab reaches the close button and the actions from there.
 */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) {
      d.showModal?.()
      titleRef.current?.focus({ preventScroll: true })
    }
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="xfer"
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {open ? (
        <div className="px-[1.35rem] pt-5 pb-[1.4rem]">
          <header className="mb-4 flex items-start justify-between gap-4">
            <h2 id={titleId} ref={titleRef} tabIndex={-1} className="title heavy xfer-title">
              {title}
            </h2>
            <button type="button" className="xfer-close" onClick={onClose} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M3 3l8 8M11 3l-8 8" />
              </svg>
            </button>
          </header>
          {children}
        </div>
      ) : null}
    </dialog>
  )
}

/**
 * A circled-i button that opens a small panel anchored under it, with the extra detail that used to sit as
 * plain text on the card. Opens and closes on click or Enter/Space (it is a real button); closes on Escape,
 * returning focus to the button, and on a click or focus outside it. The panel is `role="dialog"` so a
 * screen reader announces it as a distinct region when it opens.
 */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  // The panel's pixel offset from the trigger's own left edge, clamped so it never extends past the viewport
  // on either side regardless of where the trigger sits or how wide the panel renders. Recomputed whenever it
  // could change: on open (a fresh layout) and on resize while it stays open (an orientation change, a resized
  // window) — not just once, and not a left/right guess, since neither alone fits a trigger at any position.
  const [left, setLeft] = useState<number | null>(null)
  const id = useId()
  const wrapRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const wrap = wrapRef.current
      const panel = panelRef.current
      if (!wrap || !panel) return
      const margin = 8
      const wrapBox = wrap.getBoundingClientRect()
      // Prefer ending flush with the trigger's right edge (today's common case); clamp into the viewport.
      const preferred = wrapBox.right - panel.offsetWidth
      const clamped = Math.max(margin, Math.min(preferred, window.innerWidth - margin - panel.offsetWidth))
      setLeft(clamped - wrapBox.left)
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        close()
        btnRef.current?.focus()
      }
    }
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close()
    }
    const onFocus = (e: FocusEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('focusin', onFocus)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('focusin', onFocus)
    }
  }, [open])

  return (
    <span className="info" ref={wrapRef}>
      <button type="button" ref={btnRef} className="info-btn" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 7.3v4" strokeLinecap="round" />
          <circle cx="8" cy="4.6" r="0.75" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <div id={id} ref={panelRef} role="dialog" aria-label={label} tabIndex={-1} className="info-panel" style={left === null ? undefined : { left: `${left}px`, right: 'auto' }}>
          {children}
        </div>
      )}
    </span>
  )
}

export function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 flex items-center gap-2.5 text-[0.95rem]" role="status">
      <span className="pulse" aria-hidden="true" />
      {children}
    </p>
  )
}
