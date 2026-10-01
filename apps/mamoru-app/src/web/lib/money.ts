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
  maxWithdraw: bigint // total less a 1% margin, rounded down to cents
}

export function split(f: FundingView, price: bigint | null): Split {
  const workingUsdc = f.positions.reduce((a, p) => a + BigInt(p.amountUsdc), 0n)
  const workingCbbtc = f.positions.reduce((a, p) => a + BigInt(p.amountCbbtc), 0n)
  const idleUsdc = BigInt(f.usdc)
  const idleCbbtc = BigInt(f.cbbtc)
  // valueUsdc covers every pool (USDT, WETH too); older views fall back to the USDC + cbBTC legs.
  const working = f.positions.reduce((a, p) => a + (p.valueUsdc !== undefined ? BigInt(p.valueUsdc) : BigInt(p.amountUsdc) + cbbtcToUsdc(BigInt(p.amountCbbtc), price)), 0n)
  const idle = idleUsdc + cbbtcToUsdc(idleCbbtc, price)
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
    maxWithdraw: (margin / 10_000n) * 10_000n,
  }
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

/** Base units to the amount a person types: "1.93". */
export function usdInput(raw: bigint): string {
  return usd(raw).replace(/,/g, '')
}

/** Rewrites raw operator text: base-unit numbers become USDC, and a shortfall becomes what can be withdrawn. */
export function humanMessage(message: string, maxWithdraw?: bigint): string {
  if (/cannot free|insufficient|exceeds|not enough/i.test(message) && maxWithdraw !== undefined) {
    return `You can withdraw up to ${usd(maxWithdraw)} USDC right now.`
  }
  return message.replace(/(\d+)\s*USDC base units/g, (_, n: string) => `${usd(n)} USDC`)
}
