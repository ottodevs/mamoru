import registry from '@mamoru/registry/base.json'

type RegistryToken = { name: string; kind: string; decimals?: number }

// Decimals come from the registry (dashboard.md §2 rule 11). ETH is native, 18.
const DECIMALS: ReadonlyMap<string, number> = new Map([
  ...(registry.entries as RegistryToken[])
    .filter((e) => e.kind === 'token' && typeof e.decimals === 'number')
    .map((e) => [e.name, e.decimals as number] as const),
  ['ETH', 18],
])

export function decimalsOf(unit: string | undefined): number | undefined {
  return unit === undefined ? undefined : DECIMALS.get(unit)
}

const MAX_FRACTION_DIGITS: Readonly<Record<string, number>> = { USDC: 2, cbBTC: 8, WETH: 6, ETH: 6 }

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Formats an integer string in token base units. Truncates, never rounds up. */
export function formatUnits(raw: string, unit: string | undefined): string {
  if (!/^-?\d+$/.test(raw)) throw new Error(`not an integer amount: ${raw}`)
  const decimals = decimalsOf(unit)
  const negative = raw.startsWith('-')
  const digits = negative ? raw.slice(1) : raw
  if (decimals === undefined) return `${negative ? '-' : ''}${groupThousands(digits.replace(/^0+(?=\d)/, ''))}`
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals).replace(/^0+(?=\d)/, '')
  const maxFraction = MAX_FRACTION_DIGITS[unit ?? ''] ?? decimals
  const fraction = padded.slice(padded.length - decimals).slice(0, maxFraction).replace(/0+$/, '')
  const sign = negative && (whole !== '0' || fraction !== '') ? '-' : ''
  return `${sign}${groupThousands(whole)}${fraction ? `.${fraction}` : ''}`
}

export function formatAmount(raw: string, unit: string | undefined): string {
  const n = formatUnits(raw, unit)
  return unit ? `${n} ${unit}` : n
}

/** Basis points (policy preference) to a percentage. */
export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`
}

/** Decimal fraction string, e.g. "0.83", to a percentage. */
export function formatFraction(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`not a fraction: ${value}`)
  return `${(n * 100).toFixed(1).replace(/\.0$/, '')}%`
}

export function formatInteger(n: number): string {
  return groupThousands(String(Math.trunc(n)))
}

export function shortHex(hex: string): string {
  return hex.length <= 12 ? hex : `${hex.slice(0, 6)}…${hex.slice(-4)}`
}
