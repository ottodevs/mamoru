import { createContext, useContext } from 'react'
import type {
  ApiError,
  AppConfig,
  DashboardPayload,
  OwnerRequest,
  OwnerResponse,
  PoolsResponse,
  SessionView,
} from '@mamoru/domain'

// Every call goes to same-origin /api (FR-DSH-019). The SPA never reaches RPC, bundler or MultiBaas.
export type ApiClient = {
  config(): Promise<AppConfig>
  /** null when the API answers 401: nobody is signed in. */
  session(): Promise<SessionView | null>
  dashboard(accountKey: string): Promise<DashboardPayload>
  pools(): Promise<PoolsResponse>
  createOwner(body: OwnerRequest): Promise<OwnerResponse>
  recoveryKit(accountKey: string): Promise<unknown>
  ackRecovery(accountKey: string): Promise<{ ok: true }>
}

export class ApiRequestError extends Error {
  readonly status: number
  readonly code?: string

  constructor(status: number, body: ApiError | null) {
    super(body?.error ?? `HTTP ${status}`)
    this.status = status
    this.code = body?.code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) },
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null
    throw new ApiRequestError(res.status, body)
  }
  return (await res.json()) as T
}

export const httpClient: ApiClient = {
  config: () => request<AppConfig>('/api/config'),
  session: async () => {
    try {
      return await request<SessionView>('/api/session')
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 401) return null
      throw e
    }
  },
  dashboard: (accountKey) => request<DashboardPayload>(`/api/accounts/${encodeURIComponent(accountKey)}/dashboard`),
  pools: () => request<PoolsResponse>('/api/pools'),
  createOwner: (body) => request<OwnerResponse>('/api/onboarding/owner', { method: 'POST', body: JSON.stringify(body) }),
  recoveryKit: (accountKey) => request<unknown>(`/api/onboarding/kit?accountKey=${encodeURIComponent(accountKey)}`),
  ackRecovery: (accountKey) =>
    request<{ ok: true }>('/api/onboarding/recovery-ack', { method: 'POST', body: JSON.stringify({ accountKey }) }),
}

export const ApiContext = createContext<ApiClient>(httpClient)

export function useApi(): ApiClient {
  return useContext(ApiContext)
}
