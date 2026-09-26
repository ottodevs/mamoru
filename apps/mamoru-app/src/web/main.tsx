import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiContext, httpClient, type ApiClient } from './api/client.ts'
import { buildRouter } from './router.tsx'
import './styles.css'

// Statically false in `vite build` (the config refuses VITE_FIXTURES there), so the fixture chunk is never emitted.
const fixtures = import.meta.env.VITE_FIXTURES === '1'
const api: ApiClient = fixtures ? (await import('./fixtures/client.ts')).fixtureClient : httpClient

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } })
const router = buildRouter()

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <ApiContext.Provider value={api}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ApiContext.Provider>
  </StrictMode>,
)
