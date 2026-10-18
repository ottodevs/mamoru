import { getAddress, type Address, type Hex } from 'viem'
import { tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import { assertOwnerOnlyRecipient } from '../recipient.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. deBridge DLN (dln.debridge.finance), the "at least one more aggregator" adapter — picked over
// Bungee/Socket because its quote-and-build endpoint is confirmed genuinely keyless as of 18 Oct 2026 (50 req/min
// public tier). Owner-only, same decode-and-refuse discipline as relay.ts / lifi.ts; DLN echoes no recipient
// field of its own in the response to cross-check, so the calldata scan is the only check (still a refusal if it
// fails — see recipient.ts).
//
// DLN charges an order-creation fee in the source chain's *native* asset (`tx.value` below, `fixFee` in the
// response) on top of whatever it takes from the bridged token — Quote.value carries that through so a caller
// does not silently drop it when building the transaction.
//
// Verified live against dln.debridge.finance on 18 Oct 2026 (empirical response shape below) and
// docs.debridge.com/dln-the-debridge-liquidity-network-protocol/interacting-with-the-api,
// docs.debridge.com/home/architecture/supported-chains. Monad is supported but under a *different* id than its
// EVM chain id — see DEBRIDGE_CHAIN_ID below.

export const DEBRIDGE_QUOTE_URL = 'https://dln.debridge.finance/v1.0/dln/order/create-tx'
export const QUOTE_TIMEOUT_MS = 8_000
const DEFAULT_TTL_MS = 30_000

/** DLN's own internal chain id for Monad (143), per docs.debridge.com/home/architecture/supported-chains — not
 * Monad's EVM chain id. Any chain not listed here is passed through as its EVM chain id unchanged (true for
 * Ethereum and Base, confirmed live). */
const DEBRIDGE_CHAIN_ID: Readonly<Record<number, number>> = { 143: 100_000_030 }

function debridgeChainId(chainId: number): number {
  return DEBRIDGE_CHAIN_ID[chainId] ?? chainId
}

type DebridgeResponse = {
  estimation?: { dstChainTokenOut?: { amount?: string } }
  order?: { approximateFulfillmentDelay?: number }
  tx?: { to?: string; data?: string; value?: string }
  errorCode?: number
  errorMessage?: string
}

async function getQuote(fetcher: Fetch, params: Record<string, string>): Promise<DebridgeResponse> {
  const url = `${DEBRIDGE_QUOTE_URL}?${new URLSearchParams(params).toString()}`
  let res: Response
  try {
    res = await fetcher(url, { signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) })
  } catch {
    throw new RouteError('debridge', 'QUOTE_UNAVAILABLE', 'deBridge did not answer')
  }
  const body: unknown = await res.json().catch(() => undefined)
  if (typeof body !== 'object' || body === null) throw new RouteError('debridge', 'QUOTE_UNAVAILABLE', `deBridge returned ${res.status} with no readable body`)
  const parsed = body as DebridgeResponse
  if (!res.ok || parsed.errorCode !== undefined) throw new RouteError('debridge', 'QUOTE_REFUSED', parsed.errorMessage ?? `deBridge returned ${res.status}`)
  return parsed
}

export const debridgeAdapter: Adapter = {
  name: 'debridge',

  supports(req: QuoteRequest): boolean {
    if (req.sourceChainId === req.destChainId) return false
    return tokenAddress(req.asset, req.sourceChainId) !== undefined && tokenAddress(req.asset, req.destChainId) !== undefined
  },

  async quote(req: QuoteRequest, deps: AdapterDeps = {}): Promise<Quote> {
    if (!this.supports(req)) throw new RouteError('debridge', 'UNSUPPORTED', `${req.asset} ${req.sourceChainId}->${req.destChainId}`)
    if (req.amountIn <= 0n) throw new RouteError('debridge', 'BAD_AMOUNT', 'amountIn must be positive')
    const fetcher = deps.fetch ?? fetch
    const now = deps.now?.() ?? Date.now()
    const resp = await getQuote(fetcher, {
      srcChainId: String(debridgeChainId(req.sourceChainId)),
      srcChainTokenIn: tokenAddress(req.asset, req.sourceChainId)!,
      srcChainTokenInAmount: req.amountIn.toString(),
      dstChainId: String(debridgeChainId(req.destChainId)),
      dstChainTokenOut: tokenAddress(req.asset, req.destChainId)!,
      dstChainTokenOutAmount: 'auto',
      senderAddress: req.account,
      srcChainOrderAuthorityAddress: req.account,
      dstChainOrderAuthorityAddress: req.account,
      dstChainTokenOutRecipient: req.account,
      srcChainRefundAddress: req.account,
      prependOperatingExpenses: 'true',
    })

    const amountOutRaw = resp.estimation?.dstChainTokenOut?.amount
    if (!amountOutRaw) throw new RouteError('debridge', 'QUOTE_MALFORMED', 'missing estimation.dstChainTokenOut.amount')
    let amountOut: bigint
    try {
      amountOut = BigInt(amountOutRaw)
    } catch {
      throw new RouteError('debridge', 'QUOTE_MALFORMED', 'unparseable output amount')
    }
    if (amountOut <= 0n || amountOut > req.amountIn) throw new RouteError('debridge', 'QUOTE_MALFORMED', 'output amount out of range')

    const tx = resp.tx
    if (!tx?.to || !tx?.data) throw new RouteError('debridge', 'QUOTE_MALFORMED', 'missing tx.to/tx.data — pass sender and recipient addresses')
    let target: Address
    let value: bigint
    try {
      target = getAddress(tx.to)
      value = tx.value ? BigInt(tx.value) : 0n
    } catch {
      throw new RouteError('debridge', 'QUOTE_MALFORMED', 'bad target or value field')
    }
    const calldata = tx.data as Hex
    // DLN echoes no recipient field of its own to cross-check against; the calldata scan alone decides.
    assertOwnerOnlyRecipient('debridge', req.account, calldata)

    const etaSec = typeof resp.order?.approximateFulfillmentDelay === 'number' && resp.order.approximateFulfillmentDelay >= 0 ? resp.order.approximateFulfillmentDelay : 60

    return {
      provider: 'debridge',
      route: 'deBridge DLN',
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
