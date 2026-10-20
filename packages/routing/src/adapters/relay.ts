import { getAddress, type Address, type Hex } from 'viem'
import { tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import { wordAt } from '../recipient.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. Relay (relay.link) picks a solver/route per request. Verified live against the v1 endpoint
// on 18 Oct 2026 (empirical response shape below); docs.relay.link's v2 page now states v2 requires an API key
// as of 2 Oct 2026 — this adapter stays on v1 to keep the "no paid APIs" rule, flagged in
// docs/research/routing-2026-10.md as a risk if v1 is retired the same way.
//
// otto/mamoru#181 CORRECTION (review round 3, 20 Oct 2026): an earlier version of this adapter pinned "word 0
// of the deposit calldata" as the recipient and treated Relay as owner-only with recipientCheck
// 'decoded-calldata'. That was wrong. Tested live with a DIFFERENT `user` and `recipient` in the same quote
// request (0x5555...->user, 0x6666...->recipient): word 0 is the DEPOSITOR (0x5555...), and the recipient
// (0x6666...) does not appear anywhere in the deposit calldata at all — Relay tracks the destination off-chain,
// correlated by the opaque request-id word that follows. Every earlier test had `user === recipient`, which
// made "this is the depositor" and "this is the recipient" indistinguishable; that confound is exactly what
// produced the wrong conclusion. (LI.FI and deBridge were re-tested the same way after this was found: both DO
// carry the real recipient in their calldata with distinct sender/recipient values — see their test files —
// so they keep `recipientCheck: 'decoded-calldata'`. Relay alone fails this test.)
//
// Per the project's rule — if the destination recipient cannot be verified, the route is not offered — Relay is
// now quote-only: a price point for comparison, `recipientCheck: 'none'`, `calldata` and `value` always
// undefined so nothing here can be mistaken for something safe to sign. `target` is still reported as
// descriptive metadata (which contract Relay would use), never as "safe to call with this calldata".
//
// The decode-and-refuse check this adapter still runs isn't about the recipient — it never could verify that —
// it is a quality gate on the OUTPUT NUMBER: this adapter decodes the deposit calldata's embedded token and
// amount (and the attached native value) and refuses the whole quote if they don't match the request, so a
// comparison against the other adapters' amountOut is never built on a mismatched quantity.

export const RELAY_QUOTE_URL = 'https://api.relay.link/quote'
/** The only deposit target observed across Ethereum/Base/Monad origin, ERC20 and native input (18 Oct 2026). */
export const RELAY_DEPOSIT_TARGET: Address = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
export const QUOTE_TIMEOUT_MS = 8_000
/** Relay does not publish a quote validity window; this is a conservative app-side default — solver prices move
 * faster than CCTP's or Across's. */
const DEFAULT_TTL_MS = 30_000
/** Relay's docs do not confirm an ETA field; used only if the response omits `details.timeEstimate` (it did not,
 * in the 18 Oct 2026 sample this adapter was built against). */
const DEFAULT_ETA_SEC = 60

/** `depositV3`/`deposit`-style ERC20 call: selector, then depositor, token, amount, request id. Confirmed live
 * 18 Oct 2026 — word 1 is the input token, word 2 is the amount. */
const ERC20_SELECTOR = '0xe8017952'
/** Native-asset deposit: selector, then depositor, request id. No token or amount word — the amount is
 * `msg.value`, confirmed exactly equal to the requested amount (no top-up, unlike deBridge). */
const NATIVE_SELECTOR = '0x49290c1c'

type RelayStepItem = { data?: { to?: string; data?: string; value?: string } }
type RelayStep = { items?: RelayStepItem[] }
type RelayQuoteResponse = {
  details?: { currencyOut?: { amount?: string }; timeEstimate?: number }
  steps?: RelayStep[]
}

async function postQuote(fetcher: Fetch, body: Record<string, unknown>): Promise<RelayQuoteResponse> {
  let res: Response
  try {
    res = await fetcher(RELAY_QUOTE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) })
  } catch {
    throw new RouteError('relay', 'QUOTE_UNAVAILABLE', 'Relay did not answer')
  }
  if (!res.ok) throw new RouteError('relay', 'QUOTE_UNAVAILABLE', `Relay returned ${res.status}`)
  const body2: unknown = await res.json().catch(() => undefined)
  if (typeof body2 !== 'object' || body2 === null) throw new RouteError('relay', 'QUOTE_MALFORMED', 'expected a JSON object')
  return body2 as RelayQuoteResponse
}

/** The final action's call — the one that actually moves funds, as opposed to an earlier ERC20 `approve` step. */
function finalCall(resp: RelayQuoteResponse): { target: Address; calldata: Hex; value: bigint } {
  const data = resp.steps?.at(-1)?.items?.at(-1)?.data
  if (!data?.to || !data?.data) throw new RouteError('relay', 'QUOTE_MALFORMED', 'missing steps[].items[].data')
  let target: Address
  try {
    target = getAddress(data.to)
  } catch {
    throw new RouteError('relay', 'QUOTE_MALFORMED', 'bad target address')
  }
  let value = 0n
  try {
    value = data.value ? BigInt(data.value) : 0n
  } catch {
    throw new RouteError('relay', 'QUOTE_MALFORMED', 'bad value field')
  }
  return { target, calldata: data.data as Hex, value }
}

/** `approve(address spender, uint256 amount)`'s selector — only form this adapter will ever accept for a leading
 * approve step. */
const APPROVE_SELECTOR = '0x095ea7b3'

/** When Relay's plan starts with an ERC20 `approve` step (an ERC20-input order; a native-input one has none),
 * that approval must name `RELAY_DEPOSIT_TARGET` as spender and `amountIn` as the amount. */
function checkLeadingApprove(resp: RelayQuoteResponse, amountIn: bigint): void {
  const steps = resp.steps ?? []
  if (steps.length < 2) return // native input: no approve step to check
  const first = steps[0]?.items?.[0]?.data
  if (first?.data === undefined) throw new RouteError('relay', 'QUOTE_MALFORMED', 'missing leading approve calldata')
  if (!first.data.toLowerCase().startsWith(APPROVE_SELECTOR)) throw new RouteError('relay', 'QUOTE_MALFORMED', 'leading step is not a plain ERC20 approve')
  const spenderWord = wordAt(first.data as Hex, 0)
  const amountWord = wordAt(first.data as Hex, 1)
  if (spenderWord === undefined || amountWord === undefined) throw new RouteError('relay', 'QUOTE_MALFORMED', 'malformed approve calldata')
  if (spenderWord !== RELAY_DEPOSIT_TARGET.slice(2).toLowerCase().padStart(64, '0')) throw new RouteError('relay', 'QUOTE_MALFORMED', 'approve names a spender other than the deposit target')
  if (BigInt(`0x${amountWord}`) !== amountIn) throw new RouteError('relay', 'QUOTE_MALFORMED', 'approve amount does not match amountIn')
}

/**
 * Decodes the deposit call itself and refuses unless it genuinely matches the request: the right selector for
 * the asset, the right token and amount (ERC20 case) embedded in the calldata, and the right native value (0
 * for ERC20; exactly `amountIn` for native — Relay adds no top-up, confirmed live, unlike deBridge). This never
 * touches the recipient question — see the module comment — it only makes sure the quoted amountOut is priced
 * against the transaction that was actually asked for.
 */
function checkDepositMatchesRequest(req: QuoteRequest, calldata: Hex, value: bigint): void {
  const selector = calldata.slice(0, 10).toLowerCase()
  if (req.asset === 'ETH') {
    if (selector !== NATIVE_SELECTOR) throw new RouteError('relay', 'QUOTE_MALFORMED', `expected a native deposit selector, got ${selector}`)
    if (value !== req.amountIn) throw new RouteError('relay', 'QUOTE_MALFORMED', `native value ${value} does not match amountIn ${req.amountIn}`)
    return
  }
  if (selector !== ERC20_SELECTOR) throw new RouteError('relay', 'QUOTE_MALFORMED', `expected the ERC20 deposit selector, got ${selector}`)
  if (value !== 0n) throw new RouteError('relay', 'QUOTE_MALFORMED', `an ERC20 deposit must attach no native value, got ${value}`)
  const tokenWord = wordAt(calldata, 1)
  const amountWord = wordAt(calldata, 2)
  if (tokenWord === undefined || amountWord === undefined) throw new RouteError('relay', 'QUOTE_MALFORMED', 'malformed deposit calldata')
  const expectedToken = tokenAddress(req.asset, req.sourceChainId)
  if (expectedToken === undefined) throw new RouteError('relay', 'UNSUPPORTED', `no token address for ${req.asset} on chain ${req.sourceChainId}`)
  if (tokenWord !== expectedToken.slice(2).toLowerCase().padStart(64, '0')) throw new RouteError('relay', 'QUOTE_MALFORMED', 'deposit names a token other than the one requested')
  if (BigInt(`0x${amountWord}`) !== req.amountIn) throw new RouteError('relay', 'QUOTE_MALFORMED', 'deposit amount does not match amountIn')
}

export const relayAdapter: Adapter = {
  name: 'relay',

  supports(req: QuoteRequest): boolean {
    if (req.sourceChainId === req.destChainId) return false
    return tokenAddress(req.asset, req.sourceChainId) !== undefined && tokenAddress(req.asset, req.destChainId) !== undefined
  },

  async quote(req: QuoteRequest, deps: AdapterDeps = {}): Promise<Quote> {
    if (!this.supports(req)) throw new RouteError('relay', 'UNSUPPORTED', `${req.asset} ${req.sourceChainId}->${req.destChainId}`)
    if (req.amountIn <= 0n) throw new RouteError('relay', 'BAD_AMOUNT', 'amountIn must be positive')
    const fetcher = deps.fetch ?? fetch
    const now = deps.now?.() ?? Date.now()
    const resp = await postQuote(fetcher, {
      user: req.account,
      originChainId: req.sourceChainId,
      destinationChainId: req.destChainId,
      originCurrency: tokenAddress(req.asset, req.sourceChainId),
      destinationCurrency: tokenAddress(req.asset, req.destChainId),
      amount: req.amountIn.toString(),
      tradeType: 'EXACT_INPUT',
      recipient: req.account,
      refundTo: req.account,
    })

    const amountOutRaw = resp.details?.currencyOut?.amount
    if (!amountOutRaw) throw new RouteError('relay', 'QUOTE_MALFORMED', 'missing details.currencyOut.amount')
    let amountOut: bigint
    try {
      amountOut = BigInt(amountOutRaw)
    } catch {
      throw new RouteError('relay', 'QUOTE_MALFORMED', 'unparseable output amount')
    }
    if (amountOut <= 0n || amountOut > req.amountIn) throw new RouteError('relay', 'QUOTE_MALFORMED', 'output amount out of range')
    checkLeadingApprove(resp, req.amountIn)

    const { target, calldata, value } = finalCall(resp)
    if (target !== getAddress(RELAY_DEPOSIT_TARGET)) throw new RouteError('relay', 'QUOTE_MALFORMED', `unexpected target contract ${target}`)
    checkDepositMatchesRequest(req, calldata, value)

    const etaSec = typeof resp.details?.timeEstimate === 'number' && resp.details.timeEstimate >= 0 ? resp.details.timeEstimate : DEFAULT_ETA_SEC

    return {
      provider: 'relay',
      route: 'Relay',
      sourceChainId: req.sourceChainId,
      destChainId: req.destChainId,
      asset: req.asset,
      amountIn: req.amountIn,
      amountOut,
      fee: req.amountIn - amountOut,
      etaSec,
      target,
      // No calldata, no value: Relay's deposit carries no on-chain destination recipient at all (see module
      // comment) — this is a price point, never something to sign.
      recipientCheck: 'none',
      mode: 'owner-only',
      expiresAt: new Date(now + DEFAULT_TTL_MS).toISOString(),
    }
  },
}
