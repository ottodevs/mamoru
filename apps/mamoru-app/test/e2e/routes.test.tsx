import { describe, expect, test } from 'bun:test'
import { PRODUCTION_BANNER } from '@mamoru/domain'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { ApiContext } from '../../src/web/api/client.ts'
import { queryKeys } from '../../src/web/api/queries.ts'
import { emptyAccount, FIXTURE_ACCOUNT_KEY } from '../../src/web/fixtures/empty-account.ts'
import { fixtureClient, fixtureConfig, fixtureSession } from '../../src/web/fixtures/client.ts'
import { poolsResponse } from '../../src/web/fixtures/pools.ts'
import { buildRouter } from '../../src/web/router.tsx'
import { render } from './render.ts'

// Route-level render with the query cache primed from fixtures, as the browser would see it after the API answers.
async function renderRoute(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  queryClient.setQueryData(queryKeys.config, fixtureConfig)
  queryClient.setQueryData(queryKeys.session, fixtureSession)
  queryClient.setQueryData(queryKeys.dashboard(FIXTURE_ACCOUNT_KEY), emptyAccount)
  queryClient.setQueryData(queryKeys.pools, poolsResponse)
  const router = buildRouter(createMemoryHistory({ initialEntries: [path] }))
  await router.load()
  return render(
    <ApiContext.Provider value={fixtureClient}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiContext.Provider>,
  )
}

describe('routes', () => {
  test('/ explains Mamoru, the safety mode and the way in', async () => {
    const { text } = await renderRoute('/')
    expect(text).toContain(PRODUCTION_BANNER)
    expect(text).toContain('non-custodial savings agent on Base')
    expect(text).toContain('Create account')
    expect(text).toContain('Open dashboard')
  })

  test('/onboarding shows the four steps and closed deposits', async () => {
    const { text } = await renderRoute('/onboarding')
    expect(text).toContain(PRODUCTION_BANNER)
    expect(text).toContain('Create passkey')
    expect(text).toContain('Save your recovery kit')
    expect(text).toContain('Conservador is the only preset in v1')
    expect(text).toContain('Deposits are closed')
  })

  test('/dashboard paints the payload in the §3 order', async () => {
    const { html, text } = await renderRoute('/dashboard')
    expect(text).toContain(PRODUCTION_BANNER)
    const order = ['account', 'actions', 'current-action', 'portfolio', 'treasury', 'positions', 'savings', 'savings-log', 'leave']
    const positions = order.map((id) => html.indexOf(`id="${id}"`))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
    expect(text).toContain('Uniswap V3 · USDC/cbBTC 0.05%')
  })

  test('unknown paths show not found, not a new route', async () => {
    const { text } = await renderRoute('/deposit')
    expect(text).toContain('Page not found')
  })
})
