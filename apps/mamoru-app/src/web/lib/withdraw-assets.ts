import type { TransferPlan, WithdrawAsset } from '@mamoru/domain'

export type WithdrawAssetOption = { asset: WithdrawAsset; available: boolean; reason?: string }

export const WITHDRAW_ASSETS: readonly WithdrawAsset[] = ['USDC', 'EURC', 'ETH', 'JPYC']

export const JPYC_NOT_ON_BASE = 'Not available on Base yet'

/** Used when GET withdraw-assets fails: USDC always, EURC and ETH optimistically, JPYC off. */
export const FALLBACK_WITHDRAW_ASSETS: WithdrawAssetOption[] = [
  { asset: 'USDC', available: true },
  { asset: 'EURC', available: true },
  { asset: 'ETH', available: true },
  { asset: 'JPYC', available: false, reason: JPYC_NOT_ON_BASE },
]

/** Keeps the picker order fixed and USDC always selectable, whatever the API returns. */
export function withdrawOptions(api: WithdrawAssetOption[] | undefined): WithdrawAssetOption[] {
  if (!api) return FALLBACK_WITHDRAW_ASSETS
  return WITHDRAW_ASSETS.map((asset) => {
    if (asset === 'USDC') return { asset, available: true }
    return api.find((o) => o.asset === asset) ?? { asset, available: false, reason: 'Not available right now' }
  })
}

// ETH to 6 decimals, the fiat stables to 2.
const FRACTION: Record<WithdrawAsset, number> = { USDC: 2, EURC: 2, JPYC: 2, ETH: 6 }

/** Base units to a display amount with the asset's precision. Truncates, never rounds up. */
export function formatReceive(raw: string, decimals: number, asset: WithdrawAsset): string {
  if (!/^\d+$/.test(raw)) throw new Error(`not an integer amount: ${raw}`)
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const fraction = padded.slice(padded.length - decimals).slice(0, FRACTION[asset]).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/** "You receive ≈ 18.4 EURC (at least 18.3)". */
export function receiveLine(r: NonNullable<TransferPlan['receive']>): string {
  return `You receive ≈ ${formatReceive(r.quoted, r.decimals, r.asset)} ${r.asset} (at least ${formatReceive(r.minimum, r.decimals, r.asset)})`
}
