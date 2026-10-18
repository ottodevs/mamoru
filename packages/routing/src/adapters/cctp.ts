import { encodeFunctionData, pad, parseAbi, type Address, type Hex } from 'viem'
import { chainConfig, tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. Circle CCTP V2: USDC's own official burn-and-mint route. `depositForBurn`'s `mintRecipient` is
// a fixed-position bytes32 argument, so a Rhinestone `UniActionPolicy` EQUAL rule can pin it — this is the only
// adapter (with Across) offered session-key. `depositForBurnWithHook` is never called by this adapter (there is
// no code path to it), which is the design note's "prohibit the hook by not giving it an action id."
//
// Verified 18 Oct 2026 against developers.circle.com/cctp (technical-guide, cctp-supported-blockchains,
// howtos/get-transfer-fee, references/contract-addresses, references/contract-interfaces) and
// circle.com/blog/migrate-to-cctp-v2-ahead-of-cctp-v1-legacy-deprecation. TokenMessengerV2 cross-checked on
// Basescan as "Circle CCTP: Token Messenger V2", exact-match verified source.

export const IRIS_API = 'https://iris-api.circle.com'
/** Identical address on Ethereum, Base and Monad (CREATE2). developers.circle.com/cctp/references/contract-addresses */
export const TOKEN_MESSENGER_V2: Address = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d'

/** Fast attestation, minFinalityThreshold 1000. */
export const FINALITY_FAST = 1000
/** Standard attestation, minFinalityThreshold 2000 — always available; the only option Circle lists for Monad. */
export const FINALITY_STANDARD = 2000

/**
 * A fee above this share of the amount is refused — same bound and reasoning as Across's proven MAX_FEE_BPS.
 * This route is session-key: an unattended signer trusts this adapter's output directly, so a malformed or
 * compromised fee answer (`minimumFee: 9999`, say) must never silently become calldata that burns most of the
 * amount. Circle's live fees this round were 0-1.3 bps; 50 bps (0.5%) is generous headroom, not a guess at what
 * a real fee could be.
 */
export const MAX_FEE_BPS = 50n

// developers.circle.com does not publish a per-route ETA figure for the fees API response; these are Circle's own
// marketing-level descriptions of the two attestation speeds ("Fast" in seconds, "Standard" bounded by Ethereum's
// ~13-19 min hard finality when Ethereum is in the path), not independently timed this round — flagged in
// docs/research/routing-2026-10.md.
const FAST_ETA_SEC = 30
const STANDARD_ETA_SEC = 15 * 60

const ZERO_BYTES32: Hex = `0x${'0'.repeat(64)}`

export const tokenMessengerV2Abi = parseAbi([
  'function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)',
])

export type CctpFeeEntry = { finalityThreshold: number; minimumFee: number }

async function fetchFees(fetcher: Fetch, srcDomain: number, dstDomain: number): Promise<CctpFeeEntry[]> {
  let res: Response
  try {
    res = await fetcher(`${IRIS_API}/v2/burn/USDC/fees/${srcDomain}/${dstDomain}`, { signal: AbortSignal.timeout(8_000) })
  } catch {
    throw new RouteError('cctp', 'FEES_UNAVAILABLE', 'Circle fee API did not answer')
  }
  if (!res.ok) throw new RouteError('cctp', 'FEES_UNAVAILABLE', `Circle fee API returned ${res.status}`)
  const body: unknown = await res.json().catch(() => undefined)
  if (!Array.isArray(body)) throw new RouteError('cctp', 'FEES_MALFORMED', 'expected a JSON array')
  return body as CctpFeeEntry[]
}

/** Ceiling of `amount * bps / 10_000`, in base units. `minimumFee` from Circle's fee API is basis points but not
 * always a whole number (18 Oct 2026 live: Base->Monad Fast answered `1.3`) — this scales to micro-bps first so
 * the division stays exact bigint arithmetic, never a float. Never negative, never rounds the fee down against
 * the account. */
export function feeFromBps(amount: bigint, bps: number): bigint {
  if (!Number.isFinite(bps) || bps < 0) throw new RouteError('cctp', 'FEES_MALFORMED', `bad fee bps: ${bps}`)
  const microBps = BigInt(Math.round(bps * 1_000_000))
  const denom = 10_000n * 1_000_000n
  return (amount * microBps + denom - 1n) / denom
}

export const cctpAdapter: Adapter = {
  name: 'cctp-v2',

  supports(req: QuoteRequest): boolean {
    if (req.asset !== 'USDC') return false
    if (req.sourceChainId === req.destChainId) return false
    return chainConfig(req.sourceChainId) !== undefined && chainConfig(req.destChainId) !== undefined
  },

  async quote(req: QuoteRequest, deps: AdapterDeps = {}): Promise<Quote> {
    if (!this.supports(req)) throw new RouteError('cctp-v2', 'UNSUPPORTED', `${req.asset} ${req.sourceChainId}->${req.destChainId}`)
    if (req.amountIn <= 0n) throw new RouteError('cctp-v2', 'BAD_AMOUNT', 'amountIn must be positive')
    const src = chainConfig(req.sourceChainId)!
    const dst = chainConfig(req.destChainId)!
    const fetcher = deps.fetch ?? fetch
    const now = deps.now?.() ?? Date.now()

    const wantFast = src.cctpFastSupported && dst.cctpFastSupported
    const threshold = wantFast ? FINALITY_FAST : FINALITY_STANDARD
    const entries = await fetchFees(fetcher, src.cctpDomain, dst.cctpDomain)
    const entry = entries.find((e) => e.finalityThreshold === threshold)
    if (!entry) throw new RouteError('cctp-v2', 'FEES_MALFORMED', `no fee entry for finalityThreshold ${threshold}`)

    if (entry.minimumFee > Number(MAX_FEE_BPS)) throw new RouteError('cctp-v2', 'FEES_TOO_HIGH', `minimumFee ${entry.minimumFee} bps exceeds the app policy bound`)
    const maxFee = feeFromBps(req.amountIn, entry.minimumFee)
    if (maxFee >= req.amountIn) throw new RouteError('cctp-v2', 'FEES_TOO_HIGH', `fee ${maxFee} would consume the whole amount ${req.amountIn}`)
    const amountOut = req.amountIn - maxFee

    const burnToken = tokenAddress('USDC', req.sourceChainId)
    if (!burnToken) throw new RouteError('cctp-v2', 'UNSUPPORTED', `no USDC address known for chain ${req.sourceChainId}`)

    const calldata = encodeFunctionData({
      abi: tokenMessengerV2Abi,
      functionName: 'depositForBurn',
      args: [req.amountIn, dst.cctpDomain, pad(req.account, { size: 32 }), burnToken, ZERO_BYTES32, maxFee, threshold],
    })

    return {
      provider: 'cctp-v2',
      route: wantFast ? 'CCTP V2 Fast' : 'CCTP V2 Standard',
      amountIn: req.amountIn,
      amountOut,
      fee: maxFee,
      etaSec: wantFast ? FAST_ETA_SEC : STANDARD_ETA_SEC,
      target: TOKEN_MESSENGER_V2,
      calldata,
      // `mintRecipient` is depositForBurn's 3rd argument, a fixed-position bytes32: EQUAL-pinnable.
      recipientCheck: 'onchain-pinnable',
      mode: 'session-key',
      expiresAt: new Date(now + 60_000).toISOString(),
    }
  },
}
