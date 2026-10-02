import { ReasonError } from '@mamoru/domain'
import { amountsOf, type Proposal } from '@mamoru/decide'
import { entry, type RegistryEntry, type RegistryName } from '@mamoru/registry'
import { quoteMint, token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import type { PoolSample } from './types.ts'

const Q96 = 1n << 96n
const Q128 = 1n << 128n
const U256 = 1n << 256n

/** A position the simulated account holds. It never existed on chain: it earns what a real one of the same size would have. */
export type SimPosition = {
  tokenId: bigint
  pool: RegistryName
  tickLower: number
  tickUpper: number
  liquidity: bigint
  /** Fees accrued and not collected yet. */
  owed0: bigint
  owed1: bigint
  /** Fractions of a raw unit still to be credited, scaled by 2^128, so small positions do not lose them at every sample. */
  rem0?: bigint
  rem1?: bigint
}

export type World = {
  balances: Record<RegistryName, bigint>
  positions: SimPosition[]
  nextTokenId: bigint
  /** Timestamp of the last re-range, for the policy cooldown. */
  lastRerangeAt: bigint | null
}

export function newWorld(savings: RegistryName, deposit: bigint): World {
  return { balances: { [savings]: deposit }, positions: [], nextTokenId: 1n, lastRerangeAt: null }
}

function credit(w: World, token: RegistryName, amount: bigint): void {
  w.balances[token] = (w.balances[token] ?? 0n) + amount
}

function debit(w: World, token: RegistryName, amount: bigint): void {
  const held = w.balances[token] ?? 0n
  if (amount > held) throw new Error(`simulated account spends ${amount} ${token}, holds ${held}`)
  w.balances[token] = held - amount
}

export function inRange(tick: number, p: { tickLower: number; tickUpper: number }): boolean {
  return tick >= p.tickLower && tick < p.tickUpper
}

/** Raw units of `savings` worth `amount` of `token` at the price of a pool that pairs the two. */
export function valueIn(e: RegistryEntry, s: PoolSample, token: RegistryName, amount: bigint, savings: RegistryName): bigint {
  if (token === savings || amount === 0n) return token === savings ? amount : 0n
  if (e.token0 === token && e.token1 === savings) return token0InToken1(amount, s.sqrtPriceX96)
  if (e.token1 === token && e.token0 === savings) return token1InToken0(amount, s.sqrtPriceX96)
  throw new Error(`${e.name} does not price ${token} in ${savings}`)
}

/**
 * Fees one position earned between two samples of its pool.
 *
 * `feeGrowthGlobal` is the fee per unit of active liquidity, already net of the protocol fee. The position was not in
 * the pool, so its share is its liquidity over the active liquidity plus itself. In range at both ends: the whole
 * interval. At one end only: half. At neither: nothing. A price that crosses the whole range between two samples is
 * not seen; denser samples shrink that error. The result is scaled by 2^128, as the counters are.
 */
export function accruedX128(p: SimPosition, a: PoolSample, b: PoolSample): { fees0X128: bigint; fees1X128: bigint } {
  const halves = BigInt((inRange(a.tick, p) ? 1 : 0) + (inRange(b.tick, p) ? 1 : 0))
  const active = (a.liquidity + b.liquidity) / 2n
  if (halves === 0n || p.liquidity === 0n || active === 0n) return { fees0X128: 0n, fees1X128: 0n }
  const growth = (now: bigint, before: bigint) => (((now - before) % U256) + U256) % U256
  const share = (g: bigint) => (p.liquidity * g * active * halves) / ((active + p.liquidity) * 2n)
  return { fees0X128: share(growth(b.feeGrowthGlobal0X128, a.feeGrowthGlobal0X128)), fees1X128: share(growth(b.feeGrowthGlobal1X128, a.feeGrowthGlobal1X128)) }
}

/** The same in whole raw units, for one interval on its own. */
export function accrued(p: SimPosition, a: PoolSample, b: PoolSample): { fees0: bigint; fees1: bigint } {
  const f = accruedX128(p, a, b)
  return { fees0: f.fees0X128 / Q128, fees1: f.fees1X128 / Q128 }
}

/** Credits one interval to the position, carrying the fraction of a unit to the next one. Returns the whole units credited. */
export function accrue(p: SimPosition, a: PoolSample, b: PoolSample): { fees0: bigint; fees1: bigint } {
  const f = accruedX128(p, a, b)
  const t0 = (p.rem0 ?? 0n) + f.fees0X128
  const t1 = (p.rem1 ?? 0n) + f.fees1X128
  const fees0 = t0 / Q128
  const fees1 = t1 / Q128
  p.rem0 = t0 % Q128
  p.rem1 = t1 % Q128
  p.owed0 += fees0
  p.owed1 += fees1
  return { fees0, fees1 }
}

/**
 * Output of an exact-input swap against the active liquidity of the sample, with the pool fee and the price impact
 * of a single tick range, rounded the way the pool rounds. A swap large enough to cross a tick is priced as if the
 * liquidity stayed the same. The historical price path is not moved by it.
 */
export function swapOut(e: RegistryEntry, s: PoolSample, tokenIn: RegistryName, amountIn: bigint): bigint {
  const net = (amountIn * BigInt(1_000_000 - (e.fee ?? 0))) / 1_000_000n
  const L = s.liquidity
  const sp = s.sqrtPriceX96
  if (net === 0n) return 0n
  if (tokenIn === e.token0) {
    if (L === 0n) return token0InToken1(net, sp)
    // As the pool does for an exact input of token0: the next price rounds up, the output rounds down.
    const den = (L << 96n) + net * sp
    const next = ((L << 96n) * sp + den - 1n) / den
    return (L * (sp - next)) / Q96
  }
  if (L === 0n) return token1InToken0(net, sp)
  const next = sp + (net * Q96) / L
  return ((L << 96n) * (next - sp)) / next / sp
}

export type Applied = { ok: true; fees0: bigint; fees1: bigint } | { ok: false; detail: string }

/** One proposal of `decide`, executed the way the engine builds its calls. */
export function apply(w: World, p: Proposal, s: PoolSample, time: number, slippageBps: number): Applied {
  const e = entry(p.pool)
  const none = { ok: true as const, fees0: 0n, fees1: 0n }
  if (p.kind === 'enter_swap') {
    debit(w, p.tokenIn, p.amountIn)
    credit(w, p.tokenOut, swapOut(e, s, p.tokenIn, p.amountIn))
    return none
  }
  if (p.kind === 'enter_mint') {
    let q
    try {
      q = quoteMint({ sqrtPriceX96: s.sqrtPriceX96, tickLower: p.tickLower, tickUpper: p.tickUpper, amount0Desired: p.amount0Desired, amount1Desired: p.amount1Desired, slippageBps })
    } catch (err) {
      if (err instanceof ReasonError) return { ok: false, detail: `${err.code}${err.detail ? `: ${err.detail}` : ''}` }
      throw err
    }
    debit(w, e.token0!, q.amount0)
    debit(w, e.token1!, q.amount1)
    w.positions.push({ tokenId: w.nextTokenId++, pool: p.pool, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: q.liquidity, owed0: 0n, owed1: 0n })
    return none
  }
  const pos = w.positions.find((x) => x.tokenId === p.tokenId)
  if (!pos) return { ok: false, detail: `no position ${p.tokenId}` }
  const fees = { fees0: pos.owed0, fees1: pos.owed1 }
  // Every remaining kind starts with a collect to the account.
  credit(w, e.token0!, pos.owed0)
  credit(w, e.token1!, pos.owed1)
  pos.owed0 = 0n
  pos.owed1 = 0n
  if (p.kind === 'harvest') {
    if (p.convert) {
      // Fees only: never more of the volatile token than the fees just collected.
      const collected = p.convert.token === e.token0 ? fees.fees0 : fees.fees1
      const amount = p.convert.amount < collected ? p.convert.amount : collected
      const savings = p.convert.token === e.token0 ? e.token1! : e.token0!
      debit(w, p.convert.token, amount)
      credit(w, savings, swapOut(e, s, p.convert.token, amount))
    }
    return { ok: true, ...fees }
  }
  const liquidity = p.kind === 'rerange' || p.liquidity > pos.liquidity ? pos.liquidity : p.liquidity
  const out = amountsOf(s.sqrtPriceX96, pos.tickLower, pos.tickUpper, liquidity)
  credit(w, e.token0!, out.amount0)
  credit(w, e.token1!, out.amount1)
  pos.liquidity -= liquidity
  if (p.kind === 'rerange') {
    w.positions.splice(w.positions.indexOf(pos), 1)
    w.lastRerangeAt = BigInt(time)
  }
  return { ok: true, ...fees }
}
