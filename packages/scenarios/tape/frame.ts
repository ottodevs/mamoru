import type { ScenarioTape, TapeFrame, TapeGate } from '@mamoru/domain'
import { amountsForLiquidity, estimateFees, inSavings, type Decision, type Observation, type PoolObs } from '@mamoru/decide'
import type { PolicyVersion } from '@mamoru/policy'
import { entry } from '@mamoru/registry'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'

const Q96 = 1n << 96n
const Q192 = Q96 * Q96

/** Raw integer units to a plain decimal string, trailing zeros trimmed, rounded down to `places`. */
export function toDec(raw: bigint, decimals: number, places = decimals): string {
  const neg = raw < 0n
  let v = neg ? -raw : raw
  if (places < decimals) v /= 10n ** BigInt(decimals - places)
  const p = Math.min(places, decimals)
  const s = v.toString().padStart(p + 1, '0')
  const int = s.slice(0, s.length - p)
  const frac = s.slice(s.length - p).replace(/0+$/, '')
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`
}

/** Human price of the volatile token in the savings asset at `sqrtPriceX96`, as a decimal string. */
export function priceDec(sqrtPriceX96: bigint, pool: { token0: string; token1: string }, savings: string, places = 2): string {
  const d0 = decimalsOf(pool.token0)
  const d1 = decimalsOf(pool.token1)
  const scale = 10n ** BigInt(places)
  const sq = sqrtPriceX96 * sqrtPriceX96
  // raw token1 per raw token0 = sq / Q192
  const scaled = pool.token1 === savings ? (sq * 10n ** BigInt(d0) * scale) / (Q192 * 10n ** BigInt(d1)) : (Q192 * 10n ** BigInt(d1) * scale) / (sq * 10n ** BigInt(d0))
  return toDec(scaled, places)
}

export function decimalsOf(token: string): number {
  const d = entry(token).decimals
  if (d === undefined || d === null) throw new Error(`${token} has no decimals in the registry`)
  return d
}

/** Amount of token0 (price down) or token1 (price up) that moves the pool from `sqrtPriceX96` to `targetTick` at constant `liquidity`. */
export function amountToTick(sqrtPriceX96: bigint, liquidity: bigint, targetTick: number): { zeroForOne: boolean; amountIn: bigint } {
  const target = sqrtRatioAtTick(targetTick)
  if (target < sqrtPriceX96) return { zeroForOne: true, amountIn: (liquidity * Q96 * (sqrtPriceX96 - target)) / (sqrtPriceX96 * target) }
  return { zeroForOne: false, amountIn: (liquidity * (target - sqrtPriceX96)) / Q96 }
}

export type FrameMeta = { key?: boolean; title: string; note: string; tx?: TapeFrame['tx'] }

export type FrameInput = {
  obs: Observation
  decision: Decision
  policy: PolicyVersion
  pool: string
  t0: bigint
  /** Priority fee the engine adds to twice the base fee (driver MAX_PRIORITY_FEE_PER_GAS). */
  maxPriorityFeePerGas: bigint
}

function kindOf(d: Decision): TapeFrame['decision']['kind'] {
  return d.kind === 'hold' ? 'hold' : d.kind === 'harvest' ? 'harvest' : 'enter'
}

/** One tape frame: every figure from the observation, the decision exactly as decide() returned it. */
export function buildFrame(input: FrameInput, meta: FrameMeta): TapeFrame {
  const { obs, decision, policy } = input
  const savings = policy.savingsAsset
  const sd = decimalsOf(savings)
  const pool = obs.pools.find((p) => p.name === input.pool)
  if (!pool) throw new Error(`${input.pool} is not in the observation`)
  const pos = obs.positions.find((p) => p.managed && p.pool === pool.name) ?? null
  const baseFee = (obs.gas.maxFeePerGas - input.maxPriorityFeePerGas) / 2n
  const factorBps = policy.harvest.costFactorBps
  const probe = pos ?? { tokenId: 0n, pool: pool.name, tickLower: 0, tickUpper: 0, liquidity: 0n, collectable0: 0n, collectable1: 0n, principalOwed0: 0n, principalOwed1: 0n, managed: false }
  const est = estimateFees(obs, policy, probe, pool)
  const trail: TapeGate[] = decision.trail.map((g) => ({ gate: g.gate, verdict: g.verdict, reason: g.reason }))
  return {
    t: Number(obs.block.timestamp - input.t0),
    block: Number(obs.block.number),
    key: meta.key ?? false,
    title: meta.title,
    note: meta.note,
    pool: { name: pool.name.replace(/^pool:/, ''), tick: pool.tick, price: priceDec(pool.sqrtPriceX96, pool, savings), liquidity: pool.liquidity.toString() },
    position: pos ? positionOf(pos, pool, savings, sd, est.feesValue) : null,
    cost: {
      baseFeeGwei: toDec(baseFee, 9, 4),
      opCost: toDec(est.costValue, sd),
      threshold: toDec((est.costValue * BigInt(factorBps)) / 10_000n, sd),
      factorBps,
    },
    decision: { kind: kindOf(decision), code: decision.code, reason: decision.reason, trail, decisionId: decision.decisionId },
    tx: meta.tx ?? null,
  }
}

function positionOf(pos: Observation['positions'][number], pool: PoolObs, savings: string, sd: number, feesValue: bigint): NonNullable<TapeFrame['position']> {
  const { amount0, amount1 } = amountsForLiquidity(pool.sqrtPriceX96, pos.tickLower, pos.tickUpper, pos.liquidity)
  const principal = inSavings(pool, pool.token0, amount0, savings) + inSavings(pool, pool.token1, amount1, savings)
  const a = priceDec(sqrtRatioAtTick(pos.tickLower), pool, savings)
  const b = priceDec(sqrtRatioAtTick(pos.tickUpper), pool, savings)
  const [lowerPrice, upperPrice] = Number(a) <= Number(b) ? [a, b] : [b, a]
  return {
    tokenId: pos.tokenId.toString(),
    tickLower: pos.tickLower,
    tickUpper: pos.tickUpper,
    lowerPrice,
    upperPrice,
    inRange: pool.tick >= pos.tickLower && pool.tick < pos.tickUpper,
    principalValue: toDec(principal, sd),
    feesValue: toDec(feesValue, sd),
  }
}

/** Structural checks a tape must pass before it is written. */
export function checkTape(tape: ScenarioTape): string[] {
  const errs: string[] = []
  if (tape.chainId === 8453 || tape.chainId === 84532) errs.push(`chain id ${tape.chainId} is Base`)
  if (tape.frames.length < 3) errs.push(`${tape.frames.length} frames`)
  if (!tape.frames.some((f) => f.key)) errs.push('no keyframe')
  for (const [i, f] of tape.frames.entries()) {
    if (i > 0 && f.block < tape.frames[i - 1]!.block) errs.push(`frame ${i} goes back in blocks`)
    if (i > 0 && f.t < tape.frames[i - 1]!.t) errs.push(`frame ${i} goes back in time`)
    if (!f.title || !f.note) errs.push(`frame ${i} without title or note`)
  }
  if (tape.frames[0]?.t !== 0) errs.push('first frame is not at t=0')
  return errs
}
