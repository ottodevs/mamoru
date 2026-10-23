import type { OwnerResponse } from '@mamoru/domain'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { type ReactNode, useEffect, useState } from 'react'
import { useApi } from '../api/client.ts'
import { queryKeys, useConfig, useRegistrationChallenge } from '../api/queries.ts'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { capNote } from '../lib/money.ts'
import { errorText, useOwnerAction } from '../lib/owner-flow.ts'
import { createOwnerPasskey } from '../lib/passkey.ts'
import { rememberCredential } from '../lib/passkey-sign.ts'
import { activateLine, signatureCopy } from '../lib/signature.ts'
import { challengeUsable, signInCopy } from '../lib/signin.ts'

export const onboardingCopy = {
  brand: 'Mamoru',
  title: 'Savings, automated.',
  points: [
    { title: 'Add USDC on Base.', body: '' },
    { title: 'All your USDC has a job.', body: 'Mamoru opens positions for you. Profits become USDC.' },
    { title: 'You keep control. No lockups.', body: 'Withdraw anytime. Only you can take it out.' },
  ],
}

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

/** otto/mamoru#19: which of the two onboarding signatures this is, in words and as a two-part bar. */
function SignStep({ n }: { n: 1 | 2 }) {
  return (
    <>
      <p className="ob-step uppercase">{n === 1 ? signatureCopy.create.step : signatureCopy.activate.step}</p>
      <div className="mb-5 flex gap-2" aria-hidden="true">
        <span className="h-[3px] flex-1 bg-ink" />
        <span className={`h-[3px] flex-1 ${n === 2 ? 'bg-ink' : 'bg-[color-mix(in_srgb,var(--color-ink)_18%,transparent)]'}`} />
      </div>
    </>
  )
}

/** Signature 1 of 2: what creating the passkey does, said before the prompt opens. */
export function CreateSignature({ creating, error, onApprove }: { creating: boolean; error: string | null; onApprove: () => void }) {
  return (
    <div className="enter">
      <SignStep n={1} />
      <h1 className="ob-title">{signatureCopy.create.title}</h1>
      <p className="ob-body">{signatureCopy.create.body}</p>
      {error ? <p className="err mt-3">{error}</p> : null}
      <div className="mt-[1.6rem] flex flex-wrap items-center justify-between gap-3">
        <span className="text-[0.95rem] text-[color-mix(in_srgb,var(--color-ink)_60%,transparent)]">{signatureCopy.create.next}</span>
        <button type="button" className="ob-btn solid ml-auto" onClick={onApprove} disabled={creating}>
          {creating ? 'Waiting for passkey' : 'Approve with passkey'}
        </button>
      </div>
    </div>
  )
}

/** After the passkey is made: the one approval that lets Mamoru put the money to work. */
function Approve({ owner }: { owner: OwnerResponse }) {
  const api = useApi()
  const navigate = useNavigate()
  const act = useOwnerAction(owner.accountKey, 'activate')
  const [kitSaved, setKitSaved] = useState(false)
  const kit = useMutation({
    mutationFn: async (o: OwnerResponse) => {
      downloadJson(kitFilename(o.address), await api.recoveryKit(o.accountKey))
      await api.ackRecovery(o.accountKey).catch(() => undefined)
    },
    onSuccess: () => setKitSaved(true),
  })
  const { prepare, prepared, busy } = act

  // Prepare the activation as soon as the account exists, so the approve tap goes straight to the passkey.
  useEffect(() => {
    if (owner && !prepared && busy === null && !act.error && !act.result) void prepare()
  }, [owner, prepared, busy, act.error, act.result, prepare])

  const approve = async () => {
    const op = prepared ? await act.approve() : null
    if (!prepared) await prepare()
    if (op) void navigate({ to: '/add' })
  }

  const summary = prepared?.tx.summary ?? null

  return (
    <div className="enter">
      <SignStep n={2} />
      <h1 className="ob-title">{signatureCopy.activate.title}</h1>
      <p className="ob-body">{summary ? activateLine(summary) : `${signatureCopy.activate.body} ${signatureCopy.activate.setup}`}</p>
      <p className="ob-body font-semibold">{signatureCopy.activate.never}</p>
      <div className="mt-3 flex flex-wrap items-start gap-x-5 gap-y-2">
        {summary ? (
          <details className="min-w-0 basis-full" data-testid="sign-details">
            <summary className={`${CARD_LINK} cursor-pointer`}>{signatureCopy.activate.details}</summary>
            <ul className="mt-2 mb-0 grid gap-1 pl-5 text-[0.88rem] leading-[1.45] [overflow-wrap:anywhere]">
              {summary.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <button type="button" className={CARD_LINK} onClick={() => kit.mutate(owner)} disabled={kit.isPending}>
          {kitSaved ? 'Recovery kit saved' : 'Save recovery kit'}
        </button>
      </div>
      {act.error ? <p className="err mt-3">{act.error}</p> : null}
      <div className="mt-[1.6rem] flex flex-wrap items-center justify-between gap-3">
        <span className="text-[0.95rem] text-[color-mix(in_srgb,var(--color-ink)_60%,transparent)]">{signatureCopy.activate.next}</span>
        <button type="button" className="ob-btn solid ml-auto" onClick={approve} disabled={busy !== null}>
          {busy === 'signing' ? 'Waiting for passkey' : busy === 'preparing' ? 'Preparing' : 'Approve with passkey'}
        </button>
      </div>
    </div>
  )
}

/** The first screen: what Mamoru does in three points, then the passkey that creates the account. */
export function Onboarding({ onSignIn }: { onSignIn: () => void }) {
  const api = useApi()
  const qc = useQueryClient()
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
  })
  const ready = useRegistrationChallenge(!owner.data)
  // The cap is said before any money moves, when the API runs live.
  const capUsdc = useConfig().data?.capUsdc
  const points = onboardingCopy.points.map((p, i) => (i === 0 && capUsdc ? { ...p, body: capNote(capUsdc) } : p))
  const creating = owner.isPending
  // otto/mamoru#19: «Create account» first says what the passkey is about to sign; the prompt opens from that card.
  const [signing, setSigning] = useState(false)

  return (
    <CardFrame label="Welcome to Mamoru" testId={owner.data ? 'onboarding-approve' : signing ? 'onboarding-create' : 'onboarding'}>
      {owner.data ? (
        <Approve owner={owner.data} />
      ) : signing ? (
        <CreateSignature creating={creating} error={owner.error ? errorText(owner.error) : null} onApprove={() => owner.mutate()} />
      ) : (
        <div className="enter">
          <p className="ob-step uppercase">{onboardingCopy.brand}</p>
          <h1 className="ob-title">{onboardingCopy.title}</h1>
          <ol className="mt-[1.4rem] mb-0 grid list-none gap-[1.1rem] p-0">
            {points.map((p, i) => (
              <li key={p.title} className="grid grid-cols-[2.2rem_1fr]">
                <span className="font-mono text-[0.8rem] leading-[1.9] text-emerald">{String(i + 1).padStart(2, '0')}</span>
                <span>
                  <b className="block text-[1.12rem] leading-snug font-semibold">{p.title}</b>
                  {p.body ? <span className="mt-[0.2rem] block leading-normal text-[color-mix(in_srgb,var(--color-ink)_72%,transparent)]">{p.body}</span> : null}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-[1.6rem] flex flex-wrap items-center justify-between gap-3">
            <button type="button" className={CARD_LINK} onClick={onSignIn}>
              {signInCopy.link}
            </button>
            <button type="button" className="ob-btn solid ml-auto" onClick={() => setSigning(true)}>
              Create account
            </button>
          </div>
        </div>
      )}
    </CardFrame>
  )
}
