// The app's two sections (spec 013): Portfolio at "/", Stats at "/stats". Desktop: text tabs beside the brand.
// Mobile (<= 640 px): a bar fixed at the bottom. Both show with and without a session; Stats needs none.
import { Link, useRouterState } from '@tanstack/react-router'
import { createPortal } from 'react-dom'
import '../stats.css'

const ITEMS = [
  {
    to: '/' as const,
    label: 'Portfolio',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <ellipse cx="8" cy="11" rx="5.5" ry="6.5" />
        <ellipse cx="14.5" cy="13" rx="3" ry="4" />
      </svg>
    ),
  },
  {
    to: '/stats' as const,
    label: 'Stats',
    icon: (
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <path d="M3 17V10M8 17V5M13 17V8M18 17V12" />
      </svg>
    ),
  },
]

function useSection(): '/' | '/stats' {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return path.startsWith('/stats') ? '/stats' : '/'
}

/** Text tabs for the header, hidden on small screens (the bottom bar takes over). */
export function MainTabs() {
  const here = useSection()
  return (
    <nav className="main-tabs" aria-label="Main">
      {ITEMS.map((it) => (
        <Link key={it.to} to={it.to} aria-current={here === it.to ? 'page' : undefined}>
          {it.label}
        </Link>
      ))}
    </nav>
  )
}

/** The bottom tab bar on small screens. In a portal on <body>: a page that animates in (a transform) would otherwise
 * pin it to the page, not the screen. */
export function TabBar() {
  const here = useSection()
  if (typeof document === 'undefined') return null
  return createPortal(
    <nav className="tab-bar" aria-label="Main">
      {ITEMS.map((it) => (
        <Link key={it.to} to={it.to} aria-current={here === it.to ? 'page' : undefined}>
          {it.icon}
          {it.label}
        </Link>
      ))}
    </nav>,
    document.body,
  )
}
