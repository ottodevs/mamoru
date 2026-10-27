import { useState, type ReactNode } from 'react'
import type { PolicyVersion } from '@mamoru/policy'
import { sleeveChain } from '../lib/chain.tsx'
import { KNOWN_POLICIES as KNOWN, isMultichainTarget } from '../lib/policies.ts'
import { pairLabel } from '../lib/positions.ts'
import { ApprovalBody, ApprovalDialog } from './approval-dialog.tsx'

export { isMultichainTarget }

/**
 * The mix before and after, from the two policies themselves (never a number typed here): every pool of either, its
 * chain, its share of the whole account. A pool the target drops shows as closed; one it adds shows from a dash.
 */
export function splitRows(fromId: string, toId: string): SplitRow[] {
  const from = KNOWN[fromId]
  const to = KNOWN[toId]
  if (!from || !to) return []
  type Share = { pool: string; chainId: number; bps: number }
  const shares = (p: PolicyVersion): Share[] => {
    const total = p.buckets.reduce((s, b) => s + b.preference, 0) + (p.remoteBuckets ?? []).reduce((s, b) => s + b.preference, 0)
    // A bucket at preference 0 is one being left (v6's USDC/cbBTC): not part of that mix.
    const local = p.buckets.filter((b) => b.pools[0] && b.preference > 0).map((b) => ({ pool: b.pools[0]!, chainId: 8453, bps: Math.round((b.preference * 10_000) / total) }))
    const remote = (p.remoteBuckets ?? []).map((b) => ({ pool: b.pools[0]!, chainId: b.chainId as number, bps: Math.round((b.preference * 10_000) / total) }))
    return [...local, ...remote]
  }
  const before = shares(from)
  const after = shares(to)
  const keys = [...new Set([...before, ...after].map((x) => `${x.chainId}|${x.pool}`))]
  return keys
    .map((k) => {
      const [chainId, pool] = [Number(k.split('|')[0]), k.split('|')[1]!]
      const was = before.find((x) => x.chainId === chainId && x.pool === pool)
      const will = after.find((x) => x.chainId === chainId && x.pool === pool)
      return { pool: pairLabel(pool), chain: sleeveChain(chainId).name, fromBps: was ? was.bps : null, toBps: will ? will.bps : 0 }
    })
    .sort((a, b) => b.toBps - a.toBps || (b.fromBps ?? 0) - (a.fromBps ?? 0))
}

/**
 * otto/mamoru#201, #216: an account that runs on Base is asked, once, to let Mamoru also work on Monad. The dialog
 * explains first (what changes in the mix, what does not), then asks for the two passkey signatures in order: open the
 * Safe on Monad, then renew the approval on Base with the new mix. Nothing moves before both are signed.
 */
export const monadCopy = {
  title: 'Mamoru now works on Monad too',
  lead: (pool: string, chain: string, pct: string) => `Your savings get a third home: a ${pool} pool on ${chain}. If you approve, Mamoru moves ${pct} there and rebalances the rest to the new mix below; a pool marked closed is unwound into the others.`,
  split: 'Your mix',
  now: 'Now',
  after: 'After',
  leaving: 'closed',
  points: [
    { title: 'Same Safe, same passkey', body: 'Your Safe has the same address on Monad. Only you can withdraw, on either chain.' },
    { title: 'Step by step, inside limits', body: 'Mamoru closes and opens positions gradually, within the limits you sign. Nothing moves until you approve.' },
    { title: 'Two signatures', body: 'One opens your Safe on Monad. The other renews Mamoru\'s approval on Base with the new mix.' },
  ],
  continue: 'Continue',
  later: 'Not now',
  step: (n: number) => `Step ${n} of 2`,
  monadTitle: 'Open your Safe on Monad',
  monadLead: 'Same address, same passkey. Mamoru may then manage the Growth pool there, within these limits.',
  baseTitle: 'Renew the approval on Base',
  baseLead: (mix: string, chain: string) => `The new mix: ${mix}. Mamoru may move the share on ${chain} to your own Safe there, and nowhere else.`,
  pending: 'Opening your Safe on Monad. Step 2 opens by itself once it is open on chain.',
  opening: 'Opening your Safe on Monad',
}

/** One row of the before/after mix: a pool on a chain and its share of the account, in basis points. */
export type SplitRow = { pool: string; chain: string; fromBps: number | null; toBps: number }

const pct = (bps: number) => `${Math.round(bps / 100)}%`

export function SplitTable({ rows }: { rows: SplitRow[] }) {
  return (
    <table className="split" data-testid="monad-split">
      <caption className="split-caption">{monadCopy.split}</caption>
      <thead>
        <tr>
          <th scope="col">
            <span className="sr-only">Pool</span>
          </th>
          <th scope="col">{monadCopy.now}</th>
          <th scope="col">{monadCopy.after}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const change = r.fromBps !== r.toBps
          return (
            <tr key={`${r.chain}:${r.pool}`} className={change ? 'split-change' : undefined}>
              <th scope="row">
                <span className="split-pool">{r.pool}</span>
                <span className="split-chain">{r.chain}</span>
              </th>
              <td>{r.fromBps === null ? '—' : pct(r.fromBps)}</td>
              <td>{r.toBps === 0 ? <span className="split-leaving">{monadCopy.leaving}</span> : pct(r.toBps)}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function Points() {
  return (
    <ul className="approve-points" aria-label="In short">
      {monadCopy.points.map((p, i) => (
        <li key={p.title}>
          <span className="approve-icon" aria-hidden="true">
            {i + 1}
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

/** The pool opening on another chain and its share, read from the rows (never typed). */
export function remoteOf(rows: SplitRow[]): SplitRow | undefined {
  return rows.find((r) => r.fromBps === null && r.toBps > 0 && r.chain !== 'Base')
}

/** "50% USDC / USDT on Base, 35% USDC / WETH on Base, 15% USDC / WMON on Monad", from the rows. */
export function mixLine(rows: SplitRow[]): string {
  return rows.filter((r) => r.toBps > 0).map((r) => `${pct(r.toBps)} ${r.pool} on ${r.chain}`).join(', ')
}

/** The first screen: what changes, before anything is prepared or signed. */
export function MonadIntro({ rows, onContinue, onLater }: { rows: SplitRow[]; onContinue: () => void; onLater: () => void }) {
  const remote = remoteOf(rows)
  return (
    <div className="approve" data-testid="monad-intro">
      <p className="approve-lead">{remote ? monadCopy.lead(remote.pool, remote.chain, pct(remote.toBps)) : mixLine(rows)}</p>
      <SplitTable rows={rows} />
      <Points />
      <div className="approve-actions">
        <button type="button" className="approve-later" onClick={onLater}>
          {monadCopy.later}
        </button>
        <button type="button" className="cta" onClick={onContinue}>
          {monadCopy.continue}
        </button>
      </div>
    </div>
  )
}

/** A signing step: its number, then the usual approval body (brief, signed lines, passkey). */
export function MonadStep({ n, lead, children }: { n: 1 | 2; lead: string; children: (lead: ReactNode) => ReactNode }) {
  return (
    <div className="monad-step" data-testid={`monad-step-${n}`}>
      <p className="monad-step-n">{monadCopy.step(n)}</p>
      {children(lead)}
    </div>
  )
}

export type MonadFlow = {
  busy: string | null
  error: string | null
  summary: string[] | null
  prepare: () => void
  approve: () => void
}

/**
 * The whole dialog. `monad` signs the Monad Safe's activation, `base` the renewal on Base; each is the same owner flow
 * every other approval uses. Step 2 opens only once step 1 is done (`monadDone`), so the renewal that lets Mamoru
 * bridge is never signed before the Safe it bridges to is open.
 */
export function MonadConsentDialog({ open, rows, monad, base, monadDone, monadPending = false, onClose }: { open: boolean; rows: SplitRow[]; monad: MonadFlow; base: MonadFlow; monadDone: boolean; monadPending?: boolean; onClose: () => void }) {
  const [started, setStarted] = useState(false)
  const remote = remoteOf(rows)
  const title = !started ? monadCopy.title : monadDone ? monadCopy.baseTitle : monadCopy.monadTitle
  return (
    <ApprovalDialog title={title} open={open} onClose={onClose}>
      {!started ? (
        <MonadIntro rows={rows} onContinue={() => setStarted(true)} onLater={onClose} />
      ) : !monadDone ? (
        <MonadStep n={1} lead={monadCopy.monadLead}>
          {(lead) => (
            <>
              {monadPending ? (
                <p className="progress mono-label text-stone" role="status" aria-live="polite" data-testid="monad-pending">
                  <span className="progress-dot" aria-hidden="true" />
                  {monadCopy.pending}
                </p>
              ) : null}
              <ApprovalBody lead={lead} summary={monad.summary} busy={monadPending ? 'pending' : monad.busy} error={monad.error} onPrepare={monad.prepare} onApprove={monad.approve} onLater={onClose} />
            </>
          )}
        </MonadStep>
      ) : (
        <MonadStep n={2} lead={monadCopy.baseLead(mixLine(rows), remote?.chain ?? 'the other chain')}>
          {(lead) => <ApprovalBody lead={lead} summary={base.summary} busy={base.busy} error={base.error} onPrepare={base.prepare} onApprove={base.approve} onLater={onClose} />}
        </MonadStep>
      )}
    </ApprovalDialog>
  )
}
