import type { BridgeProgress, FundingView } from '@mamoru/domain'
import { usd } from './money.ts'
import registry from '@mamoru/registry/base.json'
import monad from '@mamoru/registry/monad.json'

type Position = FundingView['positions'][number]
type Progress = NonNullable<FundingView['progress']>
type Entry = { name: string; kind: string; address: string; decimals?: number; token0?: string; token1?: string }

const ENTRIES = registry.entries as Entry[]
// otto/mamoru#67: pools of every chain a sleeve runs on, Base first. Pool names and addresses do not repeat across
// the two pinned registries, so a lookup by either finds the one pool it names.
const POOLS = [...ENTRIES, ...(monad.entries as Entry[])].filter((e) => e.kind === 'pool')
const DEFAULT_PAIR: [string, string] = ['USDC', 'cbBTC']

function poolEntry(pool: string | undefined): Entry | undefined {
  if (!pool) return undefined
  const p = pool.toLowerCase()
  return POOLS.find((e) => e.name.toLowerCase() === p || e.address.toLowerCase() === p)
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

/** The pool's registry name ("pool:USDC/USDT/100") whether the view carries the name or the address; null when unknown. */
export function poolName(pool: string | undefined): string | null {
  return poolEntry(pool)?.name ?? (pool && /^pool:/.test(pool) ? pool : null)
}

/** otto/mamoru#210: a vault's contract address for the explorer, by its registry name; null when unknown. */
export function vaultAddress(vault: string): string | null {
  return ENTRIES.find((e) => e.kind === 'vault' && e.name === vault)?.address ?? null
}

/** The pool's contract address for the explorer of its chain, whether the view carries the name or the address. */
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
  for (const p of f.positions) for (const t of p.vault ? ['USDC'] : poolTokens(p.pool, p.amounts)) set.add(t)
  return [...set]
}

/** otto/mamoru#215: the chain a bridge goes to, by name. */
export function chainLabel(chainId: number): string {
  return chainId === 143 ? 'Monad' : chainId === 8453 ? 'Base' : `chain ${chainId}`
}

/** otto/mamoru#215: savings moving to the account's sleeve on another chain, and how far they got. */
export function bridgeLine(b: BridgeProgress): string {
  const what = `${usd(b.amountUsdc)} USDC to ${chainLabel(b.chainId)}`
  if (b.state === 'minted') return `Moved ${what}`
  if (b.state === 'failed') return `Did not move ${what}`
  return b.state === 'burned' ? `Moving ${what} (arrives in about 20 minutes)` : `Moving ${what}`
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
    case 'bridging':
      // otto/mamoru#215: savings on their way to the account's sleeve on another chain.
      return p.bridge ? bridgeLine(p.bridge) : 'Moving USDC to Monad'
  }
}
