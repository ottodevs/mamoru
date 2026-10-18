import { getAddress, type Address, type Hex } from 'viem'
import { tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import { assertOwnerOnlyRecipient, parseDeclaredAddress } from '../recipient.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. LI.FI (li.quest) aggregates many bridges/DEXs and picks one per request — owner-only, same
// decode-and-refuse discipline as relay.ts. LI.FI charges a documented 0.25% service fee on top of whatever the
// underlying route costs (docs.li.fi/overview/faq), which shows up simply as a smaller `amountOut` here; this
// adapter does not special-case it.
//
// Verified live against li.quest/v1/quote on 18 Oct 2026 (empirical response shape below) and
// docs.li.fi/li.fi-api/li.fi-api/requesting-a-quote/token-transfer, docs.li.fi/api-reference/rate-limits
// (unauthenticated: 75 req/2h, enough for occasional quoting and the smoke script, not for polling).

export const LIFI_QUOTE_URL = 'https://li.quest/v1/quote'
export const QUOTE_TIMEOUT_MS = 8_000
/** LI.FI does not publish a quote validity window either; same conservative default as relay.ts. */
const DEFAULT_TTL_MS = 30_000

type LifiQuoteResponse = {
  action?: { toAddress?: string }
  estimate?: { toAmount?: string; executionDuration?: number }
  transactionRequest?: { to?: string; data?: string; value?: string }
}

async function getQuote(fetcher: Fetch, params: Record<string, string>): Promise<LifiQuoteResponse> {
  const url = `${LIFI_QUOTE_URL}?${new URLSearchParams(params).toString()}`
  let res: Response
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) })
  } catch {
    throw new RouteError('lifi', 'QUOTE_UNAVAILABLE', 'LI.FI did not answer')
  }
  if (!res.ok) throw new RouteError('lifi', 'QUOTE_UNAVAILABLE', `LI.FI returned ${res.status}`)
  const body: unknown = await res.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null) throw new RouteError('lifi', 'QUOTE_MALFORMED', 'expected a JSON object')
  return body as LifiQuoteResponse
}

export const lifiAdapter: Adapter = {
  name: 'lifi',

  supports(req: QuoteRequest): boolean {
    if (req.sourceChainId === req.destChainId) return false
    return tokenAddress(req.asset, req.sourceChainId) !== undefined && tokenAddress(req.asset, req.destChainId) !== undefined
  },

  async quote(req: QuoteRequest, deps: AdapterDeps = {}): Promise<Quote> {
    if (!this.supports(req)) throw new RouteError('lifi', 'UNSUPPORTED', `${req.asset} ${req.sourceChainId}->${req.destChainId}`)
    if (req.amountIn <= 0n) throw new RouteError('lifi', 'BAD_AMOUNT', 'amountIn must be positive')
    const fetcher = deps.fetch ?? fetch
    const now = deps.now?.() ?? Date.now()
    const resp = await getQuote(fetcher, {
      fromChain: String(req.sourceChainId),
      toChain: String(req.destChainId),
      fromToken: tokenAddress(req.asset, req.sourceChainId)!,
      toToken: tokenAddress(req.asset, req.destChainId)!,
      fromAmount: req.amountIn.toString(),
      fromAddress: req.account,
      toAddress: req.account,
    })

    const amountOutRaw = resp.estimate?.toAmount
    if (!amountOutRaw) throw new RouteError('lifi', 'QUOTE_MALFORMED', 'missing estimate.toAmount')
    let amountOut: bigint
    try {
      amountOut = BigInt(amountOutRaw)
    } catch {
      throw new RouteError('lifi', 'QUOTE_MALFORMED', 'unparseable output amount')
    }
    if (amountOut <= 0n || amountOut > req.amountIn) throw new RouteError('lifi', 'QUOTE_MALFORMED', 'output amount out of range')

    const tx = resp.transactionRequest
    if (!tx?.to || !tx?.data) throw new RouteError('lifi', 'QUOTE_MALFORMED', 'missing transactionRequest')
    let target: Address
    try {
      target = getAddress(tx.to)
    } catch {
      throw new RouteError('lifi', 'QUOTE_MALFORMED', 'bad target address')
    }
    const calldata = tx.data as Hex
    let value = 0n
    try {
      value = tx.value ? BigInt(tx.value) : 0n
    } catch {
      throw new RouteError('lifi', 'QUOTE_MALFORMED', 'bad value field')
    }
    assertOwnerOnlyRecipient('lifi', req.account, calldata, parseDeclaredAddress(resp.action?.toAddress))

    const etaSec = typeof resp.estimate?.executionDuration === 'number' && resp.estimate.executionDuration >= 0 ? resp.estimate.executionDuration : 60

    return {
      provider: 'lifi',
      route: 'LI.FI',
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
