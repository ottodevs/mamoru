import { decodeAbiParameters, encodeAbiParameters, getAddress, parseAbiParameters, type AbiParameter, type Address, type Hex } from 'viem'
import { chainConfig, tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import { parseDeclaredAddress } from '../recipient.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. LI.FI (li.quest) aggregates many bridges/DEXs and picks a different underlying facet per
// request. LI.FI charges a documented 0.25% service fee on top of whatever the underlying route costs
// (docs.li.fi/overview/faq), which shows up simply as a smaller `amountOut` here; this adapter does not
// special-case it.
//
// otto/mamoru#181 CORRECTION (review round 5, 20 Oct 2026): the previous version decoded only `ILiFi.BridgeData`
// generically — "decode the first struct and trust it" — regardless of which selector the calldata actually
// called. That is a parser differential risk: a selector whose real function does NOT take `BridgeData` first
// (or reads the destination/receiver from somewhere other than `BridgeData.receiver`) could still "decode" as
// BridgeData-shaped bytes without that meaning anything about what the EVM will actually execute. Checked by
// fetching every facet this round's live quotes actually used, not assumed:
//
// - Selector `0x17917a4e` is `swapAndStartBridgeTokensViaPolymerCCTP(BridgeData, LibSwap.SwapData[],
//   PolymerCCTPData)` — computed from the real source (lifinance/contracts, PolymerCCTPFacet.sol + LibSwap.sol)
//   and confirmed to match (not merely resemble) the selector LI.FI actually returned on every USDC quote this
//   round. Read the facet's on-chain `_startBridge`: for any destinationChainId that is a normal EVM chain id
//   (not LI.FI's own non-EVM sentinel ids for Solana/Stellar/HyperCore — none of which are 1, 8453 or 143, the
//   only ids `supports()` ever requests), it calls `TOKEN_MESSENGER.depositForBurn(..., bytes32(uint160(receiver)),
//   ...)` directly with `BridgeData.receiver` — genuinely on-chain-enforced, not merely a convention. The facet
//   function itself carries `doesNotContainDestinationCalls`, so `hasDestinationCall: true` reverts on-chain
//   regardless of what this adapter decodes — checked here anyway, for defense in depth and because that
//   guarantee is specific to this one facet. When `hasSourceSwaps` is true (true on every live sample this
//   round — LI.FI's own fee-collection step), the facet also enforces the LAST swap's output must be USDC;
//   `BridgeData.minAmount` itself gets overwritten on-chain by the real swap output, so the amount actually
//   checked against the request is `swapData[0].fromAmount` — the amount entering that first swap — exactly
//   the convention LI.FI's own `CalldataVerificationFacet.extractMainParameters` uses for this same reason.
// - Selector `0x1794958f` (`swapAndStartBridgeTokensViaAcrossV4`, used by every native-ETH quote this round) is
//   DELIBERATELY NOT allowlisted: `AcrossV4SwapFacet.sol`'s own doc comment states "the final receiver is
//   encoded inside dynamic calldata that cannot be fully validated on-chain against BridgeData.receiver" for
//   the paths it uses, and that LI.FI's backend signs over the calldata hash specifically because the facet
//   itself cannot verify it — a stated trust model this adapter cannot certify with the same confidence as
//   PolymerCCTPFacet's, so a quote through it is quote-only, not decoded-calldata.
// - Any other selector (LI.FI picks among dozens of facets): quote-only. No facet not read and verified this
//   way is ever treated as decoded-calldata, per the project's rule.
//
// A successful decode is also re-encoded with the exact same ABI and byte-compared against the original
// calldata; any mismatch (extra/padded/non-canonical bytes a low-level read inside the facet could in
// principle interpret differently from a standard `abi.decode`) is treated the same as a failed decode —
// quote-only, not trusted.
//
// `calldataPinsRecipient`/`assertOwnerOnlyRecipient` (the generic "scan every word" check this adapter used to
// fall back to) were removed from recipient.ts entirely in the prior round — nothing in this package relies on
// a calldata scan for a recipient claim any more.
//
// `transactionRequest.value` is checked for real: 0 for an ERC20-input order (the principal moves by
// allowance, not value); for a native-input order, `amountIn` plus a small bounded slack (confirmed live:
// LI.FI attached exactly `amountIn`, no top-up).
//
// Unlike Relay, LI.FI's target is NOT the same across every origin chain: the standard LiFiDiamond
// (`0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`) on Ethereum- and Base-origin quotes, a different executor on
// Monad-origin ones. This adapter pins a per-origin-chain allowlist, refusing any chain not in it.
//
// Verified live against li.quest/v1/quote on 18 and 20 Oct 2026 (empirical response shapes in the test file)
// and raw.githubusercontent.com/lifinance/contracts (ILiFi.sol, CalldataVerificationFacet.sol,
// PolymerCCTPFacet.sol, AcrossV4SwapFacet.sol, Libraries/LibSwap.sol, Helpers/LiFiData.sol).

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

/** LiFiData.sol's sentinel for a non-EVM receiver (Solana/Stellar/etc. flows) — `BridgeData.receiver` is this
 * exact constant on those paths, never a real address. None of this adapter's requests ever target a non-EVM
 * destination chain (`destinationChainId` is checked against the request below, and this package only ever
 * requests 1, 8453 or 143), so this should be unreachable; checked explicitly anyway, per the review's own
 * "non-EVM receiver fields" concern, rather than relying solely on that chain-id check holding. */
const NON_EVM_ADDRESS: Address = '0x11f111f111f111F111f111f111F111f111f111F1'

const bridgeDataTupleType = '(bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId, address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps, bool hasDestinationCall)'
const swapDataTupleType = '(address callTo, address approveTo, address sendingAssetId, address receivingAssetId, uint256 fromAmount, bytes callData, bool requiresDeposit)'
const polymerCctpDataTupleType = '(uint256 polymerTokenFee, uint256 maxCCTPFee, bytes32 nonEVMReceiver, bytes32 solanaReceiverATA, uint32 minFinalityThreshold, address refundRecipient, bytes hookData)'

/** `swapAndStartBridgeTokensViaPolymerCCTP(BridgeData, LibSwap.SwapData[], PolymerCCTPData)` — the only facet
 * selector this adapter treats as decodable with certainty. Computed from the real parameter types above
 * (`viem`'s `toFunctionSelector`) and confirmed to equal what LI.FI actually returned on every USDC quote this
 * round, not merely assumed from a name. */
const POLYMER_CCTP_SELECTOR = '0x17917a4e'
const polymerCctpAbi = parseAbiParameters(`${bridgeDataTupleType}, ${swapDataTupleType}[], ${polymerCctpDataTupleType}`)

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

type SwapData = {
  callTo: Address
  approveTo: Address
  sendingAssetId: Address
  receivingAssetId: Address
  fromAmount: bigint
  callData: Hex
  requiresDeposit: boolean
}

type PolymerCctpCall = { bridgeData: BridgeData; swapData: readonly SwapData[] }

/** Decodes calldata against `abi` and requires it to re-encode back to EXACTLY the same bytes — a decode that
 * "succeeds" but does not round-trip means the bytes carry something beyond the canonical encoding of `abi`
 * (extra/padded/overlapping data a low-level read inside the real facet could interpret differently from this
 * decode), and is treated the same as a decode that threw: `undefined`, never trusted. */
function canonicalDecode(abi: readonly AbiParameter[], body: Hex): readonly unknown[] | undefined {
  try {
    const decoded = decodeAbiParameters(abi, body)
    const reEncoded = encodeAbiParameters(abi, decoded)
    if (reEncoded.toLowerCase() !== body.toLowerCase()) return undefined
    return decoded
  } catch {
    return undefined
  }
}

/** Decodes a `swapAndStartBridgeTokensViaPolymerCCTP` call with certainty — selector-checked, canonically
 * re-encoded — or `undefined` for anything else (wrong selector, failed decode, non-canonical bytes). The
 * `PolymerCCTPData` tail is decoded (as part of the canonical check) but not returned: nothing this adapter
 * validates needs its fields, only that the whole call decodes cleanly. */
function decodePolymerCctpCall(calldata: Hex): PolymerCctpCall | undefined {
  if (calldata.length < 10 || calldata.slice(0, 10).toLowerCase() !== POLYMER_CCTP_SELECTOR) return undefined
  const decoded = canonicalDecode(polymerCctpAbi, `0x${calldata.slice(10)}` as Hex)
  if (decoded === undefined) return undefined
  const [bridgeData, swapData] = decoded as [BridgeData, readonly SwapData[], unknown]
  return { bridgeData, swapData }
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

    const call = decodePolymerCctpCall(calldata)
    const declaredRecipient = parseDeclaredAddress(resp.action?.toAddress)

    let recipientCheck: Quote['recipientCheck']
    let quoteOnly = false
    if (call === undefined) {
      // Not the one facet selector this adapter can decode with certainty (wrong selector, failed decode, or a
      // non-canonical re-encode): quote-only, per the project's rule, not a refusal — the price is still
      // comparable, nothing here is safe to sign.
      recipientCheck = 'none'
      quoteOnly = true
    } else {
      const { bridgeData, swapData } = call
      if (getAddress(bridgeData.receiver) !== getAddress(req.account)) throw new RouteError('lifi', 'RECIPIENT_REFUSED', `BridgeData.receiver ${bridgeData.receiver} is not the account ${req.account}`)
      if (bridgeData.receiver === NON_EVM_ADDRESS) throw new RouteError('lifi', 'RECIPIENT_REFUSED', 'BridgeData.receiver is the non-EVM sentinel address')
      if (declaredRecipient !== undefined && getAddress(declaredRecipient) !== getAddress(req.account)) throw new RouteError('lifi', 'RECIPIENT_REFUSED', `declared recipient ${declaredRecipient} is not the account ${req.account}`)
      if (bridgeData.destinationChainId !== BigInt(req.destChainId)) throw new RouteError('lifi', 'QUOTE_MALFORMED', `BridgeData.destinationChainId ${bridgeData.destinationChainId} is not the requested ${req.destChainId}`)
      // PolymerCCTPFacet's own `doesNotContainDestinationCalls` modifier reverts on-chain if this is true —
      // checked here too, so a quote that claims one is never even shown as decoded-calldata.
      if (bridgeData.hasDestinationCall) throw new RouteError('lifi', 'QUOTE_MALFORMED', 'BridgeData.hasDestinationCall is true, not supported')
      if (bridgeData.minAmount <= 0n) throw new RouteError('lifi', 'QUOTE_MALFORMED', 'BridgeData.minAmount is zero')

      const expectedSendingAsset = tokenAddress(req.asset, req.sourceChainId)
      if (expectedSendingAsset === undefined) throw new RouteError('lifi', 'UNSUPPORTED', `no token address for ${req.asset} on chain ${req.sourceChainId}`)

      // PolymerCCTPFacet.sol's own `_startBridge` overwrites BridgeData.minAmount on-chain with the real output
      // of the source swap when hasSourceSwaps is true — so BridgeData.minAmount is not what actually enters
      // the bridge in that case. CalldataVerificationFacet.extractMainParameters uses swapData[0] instead for
      // exactly this reason; this adapter mirrors that convention rather than trusting BridgeData's own fields.
      if (bridgeData.hasSourceSwaps) {
        if (swapData.length === 0) throw new RouteError('lifi', 'QUOTE_MALFORMED', 'hasSourceSwaps is true but swapData is empty')
        const first = swapData[0]!
        const last = swapData[swapData.length - 1]!
        if (getAddress(first.sendingAssetId) !== getAddress(expectedSendingAsset)) throw new RouteError('lifi', 'QUOTE_MALFORMED', `swapData[0].sendingAssetId ${first.sendingAssetId} is not the requested token`)
        if (first.fromAmount !== req.amountIn) throw new RouteError('lifi', 'QUOTE_MALFORMED', `swapData[0].fromAmount ${first.fromAmount} does not match amountIn ${req.amountIn}`)
        // The facet itself requires the last swap's output to be the same asset the bridge actually moves
        // (PolymerCCTPFacet enforces this is USDC on-chain); mirrored here as a sanity bound, not a trust claim
        // about the swap step's arbitrary callTo/callData, which remains the owner's own review to catch.
        if (getAddress(last.receivingAssetId) !== getAddress(expectedSendingAsset)) throw new RouteError('lifi', 'QUOTE_MALFORMED', `swapData[${swapData.length - 1}].receivingAssetId ${last.receivingAssetId} is not the requested token`)
      } else {
        if (getAddress(bridgeData.sendingAssetId) !== getAddress(expectedSendingAsset)) throw new RouteError('lifi', 'QUOTE_MALFORMED', `BridgeData.sendingAssetId ${bridgeData.sendingAssetId} is not the requested token`)
        if (bridgeData.minAmount > req.amountIn) throw new RouteError('lifi', 'QUOTE_MALFORMED', `BridgeData.minAmount ${bridgeData.minAmount} exceeds amountIn ${req.amountIn}`)
        if (bridgeData.minAmount < amountOut) throw new RouteError('lifi', 'QUOTE_MALFORMED', `BridgeData.minAmount ${bridgeData.minAmount} is less than the quoted amountOut ${amountOut}`)
      }
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
