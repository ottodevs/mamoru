import type { FundingView } from '@mamoru/domain'
import registry from '@mamoru/registry/base.json'

type Position = FundingView['positions'][number]
type Progress = NonNullable<FundingView['progress']>
type Entry = { name: string; kind: string; address: string; decimals?: number; token0?: string; token1?: string }

const ENTRIES = registry.entries as Entry[]
const DEFAULT_PAIR: [string, string] = ['USDC', 'cbBTC']

function poolEntry(pool: string | undefined): Entry | undefined {
  if (!pool) return undefined
  const p = pool.toLowerCase()
  return ENTRIES.find((e) => e.kind === 'pool' && (e.name.toLowerCase() === p || e.address.toLowerCase() === p))
}

/** The two tokens of a pool, from its registry name or address, else from the position amounts. */
export function poolTokens(pool: string | undefined, amounts?: Position['amounts']): [string, string] {
  const e = poolEntry(pool)
  if (e?.token0 && e.token1) return [e.token0, e.token1]
  const m = pool ? /^pool:([^/]+)\/([^/]+)\//.exec(pool) : null
  if (m) return [m[1]!, m[2]!]
  if (amounts && amounts.length >= 2) return [amounts[0]!.token, amounts[1]!.token]
  return DEFAULT_PAIR
}

/** "USDC / USDT": the pool pair, USDC first. */
export function pairLabel(pool: string | undefined, amounts?: Position['amounts']): string {
  const [a, b] = poolTokens(pool, amounts)
  return b === 'USDC' ? `USDC / ${a}` : `${a} / ${b}`
}

/** The pool's contract address for Basescan, whether the view carries the name or the address. */
export function poolAddress(pool: string): string | null {
  return poolEntry(pool)?.address ?? (/^0x[0-9a-fA-F]{40}$/.test(pool) ? pool : null)
}

/** Both sides of a position, in pool order; old views without `amounts` fall back to USDC + cbBTC. */
export function positionAmounts(p: Position): { token: string; amount: string; decimals: number }[] {
  if (p.amounts?.length) return p.amounts
  const [t0, t1] = poolTokens(p.pool)
  const of = (t: string) => (t === 'USDC' ? p.amountUsdc : t === 'cbBTC' ? p.amountCbbtc : '0')
  const dec = (t: string) => ENTRIES.find((e) => e.name === t)?.decimals ?? 18
  return [t0, t1].map((t) => ({ token: t, amount: of(t), decimals: dec(t) }))
}

/** Every token the positions hold, USDC first. */
export function positionTokens(f: FundingView): string[] {
  const set = new Set<string>(['USDC'])
  for (const p of f.positions) for (const t of poolTokens(p.pool, p.amounts)) set.add(t)
  return [...set]
}

/** The subtle one-line state under Working capital while the engine or an owner tx is in flight. */
export function progressLine(p: Progress | null | undefined): string | null {
  if (!p) return null
  const [a, b] = poolTokens(p.pool)
  const other = a === 'USDC' ? b : a
  switch (p.step) {
    case 'deploying':
    case 'activating':
      return 'Deploying your account'
    case 'swapping':
      return p.pool ? `Swapping USDC to ${other}` : 'Swapping'
    case 'opening':
      return p.pool ? `Opening ${pairLabel(p.pool).replace(/ /g, '')} position` : 'Opening a position'
    case 'rebalancing':
      return 'Rebalancing'
    case 'reranging':
      return 'Adjusting range'
    case 'closing':
      return 'Closing positions'
    case 'withdrawing':
      return 'Sending your withdrawal'
  }
}
