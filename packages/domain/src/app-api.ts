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
  // `waiting` (otto/mamoru#127, #128): money the engine is holding back as USDC on purpose, per bucket, with the reason
  // code of the last review (DECIDE_WAIT_DEPTH: the pool cannot take more now; DECIDE_ENTRY_PAUSED_FALL: its market is
  // falling fast) and when that review ran. Absent when nothing waits.
  engine?: { placing: boolean; nextReviewAt: string | null; waiting?: { bucket: string; pool: string | null; code: string; amountUsdc: string }[]; reviewedAt?: string | null } | null
  // The owner's approval of a running account: until when (unix seconds) the engine's grants are valid, whether the
  // renewal is due (inside the renewal window) and whether they already lapsed. Null or absent when not running.
  // `missing`: how many grants of its policy the account lacks (left out to fit Base's per-tx gas cap); the renew
  // route then adds them with one more approval. Absent when none is missing.
  // `usage` (otto/mamoru#149): the grant closest to the end of what the approval allows, once it has used 80% of it
  // (its userOp count, or an entry grant's cumulative cap): what it does (`collect` fees, `rerange` or reduce, `enter`),
  // in which pool, how much is used (bps) and whether it is `spent` (the engine has stopped doing it,
  // SESSION_USAGE_SPENT). The renew route then renews every grant with fresh counts. Absent under 80%.
  // `upgrade` (spec 007 T7): the renew route moves this account's approval to the on-chain action policy (v4): one
  // more tap, nothing moved. Absent when not offered. `upgradePolicy` (otto/mamoru#151): the policy id it moves to
  // (conservador-live-v4, or conservador-live-v5 on MamoruActionPolicyV2), so the row says what changes.
  // `paused` (otto/mamoru#151): MamoruActionPolicyV2's guardian has paused the account; a renewal would end that pause.
  // `policyId`: the account's own policy, what a renewal that moves nothing renews.
  approval?: {
    validUntil: number; renewDue: boolean; expired: boolean; missing?: number; upgrade?: boolean; upgradePolicy?: string; paused?: boolean; policyId?: string
    usage?: { action: 'collect' | 'rerange' | 'enter'; pool: string | null; usedBps: number; spent: boolean }
  } | null
  positions: {
    tokenId: string; pool: string; liquidity: string; inRange: boolean; amountUsdc: string; amountCbbtc: string
    amounts?: { token: string; amount: string; decimals: number; valueUsdc?: string }[]   // both sides of any pool, base units, each with its value in USDC
    valueUsdc?: string                                                  // position value in USDC base units
  }[]
  // What the engine is doing right now, for a subtle progress line in Working capital.
  progress?: { step: 'deploying' | 'activating' | 'swapping' | 'opening' | 'rebalancing' | 'reranging' | 'closing' | 'withdrawing'; pool?: string; since: string } | null
}

// GET /api/accounts/:accountKey/yield -> YieldLedgerView (otto/mamoru#129): what the yield ledger knows so far,
// read from D1 (account_snapshot_latest, account_daily, yield_ledger_position_daily — migrations/d1/0010_yield_ledger.sql).
// A null field is not_observed, never a fabricated zero: every field stays null until the Worker's cron
// (the `yield_ledger` ops flag on) has pulled at least one operator snapshot for this account. `collectedUsd`
// and `gasPaidWei` specifically stay null until a harvest/close_position receipt is known for this account (none has fired on
// any account yet, otto/mamoru#129 research 15 Oct); `earnedSoFarUsd` folds a null collected in as 0, which is
// accurate for every account's real history today but will need a receipt tracker once a harvest actually lands.
export type YieldLedgerView = {
  asOf: string | null // ISO, the latest pulled snapshot this is built from
  accruedUsd: string | null // uncollected fees right now, USDC base units (yield only, never owed principal)
  collectedUsd: string | null // lifetime fees collected (harvest, close), USDC base units; null until any receipt exists
  earnedSoFarUsd: string | null // accruedUsd + collectedUsd, USDC base units: the figure "earned so far" shows
  gasPaidWei: string | null // lifetime gas Mamoru paid for this account's ops, wei; shown separately, never subtracted from earnedSoFarUsd
  valueVsHoldUsd: string | null // today's (position value + accrued) minus the hold baseline, summed over positions, USDC base units; can be negative
  feeAccruedUsd: string | null // #108 readiness: 10% of collectedUsd, stored, never charged by anything that reads this
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
// POST /api/accounts/:accountKey/transfer           body: OwnerSignature -> OpView | 409 PRICE_DIVERGENCE_STALE
// Frees USDC by reducing positions if idle USDC is short (engine), then the owner transfer. The reduce step runs
// BEFORE the owner transfer and is engine-executed, not part of the signed ownerTx — see PriceDivergenceLeg.minAmount
// below for what that means for a 'swap-back' leg's floor. PRICE_DIVERGENCE_STALE: the submit carried an
// acceptDivergence whose quote the price has since moved past; nothing was sent and nothing was refused outright
// (otto/mamoru#155). "Nothing was sent" has to be true of the WHOLE withdrawal, reduce included: the operator must
// run the staleness check, and must have decided to answer STALE, before the engine executes any reduce for this
// request — never partially execute a withdrawal that is about to be told to wait. On STALE the operator also
// discards the prior prepareId's already-signed safeTxHash (the re-prepare should reuse the same Safe nonce) so
// that old, still-validly-signed transaction can never later be executed on its own, even if the owner never
// resubmits — the app re-prepares and shows the fresh PriceDivergenceWarning; the owner tapping "Wait" must be a
// real wait, not a signed transaction left live in the background.
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

// otto/mamoru#155: a withdrawal (the reduce swap-back into USDC, or the payout swap for EURC/ETH/JPYC) that
// would execute meaningfully below the fair price over the last 30 minutes. Never a refusal: prepare still
// returns a plan the owner can sign, carrying this warning so they can choose to wait or accept the quote
// as-is. One leg per diverging swap (usually one; a reduce-then-payout withdrawal can have two).
//
// 'swap-back': reduce converts a position's volatile side back into USDC inside the Safe; the recipient still
// gets the unaffected, fixed transfer amount — the shortfall lands on the account's remaining USDC balance, not
// on what the recipient receives. `token` is the swap's output (USDC) and `sellToken` names what is sold (e.g.
// 'cbBTC'). 'payout': the USDC-to-(EURC|ETH|JPYC) swap whose output IS what the recipient receives — the
// shortfall is what they get less of. `token` is the payout asset; `sellToken` is not set (the source is always
// USDC, per TransferRequest above).
export type PriceDivergenceLeg = {
  kind: 'swap-back' | 'payout'
  token: string // this leg's output, in registry-token-name form: USDC for swap-back, the payout asset for payout
  // REQUIRED and non-empty for 'swap-back' (what is being sold, e.g. 'cbBTC'); absent for 'payout' (the source
  // is always USDC). The app's client boundary rejects a 'swap-back' leg without it — the notice has nothing
  // honest to say for "from selling ___" otherwise, and must not guess by naming `token` (the leg's own OUTPUT)
  // instead (otto/mamoru#155, final Codex gate on 063332d).
  sellToken?: string
  decimals: number
  fairAmount: string // base units: what this leg gives at the 30-minute fair price
  // base units: the live quote at prepare time. Informational only — NOT the binding floor and not what the
  // app shows or computes shortfall from; see `minAmount`.
  quotedAmount: string
  // base units: the floor the operator commits to for this leg.
  // - 'payout' leg: the router's amountOutMinimum baked into ownerTx's already-signed calldata. The owner's
  //   passkey signature binds this on-chain; the operator cannot loosen it without invalidating that signature.
  // - 'swap-back' leg: the reduce step is engine-executed, not part of ownerTx (see the /transfer route comment
  //   above). The owner's signature does NOT bind this floor. It is an operator commitment, enforced by the
  //   engine using exactly the accepted quoteId's minAmount for the reduce it runs — the same trust the engine's
  //   other automated actions already carry, not a new cryptographic guarantee. The app cannot verify this side
  //   and shows "at least" the same way regardless of kind; it is honest about the number, not about who enforces it.
  // Either way, `shortfall`/`shortfallBps` the app computes are against this minimum, not against `quotedAmount`
  // (the quote can only get worse by the time the owner acts; the minimum is the committed worst case) — and the
  // app re-derives both from `fairAmount`/`minAmount` itself rather than trusting `shortfall`/`shortfallBps`
  // below as sent (otto/mamoru#155, security review on 1c54819): those two fields are kept for the operator's own
  // bookkeeping/logs, not as the app's source of truth.
  minAmount: string
  // base units: SHOULD be fairAmount - minAmount, operator-computed, for its own logs — but the app treats this
  // as advisory only (otto/mamoru#155, security review on 1c54819): it re-derives its own fairAmount-minAmount
  // difference and shows the larger (worse) of that and this field, so an operator bug that under-reports here
  // (computing against quotedAmount instead of minAmount, say) cannot understate what the owner sees.
  shortfall: string
  // basis points, SHOULD be shortfall / fairAmount, operator-computed — likewise advisory only. The app computes
  // its own percentage from the shortfall it already settled on above, ceiled, never truncated, so this field
  // cannot cause the shown amount and the shown percentage to disagree, and cannot flatten a real sub-1bp loss
  // to a misleading "0%".
  shortfallBps: number
}
export type PriceDivergenceWarning = {
  code: 'PRICE_DIVERGENCE'
  legs: PriceDivergenceLeg[] // at least one
  shortfallUsdc: string // total worst-case shortfall across every leg (from each leg's minAmount), converted to USDC base units
  // Identifies the exact quote baked into ownerTx's calldata (the amounts above and the router minimum are
  // already fixed at prepare time). Echoed back in OwnerSignature.acceptDivergence on submit; the operator
  // treats a missing or mismatched quoteId while a warning is on file as not accepted, and executes at exactly
  // this quoteId's minAmount per leg, never a looser one. The operator MUST mint a fresh quoteId on every
  // prepare — never reuse one across two different warnings, even where the numbers happen to match exactly.
  // The app does not rely on quoteId alone to invalidate a stale on-screen acceptance (it keys that to the
  // warning object from the specific prepare response), but a reused quoteId would still defeat the operator's
  // own ability to tell which exact numbers were accepted, so it must stay unique per prepare regardless.
  quoteId: string
}
export type TransferPlan = {
  reduce: { tokenId: string; liquidityBps: number }[]
  receive?: { asset: WithdrawAsset; quoted: string; minimum: string; decimals: number; route: string }
  ownerTx: OwnerTxToSign
  // Present only when the quote prices meaningfully below the fair price. Absent for every prepare within
  // tolerance, and absent entirely from an operator built before this field existed — the app then behaves
  // exactly as it does today (otto/mamoru#155).
  divergence?: PriceDivergenceWarning
}
// GET /api/accounts/:accountKey/withdraw-assets -> { assets: { asset: WithdrawAsset; available: boolean; reason?: string }[] }
export type OwnerTxToSign = {
  safe: Hex0x
  chainId: number
  safeTxHash: Hex0x        // the passkey signs this (WebAuthn challenge)
  summary: string[]        // human lines shown before signing
  expiresAt: string
  prepareId: string
  policyId?: string        // renew (otto/mamoru#151): the policy the summary describes; the row shows it only while it is still the offered one
  move?: boolean           // renew: it moves the account to another policy (true) or renews the account's own (false)
}
// WebAuthn assertion for SafeWebAuthnSharedSigner (base64url fields as returned by the browser).
export type OwnerSignature = {
  prepareId: string
  authenticatorData: string
  clientDataJSON: string
  signature: string        // DER, base64url
  // otto/mamoru#155, transfer only: the owner explicitly accepted the PriceDivergenceWarning this prepare
  // returned. quoteId must match TransferPlan.divergence.quoteId for this prepareId; the operator executes
  // at exactly that warning's per-leg minAmount, never a looser one. This is a CONSENT GATE, not itself part
  // of the signed payload above (the passkey signs safeTxHash, not this field): for a 'payout' leg the
  // accepted minAmount is independently enforced by what is already baked into that signed calldata, but for
  // a 'swap-back' leg (see PriceDivergenceLeg.minAmount) there is no signature binding it — only the engine
  // honoring the accepted quoteId. Absent on every submit that carried no warning, and on every other kind —
  // an operator that never emits PriceDivergenceWarning never looks at this field.
  acceptDivergence?: { quoteId: string }
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
  /**
   * The plan's pools behind the blended figures above, each with its bucket weight (basis points, sums to
   * 10000) and its own current/monthly APY (null when that one pool has no data). Absent only for a response
   * from an app version before this field existed. otto/mamoru#132.
   */
  byPool?: { pool: string; weight: number; currentPct: number | null; monthlyPct: number | null }[]
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
