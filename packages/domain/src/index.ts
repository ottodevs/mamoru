export { REASON_CODES, ReasonError, isReasonCode, type ReasonCode } from './reason-codes.ts'

export type Hex = `0x${string}`
export type Address = `0x${string}`

export const BASE_CHAIN_ID = 8453
export const BASE_SEPOLIA_CHAIN_ID = 84532
export const FORBIDDEN_LAB_CHAIN_IDS: readonly number[] = [BASE_CHAIN_ID, BASE_SEPOLIA_CHAIN_ID]
export type * from './dashboard-payload.ts'
export { PRODUCTION_BANNER, LIVE_BANNER } from './dashboard-payload.ts'
export type * from './app-api.ts'
export { overCap } from './funding.ts'
export type * from './scenario-tape.ts'
