import { ReasonError } from './reason-codes.ts'

/** FR-CHN-001: the closed set of chains Mamoru executes on. No member is a default anywhere. */
export type ChainId = 8453 | 143

/** The block tag a chain treats as its confirmation. */
export type FinalityTag = 'safe' | 'finalized' | 'latest'

/** How a chain charges gas: by what a transaction used, or by the limit it declared. */
export type GasModel = 'gas_used' | 'gas_limit'

/**
 * FR-CHN-001: what a piece needs to know about a chain, read from here and never
 * from a constant of its own. A field that could not be verified for a chain is
 * `null`, and the piece that needs it fails closed. No value here is a Packaging
 * threshold.
 */
export type ChainDescriptor = {
  chainId: ChainId
  name: string
  native: { symbol: string; decimals: 18 }
  /** Registry name of the ERC-20 wrapping the native asset (SwapRouter02's WETH9 on the chain). */
  wrappedNative: string
  /** Reference block time, to convert seconds into blocks. */
  blockTimeMs: number
  /** Tag the chain serves as confirmation; `null` when none was verified (CONFIG_CHAIN_FINALITY_UNKNOWN). */
  finalityTag: FinalityTag | null
  gasModel: GasModel
  /** Whether the chain adds an L1 data fee to every transaction. */
  l1DataFee: boolean
  /** Gas cap of one transaction on the chain, or `null` when the chain has none. */
  perTxGasCap: bigint | null
  explorerHost: string
  /** Chain ids of the chain's test networks. */
  testnetChainIds: readonly number[]
}

export const BASE_CHAIN: ChainDescriptor = {
  chainId: 8453,
  name: 'Base',
  native: { symbol: 'ETH', decimals: 18 },
  wrappedNative: 'WETH',
  blockTimeMs: 2_000,
  finalityTag: 'safe',
  gasModel: 'gas_used',
  l1DataFee: true,
  perTxGasCap: 16_777_216n,
  explorerHost: 'basescan.org',
  testnetChainIds: [84532],
}

/**
 * Values read against the Monad RPC and the Monad documentation on 2026-10-02
 * (`scripts/monad/verify-rpc.ts`, `evidence/monad/rpc.md`): `safe` and `finalized`
 * are served and `finalized` lags `latest` by two blocks; 300 ms per block in the
 * documentation, 301 to 302 ms measured over 1,000 and 10,000 blocks; 30M gas per
 * transaction from the documentation; MonadVision as the documented explorer;
 * Monad Testnet 10143.
 */
export const MONAD_CHAIN: ChainDescriptor = {
  chainId: 143,
  name: 'Monad',
  native: { symbol: 'MON', decimals: 18 },
  wrappedNative: 'WMON',
  blockTimeMs: 300,
  finalityTag: 'finalized',
  gasModel: 'gas_limit',
  l1DataFee: false,
  perTxGasCap: 30_000_000n,
  explorerHost: 'monadvision.com',
  testnetChainIds: [10143],
}

export const SUPPORTED_CHAINS: readonly ChainDescriptor[] = [BASE_CHAIN, MONAD_CHAIN]

export function isChainId(chainId: number): chainId is ChainId {
  return SUPPORTED_CHAINS.some((c) => c.chainId === chainId)
}

/** The descriptor of a supported chain, or CHAIN_UNSUPPORTED. */
export function chainOf(chainId: number): ChainDescriptor {
  const found = SUPPORTED_CHAINS.find((c) => c.chainId === chainId)
  if (!found) throw new ReasonError('CHAIN_UNSUPPORTED', `chain id ${chainId} is not in SUPPORTED_CHAINS`)
  return found
}

/**
 * FR-CHN-003: every chain id the lab must refuse, derived from the descriptors:
 * each supported chain and each of its test networks. Never written by hand.
 */
export const FORBIDDEN_LAB_CHAIN_IDS: readonly number[] = SUPPORTED_CHAINS.flatMap((c) => [c.chainId, ...c.testnetChainIds])

/**
 * otto/mamoru#61: the chains other than Base that an operator may be opted into writing to. Base is written to as it
 * always was (MAMORU_LIVE=1 on chain 8453) and is never named here; a chain joins this list only once every
 * Base-bound builder on its write path reads that chain's registry instead.
 */
export const OPT_IN_WRITE_CHAIN_IDS: readonly ChainId[] = [143]

/** The env variable that opts an operator into writing to a chain of OPT_IN_WRITE_CHAIN_IDS. Unset: Base only. */
export const CHAIN_WRITES_ENV = 'MAMORU_CHAIN_WRITES'

/**
 * otto/mamoru#61: the chain ids MAMORU_CHAIN_WRITES opts into, comma-separated. Unset or empty: none (default; Base
 * behaviour unchanged). Anything that is not a chain of OPT_IN_WRITE_CHAIN_IDS (Base included, a typo, a testnet) is
 * refused with CONFIG_INVALID rather than ignored, so a misconfigured flag stops the process instead of half applying.
 */
export function chainWritesOptIn(env: Record<string, string | undefined>): readonly ChainId[] {
  const raw = env[CHAIN_WRITES_ENV]
  if (raw === undefined || raw.trim() === '') return []
  const out: ChainId[] = []
  for (const part of raw.split(',').map((x) => x.trim())) {
    const id = /^[0-9]+$/.test(part) ? Number(part) : Number.NaN
    const found = OPT_IN_WRITE_CHAIN_IDS.find((c) => c === id)
    if (found === undefined) throw new ReasonError('CONFIG_MODE_INVALID', `${CHAIN_WRITES_ENV}=${raw}: ${part} is not a chain that can be opted into (${OPT_IN_WRITE_CHAIN_IDS.join(', ')})`)
    if (!out.includes(found)) out.push(found)
  }
  return out
}

/**
 * Whether a live process (MAMORU_LIVE=1) may sign and send on `chainId`: Base, as always, or a chain this process
 * was explicitly opted into (chainWritesOptIn). A malformed opt-in allows nothing beyond Base.
 */
export function liveChainAllowed(chainId: number, env: Record<string, string | undefined>): boolean {
  if (env.MAMORU_LIVE !== '1') return false
  if (chainId === BASE_CHAIN.chainId) return true
  try {
    return chainWritesOptIn(env).some((c) => c === chainId)
  } catch {
    return false
  }
}
