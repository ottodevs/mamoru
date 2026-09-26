// Scenario tape contract: a recorded fork run replayed by the SPA Lab route.
// Written by packages/scenarios (recorder), read by apps/mamoru-app (/lab). Only the integrator changes this file.
import type { ReasonCode } from './reason-codes.ts'

export type TapeId = 'TAPE-HARVEST' | 'TAPE-OUT-OF-RANGE' | 'TAPE-POOL-SHOCK'

// Decimal strings, human units (USDC, gwei), so the SPA never does bigint math.
export type Dec = string

export type TapeGate = { gate: string; verdict: 'GO' | 'NO_GO' | 'EXIT' | 'SKIP'; reason: ReasonCode }

export type TapeFrame = {
  // Seconds of chain time since the first frame.
  t: number
  block: number
  // A keyframe gets a marker on the timeline and a title.
  key: boolean
  title: string
  // One plain sentence of what the engine saw and did.
  note: string
  pool: { name: string; tick: number; price: Dec; liquidity: Dec }
  position: {
    tokenId: string
    tickLower: number
    tickUpper: number
    lowerPrice: Dec
    upperPrice: Dec
    inRange: boolean
    principalValue: Dec
    feesValue: Dec
  } | null
  // Harvest economics in the savings asset: harvest when feesValue > opCost * factor.
  cost: { baseFeeGwei: Dec; opCost: Dec; threshold: Dec; factorBps: number }
  // Straight from decide(): never hand-written.
  decision: { kind: 'hold' | 'harvest' | 'enter'; code: ReasonCode; reason: ReasonCode; trail: TapeGate[]; decisionId: `0x${string}` }
  tx: { hash: `0x${string}`; label: string; ok: boolean } | null
}

export type ScenarioTape = {
  id: TapeId
  title: string
  summary: string
  savingsAsset: string
  // Lab chain id, never 8453 or 84532.
  chainId: number
  forkOf: 'Base'
  forkBlock: number
  recordedAt: string
  frames: TapeFrame[]
}
