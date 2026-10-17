import { overCap, type FundingView, type OverCap, type PoolsResponse } from '@mamoru/domain'
import { formatUnits } from './format.ts'

const SATS = 100_000_000n

/** USDC base units per whole cbBTC, from the USDC/cbBTC pool row. Null when not observed. */
export function cbbtcPrice(pools: PoolsResponse | undefined): bigint | null {
  const row = pools?.pools.find((p) => /cbBTC/i.test(p.pool.name) && /USDC/i.test(p.pool.name)) ?? pools?.pools[0]
  const v = row?.price.value
  return v && /^\d+$/.test(v) ? BigInt(v) : null
}

export function cbbtcToUsdc(sats: bigint, price: bigint | null): bigint {
  return price === null ? 0n : (sats * price) / SATS
}

export type Split = {
  total: bigint // USDC base units
  working: bigint
  idle: bigint
  workingUsdc: bigint
  workingCbbtc: bigint // sats
  idleUsdc: bigint
  idleCbbtc: bigint
  priced: boolean // false when cbBTC is held but no price was observed
  /**
   * What Max fills in. The 1% margin covers the slippage of unwinding positions; idle USDC needs no unwind (the
   * operator pays it straight out), so when it covers that much Max is every last unit of it.
   */
  maxWithdraw: bigint
  /** Every token held outside a position, as the operator reports it; empty for an older operator. */
  idleTokens: Holding[]
}

/** Under one cent a balance is what a swap or a mint rounds off: counted in the totals, not worth a line. */
export const DUST_USDC = 10_000n

/** An amount of one token (base units) and what it is worth in USDC base units. */
export type Holding = { token: string; amount: bigint; decimals: number; valueUsdc: bigint }

export function split(f: FundingView, price: bigint | null): Split {
  const workingUsdc = f.positions.reduce((a, p) => a + BigInt(p.amountUsdc), 0n)
  const workingCbbtc = f.positions.reduce((a, p) => a + BigInt(p.amountCbbtc), 0n)
  const idleUsdc = BigInt(f.usdc)
  const idleCbbtc = BigInt(f.cbbtc)
  // valueUsdc covers every pool (USDT, WETH too); older views fall back to the USDC + cbBTC legs.
  const working = f.positions.reduce((a, p) => a + (p.valueUsdc !== undefined ? BigInt(p.valueUsdc) : BigInt(p.amountUsdc) + cbbtcToUsdc(BigInt(p.amountCbbtc), price)), 0n)
  const everyIdle: Holding[] = (f.idle ?? []).map((t) => ({ token: t.token, amount: BigInt(t.amount), decimals: t.decimals, valueUsdc: BigInt(t.valueUsdc) }))
  // The operator's list covers every token (USDT and WETH between a swap and its mint too); without it, USDC + cbBTC.
  const idle = f.idle ? everyIdle.reduce((a, t) => a + t.valueUsdc, 0n) : idleUsdc + cbbtcToUsdc(idleCbbtc, price)
  // Listed token by token only from a cent up; the sum above keeps the rest.
  const idleTokens = everyIdle.filter((t) => t.valueUsdc >= DUST_USDC)
  const total = working + idle
  const margin = (total * 99n) / 100n
  return {
    total,
    working,
    idle,
    workingUsdc,
    workingCbbtc,
    idleUsdc,
    idleCbbtc,
    priced: price !== null || (f.positions.every((p) => p.valueUsdc !== undefined || p.amountCbbtc === '0') && idleCbbtc === 0n),
    maxWithdraw: idleUsdc >= margin ? idleUsdc : (margin / 10_000n) * 10_000n,
    idleTokens,
  }
}

/**
 * The whole account by token: what sits idle plus both sides of every position, largest value first. Null when the
 * operator does not report values per token yet.
 */
export function holdings(f: FundingView): (Holding & { idle: bigint; working: bigint })[] | null {
  if (!f.idle || f.positions.some((p) => !p.amounts || p.amounts.some((a) => a.valueUsdc === undefined))) return null
  const by = new Map<string, Holding & { idle: bigint; working: bigint }>()
  const add = (token: string, amount: bigint, decimals: number, valueUsdc: bigint, where: 'idle' | 'working') => {
    const h = by.get(token) ?? { token, amount: 0n, decimals, valueUsdc: 0n, idle: 0n, working: 0n }
    h.amount += amount
    h.valueUsdc += valueUsdc
    h[where] += amount
    by.set(token, h)
  }
  for (const t of f.idle) add(t.token, BigInt(t.amount), t.decimals, BigInt(t.valueUsdc), 'idle')
  for (const p of f.positions) for (const a of p.amounts!) add(a.token, BigInt(a.amount), a.decimals, BigInt(a.valueUsdc!), 'working')
  return [...by.values()].filter((h) => h.valueUsdc >= DUST_USDC).sort((a, b) => (b.valueUsdc > a.valueUsdc ? 1 : b.valueUsdc < a.valueUsdc ? -1 : 0))
}

/** Base units to "12.34". Always two decimals, grouped. */
export function usd(raw: bigint | string): string {
  const s = formatUnits(String(raw), 'USDC')
  const [w, f = ''] = s.split('.')
  return `${w}.${f.padEnd(2, '0')}`
}

/** Base units to "25" or "1.92": cents, without a trailing ".00". */
export function usdPlain(raw: bigint | string): string {
  return usd(raw).replace(/\.00$/, '')
}

/** Base units rounded up to the next cent, so an amount the owner must reach is never understated. */
export function ceilCents(raw: bigint): bigint {
  return ((raw + 9_999n) / 10_000n) * 10_000n
}

export function capNote(capUsdc: string): string {
  return `Up to ${usdPlain(capUsdc)} USDC per account for now.`
}

/** The operator's over-cap report; derived from the balance when an older operator does not send one. */
export function overCapOf(f: FundingView | undefined): OverCap | null {
  if (!f) return null
  if (f.overCap !== undefined) return f.overCap
  return f.active ? null : overCap(BigInt(f.usdc), BigInt(f.capUsdc))
}

/** An undeployed account holding less than the relayer deploys for: nothing starts until it reaches the minimum. */
export function belowMinimumOf(f: FundingView | undefined): { usdc: bigint; minUsdc: bigint; missingUsdc: bigint } | null {
  if (!f || f.deployed || f.deployMinUsdc === undefined) return null
  const [usdc, minUsdc] = [BigInt(f.usdc), BigInt(f.deployMinUsdc)]
  return usdc > 0n && usdc < minUsdc ? { usdc, minUsdc, missingUsdc: minUsdc - usdc } : null
}

/** Base units to the amount a person types: "1.93". */
export function usdInput(raw: bigint): string {
  return usd(raw).replace(/,/g, '')
}

/** Base units to every unit a person could type: "26.983456", "26.90". What Max fills in, so it never leaves dust. */
export function usdExactInput(raw: bigint): string {
  const f = (raw % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')
  return `${raw / 1_000_000n}.${f}`
}

/** Rewrites raw operator text: base-unit numbers become USDC, and a shortfall becomes what can be withdrawn. */
export function humanMessage(message: string, maxWithdraw?: bigint): string {
  if (/cannot free|insufficient|exceeds|not enough/i.test(message) && maxWithdraw !== undefined) {
    return `You can withdraw up to ${usd(maxWithdraw)} USDC right now.`
  }
  return message.replace(/(\d+)\s*USDC base units/g, (_, n: string) => `${usd(n)} USDC`)
}
