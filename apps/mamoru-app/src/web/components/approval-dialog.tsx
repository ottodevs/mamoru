import { Fragment, type ReactNode } from 'react'
import { Modal } from './ui.tsx'

/**
 * otto/mamoru#176: one dialog for every approval of a running account (a renewal, a limit that ran out, the grants an
 * activation left out). The passkey signs the operator's own lines (`summary`), word for word (#41); this dialog only
 * lays them out: a short brief first, then every line, in order, behind a disclosure.
 */
export const approvalCopy = {
  points: [
    { title: 'Nothing moves now', body: 'Your money stays in your Safe, where it is.' },
    { title: 'Only inside fixed limits', body: 'Every limit is listed below. Mamoru cannot go past them.' },
    { title: 'Paid only to your Safe', body: 'Whatever Mamoru collects or swaps comes back to you. Stop or withdraw any time.' },
  ],
  review: 'Review',
  preparing: 'Preparing',
  approve: 'Approve with passkey',
  signing: 'Waiting for passkey',
  later: 'Not now',
  validFor: 'Valid for',
  sizedFor: 'Sized for deposits up to',
  pools: 'Pools',
  details: 'Everything your passkey signs',
}

/** What the brief can state from the signed lines themselves; anything it cannot find is left out, never guessed. */
export type SignedFacts = { days: number | null; capUsdc: string | null; pools: string[] }

const POOL_LINE = /^In (.+?): (.*)$/

export function signedFacts(lines: string[]): SignedFacts {
  const text = lines.join('\n')
  const days = text.match(/for (\d+) (?:more )?days/)
  const cap = text.match(/deposits up to ([\d,.]+) USDC/)
  const pools = [...new Set(lines.map((l) => l.match(POOL_LINE)?.[1]).filter((p): p is string => !!p))]
  return { days: days ? Number(days[1]) : null, capUsdc: cap ? cap[1]! : null, pools }
}

/**
 * A signed line with its figures set in bold and addresses in mono. The text itself is untouched: what it renders
 * reads exactly as the line the passkey signs.
 */
export function Emph({ text }: { text: string }) {
  // A figure stands alone: the 3 in "Uniswap v3" or the 0.05% inside a pool name are not amounts.
  const parts = text.split(/(0x[0-9a-fA-F]{40}|(?<![\w./])\d[\d,]*(?:\.\d+)?(?![\w%]))/)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 0 ? (
          <Fragment key={i}>{p}</Fragment>
        ) : p.startsWith('0x') ? (
          <code key={i} className="signed-addr">
            {p}
          </code>
        ) : (
          <strong key={i} className="signed-num">
            {p}
          </strong>
        ),
      )}
    </>
  )
}

function PointIcon({ i }: { i: number }) {
  // Drawn in one stroke weight: a resting stone, a fence, a return arrow.
  const paths = ['M3 11.5c0-2.6 2.2-4.5 5-4.5s5 1.9 5 4.5H3Z', 'M3 4v9M8 4v9M13 4v9M3 7h10M3 10.5h10', 'M12.5 6.5H6a3 3 0 0 0 0 6h4M12.5 6.5 10 4M12.5 6.5 10 9']
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[i]} />
    </svg>
  )
}

export function KeyPoints() {
  return (
    <ul className="approve-points" aria-label="In short">
      {approvalCopy.points.map((p, i) => (
        <li key={p.title}>
          <span className="approve-icon">
            <PointIcon i={i} />
          </span>
          <span>
            <span className="approve-point-title">{p.title}</span>
            <span className="approve-point-body">{p.body}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function Facts({ facts }: { facts: SignedFacts }) {
  if (facts.days === null && facts.capUsdc === null && !facts.pools.length) return null
  return (
    <dl className="approve-facts">
      {facts.days !== null ? (
        <div>
          <dt>{approvalCopy.validFor}</dt>
          <dd>
            {facts.days} <span className="approve-unit">days</span>
          </dd>
        </div>
      ) : null}
      {facts.capUsdc !== null ? (
        <div>
          <dt>{approvalCopy.sizedFor}</dt>
          <dd>
            {facts.capUsdc} <span className="approve-unit">USDC</span>
          </dd>
        </div>
      ) : null}
      {facts.pools.length ? (
        <div className="approve-facts-wide">
          <dt>{approvalCopy.pools}</dt>
          <dd className="approve-pools">
            {facts.pools.map((p) => (
              <span key={p} className="chip">
                {p}
              </span>
            ))}
          </dd>
        </div>
      ) : null}
    </dl>
  )
}

/**
 * Every signed line, in its order: per-pool limits as their own block, the rest as a list. Open from the start: the
 * owner sees every line next to the Approve button and may fold it, never has to unfold it to read it (#41).
 */
export function SignedLines({ lines }: { lines: string[] }) {
  return (
    <details className="signed" data-testid="review" open>
      <summary>
        {approvalCopy.details}
        <span className="signed-count">{lines.length} lines</span>
      </summary>
      <ol className="signed-list">
        {lines.map((l, i) => {
          const pool = l.match(POOL_LINE)
          return pool ? (
            <li key={i} className="signed-pool">
              <span className="signed-pool-name">In {pool[1]}:</span> <Emph text={pool[2]!} />
            </li>
          ) : (
            <li key={i}>
              <Emph text={l} />
            </li>
          )
        })}
      </ol>
    </details>
  )
}

/** The dialog's body for one approval: the brief, then (once prepared) the facts and every signed line. */
/** `context`: shown under the lead (the Monad move's mix); `points`: in place of the usual key points. */
export function ApprovalBody({ lead, summary, busy, error, onPrepare, onApprove, onLater, context, points }: { lead: ReactNode; summary: string[] | null; busy: string | null; error: string | null; onPrepare: () => void; onApprove: () => void; onLater: () => void; context?: ReactNode; points?: ReactNode }) {
  return (
    <div className="approve" data-testid="renew-body">
      <p className="approve-lead">{lead}</p>
      {context}
      {summary ? <Facts facts={signedFacts(summary)} /> : null}
      {points ?? <KeyPoints />}
      {summary ? <SignedLines lines={summary} /> : null}
      {error ? (
        <p className="err" role="alert">
          {error}
        </p>
      ) : null}
      <div className="approve-actions">
        <button type="button" className="approve-later" onClick={onLater} disabled={busy === 'signing'}>
          {approvalCopy.later}
        </button>
        {summary ? (
          <button key="approve" type="button" className="cta" onClick={onApprove} disabled={busy !== null}>
            {busy === 'signing' ? approvalCopy.signing : approvalCopy.approve}
          </button>
        ) : (
          <button key="review" type="button" className="cta" onClick={onPrepare} disabled={busy !== null}>
            {busy === 'preparing' ? approvalCopy.preparing : approvalCopy.review}
          </button>
        )}
      </div>
    </div>
  )
}

export function ApprovalDialog({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div data-testid="renew-dialog">{children}</div>
    </Modal>
  )
}
