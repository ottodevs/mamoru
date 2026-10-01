import type { OverCap } from './app-api.ts'

/** The over-cap report for a USDC balance, or null when the balance fits the cap. Base units. */
export function overCap(usdc: bigint, capUsdc: bigint): OverCap | null {
  if (usdc <= capUsdc) return null
  return { code: 'DEPOSIT_OVER_CAP', usdc: usdc.toString(), capUsdc: capUsdc.toString(), excessUsdc: (usdc - capUsdc).toString() }
}
