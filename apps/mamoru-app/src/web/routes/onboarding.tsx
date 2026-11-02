import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useApi } from '../api/client.ts'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { queryKeys, useRegistrationChallenge } from '../api/queries.ts'
import { errorText, useOwnerAction } from '../lib/owner-flow.ts'
import { createOwnerPasskey } from '../lib/passkey.ts'
import { rememberCredential } from '../lib/passkey-sign.ts'
import { activateLine, signatureCopy } from '../lib/signature.ts'
import { challengeUsable, signInCopy } from '../lib/signin.ts'

// A text link on the card: the card is darker than the page, so stone on wash would not read.
export const CARD_LINK = 'text-[0.88rem] text-[color-mix(in_srgb,var(--color-ink)_68%,transparent)] underline decoration-[color-mix(in_srgb,var(--color-ink)_35%,transparent)] underline-offset-4 hover:text-ink'

/** The dimmed backdrop and the card every first-screen step sits in. */
export function CardFrame({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-30 grid place-items-center overflow-y-auto bg-[color-mix(in_srgb,var(--color-ink)_42%,transparent)] p-4" role="dialog" aria-modal="true" aria-label={label}>
      <div className="w-[min(48rem,100%)] min-[761px]:w-[min(60vw,48rem)]">
        <section className="ob-card rise" aria-live="polite" data-testid={testId}>
          {children}
        </section>
      </div>
    </div>
  )
}

export type CreatePhase = 'idle' | 'creating' | 'authorizing' | 'retry'

/** The key in its circle, as drawn in the v4 design. */
function KeyMark() {
  return (
    <span className="mb-5 grid size-[3.4rem] place-items-center rounded-full bg-[color-mix(in_srgb,var(--color-emerald)_16%,transparent)] text-emerald" aria-hidden="true">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7.5" cy="12" r="3.5" />
        <path d="M11 12h10M17 12v3M20 12v2" />
      </svg>
    </span>
  )
}

/**
 * otto/mamoru#294 (Brais, v4): the only account-creation screen. One button runs both ceremonies, the passkey and then
 * the authorization, with the progress said in place. The signed lines stay behind "What you sign" (#41).
 */
export function CreateAccount({ phase, error, summary, onStart, onSignIn, kit = null }: { phase: CreatePhase; error: string | null; summary: string[] | null; onStart: () => void; onSignIn: () => void; kit?: { saved: boolean; pending: boolean; onSave: () => void } | null }) {
  const copy = signatureCopy.create
  const busy = phase === 'creating' || phase === 'authorizing'
  const label = phase === 'creating' ? copy.creating : phase === 'authorizing' ? copy.authorizing : phase === 'retry' ? copy.retry : copy.action
  return (
    <div className="enter">
      <p className="ob-step uppercase">{copy.eyebrow}</p>
      <KeyMark />
      <h1 className="ob-title">{copy.title}</h1>
      <p className="ob-body">{copy.body}</p>
      <ul className="mt-4 mb-0 grid list-none gap-[0.55rem] p-0">
        {copy.points.map((t) => (
          <li key={t} className="grid grid-cols-[1.6rem_1fr] leading-snug">
            <span className="text-emerald" aria-hidden="true">
              ✓
            </span>
            <span>{t}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 mb-0 text-[0.95rem] leading-snug text-[color-mix(in_srgb,var(--color-ink)_60%,transparent)]">{copy.note}</p>
      <details className="mt-3" data-testid="sign-details">
        <summary className={`${CARD_LINK} cursor-pointer`}>{copy.details}</summary>
        <div className="mt-2 grid gap-2 text-[0.88rem] leading-[1.45] [overflow-wrap:anywhere]">
          <p className="m-0">{copy.signs}</p>
          <p className="m-0">
            {summary ? activateLine(summary) : `${signatureCopy.activate.body} ${signatureCopy.activate.setup}`} <strong>{signatureCopy.activate.never}</strong>
          </p>
          {summary ? (
            <ul className="m-0 grid list-disc gap-1 pl-5">
              {summary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
      <div role="status" aria-live="polite">
        {phase === 'retry' || phase === 'authorizing' ? <p className="mt-3 mb-0 text-[0.95rem] text-emerald">✓ {copy.created}</p> : null}
        {error ? <p className="err mt-3">{error}</p> : null}
      </div>
      {kit ? (
        <button type="button" className={`${CARD_LINK} mt-3 block`} onClick={kit.onSave} disabled={kit.pending}>
          {kit.saved ? 'Recovery kit saved' : 'Save recovery kit'}
        </button>
      ) : null}
      <div className="mt-[1.6rem] flex items-center justify-between gap-4">
        {phase === 'idle' ? (
          <button type="button" className={`${CARD_LINK} min-w-0 flex-1 text-left`} onClick={onSignIn}>
            {signInCopy.link}
          </button>
        ) : null}
        <button type="button" className="ob-btn solid ml-auto shrink-0" onClick={onStart} disabled={busy} data-phase={phase}>
          {label}
        </button>
      </div>
    </div>
  )
}

/** The first screen: the passkey that creates the account, then the approval that lets Mamoru work, from one button. */
export function Onboarding({ onSignIn }: { onSignIn: () => void }) {
  const api = useApi()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [go, setGo] = useState(false)
  const owner = useMutation({
    mutationFn: async () => {
      // Fetched ahead while the screen is up; a stale one is replaced first. One challenge is one attempt.
      const challenge = challengeUsable(ready.data) ? ready.data : await api.registrationChallenge()
      try {
        const made = await createOwnerPasskey(challenge)
        const created = await api.createOwner(made)
        rememberCredential(created.accountKey, made.passkey.credentialId)
        return created
      } catch (e) {
        void ready.refetch()
        throw e
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.session }),
    onError: () => setGo(false),
  })
  const ready = useRegistrationChallenge(!owner.data)
  const created = owner.data
  const act = useOwnerAction(created?.accountKey, 'activate')
  const { prepare, approve, prepared, busy, error, result } = act
  // Once the account exists, the authorization follows on its own: prepare it, then the passkey signs it. A failed or
  // closed step stops here with its error; the retry button resumes from this step and never makes another passkey.
  const inflight = useRef(false)
  const step = () => {
    inflight.current = true
    const next = prepared ? approve().then((op) => (op ? navigate({ to: '/add' }) : undefined)) : prepare()
    void Promise.resolve(next).finally(() => {
      inflight.current = false
    })
  }
  useEffect(() => {
    if (!created || !go || busy !== null || result || inflight.current) return
    if (error) {
      setGo(false)
      return
    }
    step()
  }, [created, go, busy, result, error, prepared])

  const phase: CreatePhase = !created ? (owner.isPending ? 'creating' : 'idle') : go || busy !== null ? 'authorizing' : 'retry'
  const start = () => {
    if (!created) {
      setGo(true)
      owner.mutate()
      return
    }
    setGo(true)
    // The retry tap is the user gesture: an unexpired preparation is signed right here, not from an effect after
    // another request. Only a missing or expired one is prepared again first.
    if (prepared && Date.parse(prepared.tx.expiresAt) > Date.now()) step()
    else act.reset()
  }
  const kit = useMutation({
    mutationFn: async (o: NonNullable<typeof created>) => {
      downloadJson(kitFilename(o.address), await api.recoveryKit(o.accountKey))
      await api.ackRecovery(o.accountKey).catch(() => undefined)
    },
  })
  const shownError = created ? error : owner.error ? errorText(owner.error) : null

  return (
    <CardFrame label="Create your Mamoru account" testId="onboarding">
      <CreateAccount phase={phase} error={shownError} summary={prepared?.tx.summary ?? null} onStart={start} onSignIn={onSignIn} kit={created ? { saved: kit.isSuccess, pending: kit.isPending, onSave: () => kit.mutate(created) } : null} />
    </CardFrame>
  )
}
