import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useSession } from '../api/queries.ts'
import { Brand } from '../components/ui.tsx'
import { knownCredentials } from '../lib/signin.ts'
import { HomeView } from './home.tsx'
import { Onboarding } from './onboarding.tsx'
import { SignIn } from './signin.tsx'

/** app.mamoru.lol: Home when this device has a session with an account; otherwise the three cards, or the sign-in card for a returning owner. */
export function IndexPage() {
  const session = useSession()
  const navigate = useNavigate()
  const accountKey = session.data?.accountKey
  const asked = (useSearch({ strict: false }) as { signin?: true }).signin === true
  // Once the cards start, they stay until the approval is done, even after the account exists.
  const [boarding, setBoarding] = useState(false)
  useEffect(() => {
    if (session.isSuccess && !accountKey) setBoarding(true)
  }, [session.isSuccess, accountKey])
  // A returning owner: the link said so, this browser used a passkey here before, or the session ended while Home was open.
  const [known] = useState(() => knownCredentials().length > 0)
  const had = useRef(false)
  const [choice, setChoice] = useState<'signin' | 'create' | null>(null)
  const cards = boarding || (session.isSuccess && !accountKey)
  // Decided when the cards open and kept: creating an account must not flip the cards to the sign-in card.
  const opened = useRef<'signin' | 'create' | null>(null)
  if (!cards) opened.current = null
  else if (opened.current === null) opened.current = asked || known || had.current ? 'signin' : 'create'
  const signin = (choice ?? opened.current) === 'signin'
  if (accountKey && !cards) {
    had.current = true
    return <HomeView accountKey={accountKey} />
  }
  const signedIn = () => {
    setBoarding(false)
    setChoice(null)
    void navigate({ to: '/', search: {}, replace: true })
  }
  return (
    <main className="page">
      <title>Mamoru</title>
      <header className="mb-7">
        <Brand />
      </header>
      {session.isError ? (
        <p className="err">
          Mamoru did not answer.{' '}
          <button type="button" className="underline" onClick={() => void session.refetch()}>
            Try again
          </button>
        </p>
      ) : null}
      {cards ? signin ? <SignIn onDone={signedIn} onCreate={() => setChoice('create')} /> : <Onboarding onSignIn={() => setChoice('signin')} /> : null}
    </main>
  )
}
