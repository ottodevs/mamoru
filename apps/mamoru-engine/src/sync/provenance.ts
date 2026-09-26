import type { Figure, Hex0x, Provenance, ReasonCode } from '@mamoru/domain'

/** The block every read of one sync is pinned to (plan §23.3, `H`). */
export type Anchor = { chainId: number; blockNumber: number; blockHash: Hex0x; observedAt: string }

export function rpcAt(anchor: Anchor, extra: Partial<Provenance> = {}): Provenance {
  return { source: 'chain_rpc', chainId: anchor.chainId, blockNumber: anchor.blockNumber, blockHash: anchor.blockHash, observedAt: anchor.observedAt, status: 'fresh', ...extra }
}

export function estimateAt(anchor: Anchor): Provenance {
  return { ...rpcAt(anchor), source: 'estimate' }
}

export function fig<T>(value: T, provenance: Provenance, unit?: string): Figure<T> {
  return unit === undefined ? { value, provenance } : { value, unit, provenance }
}

/** A figure with no data: null value, status not_observed, and why. */
export function notObserved<T>(anchor: Anchor, detail?: ReasonCode, unit?: string, source: Provenance['source'] = 'chain_rpc'): Figure<T> {
  const provenance: Provenance = { source, chainId: anchor.chainId, observedAt: anchor.observedAt, status: 'not_observed' }
  if (detail) provenance.detail = detail
  return unit === undefined ? { value: null, provenance } : { value: null, unit, provenance }
}
