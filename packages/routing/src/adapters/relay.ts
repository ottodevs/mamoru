import { getAddress, type Address, type Hex } from 'viem'
import { tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import { calldataPinsRecipientAtWord, parseDeclaredAddress, wordAt } from '../recipient.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. Relay (relay.link) picks a solver/route per request — owner-only, with this adapter decoding
// and refusing before the owner ever sees it (see recipient.ts). Verified live against the v1 endpoint on 18 Oct
// 2026 (empirical response shape below); docs.relay.link's v2 page now states v2 requires an API key as of 2 Oct
// 2026 — this adapter stays on v1 to keep the "no paid APIs" rule, flagged in docs/research/routing-2026-10.md
// as a risk if v1 is retired the same way.
//
// Unlike LI.FI and deBridge, Relay's final deposit step was observed, live, going to the *same* target contract
// and placing the recipient at the *same* word-0 offset across every combination checked (ERC20 and native
// input; Ethereum, Base and Monad as origin). That is strong enough empirical grounding to pin both: the target
// is refused if it is ever anything else, and the recipient check is the exact-offset equivalent of a
// `UniActionPolicy` EQUAL rule (`calldataPinsRecipientAtWord`), not the generic any-word scan LI.FI/deBridge
// still rely on. If Relay ever changes this and `target`/`word 0` diverge, every quote fails closed, not open.

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

type RelayStepItem = { data?: { to?: string; data?: string; value?: string } }
type RelayStep = { items?: RelayStepItem[] }
type RelayQuoteResponse = {
  details?: { currencyOut?: { amount?: string }; recipient?: string; timeEstimate?: number }
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

/** The final action's call — the one that actually moves funds, as opposed to an earlier ERC20 `approve` step
 * (which carries a spender, not the end recipient). Relay orders `steps` in execution order; the last step's last
 * item is the one this adapter checks and signs. */
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

/**
 * When Relay's plan starts with an ERC20 `approve` step (an ERC20-input order; a native-input one has none —
 * observed live 18 Oct 2026 on every chain checked), that approval must name `RELAY_DEPOSIT_TARGET` as spender
 * and `amountIn` as the amount — not merely some spender and some amount. A response that tried to get the
 * owner to approve a different contract, or more than was quoted, is refused here before anything else runs.
 * No approve step at all is fine (native input); a step whose calldata doesn't match `approve`'s known fixed
 * shape is not.
 */
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
    const declared = parseDeclaredAddress(resp.details?.recipient)
    if (declared !== undefined && getAddress(declared) !== getAddress(req.account)) throw new RouteError('relay', 'RECIPIENT_REFUSED', `declared recipient ${declared} is not the account ${req.account}`)
    if (!calldataPinsRecipientAtWord(calldata, req.account, 0)) throw new RouteError('relay', 'RECIPIENT_REFUSED', 'the account is not word 0 of the deposit call, where it was always observed to be')

    const etaSec = typeof resp.details?.timeEstimate === 'number' && resp.details.timeEstimate >= 0 ? resp.details.timeEstimate : DEFAULT_ETA_SEC

    return {
      provider: 'relay',
      route: 'Relay',
      amountIn: req.amountIn,
      amountOut,
      fee: req.amountIn - amountOut,
      etaSec,
      target,
      calldata,
      value,
      recipientCheck: 'decoded-calldata',
      mode: 'owner-only',
      expiresAt: new Date(now + DEFAULT_TTL_MS).toISOString(),
    }
  },
}
