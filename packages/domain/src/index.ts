export { REASON_CODES, ReasonError, isReasonCode, type ReasonCode } from './reason-codes.ts'
export * from './chains.ts'

export type Hex = `0x${string}`
export type Address = `0x${string}`

// Legacy of 001, when Base was the only chain. Kept for the tests of 001; no production code
// takes either as "the chain": a piece reads its chain from SUPPORTED_CHAINS and chainOf (FR-CHN-002).
/** @deprecated Legacy of 001. Read the chain from `chainOf(sourceChainId)`; never as the default chain. */
export const BASE_CHAIN_ID = 8453
/** @deprecated Legacy of 001. The test networks of a chain are `chainOf(chainId).testnetChainIds`. */
export const BASE_SEPOLIA_CHAIN_ID = 84532
export type * from './dashboard-payload.ts'
export { PRODUCTION_BANNER, LIVE_BANNER } from './dashboard-payload.ts'
export type * from './app-api.ts'
export { overCap } from './funding.ts'
export type * from './scenario-tape.ts'
