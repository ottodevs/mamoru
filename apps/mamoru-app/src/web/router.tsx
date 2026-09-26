import { createRootRoute, createRoute, createRouter, type RouterHistory } from '@tanstack/react-router'
import { DashboardPage } from './routes/dashboard.tsx'
import { HomePage } from './routes/home.tsx'
import { OnboardingPage } from './routes/onboarding.tsx'
import { NotFound, RootLayout } from './routes/root.tsx'

// Client-only routes (FR-DSH-001): no SSR, no route beyond these three.
export function buildRouter(history?: RouterHistory) {
  const rootRoute = createRootRoute({ component: RootLayout, notFoundComponent: NotFound })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage }),
    createRoute({ getParentRoute: () => rootRoute, path: '/onboarding', component: OnboardingPage }),
    createRoute({ getParentRoute: () => rootRoute, path: '/dashboard', component: DashboardPage }),
  ])
  return createRouter({ routeTree, defaultPreload: false, scrollRestoration: true, ...(history ? { history } : {}) })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof buildRouter>
  }
}
