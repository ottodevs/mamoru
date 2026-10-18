export type { Adapter, AdapterDeps, Asset, Direction, Fetch, Quote, QuoteRequest, RecipientCheck, SigningMode } from './types.ts'
export { directionOf, isL1 } from './types.ts'
export { RouteError } from './errors.ts'
export { assertOwnerOnlyRecipient, calldataPinsRecipient, parseDeclaredAddress } from './recipient.ts'
export { quoteAll, rank, selectBest, type QuoteFailure, type QuoteRun, type SelectOptions } from './selector.ts'
export * from './chains.ts'

export { cctpAdapter } from './adapters/cctp.ts'
export { acrossAdapter } from './adapters/across.ts'
export { relayAdapter } from './adapters/relay.ts'
export { lifiAdapter } from './adapters/lifi.ts'
export { debridgeAdapter } from './adapters/debridge.ts'
export { canonicalBaseAdapter } from './adapters/canonical.ts'

import { acrossAdapter } from './adapters/across.ts'
import { canonicalBaseAdapter } from './adapters/canonical.ts'
import { cctpAdapter } from './adapters/cctp.ts'
import { debridgeAdapter } from './adapters/debridge.ts'
import { lifiAdapter } from './adapters/lifi.ts'
import { relayAdapter } from './adapters/relay.ts'
import type { Adapter } from './types.ts'

/** otto/mamoru#181: every adapter this package ships, in no particular order — the selector ranks them, not this
 * list. A caller who wants a subset (e.g. session-key-only) filters by `adapter.name` or by `Quote.mode` after
 * quoting. */
export const ALL_ADAPTERS: readonly Adapter[] = [cctpAdapter, acrossAdapter, relayAdapter, lifiAdapter, debridgeAdapter, canonicalBaseAdapter]
