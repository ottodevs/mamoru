import { encodeFunctionData, getAddress, parseAbi, zeroAddress, type Address } from 'viem'
import { chainConfig, tokenAddress } from '../chains.ts'
import { RouteError } from '../errors.ts'
import type { Adapter, AdapterDeps, Fetch, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. Across Protocol: SpokePool.depositV3, ~2s fills in the common case. `depositor` and
// `recipient` are fixed-position address arguments, so — like CCTP — a session key may call it, pinned by a
// UniActionPolicy EQUAL rule on both. Validation mirrors the proven logic in
// apps/mamoru-operator/src/bridge-out.ts (otto/mamoru#133/#72's `checkQuote`), generalised to any configured
// chain pair instead of hardcoding Ethereum->Base; the bounds below (fee ceiling, exclusivity window, fill
// deadline window) are this app's own policy, not a protocol-level guarantee from Across.
//
// Verified 18 Oct 2026 against docs.across.to (chains-and-contracts, api-reference/suggested-fees/get,
// introduction/refunds) and the across-protocol/contracts source for depositV3's current parameter semantics
// (the 11th parameter is `exclusivityParameter`: an offset from the deposit block when small, an absolute
// timestamp otherwise — handled the same way bridge-out.ts already does). SpokePool addresses cross-checked
// on-chain (Etherscan/Basescan/Monadscan contract labels).

export const ACROSS_API = 'https://app.across.to/api'

/** Fees above this share of the amount are refused: 0.5%, same bound as bridge-out.ts's proven MAX_FEE_BPS. */
export const MAX_FEE_BPS = 50n
/** An exclusive relayer may hold the fill for at most this long. App policy — Across's docs and contracts place
 * no cap on exclusivity duration (checked 18 Oct 2026); this bound exists so a quote can never ask the owner to
 * accept an open-ended exclusive window. */
export const MAX_EXCLUSIVITY_SEC = 600
/** Fill deadlines further out than this are refused: a stuck deposit would wait that long for its refund. */
export const MAX_FILL_DEADLINE_SEC = 24 * 3600
export const QUOTE_TIMEOUT_MS = 8_000

const spokePoolAbi = parseAbi([
  'function depositV3(address depositor, address recipient, address inputToken, address outputToken, uint256 inputAmount, uint256 outputAmount, uint256 destinationChainId, address exclusiveRelayer, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes message) payable',
])

/** What /api/suggested-fees answers, the fields this adapter uses. docs.across.to/api-reference/suggested-fees/get */
export type AcrossSuggestedFees = {
  outputAmount: string
  totalRelayFee: { total: string }
  timestamp: string
  fillDeadline: string
  exclusiveRelayer: string
  exclusivityDeadline: number
  spokePoolAddress: string
  estimatedFillTimeSec: number
  isAmountTooLow: boolean
}

export type AcrossDeposit = {
  amount: bigint
  outputAmount: bigint
  exclusiveRelayer: Address
  quoteTimestamp: number
  fillDeadline: number
  exclusivityDeadline: number
  fillSec: number
}

/** Checks a suggested-fees answer against what this adapter will sign. Never echoes the raw quote on failure —
 * same discipline as bridge-out.ts's checkQuote, which this is adapted from. */
export function checkAcrossQuote(provider: string, expectedSpoke: Address, q: AcrossSuggestedFees, amount: bigint, nowSec: number): AcrossDeposit {
  const bad = (why: string) => new RouteError(provider, 'BRIDGE_QUOTE_REFUSED', why)
  let spoke: Address
  let relayer: Address
  try {
    spoke = getAddress(q.spokePoolAddress)
    relayer = getAddress(q.exclusiveRelayer)
  } catch {
    throw bad('malformed address field')
  }
  if (spoke !== expectedSpoke) throw bad('unexpected SpokePool contract')
  if (q.isAmountTooLow) throw new RouteError(provider, 'BRIDGE_AMOUNT_TOO_LOW', 'the amount is too small to bridge')
  let out: bigint
  let fee: bigint
  try {
    out = BigInt(q.outputAmount)
    fee = BigInt(q.totalRelayFee.total)
  } catch {
    throw bad('malformed amount field')
  }
  if (out <= 0n || out > amount) throw bad('output amount out of range')
  if (amount - out !== fee) throw bad('fee does not match the output')
  if ((amount - out) * 10_000n > amount * MAX_FEE_BPS) throw bad('fee too high')
  const quoteTimestamp = Number(q.timestamp)
  const fillDeadline = Number(q.fillDeadline)
  const exclusivityDeadline = Number(q.exclusivityDeadline)
  if (![quoteTimestamp, fillDeadline, exclusivityDeadline].every((n) => Number.isSafeInteger(n) && n >= 0 && n < 2 ** 32)) throw bad('malformed timing field')
  if (Math.abs(quoteTimestamp - nowSec) > 600) throw bad('stale quote')
  if (fillDeadline < nowSec + 1800) throw bad('fill deadline too close')
  if (fillDeadline > nowSec + MAX_FILL_DEADLINE_SEC) throw bad('fill deadline too far')
  if (relayer === zeroAddress) {
    if (exclusivityDeadline !== 0) throw bad('exclusivity without a relayer')
  } else {
    const until = exclusivityDeadline > 1_000_000_000 ? exclusivityDeadline : nowSec + exclusivityDeadline
    if (until > nowSec + MAX_EXCLUSIVITY_SEC || until >= fillDeadline) throw bad('exclusivity window too long')
  }
  return { amount, outputAmount: out, exclusiveRelayer: relayer, quoteTimestamp, fillDeadline, exclusivityDeadline, fillSec: Number(q.estimatedFillTimeSec) || 0 }
}

async function fetchSuggestedFees(fetcher: Fetch, inputToken: Address, outputToken: Address, originChainId: number, destinationChainId: number, amount: bigint): Promise<AcrossSuggestedFees> {
  const url = `${ACROSS_API}/suggested-fees?inputToken=${inputToken}&outputToken=${outputToken}&originChainId=${originChainId}&destinationChainId=${destinationChainId}&amount=${amount}`
  // Confirmed live 18 Oct 2026: /suggested-fees answers HTTP 200 with no key at all. ACROSS_API_KEY is read only
  // for parity with the proven apps/mamoru-operator/src/bridge-out.ts pattern (a key raises rate limits; never
  // required, never paid-tier-only — the "no paid APIs" rule holds either way).
  const key = process.env.ACROSS_API_KEY
  let res: Response
  try {
    res = await fetcher(url, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS) })
  } catch {
    throw new RouteError('across', 'BRIDGE_QUOTE_UNAVAILABLE', 'Across did not answer')
  }
  if (!res.ok) throw new RouteError('across', 'BRIDGE_QUOTE_UNAVAILABLE', `Across returned ${res.status}`)
  return (await res.json()) as AcrossSuggestedFees
}

export const acrossAdapter: Adapter = {
  name: 'across',

  supports(req: QuoteRequest): boolean {
    // ETH is deliberately out of scope: Across bridges it as WETH, and this round did not verify a WETH address
    // per chain to the same standard as USDC — see docs/research/routing-2026-10.md.
    if (req.asset !== 'USDC') return false
    if (req.sourceChainId === req.destChainId) return false
    const src = chainConfig(req.sourceChainId)
    const dst = chainConfig(req.destChainId)
    return src !== undefined && dst !== undefined
  },

  async quote(req: QuoteRequest, deps: AdapterDeps = {}): Promise<Quote> {
    if (!this.supports(req)) throw new RouteError('across', 'UNSUPPORTED', `${req.asset} ${req.sourceChainId}->${req.destChainId}`)
    if (req.amountIn <= 0n) throw new RouteError('across', 'BAD_AMOUNT', 'amountIn must be positive')
    const src = chainConfig(req.sourceChainId)!
    const dst = chainConfig(req.destChainId)!
    const inputToken = tokenAddress('USDC', req.sourceChainId)!
    const outputToken = tokenAddress('USDC', req.destChainId)!
    const fetcher = deps.fetch ?? fetch
    const now = deps.now?.() ?? Date.now()
    const nowSec = Math.floor(now / 1000)

    const raw = await fetchSuggestedFees(fetcher, inputToken, outputToken, req.sourceChainId, req.destChainId, req.amountIn)
    const deposit = checkAcrossQuote('across', src.acrossSpokePool, raw, req.amountIn, nowSec)

    const calldata = encodeFunctionData({
      abi: spokePoolAbi,
      functionName: 'depositV3',
      args: [
        req.account,
        req.account,
        inputToken,
        outputToken,
        deposit.amount,
        deposit.outputAmount,
        BigInt(req.destChainId),
        deposit.exclusiveRelayer,
        deposit.quoteTimestamp,
        deposit.fillDeadline,
        deposit.exclusivityDeadline,
        '0x',
      ],
    })

    return {
      provider: 'across',
      route: 'Across depositV3',
      amountIn: deposit.amount,
      amountOut: deposit.outputAmount,
      fee: deposit.amount - deposit.outputAmount,
      etaSec: Math.max(deposit.fillSec, 1),
      target: src.acrossSpokePool,
      calldata,
      // `depositor` and `recipient` are depositV3's 1st and 2nd arguments, both fixed-position addresses.
      recipientCheck: 'onchain-pinnable',
      mode: 'session-key',
      // suggested-fees carries no explicit validity window; Across prices move, so this is a conservative
      // app-side freshness bound, not a value the API returns.
      expiresAt: new Date(now + 60_000).toISOString(),
    }
  },
}
