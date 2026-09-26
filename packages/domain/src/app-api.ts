// HTTP contract between the SPA and the mamoru-app API (sprint cut of plan §6 and dashboard.md §3).
// Only the integrator changes this file. Every route is same-origin under /api.
import type { DashboardPayload, Hex0x, PoolView } from './dashboard-payload.ts'

// GET /api/config
export type AppConfig = {
  mode: 'production' | 'lab'
  chainId: number
  banner: DashboardPayload['banner']
  fundsGate: 'closed' | 'lab' | 'live'
  dryRun: boolean
  capUsdc?: string        // live only: hard cap per account, base units
}

// GET /api/session -> 200 SessionView | 401
export type SessionView = { userId: string; email?: string; accountKey?: string }

// Passkey owner as produced by navigator.credentials.create (P-256).
export type PasskeyOwner = { credentialId: string; x: Hex0x; y: Hex0x }

// POST /api/onboarding/owner  body: OwnerRequest -> OwnerResponse
export type OwnerRequest = { passkey: PasskeyOwner; backupOwner?: Hex0x }
export type OwnerResponse = {
  accountKey: string
  chainId: number
  address: Hex0x          // counterfactual Safe on Base
  owners: Hex0x[]
  deployed: false
}

// POST /api/onboarding/recovery-ack  body: { accountKey } -> { ok: true }
// GET  /api/onboarding/kit?accountKey=  -> RecoveryKit JSON (packages/account/recovery), download
// GET  /api/accounts/:accountKey/dashboard -> DashboardPayload
// GET  /api/pools -> PoolsResponse (public pool rows of the Conservador plan)
export type PoolsResponse = { chainId: number; pools: PoolView[]; syncedAt: string | null }

export type ApiError = { error: string; code?: string }

// Real happy path (sprint amendment 2026-09-26 21:10). Owner actions are signed by the passkey
// in the browser; engine actions are signed by the engine's session key. A relayer submits both.

// GET /api/accounts/:accountKey/funding -> FundingView (what the Safe holds now, at a block)
export type FundingView = {
  address: Hex0x
  deployed: boolean
  block: number
  usdc: string            // base units
  eth: string             // wei
  capUsdc: string         // hard cap per account, base units
  cbbtc: string           // base units
  gasReserveWei: string   // the relayer tops the Safe up to this at activation
  active: boolean         // engine grants enabled and the engine loop running
  positions: { tokenId: string; pool: string; liquidity: string; inRange: boolean; amountUsdc: string; amountCbbtc: string }[]
}

// POST /api/accounts/:accountKey/activate/prepare -> OwnerTxToSign
// POST /api/accounts/:accountKey/activate            body: OwnerSignature -> OpView
// Deploys the Safe if needed and enables the session grants sized to the observed deposit.
// POST /api/accounts/:accountKey/transfer/prepare   body: TransferRequest -> TransferPlan
// POST /api/accounts/:accountKey/transfer           body: OwnerSignature -> OpView
// Frees USDC by reducing positions if idle USDC is short (engine), then the owner transfer.
// POST /api/accounts/:accountKey/stop/prepare        -> OwnerTxToSign
// POST /api/accounts/:accountKey/stop                body: OwnerSignature -> OpView
// Stop allocation: revoke every grant, close every position, swap the volatile side to USDC. USDC stays in the Safe.
// GET  /api/accounts/:accountKey/ops?after=          -> { ops: OpView[] }
export type TransferRequest = { to: Hex0x; amountUsdc: string }
export type TransferPlan = { reduce: { tokenId: string; liquidityBps: number }[]; ownerTx: OwnerTxToSign }
export type OwnerTxToSign = {
  safe: Hex0x
  chainId: number
  safeTxHash: Hex0x        // the passkey signs this (WebAuthn challenge)
  summary: string[]        // human lines shown before signing
  expiresAt: string
  prepareId: string
}
// WebAuthn assertion for SafeWebAuthnSharedSigner (base64url fields as returned by the browser).
export type OwnerSignature = {
  prepareId: string
  authenticatorData: string
  clientDataJSON: string
  signature: string        // DER, base64url
}
export type OpView = {
  opId: string
  kind: 'activate' | 'enter' | 'reduce' | 'transfer' | 'exit'
  state: 'proposed' | 'submitted' | 'confirmed' | 'failed'
  code?: string
  txHash?: Hex0x
  block?: number
  updatedAt: string
}

// Live operator (sprint amendment 2026-09-26 21:40). The Worker authenticates the device session, then
// forwards the same route to the operator with this context in `x-mamoru-account` (base64url JSON)
// and `x-mamoru-sig` = hex HMAC-SHA256(OPERATOR_SECRET, `${method} ${path}\n${header}\n${body}`).
export type AccountContext = {
  accountKey: string
  chainId: number
  address: Hex0x          // counterfactual Safe, recomputed by the operator and compared
  owners: Hex0x[]
  saltNonce: string       // decimal
  passkey: { credentialId: string; x: Hex0x; y: Hex0x }
}
