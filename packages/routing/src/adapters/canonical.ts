import { encodeFunctionData, parseAbi, type Address } from 'viem'
import { RouteError } from '../errors.ts'
import type { Adapter, AdapterDeps, Quote, QuoteRequest } from '../types.ts'

// otto/mamoru#181. Base's own canonical bridge (StandardBridge), the official L1<->L2 route for ETH — not for
// USDC, which Base issues natively via CCTP (see adapters/cctp.ts); the StandardBridge can only mint a legacy
// wrapped USDbC that carries no Circle guarantee, so this adapter refuses `asset: 'USDC'` outright.
//
// Base left the OP Stack for its own "base/base" execution+proving stack in Feb 2026 (docs.base.org still calls
// the L1 contract `OptimismPortal`, not `OptimismPortal2`); addresses below are Base's own contract registry.
// Sources: https://docs.base.org/chain/base-contracts, https://specs.optimism.io/protocol/bridges.html,
// https://docs.base.org/upgrades/beryl/overview, https://docs.base.org/upgrades/azul/proofs.

/** L1StandardBridge on Ethereum, scoped to Base. docs.base.org/chain/base-contracts. */
export const BASE_L1_STANDARD_BRIDGE: Address = '0x3154Cf16ccdb4C6d922629664174b904d80F2C35'
/** L2StandardBridge predeploy — the same fixed address on Base and every other OP-Stack-derived L2. */
export const BASE_L2_STANDARD_BRIDGE: Address = '0x4200000000000000000000000000000000000010'

/** otto/mamoru#181: no official minute figure for deposit availability is published (L1 inclusion + L2
 * derivation only) — this is a conservative round-number estimate, not a cited fact. The research doc flags
 * this; do not promote it to a "confirmed" source. */
export const BASE_DEPOSIT_ETA_SEC = 180
/**
 * Withdrawal delay on the single-proof dispute-game path, current since the Beryl upgrade (25 Jun 2026):
 * docs.base.org/upgrades/beryl/overview. Base's Azul upgrade (28 May 2026) added a TEE+ZK dual-proof path that
 * can finalize in ~1 day, but which path a given withdrawal takes depends on how it is proven at finalize time,
 * not on anything this quote controls — quoting the slower, always-available path keeps the ETA honest.
 */
export const BASE_WITHDRAWAL_ETA_SEC = 5 * 24 * 3600

const standardBridgeAbi = parseAbi(['function bridgeETHTo(address _to, uint32 _minGasLimit, bytes _extraData) payable'])

/** Generous but bounded; StandardBridge's own L2 call forwards this as the minimum gas given to the L2 message,
 * well above typical ETH-credit cost. */
const MIN_GAS_LIMIT = 200_000

function ethBridgeCall(to: Address) {
  return encodeFunctionData({ abi: standardBridgeAbi, functionName: 'bridgeETHTo', args: [to, MIN_GAS_LIMIT, '0x'] })
}

export const canonicalBaseAdapter: Adapter = {
  name: 'canonical-base',

  supports(req: QuoteRequest): boolean {
    if (req.asset !== 'ETH') return false
    const pair = [req.sourceChainId, req.destChainId].sort((a, b) => a - b)
    return pair[0] === 1 && pair[1] === 8453
  },

  async quote(req: QuoteRequest, deps: AdapterDeps = {}): Promise<Quote> {
    if (!this.supports(req)) throw new RouteError('canonical-base', 'UNSUPPORTED', `${req.asset} ${req.sourceChainId}->${req.destChainId}`)
    if (req.amountIn <= 0n) throw new RouteError('canonical-base', 'BAD_AMOUNT', 'amountIn must be positive')
    const now = deps.now?.() ?? Date.now()
    const l1ToL2 = req.sourceChainId === 1
    return {
      provider: 'canonical-base',
      route: l1ToL2 ? 'Base StandardBridge (deposit)' : 'Base StandardBridge (withdrawal, single-proof path)',
      amountIn: req.amountIn,
      // The protocol itself charges nothing beyond the L1/L2 gas of calling it: 1:1 ETH credited, same as sent.
      amountOut: req.amountIn,
      fee: 0n,
      etaSec: l1ToL2 ? BASE_DEPOSIT_ETA_SEC : BASE_WITHDRAWAL_ETA_SEC,
      target: l1ToL2 ? BASE_L1_STANDARD_BRIDGE : BASE_L2_STANDARD_BRIDGE,
      calldata: ethBridgeCall(req.account),
      // The bridged ETH is the call's value, not a function argument — bridgeETHTo is payable.
      value: req.amountIn,
      // `_to` is bridgeETHTo's first argument, a fixed-position address: a UniActionPolicy EQUAL rule pins it.
      recipientCheck: 'onchain-pinnable',
      mode: 'session-key',
      // The protocol has no price to go stale; this only bounds how long the app treats the quote as current.
      expiresAt: new Date(now + 5 * 60_000).toISOString(),
    }
  },
}
