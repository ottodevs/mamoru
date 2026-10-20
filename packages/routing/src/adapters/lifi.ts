import { getAddress, type Address } from 'viem'
import { chainConfig, tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. LI.FI (li.quest) aggregates many bridges/DEXs and picks a different underlying facet per
// request. LI.FI charges a documented 0.25% service fee on top of whatever the underlying route costs
// (docs.li.fi/overview/faq), which shows up simply as a smaller `amountOut` here; this adapter does not
// special-case it.
//
// otto/mamoru#181 DECISION (coordinator, 20 Oct 2026, after a sixth review round): LI.FI is a price oracle only
// — `recipientCheck: 'none'`, `calldata`/`value` are NEVER returned, this route is never executable. Earlier
// rounds tried to certify LI.FI's recipient by decoding its facet calldata: first a generic "scan the
// calldata for the account" (broke the same way Relay's and deBridge's did — see their module comments), then
// a generic "decode the first struct as `ILiFi.BridgeData`" (a parser-differential risk: decode success proves
// nothing about what the actually-dispatched selector does), then an allowlist of the one specific facet
// selector (`swapAndStartBridgeTokensViaPolymerCCTP`) verified safe by reading its real on-chain source. Each
// fix address a real, specific finding — and each round's reviewer kept finding the next layer underneath it
// (insufficient validation of facet-specific destination-override fields, a trust boundary on contract
// semantics this adapter cannot keep re-verifying every time LI.FI adds or changes a facet). Stopping here: the
// facet-decoding code is removed from the package entirely, not left dormant. LI.FI was the worst-priced
// owner-only quote on every live direction checked throughout this ticket (consistently ~149.625 USDC on 150,
// against Relay's ~149.96 and deBridge's ~149.88) — it is kept only as a price point for comparison, same
// footing as Relay and deBridge, costing nothing to keep and nothing lost by never trusting its calldata.
//
// Still validated — not because it proves a recipient, but because it keeps the QUOTED PRICE trustworthy for
// comparison against every other adapter: the target contract per origin chain (LI.FI's target is NOT the
// same on every chain — the standard LiFiDiamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` on Ethereum/Base,
// a different executor on Monad, confirmed live 18 Oct 2026), the output amount, and the attached native value
// (0 for an ERC20-input order; `amountIn` plus a small bounded slack for a native-input one, confirmed live:
// LI.FI attached exactly `amountIn` with no top-up).
//
// Verified live against li.quest/v1/quote on 18 and 20 Oct 2026.

export const LIFI_QUOTE_URL = 'https://li.quest/v1/quote'
export const QUOTE_TIMEOUT_MS = 8_000
/** LI.FI does not publish a quote validity window either; same conservative default as relay.ts. */
const DEFAULT_TTL_MS = 30_000

/** How far a native-input `value` may exceed `amountIn` before it is refused as unexplained. LI.FI attached
 * exactly `amountIn` in every sample checked (no top-up); this exists only in case some route adds a small
 * one, the same caution deBridge's equivalent bound applies for. */
const NATIVE_VALUE_SLACK_WEI = 1_000_000_000_000_000n // 0.001 of the source chain's native asset

/** The only `transactionRequest.to` observed for a quote whose source chain is the given id (18 Oct 2026).
 * Ethereum and Base share the standard LiFiDiamond; Monad does not. Any chain not in this table is refused by
 * `supports`, not silently allowed through with an unverified target. */
const LIFI_TARGET_BY_SOURCE_CHAIN: Readonly<Record<number, Address>> = {
  1: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  8453: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  143: '0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37',
}

type LifiQuoteResponse = {
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
    if (LIFI_TARGET_BY_SOURCE_CHAIN[req.sourceChainId] === undefined) return false
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
    let value: bigint
    try {
      target = getAddress(tx.to)
      value = tx.value ? BigInt(tx.value) : 0n
    } catch {
      throw new RouteError('lifi', 'QUOTE_MALFORMED', 'bad target or value field')
    }
    const expectedTarget = LIFI_TARGET_BY_SOURCE_CHAIN[req.sourceChainId]
    if (expectedTarget === undefined || target !== getAddress(expectedTarget)) throw new RouteError('lifi', 'QUOTE_MALFORMED', `unexpected target contract ${target} for source chain ${req.sourceChainId}`)

    // Native value: 0 for an ERC20-input order; amountIn (plus a small bounded slack) for a native-input one.
    // This protects the quoted price's plausibility, nothing about the recipient — see the module comment.
    const sourceIsNative = chainConfig(req.sourceChainId)?.nativeAsset === req.asset
    if (sourceIsNative) {
      if (value < req.amountIn || value > req.amountIn + NATIVE_VALUE_SLACK_WEI) throw new RouteError('lifi', 'QUOTE_MALFORMED', `native value ${value} is not amountIn ${req.amountIn} (plus the allowed slack)`)
    } else if (value !== 0n) {
      throw new RouteError('lifi', 'QUOTE_MALFORMED', `an ERC20-input order must attach no native value, got ${value}`)
    }

    const etaSec = typeof resp.estimate?.executionDuration === 'number' && resp.estimate.executionDuration >= 0 ? resp.estimate.executionDuration : 60

    return {
      provider: 'lifi',
      route: 'LI.FI',
      sourceChainId: req.sourceChainId,
      destChainId: req.destChainId,
      asset: req.asset,
      amountIn: req.amountIn,
      amountOut,
      fee: req.amountIn - amountOut,
      etaSec,
      target,
      // Price-oracle only: never calldata or value a caller could mistake for something safe to sign.
      calldata: undefined,
      value: undefined,
      recipientCheck: 'none',
      mode: 'owner-only',
      expiresAt: new Date(now + DEFAULT_TTL_MS).toISOString(),
    }
  },
}
