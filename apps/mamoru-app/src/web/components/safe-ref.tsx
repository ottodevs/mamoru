import { useEffect, useState } from 'react'
import { knownChain, safeLink, sleeveChain } from '../lib/chain.tsx'
import { shortHex } from '../lib/format.ts'
import { chainLabel } from '../lib/positions.ts'

// otto/mamoru#263, #264, #265: one way to name a chain and the owner's Safe on it, wherever Home shows money on more than
// one chain. The address is shortened, copied whole, and linked on its own chain's explorer (never the operator's URL).

export const safeRefCopy = {
  safe: 'Safe',
  copy: 'Copy',
  copied: 'Copied',
  copyFailed: 'Could not copy',
  copyLabel: (chain: string) => `Copy your ${chain} Safe address`,
  view: (explorer: string) => `View on ${explorer}`,
}

/** Brand colour of each chain's dot; grey for one this app does not know. */
const DOT: Record<number, string> = { 8453: '#0052FF', 143: '#836EF9' }

/** "● BASE": the chain a row or a group of rows lives on. */
export function ChainBadge({ chainId }: { chainId: number }) {
  return (
    <span className="inline-flex items-center gap-[0.35rem] border border-wash px-[0.45rem] py-[0.1rem] font-mono text-[0.66rem] uppercase leading-[1.4] tracking-[0.1em] text-ink" data-testid="chain-badge">
      <span aria-hidden="true" className="inline-block h-[0.45rem] w-[0.45rem] rounded-full" style={{ background: DOT[chainId] ?? 'var(--color-stone)' }} />
      {chainLabel(chainId)}
    </span>
  )
}

/** Copies the whole address and says so (or that it could not), next to the control. */
function CopyAddress({ text, chain }: { text: string; chain: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle')
  useEffect(() => {
    if (state === 'idle') return
    const t = setTimeout(() => setState('idle'), 1600)
    return () => clearTimeout(t)
  }, [state])
  const copy = () => {
    const write = typeof navigator !== 'undefined' ? navigator.clipboard?.writeText(text) : undefined
    if (!write) return setState('failed')
    write.then(
      () => setState('done'),
      () => setState('failed'),
    )
  }
  return (
    <button type="button" className="chipbtn" onClick={copy} aria-label={safeRefCopy.copyLabel(chain)} aria-live="polite">
      {state === 'done' ? safeRefCopy.copied : state === 'failed' ? safeRefCopy.copyFailed : safeRefCopy.copy}
    </button>
  )
}

/** "Safe 0xD72A…F108  [Copy]  Monadscan ↗": the owner's Safe on a chain. No link for an unknown chain or a malformed address. */
export function SafeRef({ chainId, safe }: { chainId: number; safe: string }) {
  const link = safeLink(chainId, safe)
  const chain = chainLabel(chainId)
  const explorer = knownChain(chainId) ? sleeveChain(chainId).explorer.name : null
  return (
    <span className="inline-flex flex-wrap items-center gap-x-[0.6rem] gap-y-1 font-mono text-[0.72rem] tracking-[0.04em] text-stone" data-testid="safe-ref">
      <span>
        {safeRefCopy.safe}{' '}
        <span className="text-ink" title={safe}>
          {shortHex(safe)}
        </span>
      </span>
      <CopyAddress text={safe} chain={chain} />
      {link && explorer ? (
        <a className="mm-link" href={link} target="_blank" rel="noreferrer" title={safeRefCopy.view(explorer)}>
          {explorer}
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <path d="M9 2h5v5M14 2 7 9M12 10v4H2V4h4" />
          </svg>
        </a>
      ) : null}
    </span>
  )
}
