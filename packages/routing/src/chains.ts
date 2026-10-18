import { zeroAddress, type Address } from 'viem'
import type { Asset } from './types.ts'

// otto/mamoru#181. Per-chain facts this package's adapters need, verified against each provider's own docs (and,
// where noted, cross-checked against an explorer) on 18 Oct 2026. Scoped to the three chains the ticket names —
// Ethereum, Base, Monad. The aggregator adapters (Relay, LI.FI, deBridge) take arbitrary chain ids and token
// addresses from the caller, so "other L2s" are already reachable through them without an entry here; CCTP and
// Across need a pinned, verified address per chain, so this table only grows when one has actually been checked.

export const ETHEREUM_CHAIN_ID = 1
export const BASE_CHAIN_ID = 8453
export const MONAD_CHAIN_ID = 143

/** The pseudo-address most bridge/aggregator APIs use for the native asset (ETH) instead of a token contract. */
export const NATIVE_ASSET_ADDRESS: Address = zeroAddress

export type ChainConfig = {
  chainId: number
  name: string
  usdc: Address
  /** Circle CCTP V2 domain id. developers.circle.com/cctp/cctp-supported-blockchains */
  cctpDomain: number
  /** Fast (minFinalityThreshold 1000) is unsupported here — Circle's own docs mark it N/A for Monad because
   * Standard attestation is already fast enough; every other configured chain supports Fast. */
  cctpFastSupported: boolean
  /** Across SpokePool for this chain. docs.across.to/chains-and-contracts, cross-checked on-chain 18 Oct 2026. */
  acrossSpokePool: Address
}

const ETHEREUM: ChainConfig = {
  chainId: ETHEREUM_CHAIN_ID,
  name: 'ethereum',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  cctpDomain: 0,
  cctpFastSupported: true,
  acrossSpokePool: '0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5',
}

const BASE: ChainConfig = {
  chainId: BASE_CHAIN_ID,
  name: 'base',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  cctpDomain: 6,
  cctpFastSupported: true,
  acrossSpokePool: '0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64',
}

const MONAD: ChainConfig = {
  chainId: MONAD_CHAIN_ID,
  name: 'monad',
  usdc: '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',
  cctpDomain: 15,
  cctpFastSupported: false,
  acrossSpokePool: '0xd2ecb3afe598b746F8123CaE365a598DA831A449',
}

export const CHAINS: readonly ChainConfig[] = [ETHEREUM, BASE, MONAD]

export function chainConfig(chainId: number): ChainConfig | undefined {
  return CHAINS.find((c) => c.chainId === chainId)
}

/** The token address an adapter should pass to a provider for `asset` on `chainId`. ETH is the pseudo-address
 * every aggregator here accepts in place of a real contract. USDC is undefined on a chain this table does not
 * cover (an aggregator adapter that reaches further chains must be given the address directly by its caller). */
export function tokenAddress(asset: Asset, chainId: number): Address | undefined {
  if (asset === 'ETH') return NATIVE_ASSET_ADDRESS
  return chainConfig(chainId)?.usdc
}
