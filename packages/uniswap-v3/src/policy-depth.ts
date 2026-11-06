/**
 * otto/mamoru#378: MamoruActionPolicy's depth check at a config write (LeftClaw M-5). `initializeWithMultiplexer`
 * refuses an Init whose `perWindow` budget is more than selling into the pool can absorb within `bandTicks`
 * (`BadInit(11)`), and the whole owner transaction reverts with it (GS013). The budget follows the signed cap, so a
 * large cap (~80k USDC and up at the Base fork block of #378) asks for more than the USDC/USDT pool holds in its
 * 10-tick band. This mirrors `_depthIn` and `_depth` read for read, so the operator can size `perWindow` under it
 * before the owner signs.
 */
import type { Address } from '@mamoru/domain'
import { MAX_TICK, MIN_TICK, quoteAtTick } from './policy-bounds.ts'
import { sqrtRatioAtTick } from './quote.ts'

const Q96 = 1n << 96n

/** What `_depth` reads from the pool: the spot, the in-range liquidity, the spacing and each crossed tick's net. */
export type DepthReads = {
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  tickSpacing: number
  /** `ticks(b).liquidityNet` for an initialized-or-not boundary `b` (0 when the tick is not initialized). */
  liquidityNet: (tick: number) => Promise<bigint>
}

function clamp(t: number): number {
  return t > MAX_TICK ? MAX_TICK : t < MIN_TICK ? MIN_TICK : t
}

/** LiquidityAmounts.getAmount1ForLiquidity. */
function amount1For(a: bigint, b: bigint, l: bigint): bigint {
  const [lo, hi] = a > b ? [b, a] : [a, b]
  return (l * (hi - lo)) / Q96
}

/** LiquidityAmounts.getAmount0ForLiquidity. */
function amount0For(a: bigint, b: bigint, l: bigint): bigint {
  const [lo, hi] = a > b ? [b, a] : [a, b]
  return ((l << 96n) * (hi - lo)) / hi / lo
}

/** Mirrors `_depth(pool, band, up)`: what selling token1 (up) or token0 (down) takes to move the price `band` ticks. */
export async function policyDepth(r: DepthReads, band: number, up: boolean): Promise<bigint> {
  let sp = r.sqrtPriceX96
  let liq = r.liquidity
  const spacing = r.tickSpacing
  const end = clamp(up ? r.tick + band : r.tick - band)
  // Solidity's int division truncates toward zero, as Math.trunc does.
  let b = Math.trunc(r.tick / spacing) * spacing
  if (r.tick < 0 && r.tick % spacing !== 0) b -= spacing
  if (up) b += spacing
  let d = 0n
  for (;;) {
    const last = up ? b >= end : b <= end
    const sb = sqrtRatioAtTick(last ? end : b)
    const l = liq > 0n ? liq : 0n
    d += up ? amount1For(sp, sb, l) : amount0For(sb, sp, l)
    if (last) return d
    const net = await r.liquidityNet(b)
    liq = up ? liq + net : liq - net
    sp = sb
    b = up ? b + spacing : b - spacing
  }
}

/** Mirrors `_depthIn(pool, p, band, in1)`: the depth in the budget's own token, the smaller of the two directions. */
export async function policyDepthIn(r: DepthReads, token0: Address, token1: Address, band: number, in1: boolean): Promise<bigint> {
  let up = await policyDepth(r, band, true)
  let down = await policyDepth(r, band, false)
  if (in1) down = quoteAtTick(clamp(r.tick - band), down, token0, token1)
  else up = quoteAtTick(clamp(r.tick + band), up, token1, token0)
  return up < down ? up : down
}
