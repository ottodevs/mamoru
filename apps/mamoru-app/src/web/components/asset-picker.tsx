import type { WithdrawAsset } from '@mamoru/domain'
import { useEffect, useRef, useState } from 'react'
import { assetLabel, type WithdrawAssetOption } from '../lib/withdraw-assets.ts'
import { TokenMark } from './token-mark.tsx'

/** Token dropdown from the mockup's transfer modal: current token face, ▾, a list of marks. */
export function AssetPicker({ value, options, onChange }: { value: WithdrawAsset; options: WithdrawAssetOption[]; onChange: (a: WithdrawAsset) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])

  return (
    <div className="tok-dd" ref={root}>
      <button type="button" className="tok-now" aria-haspopup="listbox" aria-expanded={open} aria-label={`Receive as ${assetLabel(value)}`} onClick={() => setOpen((o) => !o)}>
        <TokenMark symbol={value} size={20} />
        <span className="tok-sym">{assetLabel(value)}</span>
      </button>
      {open ? (
        <ul className="tok-list" role="listbox" aria-label="Asset to receive">
          {options.map((o) => (
            <li key={o.asset}>
              <button
                type="button"
                role="option"
                className="tok-opt"
                aria-selected={o.asset === value}
                disabled={!o.available}
                title={o.available ? undefined : o.reason}
                onClick={() => {
                  onChange(o.asset)
                  setOpen(false)
                }}
              >
                <TokenMark symbol={o.asset} size={24} />
                <span className="grid">
                  <span className="tok-sym">{assetLabel(o.asset)}</span>
                  {!o.available && o.reason ? <span className="tok-why">{o.reason}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
