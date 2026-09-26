import { Link } from '@tanstack/react-router'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { encodeQr, qrPath } from '../lib/qr.ts'

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

export function BasescanLink({ tx }: { tx: string }) {
  return (
    <a
      href={`https://basescan.org/tx/${tx}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-stone hover:text-emerald"
      aria-label="View on Basescan"
      title="View on Basescan"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
      </svg>
    </a>
  )
}

/** Native modal dialog driven by React state. Closes on Escape and on a backdrop click. */
export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal?.()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className="xfer"
      aria-label={title}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      {open ? (
        <div className="px-[1.35rem] pt-5 pb-[1.4rem]">
          <header className="mb-4 flex items-baseline justify-between gap-4">
            <p className="title heavy">{title}</p>
            <button type="button" className="xfer-close" onClick={onClose}>
              Close
            </button>
          </header>
          {children}
        </div>
      ) : null}
    </dialog>
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
