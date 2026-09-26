import { useEffect, useState } from 'react'
import { useSession } from '../api/queries.ts'
import { Brand } from '../components/ui.tsx'
import { HomeView } from './home.tsx'
import { Onboarding } from './onboarding.tsx'

/** app.mamoru.lol: Home when this device has an account, the three cards otherwise. */
export function IndexPage() {
  const session = useSession()
  const accountKey = session.data?.accountKey
  // Once the cards start, they stay until the approval is done, even after the account exists.
  const [boarding, setBoarding] = useState(false)
  useEffect(() => {
    if (session.isSuccess && !accountKey) setBoarding(true)
  }, [session.isSuccess, accountKey])
  if (accountKey && !boarding) return <HomeView accountKey={accountKey} />
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
      {boarding ? <Onboarding /> : null}
    </main>
  )
}
