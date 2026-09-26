import { createContext, useContext } from 'react'
import type {
  ApiError,
  ApyView,
  AppConfig,
  DashboardPayload,
  FundingView,
  OpView,
  OwnerRequest,
  OwnerSignature,
  OwnerTxToSign,
  OwnerResponse,
  PoolsResponse,
  SessionView,
  TransferPlan,
  TransferRequest,
} from '@mamoru/domain'

// Every call goes to same-origin /api (FR-DSH-019). The SPA never reaches RPC, bundler or MultiBaas.
export type ApiClient = {
  config(): Promise<AppConfig>
  /** null when the API answers 401: nobody is signed in. */
  session(): Promise<SessionView | null>
  dashboard(accountKey: string): Promise<DashboardPayload>
  pools(): Promise<PoolsResponse>
  apy(): Promise<ApyView>
  createOwner(body: OwnerRequest): Promise<OwnerResponse>
  recoveryKit(accountKey: string): Promise<unknown>
  ackRecovery(accountKey: string): Promise<{ ok: true }>
  // Live happy path (fundsGate 'live'). Owner actions are prepared by the API and signed by the passkey here.
  funding(accountKey: string): Promise<FundingView>
  ops(accountKey: string): Promise<{ ops: OpView[] }>
  activatePrepare(accountKey: string): Promise<OwnerTxToSign>
  activate(accountKey: string, sig: OwnerSignature): Promise<OpView>
  transferPrepare(accountKey: string, body: TransferRequest): Promise<TransferPlan>
  transfer(accountKey: string, sig: OwnerSignature): Promise<OpView>
  stopPrepare(accountKey: string): Promise<OwnerTxToSign>
  stop(accountKey: string, sig: OwnerSignature): Promise<OpView>
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

const acct = (k: string, rest: string) => `/api/accounts/${encodeURIComponent(k)}/${rest}`
const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

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
  apy: () => request<ApyView>('/api/apy'),
  createOwner: (body) => request<OwnerResponse>('/api/onboarding/owner', { method: 'POST', body: JSON.stringify(body) }),
  recoveryKit: (accountKey) => request<unknown>(`/api/onboarding/kit?accountKey=${encodeURIComponent(accountKey)}`),
  ackRecovery: (accountKey) =>
    request<{ ok: true }>('/api/onboarding/recovery-ack', { method: 'POST', body: JSON.stringify({ accountKey }) }),
  funding: (k) => request<FundingView>(acct(k, 'funding')),
  ops: (k) => request<{ ops: OpView[] }>(acct(k, 'ops')),
  activatePrepare: (k) => post<OwnerTxToSign>(acct(k, 'activate/prepare')),
  activate: (k, sig) => post<OpView>(acct(k, 'activate'), sig),
  transferPrepare: (k, body) => post<TransferPlan>(acct(k, 'transfer/prepare'), body),
  transfer: (k, sig) => post<OpView>(acct(k, 'transfer'), sig),
  stopPrepare: (k) => post<OwnerTxToSign>(acct(k, 'stop/prepare')),
  stop: (k, sig) => post<OpView>(acct(k, 'stop'), sig),
}

export const ApiContext = createContext<ApiClient>(httpClient)

export function useApi(): ApiClient {
  return useContext(ApiContext)
}
