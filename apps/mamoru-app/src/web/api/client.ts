import { createContext, useContext } from 'react'
import type {
  ApiError,
  ApyView,
  AppConfig,
  BridgeOutToSign,
  BridgeOutView,
  DashboardPayload,
  FeedbackRequest,
  FeedbackResponse,
  FundingView,
  OpView,
  OtherChainsView,
  OwnerRequest,
  OwnerSignature,
  OwnerTxToSign,
  OwnerResponse,
  PoolsResponse,
  SessionView,
  SignInChallenge,
  SignInRequest,
  TransferPlan,
  TransferRequest,
  WithdrawAsset,
  YieldLedgerView,
} from '@mamoru/domain'

// Every call goes to same-origin /api (FR-DSH-019). The SPA never reaches RPC, bundler or MultiBaas.
export type ApiClient = {
  config(): Promise<AppConfig>
  /** null when the API answers 401: nobody is signed in. */
  session(): Promise<SessionView | null>
  dashboard(accountKey: string): Promise<DashboardPayload>
  pools(): Promise<PoolsResponse>
  apy(): Promise<ApyView>
  /** The challenge the new passkey is created over; createOwner sends back what the browser returned for it. */
  registrationChallenge(): Promise<SignInChallenge>
  createOwner(body: OwnerRequest): Promise<OwnerResponse>
  /** Returning owner: a one-time challenge, then the passkey assertion over it. signIn sets the session cookie. */
  signInChallenge(): Promise<SignInChallenge>
  signIn(body: SignInRequest): Promise<SessionView>
  recoveryKit(accountKey: string): Promise<unknown>
  ackRecovery(accountKey: string): Promise<{ ok: true }>
  // Live happy path (fundsGate 'live'). Owner actions are prepared by the API and signed by the passkey here.
  /** `fresh`: bypass the operator's funding-poll cache (otto/mamoru#135) — the Add/Withdraw dialogs ask for this the moment they open, so a stale total never blocks or rejects the owner action about to happen. */
  funding(accountKey: string, opts?: { fresh?: boolean }): Promise<FundingView>
  /** What the account address holds on chains Mamoru does not run on. Never part of the balance. */
  otherChains(accountKey: string): Promise<OtherChainsView>
  /** otto/mamoru#129: uncollected fees, collected, gas Mamoru paid and value vs hold, from the yield ledger. */
  yieldLedger(accountKey: string): Promise<YieldLedgerView>
  ops(accountKey: string): Promise<{ ops: OpView[] }>
  activatePrepare(accountKey: string): Promise<OwnerTxToSign>
  activate(accountKey: string, sig: OwnerSignature): Promise<OpView>
  withdrawAssets(accountKey: string): Promise<{ assets: { asset: WithdrawAsset; available: boolean; reason?: string }[] }>
  transferPrepare(accountKey: string, body: TransferRequest): Promise<TransferPlan>
  transfer(accountKey: string, sig: OwnerSignature): Promise<OpView>
  stopPrepare(accountKey: string): Promise<OwnerTxToSign>
  stop(accountKey: string, sig: OwnerSignature): Promise<OpView>
  renewPrepare(accountKey: string): Promise<OwnerTxToSign>
  renew(accountKey: string, sig: OwnerSignature): Promise<OpView>
  /** #133: move the USDC found on Ethereum to this account on Base. */
  bridgeOutPrepare(accountKey: string): Promise<BridgeOutToSign>
  bridgeOut(accountKey: string, sig: OwnerSignature): Promise<BridgeOutView>
  bridgeOutStatus(accountKey: string): Promise<BridgeOutView>
  /** Works with or without a session. */
  feedback(body: FeedbackRequest): Promise<FeedbackResponse>
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
  registrationChallenge: () => post<SignInChallenge>('/api/onboarding/challenge'),
  createOwner: (body) => request<OwnerResponse>('/api/onboarding/owner', { method: 'POST', body: JSON.stringify(body) }),
  signInChallenge: () => post<SignInChallenge>('/api/auth/challenge'),
  signIn: (body) => post<SessionView>('/api/auth/signin', body),
  recoveryKit: (accountKey) => request<unknown>(`/api/onboarding/kit?accountKey=${encodeURIComponent(accountKey)}`),
  ackRecovery: (accountKey) =>
    request<{ ok: true }>('/api/onboarding/recovery-ack', { method: 'POST', body: JSON.stringify({ accountKey }) }),
  funding: (k, opts) => request<FundingView>(acct(k, 'funding') + (opts?.fresh ? '?fresh=1' : '')),
  otherChains: (k) => request<OtherChainsView>(acct(k, 'other-chains')),
  yieldLedger: (k) => request<YieldLedgerView>(acct(k, 'yield')),
  ops: (k) => request<{ ops: OpView[] }>(acct(k, 'ops')),
  activatePrepare: (k) => post<OwnerTxToSign>(acct(k, 'activate/prepare')),
  activate: (k, sig) => post<OpView>(acct(k, 'activate'), sig),
  withdrawAssets: (k) => request<{ assets: { asset: WithdrawAsset; available: boolean; reason?: string }[] }>(acct(k, 'withdraw-assets')),
  transferPrepare: (k, body) => post<TransferPlan>(acct(k, 'transfer/prepare'), body),
  transfer: (k, sig) => post<OpView>(acct(k, 'transfer'), sig),
  stopPrepare: (k) => post<OwnerTxToSign>(acct(k, 'stop/prepare')),
  stop: (k, sig) => post<OpView>(acct(k, 'stop'), sig),
  renewPrepare: (k) => post<OwnerTxToSign>(acct(k, 'renew/prepare')),
  renew: (k, sig) => post<OpView>(acct(k, 'renew'), sig),
  bridgeOutPrepare: (k) => post<BridgeOutToSign>(acct(k, 'bridge-out/prepare')),
  bridgeOut: (k, sig) => post<BridgeOutView>(acct(k, 'bridge-out'), sig),
  bridgeOutStatus: (k) => request<BridgeOutView>(acct(k, 'bridge-out')),
  feedback: (body) => post<FeedbackResponse>('/api/feedback', body),
}

export const ApiContext = createContext<ApiClient>(httpClient)

export function useApi(): ApiClient {
  return useContext(ApiContext)
}
