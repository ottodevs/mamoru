import { decodeAbiParameters, getAddress, parseAbiParameters, type Address, type Hex } from 'viem'
import { chainConfig, tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import { parseDeclaredAddress } from '../recipient.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. LI.FI (li.quest) aggregates many bridges/DEXs and picks a different underlying facet per
// request. LI.FI charges a documented 0.25% service fee on top of whatever the underlying route costs
// (docs.li.fi/overview/faq), which shows up simply as a smaller `amountOut` here; this adapter does not
// special-case it.
//
// otto/mamoru#181 CORRECTION (review round 4, 20 Oct 2026): an earlier version of this adapter decided the
// recipient was provably the account by scanning every word of the calldata for it, plus LI.FI's own declared
// `action.toAddress`. That generic scan cannot tell "the real recipient argument" from "the account's bytes
// appear somewhere in this call" — it happened not to be wrong for LI.FI only because the declared field also
// agreed, but the same pattern silently broke for Relay and deBridge (see their module comments), so it is
// removed from this package entirely (recipient.ts no longer exports it).
//
// Every LI.FI facet function has `ILiFi.BridgeData` as its FIRST parameter — that is the whole point of LI.FI's
// own on-chain `CalldataVerificationFacet.extractBridgeData`, a single decoder that works for every facet
// because of this convention: `abi.decode(data[4:], (ILiFi.BridgeData))`. This adapter does the same decode
// (confirmed live 20 Oct 2026 against both an ERC20-input and a native-ETH-input quote, with DISTINCT sender
// and recipient addresses) and checks the real, named fields: `receiver` must equal the account, `sendingAssetId`
// must equal the token requested, `destinationChainId` must equal the chain requested, and `minAmount` must be
// a plausible pre-bridge-fee amount (0 < minAmount <= amountIn, and >= the quoted amountOut — the bridge step
// can only take a little more fee after this point, never add value). If the decode itself fails — a facet
// whose first parameter isn't `BridgeData`, or calldata LI.FI returns in some shape this adapter has not seen —
// the quote is NOT refused outright; it becomes quote-only (`recipientCheck: 'none'`, no `calldata`/`value`),
// the same fallback Relay and deBridge use when nothing here can prove the recipient.
//
// `transactionRequest.value` is checked for real now too: 0 for an ERC20-input order (the principal moves by
// allowance, not value); for a native-input order, `amountIn` plus a small bounded slack (confirmed live:
// LI.FI attached exactly `amountIn`, no top-up, unlike deBridge's).
//
// Unlike Relay, LI.FI's target is NOT the same across every origin chain: it is the standard LiFiDiamond
// (`0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`) on Ethereum- and Base-origin quotes, but a different executor
// contract on Monad-origin ones — confirmed live 18 Oct 2026. This adapter pins a per-origin-chain allowlist,
// refusing any chain not in it rather than trusting whatever `transactionRequest.to` the response names.
//
// Verified live against li.quest/v1/quote on 18 Oct and 20 Oct 2026 (empirical response shapes below) and
// docs.li.fi/li.fi-api/li.fi-api/requesting-a-quote/token-transfer, docs.li.fi/api-reference/rate-limits
// (unauthenticated: 75 req/2h, enough for occasional quoting and the smoke script, not for polling), and
// raw.githubusercontent.com/lifinance/contracts (ILiFi.sol, CalldataVerificationFacet.sol).

export const LIFI_QUOTE_URL = 'https://li.quest/v1/quote'
export const QUOTE_TIMEOUT_MS = 8_000
/** LI.FI does not publish a quote validity window either; same conservative default as relay.ts. */
const DEFAULT_TTL_MS = 30_000

/** How far a native-input `value` may exceed `amountIn` before it is refused as unexplained. LI.FI attached
 * exactly `amountIn` in every sample checked this round (no top-up); this exists only in case some route adds
 * a small one, the same caution deBridge's equivalent bound applies for. */
const NATIVE_VALUE_SLACK_WEI = 1_000_000_000_000_000n // 0.001 of the source chain's native asset

/** The only `transactionRequest.to` observed for a quote whose source chain is the given id (18 Oct 2026).
 * Ethereum and Base share the standard LiFiDiamond; Monad does not. Any chain not in this table is refused by
 * `supports`, not silently allowed through with an unverified target. */
const LIFI_TARGET_BY_SOURCE_CHAIN: Readonly<Record<number, Address>> = {
  1: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  8453: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE',
  143: '0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37',
}

/** ILiFi.BridgeData, verified against raw.githubusercontent.com/lifinance/contracts/main/src/Interfaces/ILiFi.sol
 * on 20 Oct 2026. Every facet's `startBridgeTokensViaXxx` function takes this as its first parameter, which is
 * exactly why decoding only this type out of the calldata works regardless of which facet/bridge LI.FI picked —
 * Solidity's own `abi.decode(data[4:], (ILiFi.BridgeData))` (CalldataVerificationFacet._extractBridgeData) does
 * the same thing and ignores whatever parameters (if any) follow it. */
const bridgeDataAbi = parseAbiParameters(
  '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)',
)

type BridgeData = {
  transactionId: Hex
  bridge: string
  integrator: string
  referrer: Address
  sendingAssetId: Address
  receiver: Address
  minAmount: bigint
  destinationChainId: bigint
  hasSourceSwaps: boolean
  hasDestinationCall: boolean
}

/** Decodes `ILiFi.BridgeData` from the start of the calldata — or `undefined` if it does not decode as that
 * struct at all (an unrecognised facet layout), never a throw: the caller falls back to quote-only on
 * `undefined`, the same way every other "cannot prove this" case in this package does. */
function decodeBridgeData(calldata: Hex): BridgeData | undefined {
  if (calldata.length < 10) return undefined
  try {
    const [bd] = decodeAbiParameters(bridgeDataAbi, `0x${calldata.slice(10)}` as Hex)
    return bd as BridgeData
  } catch {
    return undefined
  }
}

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
    const calldata = tx.data as Hex

    // Native value: 0 for an ERC20-input order; amountIn (plus a small bounded slack) for a native-input one.
    const sourceIsNative = chainConfig(req.sourceChainId)?.nativeAsset === req.asset
    if (sourceIsNative) {
      if (value < req.amountIn || value > req.amountIn + NATIVE_VALUE_SLACK_WEI) throw new RouteError('lifi', 'QUOTE_MALFORMED', `native value ${value} is not amountIn ${req.amountIn} (plus the allowed slack)`)
    } else if (value !== 0n) {
      throw new RouteError('lifi', 'QUOTE_MALFORMED', `an ERC20-input order must attach no native value, got ${value}`)
    }

    const bridgeData = decodeBridgeData(calldata)
    const declaredRecipient = parseDeclaredAddress(resp.action?.toAddress)

    let recipientCheck: Quote['recipientCheck']
    let quoteOnly = false
    if (bridgeData === undefined) {
      // Cannot decode this facet's layout with certainty: quote-only, per the project's rule, not a refusal —
      // the price is still comparable, nothing here is safe to sign.
      recipientCheck = 'none'
      quoteOnly = true
    } else {
      if (getAddress(bridgeData.receiver) !== getAddress(req.account)) throw new RouteError('lifi', 'RECIPIENT_REFUSED', `BridgeData.receiver ${bridgeData.receiver} is not the account ${req.account}`)
      if (declaredRecipient !== undefined && getAddress(declaredRecipient) !== getAddress(req.account)) throw new RouteError('lifi', 'RECIPIENT_REFUSED', `declared recipient ${declaredRecipient} is not the account ${req.account}`)
      if (bridgeData.destinationChainId !== BigInt(req.destChainId)) throw new RouteError('lifi', 'QUOTE_MALFORMED', `BridgeData.destinationChainId ${bridgeData.destinationChainId} is not the requested ${req.destChainId}`)
      const expectedSendingAsset = tokenAddress(req.asset, req.sourceChainId)
      if (expectedSendingAsset === undefined || getAddress(bridgeData.sendingAssetId) !== getAddress(expectedSendingAsset)) throw new RouteError('lifi', 'QUOTE_MALFORMED', `BridgeData.sendingAssetId ${bridgeData.sendingAssetId} is not the requested token`)
      if (bridgeData.minAmount <= 0n || bridgeData.minAmount > req.amountIn) throw new RouteError('lifi', 'QUOTE_MALFORMED', `BridgeData.minAmount ${bridgeData.minAmount} is out of range for amountIn ${req.amountIn}`)
      if (bridgeData.minAmount < amountOut) throw new RouteError('lifi', 'QUOTE_MALFORMED', `BridgeData.minAmount ${bridgeData.minAmount} is less than the quoted amountOut ${amountOut}`)
      recipientCheck = 'decoded-calldata'
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
      calldata: quoteOnly ? undefined : calldata,
      value: quoteOnly ? undefined : value,
      recipientCheck,
      mode: 'owner-only',
      expiresAt: new Date(now + DEFAULT_TTL_MS).toISOString(),
    }
  },
}
