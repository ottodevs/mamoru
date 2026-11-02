import type { FundingView, OpView, OwnerTxToSign, WhatsNew } from '@mamoru/domain'
import { useEffect, useRef, useState } from 'react'
import { useMigrateOps } from '../api/queries.ts'
import { createPortal } from 'react-dom'
import { TERMINAL } from '../lib/ops.ts'
import { signatureCopy } from '../lib/signature.ts'
import { useOwnerAction } from '../lib/owner-flow.ts'
import { CARD_LINK, CardFrame } from '../routes/onboarding.tsx'

const copy = signatureCopy.whatsNew

const dismissKey = (accountKey: string) => `mamoru:whatsnew-later:${accountKey}`

/** "Not now" holds for this tab's session only. Storage can be blocked: then it holds for this page load. */
const laterThisLoad = new Set<string>()

export function whatsNewDismissed(accountKey: string): boolean {
  if (laterThisLoad.has(accountKey)) return true
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(dismissKey(accountKey)) !== null
  } catch {
    return false
  }
}

export function setWhatsNewDismissed(accountKey: string, dismissed: boolean): void {
  if (dismissed) laterThisLoad.add(accountKey)
  else laterThisLoad.delete(accountKey)
  try {
    if (typeof sessionStorage === 'undefined') return
    if (dismissed) sessionStorage.setItem(dismissKey(accountKey), '1')
    else sessionStorage.removeItem(dismissKey(accountKey))
  } catch {
    // No storage: the in-memory set alone holds it for this page load.
  }
}

/**
 * otto/mamoru#295 (security review): What's new never overrides a safety state. A paused account is offered nothing
 * (the operator refuses the migration there too); an ended approval or a spent grant keeps its own notice. After "Not now"
 * a renewal that is due is offered again, so declining never strands an account on an approval that ends.
 */
export function whatsNewOffered(approval: FundingView['approval'], dismissed: boolean): WhatsNew | null {
  const w = approval?.whatsNew
  if (!w || !approval) return null
  if (approval.paused || approval.expired || approval.usage?.spent) return null
  if (dismissed && approval.renewDue) return null
  return w
}

/** The step the card is on: the operator's `currentStep`, kept inside the steps it announced. */
export function currentStepOf(w: WhatsNew): number {
  return Math.min(Math.max(w.currentStep ?? 0, 0), w.signatures - 1)
}

/** Where a signed step stands, from its op's state alone: `failed` is a retry of the same step at once. */
export function stepProgress(state: string | undefined): 'wait' | 'failed' | 'confirmed' {
  return state === 'failed' ? 'failed' : state === 'confirmed' ? 'confirmed' : 'wait'
}

const CHAIN_ID = { base: 8453, monad: 143 } as const

/**
 * The client's own gate (security review, P1-1/P1-2), read from the ops list the way `renewing` is for renewals: nothing is
 * prepared before the ops are read; a migrate-v4 op still running holds the card (no second signature on top of it);
 * and step 1 or later needs the previous step's op confirmed, whatever `currentStep` says.
 */
export function cardGate(step: number, ops: OpView[] | undefined, failedToLoad = false): { gate: 'loading' | 'error' | 'inflight' | 'done' | 'previous' | 'ready'; inFlight: OpView | null } {
  if (!ops) return { gate: failedToLoad ? 'error' : 'loading', inFlight: null }
  const mine = ops.filter((o) => o.kind === 'migrate-v4')
  const inFlight = [...mine].reverse().find((o) => !TERMINAL.has(o.state)) ?? null
  if (inFlight) return { gate: 'inflight', inFlight }
  // N1: a step whose op is confirmed is never offered again, whatever a stale funding read still says. An unlabelled op satisfies nothing.
  if (mine.some((o) => o.state === 'confirmed' && o.migrateStep !== undefined && o.migrateStep >= step)) return { gate: 'done', inFlight: null }
  if (step >= 1 && !mine.some((o) => o.state === 'confirmed' && o.migrateStep === step - 1)) return { gate: 'previous', inFlight: null }
  return { gate: 'ready', inFlight: null }
}

/** Why the button is off while no signature is in progress: said, never a silent spinner (N2). */
export function gateNotice(gate: ReturnType<typeof cardGate>['gate'], retry: () => void): { text: string; retry?: () => void } | undefined {
  if (gate === 'error') return { text: copy.statusFailed, retry }
  if (gate === 'previous') return { text: copy.previous }
  return undefined
}

/**
 * P1-3: what is shown is what is signed. The prepare response must be for this step, on this step's chain, and move funds to
 * the very address the operator announced (or to none, when none was announced). Anything else is refused before the passkey.
 */
export function preparedProblem(prepared: { step: number; tx: OwnerTxToSign } | null, whatsNew: WhatsNew, step: number): string | null {
  if (!prepared) return null
  const announced = whatsNew.steps[step]
  if (prepared.step !== step || !announced) return copy.mismatch
  if (prepared.tx.chainId !== CHAIN_ID[announced.chain]) return copy.mismatch
  if ((prepared.tx.moveTo ?? null)?.toLowerCase() !== (announced.moveTo ?? null)?.toLowerCase()) return copy.mismatch
  return null
}

/** The quiet row Home keeps after "Not now": the way back in. */
export function WhatsNewRow({ onOpen }: { onOpen: () => void }) {
  return (
    <section className="card flex flex-wrap items-center justify-between gap-3" data-testid="whats-new-row" role="status">
      <span className="title">{copy.rowTitle}</span>
      <button type="button" className="act quiet" onClick={onOpen}>
        {copy.rowAction}
      </button>
    </section>
  )
}

/** The card itself, with the state it needs to be reviewed in one place: the points, the button, the lines. */
export function WhatsNewBody({
  whatsNew,
  step,
  summary,
  busy,
  waiting = false,
  blocked = false,
  off = false,
  notice,
  shown,
  error,
  onApprove,
  onLater,
  onLearn,
}: {
  whatsNew: WhatsNew
  step: number
  /** The lines this step signs: the prepared ones when there are, else what the operator announced. */
  summary: string[]
  busy: null | 'preparing' | 'signing'
  /** The step was signed and is not confirmed yet. */
  waiting?: boolean
  /** The gate is not open: no signature yet. */
  off?: boolean
  /** Why the button is off when it is not a signature in progress, with an optional retry. */
  notice?: { text: string; retry?: () => void }
  /** The prepared transaction does not match what was announced: no signature. */
  blocked?: boolean
  /** Chain and destination of the prepared transaction, when there is one; else what was announced. */
  shown?: { chain: 'base' | 'monad'; moveTo?: string }
  error: string | null
  onApprove: () => void
  onLater: () => void
  onLearn: () => void
}) {
  const two = whatsNew.signatures === 2
  const chain = shown?.chain ?? whatsNew.steps[step]?.chain ?? 'base'
  const moveTo = shown ? shown.moveTo : whatsNew.steps[step]?.moveTo
  return (
    <div className="enter min-w-0 [overflow-wrap:anywhere]">
      <p className="ob-step uppercase">{copy.eyebrow}</p>
      <h1 className="ob-title">{copy.title}</h1>
      <ol className="mt-[1.1rem] mb-0 grid list-none gap-[0.85rem] p-0" data-testid="whats-new-points">
        {whatsNew.points.slice(0, 4).map((p, i) => (
          <li key={p} className="grid grid-cols-[2.2rem_1fr]">
            <span className="font-mono text-[0.8rem] leading-[1.9] text-emerald">{String(i + 1).padStart(2, '0')}</span>
            <span className="text-[1.12rem] leading-snug">{p}</span>
          </li>
        ))}
      </ol>
      {two ? (
        <p className="mt-4 mb-0 font-semibold" data-testid="whats-new-two">
          {copy.twoTaps}
        </p>
      ) : null}
      <p className="mt-4 mb-0 text-[0.95rem] leading-normal text-[color-mix(in_srgb,var(--color-ink)_60%,transparent)]">
        {copy.keep}{' '}
        <button type="button" className={`${CARD_LINK} p-0`} onClick={onLearn}>
          {copy.learn}
        </button>
      </p>
      <details className="mt-4" data-testid="sign-details" key={step}>
        <summary className={`${CARD_LINK} cursor-pointer`}>{copy.details}</summary>
        <ul className="mt-2 mb-0 grid gap-1 pl-5 text-[0.88rem] leading-[1.45]" data-testid="sign-lines">
          {summary.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </details>
      {/* What this signature does, in the client's own fixed words, right above the button (#41): never only in the list. */}
      <div className="mt-4 grid gap-1 text-[0.95rem] leading-snug" data-testid="whats-new-scope">
        <p className="m-0">{copy.scope}</p>
        {moveTo ? (
          <>
            <p className="m-0">{copy.moves(chain)}</p>
            <p className="m-0 font-mono text-[0.82rem] break-all" data-testid="whats-new-move-to">
              {moveTo}
            </p>
          </>
        ) : null}
      </div>
      {notice ? (
        <p className="mt-3 mb-0 text-[0.95rem] leading-snug" role="status" data-testid="whats-new-notice">
          {notice.text}{' '}
          {notice.retry ? (
            <button type="button" className={`${CARD_LINK} p-0`} onClick={notice.retry}>
              {copy.retry}
            </button>
          ) : null}
        </p>
      ) : null}
      <div role="status" aria-live="polite">
        {error ? (
          <p className="err mt-3" data-testid="whats-new-error">
            {error}
          </p>
        ) : null}
      </div>
      {two ? (
        <p className="mt-4 mb-0 font-mono text-[0.8rem] tracking-[0.06em] uppercase text-emerald" data-testid="whats-new-step">
          {copy.step(step + 1, 2, chain)}
        </p>
      ) : null}
      <div className="mt-[1.6rem] flex flex-wrap items-center justify-between gap-3">
        <button type="button" className={CARD_LINK} onClick={onLater} disabled={busy === 'signing'}>
          {copy.later}
        </button>
        <button type="button" className="ob-btn solid shrink-0" onClick={onApprove} disabled={busy !== null || waiting || blocked || off}>
          {busy === 'signing' ? 'Waiting for passkey' : busy === 'preparing' ? 'Preparing' : waiting ? copy.confirming : copy.action}
        </button>
      </div>
    </div>
  )
}

/**
 * otto/mamoru#295 part 2: the one-time move to the one-authorization contracts. One passkey tap, or two for an account
 * with an older Monad Safe (Base, then Monad). The step is the operator's `currentStep` and the ops list gates it: nothing
 * is prepared while a migrate-v4 op runs (a reload cannot sign a step twice) and step 1 waits for step 0 to be confirmed.
 * What is shown (chain, destination) is the prepare response's, checked against the announcement before the passkey.
 */
export function WhatsNewFlow({ accountKey, whatsNew, onLater, onLearn }: { accountKey: string; whatsNew: WhatsNew; onLater: () => void; onLearn: () => void }) {
  const step = currentStepOf(whatsNew)
  const act = useOwnerAction(accountKey, 'migrate-v4', step)
  const { prepare, prepared, busy, error, result, reset, approve } = act
  const ops = useMigrateOps(accountKey, true)
  const list = ops.data?.ops
  const { gate, inFlight } = cardGate(step, list, ops.isError)
  const [signedId, setSignedId] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  // A new current step: a fresh prepare for it (gated below), nothing carried over.
  const seen = useRef(step)
  useEffect(() => {
    if (seen.current === step) return
    seen.current = step
    setSignedId(null)
    setFailed(null)
    reset()
  }, [step, reset])

  // An op already running (a reload, another tab) is the one this card waits for.
  useEffect(() => {
    if (inFlight && !signedId) setSignedId(inFlight.opId)
  }, [inFlight, signedId])

  const tracked = signedId ? list?.find((o) => o.opId === signedId) : undefined
  const progress = stepProgress(tracked?.state)
  useEffect(() => {
    if (!signedId || progress !== 'failed') return
    setSignedId(null)
    setFailed(step >= 1 ? copy.laterFailed(whatsNew.steps[step]?.chain ?? 'monad') : copy.notConfirmed)
    reset()
  }, [signedId, progress, step, whatsNew.steps, reset])

  const waiting = !!signedId && progress !== 'failed'
  // Prepared as soon as the step is on screen and the ops say it may be signed, so the tap goes straight to the passkey.
  useEffect(() => {
    if (gate === 'ready' && !prepared && busy === null && !error && !result && !failed && !signedId) void prepare()
  }, [gate, prepared, busy, error, result, failed, signedId, prepare])

  // N2: Escape closes, unless the passkey prompt is open. "Not now" never depends on the gate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && busy !== 'signing') onLater()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onLater])

  const live = prepared && prepared.step === step ? prepared : null
  const problem = preparedProblem(prepared, whatsNew, step)

  const tap = async () => {
    if (gate !== 'ready' || waiting) return
    setFailed(null)
    if (!live) {
      await prepare()
      return
    }
    if (problem) return
    const signed = await approve()
    if (!signed) return
    if (stepProgress(signed.state) === 'failed') {
      setFailed(step >= 1 ? copy.laterFailed(whatsNew.steps[step]?.chain ?? 'monad') : copy.notConfirmed)
      reset()
      return
    }
    setSignedId(signed.opId)
  }

  const summary = live?.tx.summary ?? whatsNew.steps[step]?.summary ?? []
  const shown = live ? { chain: live.tx.chainId === CHAIN_ID.monad ? ('monad' as const) : ('base' as const), moveTo: live.tx.moveTo } : undefined
  return <WhatsNewBody whatsNew={whatsNew} step={step} summary={summary} busy={busy} waiting={waiting || gate === 'inflight' || gate === 'done'} notice={gateNotice(gate, () => void ops.refetch())} blocked={!!problem} off={gate !== 'ready'} shown={shown} error={problem ?? error ?? failed} onApprove={() => void tap()} onLater={onLater} onLearn={onLearn} />
}

/** The card on the page: on the body, not inside Home, whose entrance animation makes it the containing block of a fixed backdrop. */
export function WhatsNewCard(props: { accountKey: string; whatsNew: WhatsNew; onLater: () => void; onLearn: () => void }) {
  return createPortal(
    <CardFrame label={copy.title} testId="whats-new">
      <WhatsNewFlow {...props} />
    </CardFrame>,
    document.body,
  )
}
