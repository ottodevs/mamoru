import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useApi } from '../api/client.ts'
import { queryKeys, useSignInChallenge } from '../api/queries.ts'
import { challengeUsable, knownCredentials, signInCopy, signInProblem, signInWithPasskey, WALKAWAY_URL, type SignInProblem } from '../lib/signin.ts'
import { CARD_LINK, CardFrame } from './onboarding.tsx'

/** The returning-owner card, as it paints for a given state. */
export function SignInCard({ busy, problem, remembered, onSignIn, onRemembered, onCreate }: {
  busy: boolean
  problem: SignInProblem | null
  /** This browser knows a credential id: offered after a prompt that found nothing. */
  remembered: boolean
  onSignIn: () => void
  onRemembered: () => void
  onCreate: () => void
}) {
  return (
    <CardFrame label="Sign in to Mamoru" testId="signin">
      <div className="enter">
        <p className="ob-step">{signInCopy.step}</p>
        <h1 className="ob-title">{signInCopy.title}</h1>
        <p className="ob-body">{signInCopy.body}</p>
        {problem ? (
          <p className="err mt-3" role="alert" data-testid={`signin-${problem.kind}`}>
            {problem.message}
          </p>
        ) : null}
        {problem?.kind === 'cancelled' && remembered ? (
          <p className="mt-2 mb-0">
            <button type="button" className={CARD_LINK} onClick={onRemembered} disabled={busy}>
              {signInCopy.remembered}
            </button>
          </p>
        ) : null}
        <div className="mt-[1.6rem] flex flex-wrap items-center justify-between gap-3">
          <button type="button" className={CARD_LINK} onClick={onCreate} disabled={busy}>
            {signInCopy.create}
          </button>
          <button type="button" className="ob-btn solid ml-auto" onClick={onSignIn} disabled={busy}>
            {busy ? signInCopy.waiting : signInCopy.act}
          </button>
        </div>
        <div className="mt-6 grid gap-2 border-t border-[color-mix(in_srgb,var(--color-ink)_22%,transparent)] pt-4 text-[0.88rem] leading-[1.45] text-[color-mix(in_srgb,var(--color-ink)_68%,transparent)]">
          <p className="m-0 text-ink">{signInCopy.helpTitle}</p>
          <p className="m-0">{signInCopy.help}</p>
          <p className="m-0">
            {signInCopy.kit}{' '}
            <a className="underline decoration-[color-mix(in_srgb,var(--color-ink)_35%,transparent)] underline-offset-4 hover:text-ink" href={WALKAWAY_URL} target="_blank" rel="noreferrer">
              {signInCopy.kitLink}
            </a>
          </p>
        </div>
      </div>
    </CardFrame>
  )
}

/** Signs a returning owner in with the passkey, then hands the session to the app. */
export function SignIn({ onDone, onCreate }: { onDone: () => void; onCreate: () => void }) {
  const api = useApi()
  const qc = useQueryClient()
  const ready = useSignInChallenge(true)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<SignInProblem | null>(null)
  const [known] = useState(() => knownCredentials())

  const run = async (only: string[]) => {
    setProblem(null)
    setBusy(true)
    try {
      // The challenge is fetched ahead, so the prompt opens inside the tap. A stale one is replaced first.
      const challenge = challengeUsable(ready.data) ? ready.data : await api.signInChallenge()
      const session = await signInWithPasskey(api, challenge, only)
      qc.setQueryData(queryKeys.session, session)
      onDone()
    } catch (e) {
      setProblem(signInProblem(e))
      // A challenge is one attempt: get the next one ready.
      void ready.refetch()
    } finally {
      setBusy(false)
    }
  }

  return <SignInCard busy={busy} problem={problem} remembered={known.length > 0} onSignIn={() => void run([])} onRemembered={() => void run(known)} onCreate={onCreate} />
}
