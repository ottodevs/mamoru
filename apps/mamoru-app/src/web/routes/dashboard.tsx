import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useApi } from '../api/client.ts'
import { useConfig, useDashboard, usePools, useSession } from '../api/queries.ts'
import { ScopeContext } from '../components/scope.tsx'
import { ErrorNotice, Skeleton } from '../components/section.tsx'
import { errors } from '../copy/dashboard.ts'
import { downloadJson, kitFilename } from '../lib/download.ts'
import { DashboardView } from '../panels/dashboard-view.tsx'
import { LivePanel } from '../panels/live.tsx'
import type { PlanPools } from '../panels/pools.tsx'
import { Brand } from './root.tsx'

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto flex w-[min(68rem,calc(100%-3rem))] flex-1 flex-col pt-[1.15rem] pb-7">
      <title>Mamoru · Dashboard</title>
      <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <Brand />
      </header>
      {children}
    </main>
  )
}

function NoAccount({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="sheet grid max-w-[34rem] gap-3 px-4 py-4">
      <h1 className="m-0 text-[1.4rem] font-normal">{signedIn ? 'No account yet' : 'You are not signed in'}</h1>
      <p className="m-0 leading-[1.45] text-stone">
        {signedIn
          ? 'Your dashboard shows a Mamoru account on Base. Create yours with a passkey to see it here.'
          : 'Mamoru did not find a session in this browser. Create your account to open your dashboard.'}
      </p>
      <Link to="/onboarding" className="btn btn-primary">
        Create account
      </Link>
    </div>
  )
}

export function DashboardPage() {
  const api = useApi()
  const session = useSession()
  const config = useConfig()
  const accountKey = session.data?.accountKey
  const dashboard = useDashboard(accountKey)
  const pools = usePools()
  const kit = useMutation({
    mutationFn: async ({ key, address }: { key: string; address: string }) => downloadJson(kitFilename(address), await api.recoveryKit(key)),
  })

  if (session.isPending) {
    return (
      <Shell>
        <Skeleton lines={5} />
      </Shell>
    )
  }
  if (session.isError) {
    return (
      <Shell>
        <ErrorNotice message={errors.header} onRetry={() => session.refetch()} />
      </Shell>
    )
  }
  if (!accountKey) {
    return (
      <Shell>
        <NoAccount signedIn={session.data !== null} />
      </Shell>
    )
  }

  const data = dashboard.data
  if (!data) {
    return (
      <Shell>
        {dashboard.isError ? <ErrorNotice message={errors.header} onRetry={() => dashboard.refetch()} /> : <Skeleton lines={8} />}
      </Shell>
    )
  }

  const plan: PlanPools = pools.data
    ? { status: 'ready', pools: pools.data.pools, syncedAt: pools.data.syncedAt }
    : pools.isError
      ? { status: 'error', retry: () => pools.refetch() }
      : { status: 'loading' }
  const address = data.account.address.value

  return (
    <Shell>
      {dashboard.isError ? <ErrorNotice message={errors.header} onRetry={() => dashboard.refetch()} /> : null}
      {config.data?.fundsGate === 'live' ? (
        <ScopeContext.Provider value={{ mode: data.mode, chains: data.chains }}>
          <LivePanel accountKey={accountKey} />
        </ScopeContext.Provider>
      ) : null}
      <DashboardView
        data={data}
        plan={plan}
        kitState={kit.isPending ? 'pending' : kit.isError ? 'error' : 'idle'}
        onDownloadKit={() => address && kit.mutate({ key: data.account.key, address })}
      />
    </Shell>
  )
}
