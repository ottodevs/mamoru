import { useState } from 'react'
import { shortHex } from '../lib/format.ts'
import { useScope } from './scope.tsx'

// Basescan only in production and only for Base (FR-DSH-007).
function basescanUrl(kind: 'address' | 'tx', hex: string): string {
  return `https://basescan.org/${kind}/${hex}`
}

type HexProps = { hex: string; kind: 'address' | 'tx'; full?: boolean; linkLabel?: string }

export function HexValue({ hex, kind, full = false, linkLabel }: HexProps) {
  const { mode } = useScope()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    await navigator.clipboard.writeText(hex)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-3 gap-y-1">
      <code className={`min-w-0 max-w-full font-mono break-all ${full ? 'text-[0.76rem] sm:text-[0.85rem]' : 'text-[0.85rem]'}`} title={hex}>
        {full ? hex : shortHex(hex)}
      </code>
      <button type="button" className="font-mono text-[0.7rem] uppercase tracking-wider text-stone hover:text-ink" onClick={copy}>
        {copied ? 'Copied' : kind === 'address' ? 'Copy address' : 'Copy hash'}
      </button>
      {mode === 'production' ? (
        <a
          className="font-mono text-[0.7rem] uppercase tracking-wider text-emerald"
          href={basescanUrl(kind, hex)}
          target="_blank"
          rel="noreferrer"
        >
          {linkLabel ?? (kind === 'address' ? 'View on Basescan' : 'View transaction')}
        </a>
      ) : null}
    </span>
  )
}
