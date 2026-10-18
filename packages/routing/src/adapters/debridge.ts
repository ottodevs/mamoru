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
// Every field below is treated as untrusted input from a third-party API, not as a correct answer: the target
// contract is pinned to the one address this adapter has actually observed (refused otherwise), the native
// value DLN wants attached is cross-checked against the fee the response itself separately declares and capped
// (never just trusted), and the response's own echoed chain ids are cross-checked against the request.
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

/** The DLN order-creation entrypoint this adapter will ever call. Confirmed identical — not merely similar — on
 * Ethereum, Base and Monad as the source chain (checked live 18 Oct 2026), consistent with a CREATE2 deployment
 * the same way CCTP's TokenMessengerV2 is. Any other `tx.to` the API returns is refused, not trusted. */
export const DEBRIDGE_DLN_SOURCE: Address = '0xeF4fB24aD0916217251F553c0596F8Edc630EB66'

/** A circuit breaker on the native-asset order-creation fee DLN asks the caller to attach as `tx.value`, in
 * addition to requiring it exactly match the response's own separately-declared `fixFee` (defense in depth: a
 * provider or a MITM response cannot inflate `value` without also inflating `fixFee` to match, and this still
 * refuses if that declared fee itself is absurd). Generous enough to clear every native asset and fee size
 * observed this round (ETH: 0.001; Monad: 2 MON) while still catching an order of magnitude mistake or worse. */
export const MAX_NATIVE_VALUE_WEI = 5_000_000_000_000_000_000n // 5 of whatever the source chain's native asset is

/** How far `tx.value` may exceed `fixFee` (plus `amountIn` for an ETH-input order) before it is refused as
 * unexplained. Generous relative to the ~0.00013 ETH top-up observed live on a 0.01 ETH order (roughly 16x
 * headroom), tight relative to the absolute circuit breaker above. */
export const NATIVE_VALUE_SLACK_WEI = 2_000_000_000_000_000n // 0.002 of the source chain's native asset

/**
 * `fixFee` is checked against this REGARDLESS of asset, on top of the value/expected band above — not just
 * "value matches fixFee", but "fixFee itself is a plausible order-creation fee, not a disguised transfer".
 * Without this, a response that reports `fixFee = tx.value = 4 ETH` would otherwise pass (value matches the
 * fee it declares, and 4 ETH clears the 5 ETH circuit breaker) even though no real order-creation fee is ever
 * that large. Chain-scaled because the three native assets in scope are not comparable 1 wei to 1 wei: 50x
 * headroom over the 0.001 ETH observed on Ethereum/Base, 10x over the 2 MON observed on Monad (less margin —
 * less data on Monad's real range). A chain with no entry refuses rather than falling back to a guessed number.
 */
const MAX_FEE_WEI_BY_SOURCE_CHAIN: Readonly<Record<number, bigint>> = {
  1: 50_000_000_000_000_000n, // 0.05 ETH, 50x the observed 0.001 ETH
  8453: 50_000_000_000_000_000n, // 0.05 ETH, same basis — Base's fee was observed identical to Ethereum's
  143: 20_000_000_000_000_000_000n, // 20 MON, 10x the observed 2 MON
}

type DebridgeResponse = {
  estimation?: { srcChainTokenIn?: { chainId?: number }; dstChainTokenOut?: { chainId?: number; amount?: string } }
  order?: { approximateFulfillmentDelay?: number }
  tx?: { to?: string; data?: string; value?: string }
  fixFee?: string
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

    // Cross-check the response's own echoed chain ids against what was actually asked for — a provider or a
    // MITM response naming the wrong chain is refused here, before anything else is even read. Required, not
    // merely checked-when-present: every real response seen this round (Ethereum, Base and Monad as source)
    // echoed both, so an answer that omits either is treated the same as one that disagrees.
    const wantSrc = debridgeChainId(req.sourceChainId)
    const wantDst = debridgeChainId(req.destChainId)
    const gotSrc = resp.estimation?.srcChainTokenIn?.chainId
    const gotDst = resp.estimation?.dstChainTokenOut?.chainId
    if (gotSrc !== wantSrc) throw new RouteError('debridge', 'QUOTE_MALFORMED', `estimation names source chain ${gotSrc}, not the requested ${wantSrc}`)
    if (gotDst !== wantDst) throw new RouteError('debridge', 'QUOTE_MALFORMED', `estimation names destination chain ${gotDst}, not the requested ${wantDst}`)

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
    let fixFee: bigint
    try {
      target = getAddress(tx.to)
      value = tx.value ? BigInt(tx.value) : 0n
      fixFee = resp.fixFee ? BigInt(resp.fixFee) : 0n
    } catch {
      throw new RouteError('debridge', 'QUOTE_MALFORMED', 'bad target, value or fixFee field')
    }
    if (target !== DEBRIDGE_DLN_SOURCE) throw new RouteError('debridge', 'QUOTE_MALFORMED', `unexpected target contract ${target}`)
    // tx.value is the amount this adapter will attach as msg.value; never trust it on its own. For a USDC-input
    // order it should be exactly `fixFee` — confirmed live 18 Oct 2026. For an ETH-input order it is the bridged
    // principal (req.amountIn) *plus* fixFee, plus a small gas/slippage top-up DLN itself adds (observed live:
    // ~0.00013 ETH on a 0.01 ETH order) — not something this adapter can predict exactly, so it is bounded by
    // NATIVE_VALUE_SLACK_WEI instead of required to match exactly. Either way `value` can never fall short of
    // `expected` (that would mean the fee silently went missing) and never exceed it by more than the slack, and
    // the absolute circuit breaker still applies on top.
    const expected = (req.asset === 'ETH' ? req.amountIn : 0n) + fixFee
    if (value < expected) throw new RouteError('debridge', 'QUOTE_MALFORMED', `tx.value ${value} is less than the expected ${expected}`)
    if (value > expected + NATIVE_VALUE_SLACK_WEI) throw new RouteError('debridge', 'QUOTE_MALFORMED', `tx.value ${value} exceeds the expected ${expected} by more than the allowed slack`)
    if (value > MAX_NATIVE_VALUE_WEI) throw new RouteError('debridge', 'QUOTE_REFUSED', `native value ${value} exceeds the app policy bound`)
    // The fee component itself, independent of what `value` otherwise allows: a response cannot pass by
    // inflating `value` and `fixFee` together, consistently, to something the bands above would still accept.
    const feeCap = MAX_FEE_WEI_BY_SOURCE_CHAIN[req.sourceChainId]
    if (feeCap === undefined) throw new RouteError('debridge', 'UNSUPPORTED', `no verified fee cap for source chain ${req.sourceChainId}`)
    if (fixFee > feeCap) throw new RouteError('debridge', 'QUOTE_REFUSED', `declared fixFee ${fixFee} exceeds the app policy bound for this chain`)
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
