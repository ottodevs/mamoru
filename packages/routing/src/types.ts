import type { Address, Hex } from '@mamoru/domain'

/** otto/mamoru#181. How a provider's quoted recipient can be trusted before the owner signs anything.
 *
 * - 'onchain-pinnable': the recipient is a fixed-position argument of a known function on a known contract
 *   (CCTP V2 `depositForBurn`'s `mintRecipient`, Across `depositV3`'s `depositor`/`recipient`). A Rhinestone
 *   `UniActionPolicy` EQUAL rule can pin that exact word, so a session key may call it unattended.
 * - 'decoded-calldata': the provider chose the route (aggregators pick a solver/bridge per request), so no fixed
 *   offset can be pinned ahead of time by a session policy. This adapter decoded the calldata it is about to hand
 *   back and found the account's own address among its 32-byte words — the owner still signs, but the app refused
 *   the quote before ever showing it if that check failed. See recipient.ts.
 * - 'none': no on-chain or calldata evidence exists that the recipient is the account (used by informational
 *   routes with no self-serve calldata, and by a provider whose calldata was checked and found to carry no
 *   recipient at all — e.g. relay.ts: Relay's deposit calldata carries only the depositor and an opaque
 *   request id; the destination recipient lives off-chain in Relay's own intent system and cannot be verified
 *   from anything the chain can see). A quote with 'none' must never be auto-executed, session-key or
 *   owner-signed — `calldata` is left undefined for exactly this reason (`value` may still be set as an informational
 *   native cost for ranking, e.g. deBridge's fixFee; without calldata it is never sent); `target` may still be
 *   populated as descriptive metadata about which contract the route would use.
 */
export type RecipientCheck = 'onchain-pinnable' | 'decoded-calldata' | 'none'

/** Who may send the transaction unattended.
 * - 'session-key': a Rhinestone Smart Sessions `UniActionPolicy` can bound target, selector, recipient (EQUAL) and
 *   amount/fee (IN_RANGE) ahead of time, so a leaked or scheduled session key can only ever pay itself.
 * - 'owner-only': the passkey owner must see and sign this specific calldata; no standing policy can bound it
 *   safely because the target, selector or recipient position is not fixed ahead of the quote.
 */
export type SigningMode = 'session-key' | 'owner-only'

/** otto/mamoru#181 direction classes. Ethereum (1) is the only L1 in scope; everything else quoted here is an L2. */
export type Direction = 'l1-to-l2' | 'l2-to-l1' | 'l2-to-l2'

export type Asset = 'USDC' | 'ETH'

export type QuoteRequest = {
  sourceChainId: number
  destChainId: number
  asset: Asset
  /** Base units: USDC has 6 decimals, ETH 18. */
  amountIn: bigint
  /** The account on both chains. Session-key routes pin this as the on-chain recipient; owner-only routes refuse
   * any quote whose decoded calldata does not carry it. */
  account: Address
}

/** The normalised shape every adapter returns, per otto/mamoru#181 design note §1. */
export type Quote = {
  provider: string
  /** Human label for the specific route within the provider, e.g. 'CCTP V2 Fast', 'Across depositV3'. */
  route: string
  /** Echoed from the request — a selector ranking several quotes needs the chain context (e.g. to price
   * `value`, which is denominated in sourceChainId's native asset) without re-threading the original request
   * through every call site. */
  sourceChainId: number
  destChainId: number
  /** Echoed from the request — which asset amountIn/amountOut are denominated in. Needed by the selector to
   * know whether a native `value` surcharge (always the source chain's native asset) is already the same
   * asset as the output (bridging ETH itself) or a different one that needs pricing (bridging USDC while
   * paying a native-asset fee) — see selector.ts. */
  asset: Asset
  amountIn: bigint
  amountOut: bigint
  /** amountIn - amountOut, same asset and decimals as amountIn. Never negative. */
  fee: bigint
  etaSec: number
  target: Address
  /** Present whenever the adapter already has the exact call to make; absent for informational-only quotes. */
  calldata?: Hex
  /** Native currency (wei) to attach as msg.value, when the call needs one — bridging ETH itself (canonical.ts),
   * or a protocol fee charged in the chain's native asset on top of the bridged token (debridge.ts). Absent or
   * 0n for a plain ERC20 call. */
  value?: bigint
  recipientCheck: RecipientCheck
  mode: SigningMode
  /** ISO 8601. A quote is a snapshot of a venue's price; nothing here should be signed after this passes. */
  expiresAt: string
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type AdapterDeps = {
  fetch?: Fetch
  now?: () => number
}

/** One provider's quoting logic. `supports` is a cheap, synchronous pre-filter so callers (and the selector) never
 * fire a network call at a provider that cannot serve the request. `quote` throws RouteError (errors.ts) — never
 * returns a partial or unchecked quote — when the provider has nothing safe to offer. */
export type Adapter = {
  readonly name: string
  supports(req: QuoteRequest): boolean
  quote(req: QuoteRequest, deps?: AdapterDeps): Promise<Quote>
}

const L1_CHAIN_IDS: ReadonlySet<number> = new Set([1])

/** otto/mamoru#181: Ethereum (1) is the only L1 modelled; Base (8453), Monad (143) and any other configured chain
 * are L2s. A request where source === dest is not a direction this layer quotes. */
export function directionOf(sourceChainId: number, destChainId: number): Direction {
  const srcL1 = L1_CHAIN_IDS.has(sourceChainId)
  const dstL1 = L1_CHAIN_IDS.has(destChainId)
  if (srcL1 && dstL1) throw new Error(`no L1-to-L1 direction: ${sourceChainId} -> ${destChainId}`)
  if (srcL1) return 'l1-to-l2'
  if (dstL1) return 'l2-to-l1'
  return 'l2-to-l2'
}

export function isL1(chainId: number): boolean {
  return L1_CHAIN_IDS.has(chainId)
}
