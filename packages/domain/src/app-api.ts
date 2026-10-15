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

// Returning owner: sign in with the passkey that owns the account. Grants what the device session grants, nothing more.
// POST /api/auth/challenge -> SignInChallenge (single use, 5 minutes, bound to this host)
export type SignInChallenge = { challenge: string; token: string; rpId: string; expiresAt: string }
// POST /api/auth/signin  body: SignInRequest -> 200 SessionView + session cookie | 401 AUTH_SIGNIN_FAILED | 429 AUTH_RATE_LIMITED
// Every field is base64url, as navigator.credentials.get returns them; token is SignInChallenge.token.
export type SignInRequest = { token: string; credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }

// Passkey owner as produced by navigator.credentials.create (P-256).
export type PasskeyOwner = { credentialId: string; x: Hex0x; y: Hex0x }

// POST /api/onboarding/challenge -> SignInChallenge: the challenge navigator.credentials.create() must carry.
// POST /api/onboarding/owner  body: OwnerRequest -> OwnerResponse | 400 ONB_PASSKEY_REFUSED | 429 AUTH_RATE_LIMITED
// proof: what create() returned for that challenge (base64url). The API checks the challenge, the origin, the RP ID,
// and that the credential id and public key inside authenticatorData are the ones in `passkey`.
export type RegistrationProof = { token: string; clientDataJSON: string; authenticatorData: string }
export type OwnerRequest = { passkey: PasskeyOwner; proof: RegistrationProof; backupOwner?: Hex0x }
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
  // Set while the engine is not running and the Safe holds more USDC than the cap: Start is refused until the excess leaves.
  overCap?: OverCap | null
  // The relayer deploys the Safe only once it holds this much USDC (base units); below it nothing starts and nothing can be sent.
  deployMinUsdc?: string
  cbbtc: string           // base units
  gasReserveWei: string   // the relayer tops the Safe up to this at activation
  active: boolean         // engine grants enabled and the engine loop running
  // Every token the account holds outside a position (USDC, and what a swap leaves until its mint: USDT, cbBTC, WETH),
  // base units, each with its value in USDC base units. `usdc` and `cbbtc` above are the same balances, kept for
  // older app versions.
  idle?: { token: string; amount: string; decimals: number; valueUsdc: string }[]
  // What the engine of a running account is up to between operations: `placing` while it is working through an
  // entry (the next step comes in seconds), and when its next review of the account is due. Null when not running.
  engine?: { placing: boolean; nextReviewAt: string | null } | null
  // The owner's approval of a running account: until when (unix seconds) the engine's grants are valid, whether the
  // renewal is due (inside the renewal window) and whether they already lapsed. Null or absent when not running.
  // `missing`: how many grants of its policy the account lacks (left out to fit Base's per-tx gas cap); the renew
  // route then adds them with one more approval. Absent when none is missing.
  approval?: { validUntil: number; renewDue: boolean; expired: boolean; missing?: number } | null
  positions: {
    tokenId: string; pool: string; liquidity: string; inRange: boolean; amountUsdc: string; amountCbbtc: string
    amounts?: { token: string; amount: string; decimals: number; valueUsdc?: string }[]   // both sides of any pool, base units, each with its value in USDC
    valueUsdc?: string                                                  // position value in USDC base units
  }[]
  // What the engine is doing right now, for a subtle progress line in Working capital.
  progress?: { step: 'deploying' | 'activating' | 'swapping' | 'opening' | 'rebalancing' | 'reranging' | 'closing' | 'withdrawing'; pool?: string; since: string } | null
}

// GET /api/accounts/:accountKey/other-chains -> OtherChainsView
// What sits at the account's address on a chain Mamoru does not run on (a transfer sent on the wrong network).
// Read-only and separate from FundingView on purpose: these amounts are never part of the Mamoru balance,
// never count towards the cap and never start anything. Each row carries the chain id it was read on.
export type OtherChainFunds =
  | { chainId: number; name: string; status: 'observed'; block: number; usdc: string; eth: string; observedAt: string }   // usdc base units, eth wei
  | { chainId: number; name: string; status: 'not_observed'; observedAt: string }
export type OtherChainsView = { address: Hex0x; accountChainId: number; chains: OtherChainFunds[] }

// What the operator found when a deposit is above the per-account cap. Amounts in USDC base units.
export type OverCap = { code: 'DEPOSIT_OVER_CAP'; usdc: string; capUsdc: string; excessUsdc: string }

// POST /api/accounts/:accountKey/activate/prepare -> OwnerTxToSign
// POST /api/accounts/:accountKey/activate            body: OwnerSignature -> OpView
// Deploys the Safe if needed and enables the session grants sized to the observed deposit.
// POST /api/accounts/:accountKey/transfer/prepare   body: TransferRequest -> TransferPlan
// POST /api/accounts/:accountKey/transfer           body: OwnerSignature -> OpView
// Frees USDC by reducing positions if idle USDC is short (engine), then the owner transfer.
// Works on a Safe that is not deployed yet (a deposit that never started): the relayer deploys it, then the transfer runs.
// POST /api/accounts/:accountKey/stop/prepare        -> OwnerTxToSign
// POST /api/accounts/:accountKey/renew/prepare       -> OwnerTxToSign   (running account: same grants, fresh validity; or, with grants missing and no renewal due, only the missing ones)
// POST /api/accounts/:accountKey/renew  OwnerSignature -> OpView
// POST /api/accounts/:accountKey/stop                body: OwnerSignature -> OpView
// Stop allocation: revoke every grant, close every position, swap the volatile side to USDC. USDC stays in the Safe.
// GET  /api/accounts/:accountKey/ops?after=          -> { ops: OpView[] }
// asset: what the recipient receives. amountUsdc is always the USDC the Safe spends; for EURC/ETH/JPYC
// the operator swaps it on Uniswap with the recipient as the swap output (ETH is unwrapped from WETH).
export type WithdrawAsset = 'USDC' | 'EURC' | 'ETH' | 'JPYC'
export type TransferRequest = { to: Hex0x; amountUsdc: string; asset?: WithdrawAsset }
export type TransferPlan = {
  reduce: { tokenId: string; liquidityBps: number }[]
  receive?: { asset: WithdrawAsset; quoted: string; minimum: string; decimals: number; route: string }
  ownerTx: OwnerTxToSign
}
// GET /api/accounts/:accountKey/withdraw-assets -> { assets: { asset: WithdrawAsset; available: boolean; reason?: string }[] }
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
  kind: 'activate' | 'enter' | 'reduce' | 'transfer' | 'exit' | 'renew'
  state: 'proposed' | 'submitted' | 'confirmed' | 'failed'
  code?: string
  txHash?: Hex0x
  block?: number
  updatedAt: string
  /** transfer: amount in USDC base units, the asset received, and the recipient. */
  amountUsdc?: string
  asset?: string
  to?: Hex0x
  /** activate failed with DEPOSIT_OVER_CAP: amountUsdc is the deposit found, capUsdc the cap it exceeded. */
  capUsdc?: string
  /** renew: it only added the grants the account lacked (re-range and harvest in more pools), nothing was renewed. */
  extend?: boolean
  /**
   * Engine ops only (enter/reduce rows born from the engine's journal): the registry pool name the operation
   * acted on, e.g. 'pool:USDC/cbBTC/500'. Absent on owner ops (activate/renew/transfer/exit) and on rows an
   * operator stored before this field existed; the SPA falls back to a neutral, pool-less line for those.
   */
  pool?: string
  /** enter_swap only: the token swapped from and to, and the swapped amount of tokenIn (base units). */
  tokenIn?: string
  tokenOut?: string
  amountIn?: string
  /** harvest only: the fee token a convert step swapped back to the savings asset, when the harvest did that. */
  convert?: string
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

// One current and one monthly APY for the account (public, no session). Until positions earn
// fees: the plan's pools' APYs weighted by the policy bucket weights. `pool` = the plan's policyId.
// GET  /api/apy                                      -> ApyView
export type ApyView = {
  pool: string
  currentPct: number | null
  currentWindow: '1h' | '24h'
  currentSource: string
  monthlyPct: number | null
  monthlySource: string
  asOf: string
}

// In-app feedback (otto/mamoru#72): one button, two paths. 'support' is answered in Mattermost, one thread per
// request; 'bug' and 'idea' land as a short line and wait for weekly triage. Works with or without a session.
// POST /api/feedback -> 200 FeedbackResponse | 400 | 429 FEEDBACK_RATE_LIMITED
export type FeedbackRequest = {
  kind: 'support' | 'bug' | 'idea'
  body: string
  contact?: string
  route: string          // the SPA path the form was opened from, e.g. '/'
  // Attaches the account key only when a session owning an account exists; otherwise this is a no-op. Off by default.
  attachAccount?: boolean
  // Honeypot: a field no person sees and no browser autofills. Any value in it answers success and stores nothing.
  leaveEmpty?: string
}
export type FeedbackResponse = { id: string; received: true }
