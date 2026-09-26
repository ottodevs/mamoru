import { Link, Outlet } from '@tanstack/react-router'
import { Brand } from '../components/ui.tsx'

export function RootLayout() {
  return (
    <div className="flex min-h-dvh flex-col">
      {import.meta.env.VITE_FIXTURES === '1' ? (
        <p className="m-0 bg-ink px-4 py-1 text-center font-mono text-[0.68rem] tracking-[0.05em] text-rice">Fixture data. Not from Mamoru's API.</p>
      ) : null}
      <Outlet />
    </div>
  )
}

export function NotFound() {
  return (
    <main className="page">
      <title>Mamoru · Not found</title>
      <header className="mb-7">
        <Brand />
      </header>
      <h1 className="m-0 text-[2rem] font-normal">Page not found</h1>
      <p className="mt-4">
        <Link to="/" className="act inline-block no-underline">
          Go home
        </Link>
      </p>
    </main>
  )
}
