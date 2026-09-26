import type { Provenance, ReasonCode } from '@mamoru/domain'
import type { PoolEvent } from './logs.ts'
import type { SourcedEvent } from './pool-view.ts'
import { rpcAt, type Anchor } from './provenance.ts'

/** Rows from RPC logs because the index is not usable (dashboard.md §6.6). `cause` is absent when MultiBaas is not configured. */
export function rpcFallback(events: PoolEvent[], anchor: Anchor, cause?: ReasonCode): { events: SourcedEvent[]; window: Provenance } {
  const extra: Partial<Provenance> = cause ? { detail: 'PROJ_SOURCE_FALLBACK_RPC', cause } : { detail: 'PROJ_SOURCE_FALLBACK_RPC' }
  return {
    events: events.map((e) => ({ ...e, provenance: rpcAt(anchor, { ...extra, blockNumber: e.block, blockHash: e.blockHash }) })),
    window: rpcAt(anchor, extra),
  }
}
