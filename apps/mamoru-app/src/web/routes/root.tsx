import { Link, Outlet, useLocation } from '@tanstack/react-router'
import { Banner } from '../components/banner.tsx'
import { useConfig, useDashboard, useSession } from '../api/queries.ts'

export function RootLayout() {
  const config = useConfig()
  const onDashboard = useLocation({ select: (l) => l.pathname === '/dashboard' })
  const session = useSession(onDashboard)
  const dashboard = useDashboard(onDashboard ? (session.data?.accountKey ?? undefined) : undefined)
  return (
    <div className="flex min-h-dvh flex-col">
      <Banner banner={dashboard.data?.banner ?? config.data?.banner} />
      {import.meta.env.VITE_FIXTURES === '1' ? (
        <p className="m-0 bg-ink px-4 py-1 text-center font-mono text-[0.68rem] tracking-[0.05em] text-rice">
          Fixture data from src/web/fixtures. Not from Mamoru's API.
        </p>
      ) : null}
      <Outlet />
    </div>
  )
}

export function Brand() {
  return (
    <Link to="/" className="inline-flex items-center gap-3 text-[1.35rem] tracking-[0.02em] no-underline">
      <img src="/mark-two-stones.png" width={36} height={36} alt="" />
      <span>Mamoru</span>
    </Link>
  )
}

export function NotFound() {
  return (
    <main className="mx-auto flex w-[min(34rem,calc(100%-3rem))] flex-col gap-4 py-12">
      <Brand />
      <h1 className="m-0 text-[2rem] font-normal">Page not found</h1>
      <p className="m-0 text-stone">This page does not exist. Mamoru has three pages: home, onboarding and the dashboard.</p>
      <Link to="/" className="btn btn-ghost">
        Go home
      </Link>
    </main>
  )
}
