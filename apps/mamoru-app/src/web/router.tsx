import { createRootRoute, createRoute, createRouter, redirect, type RouterHistory } from '@tanstack/react-router'
import { AddMoneyPage } from './routes/add-money.tsx'
import { IndexPage } from './routes/index.tsx'
import { NotFound, RootLayout } from './routes/root.tsx'

// Client-only routes. "/" is onboarding or Home; "/add" waits for the first deposit.
export function buildRouter(history?: RouterHistory) {
  const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: NotFound })
  const home = () => {
    throw redirect({ to: '/', replace: true })
  }
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: IndexPage }),
    createRoute({ getParentRoute: () => rootRoute, path: '/add', component: AddMoneyPage }),
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
