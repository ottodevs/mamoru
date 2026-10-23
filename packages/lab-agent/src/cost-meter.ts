// Agent Lab agent (008 task 4, otto/mamoru#200): the cost meter (AL-40) — what one job spent, so pricing (AL-41,
// AL-42) has real numbers to set from. `shadowCost` takes the price table as a parameter: this package never
// hardcodes a price, and the table carries its own `date` so a job's shadow cost is reproducible from its meter.
export type ModelCallRecord = { model: string; promptTokens: number; completionTokens: number }
export type RunCostRecord = { resultHash: string; cpuMs: number }
export type VerifierOutcome = 'ok' | 'repaired' | 'partial' | 'error'

export type CostMeter = {
  modelCalls: ModelCallRecord[]
  toolRounds: number
  runs: RunCostRecord[]
  /** CPU ms a sweep call spent, even though v1's sweep tool never actually runs one (AL-40 still wants the field). */
  sweepCpuMs: number
  wallMs: number
  repairUsed: boolean
  verifierOutcome: VerifierOutcome
}

export function newCostMeter(): CostMeter {
  return { modelCalls: [], toolRounds: 0, runs: [], sweepCpuMs: 0, wallMs: 0, repairUsed: false, verifierOutcome: 'ok' }
}

export function recordModelCall(meter: CostMeter, call: ModelCallRecord): void {
  meter.modelCalls.push(call)
}

export function recordToolRound(meter: CostMeter): void {
  meter.toolRounds += 1
}

export function recordRun(meter: CostMeter, resultHash: string, cpuMs: number): void {
  meter.runs.push({ resultHash, cpuMs })
}

export function recordSweepCpuMs(meter: CostMeter, ms: number): void {
  meter.sweepCpuMs += ms
}

/**
 * CPU ms (not wall ms) of one synchronous call, via `process.cpuUsage` deltas — what AL-40's "runs and their CPU
 * ms" means (wall time is tracked separately, once per job, as `meter.wallMs`).
 */
export function measureCpuMs<T>(fn: () => T): { result: T; cpuMs: number } {
  const before = process.cpuUsage()
  const result = fn()
  const after = process.cpuUsage(before)
  return { result, cpuMs: (after.user + after.system) / 1000 }
}

export type ModelPrice = { inputPerMTok: number; outputPerMTok: number }

/**
 * One config table, dated, per AL-40/AL-32: included subscription credits still count at a shadow price. A model
 * resource with no entry falls back to `models.default`. `computeUsdPerCpuMs` prices `runs[].cpuMs` and
 * `sweepCpuMs` the same way; `dataUsdPerJob`/`settlementUsdPerJob` are per-job flat terms (settlement is 0 in v1,
 * AL-41: "settlement (0 in v1)" — still a real field, not an assumption baked into the formula).
 */
export type ShadowPriceTable = {
  date: string
  models: Record<string, ModelPrice> & { default?: ModelPrice }
  computeUsdPerCpuMs: number
  dataUsdPerJob: number
  settlementUsdPerJob: number
}

export type ShadowCost = { llm: number; compute: number; data: number; settlement: number; total: number }

function priceOf(prices: ShadowPriceTable, model: string): ModelPrice {
  return prices.models[model] ?? prices.models.default ?? { inputPerMTok: 0, outputPerMTok: 0 }
}

/** AL-41's four-way split (LLM / compute / data / settlement) for one job's meter, under one price table. */
export function shadowCost(meter: CostMeter, prices: ShadowPriceTable): ShadowCost {
  const llm = meter.modelCalls.reduce((sum, c) => {
    const p = priceOf(prices, c.model)
    return sum + (c.promptTokens / 1_000_000) * p.inputPerMTok + (c.completionTokens / 1_000_000) * p.outputPerMTok
  }, 0)
  const cpuMs = meter.runs.reduce((sum, r) => sum + r.cpuMs, 0) + meter.sweepCpuMs
  const compute = cpuMs * prices.computeUsdPerCpuMs
  const data = prices.dataUsdPerJob
  const settlement = prices.settlementUsdPerJob
  return { llm, compute, data, settlement, total: llm + compute + data + settlement }
}
