import { createRootRoute, createRoute, createRouter, lazyRouteComponent, redirect, type RouterHistory } from '@tanstack/react-router'
import { AddMoneyPage } from './routes/add-money.tsx'
import { IndexPage } from './routes/index.tsx'
import { NotFound, RootLayout } from './routes/root.tsx'

// Client-only routes. "/" is onboarding or Home; "/add" waits for the first deposit; "/lab" replays recorded fork runs.
export function buildRouter(history?: RouterHistory) {
  const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: NotFound })
  const home = () => {
    throw redirect({ to: '/', replace: true })
  }
  const routeTree = rootRoute.addChildren([
    // ?signin=true opens on the returning-owner card: a deep link that found no session lands here.
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: IndexPage, validateSearch: (s: Record<string, unknown>): { signin?: true } => (s.signin ? { signin: true } : {}) }),
    createRoute({ getParentRoute: () => rootRoute, path: '/add', component: AddMoneyPage }),
    createRoute({ getParentRoute: () => rootRoute, path: '/lab', component: lazyRouteComponent(() => import('./lab/page.tsx'), 'LabPage') }),
    createRoute({ getParentRoute: () => rootRoute, path: '/onboarding', beforeLoad: home }),
    createRoute({ getParentRoute: () => rootRoute, path: '/dashboard', beforeLoad: home }),
  ])
  return createRouter({ routeTree, defaultPreload: false, scrollRestoration: true, ...(history ? { history } : {}) })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>
  }
}
