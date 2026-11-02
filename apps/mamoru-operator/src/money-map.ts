import type { FundingView, MoneyChain, MoneyInFlight, MoneyMap, MoneyWhy } from '@mamoru/domain'
import { chainOf, type Address } from '@mamoru/domain'
import type { Registry } from '@mamoru/registry'
import { idleTokens, MAX_INVENTORY, positionUsdc, positionView, POSITION_DUST_USDC, type PoolPosition, type SafeRead } from './chain.ts'

// otto/mamoru#269: the money map of an account. Pure assembly: the operator reads the chains and the bridge journal,
// this file turns them into one MoneyMap whose total is, by construction, the sum of its chains and its in-flight rows.

/** Standard finality (CCTP V2, minFinalityThreshold 2000) from Base: the mint is possible between these, from the burn. */
export const ETA_FROM_MS = 13 * 60_000
export const ETA_TO_MS = 19 * 60_000

/** The window a burn of `burnedAt` is expected to arrive in; `late` once `nowMs` is past its end. */
export function etaOf(burnedAt: string, nowMs: number): { from: string; to: string; late: boolean } {
  const t = Date.parse(burnedAt)
  return { from: new Date(t + ETA_FROM_MS).toISOString(), to: new Date(t + ETA_TO_MS).toISOString(), late: nowMs > t + ETA_TO_MS }
}

/** The positions of a Safe that count toward its value: all of them above dust (a chain without an admitted list, as Monad). */
export function heldAboveDust(r: SafeRead, registry: Registry): PoolPosition[] {
  return r.positions.filter((p) => positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, registry) >= POSITION_DUST_USDC)
}

/**
 * The read saw only the first MAX_INVENTORY of the position NFTs the Safe holds and was not given ids to read by: positions
 * may be missing. Display only (the map is not `complete`); the cap behaves as it did before the map existed. A Monad leg
 * is always read by ids, so it is never truncated.
 */
export function truncated(r: Pick<SafeRead, 'positionCount' | 'byId'>): boolean {
  return (r.positionCount ?? 0) > MAX_INVENTORY && !r.byId
}

/**
 * One chain of the map from a read of its Safe: idle tokens and the held positions, valued at the pool price the chain
 * shows (slot0), ETH/MON apart. `held`: the positions that count (Base: the ones Mamoru admitted).
 */
export function chainLegOf(o: {
  chainId: number
  safe: Address
  registry: Registry
  r: SafeRead
  held: readonly PoolPosition[]
  /** Rows that are not Uniswap positions (USDC supplied to a vault), already in funding's position shape. */
  extraPositions?: FundingView['positions']
  /** When the read was taken (ISO), and whether it is the last good one instead of a live read. */
  at: string
  stale: boolean
  gasSymbol: 'ETH' | 'MON'
  reserveTarget?: string
  /** The engine's last reason for leaving USDC idle on this chain. */
  why?: MoneyWhy
}): MoneyChain {
  const idle = idleTokens(o.r, o.registry).map((t) => (t.token === 'USDC' && o.why ? { ...t, why: o.why } : t))
  const positions = [...o.held.map((p) => positionView(p, o.r, o.registry)), ...(o.extraPositions ?? [])].map((p) => ({ ...p, chainId: o.chainId }))
  const total = idle.reduce((s, t) => s + BigInt(t.valueUsdc), 0n) + positions.reduce((s, p) => s + BigInt(p.valueUsdc ?? '0'), 0n)
  return {
    chainId: o.chainId,
    safe: o.safe,
    explorerUrl: explorerOf(o.chainId, o.safe),
    read: { block: Number(o.r.block), at: o.at, stale: o.stale },
    idle,
    positions,
    gas: { symbol: o.gasSymbol, amount: o.r.eth.toString(), ...(o.reserveTarget !== undefined ? { reserveTarget: o.reserveTarget } : {}) },
    ...(truncated(o.r) ? { partial: true } : {}),
    totalUsdc: total.toString(),
  }
}

/**
 * A chain that cannot be read now: the last good total (`known`), flagged stale with the time it was read, or, when it
 * was never read, nothing known (`at: null`, 0, and the map is incomplete). Never dropped from the map.
 */
export function unreadLeg(o: { chainId: number; safe: Address; gasSymbol: 'ETH' | 'MON'; known: { totalUsdc: bigint; block: number; at: string } | null; last?: MoneyChain | null }): MoneyChain {
  if (o.last && o.known) return { ...o.last, read: { block: o.known.block, at: o.known.at, stale: true }, totalUsdc: o.known.totalUsdc.toString() }
  return {
    chainId: o.chainId,
    safe: o.safe,
    explorerUrl: explorerOf(o.chainId, o.safe),
    read: { block: o.known?.block ?? 0, at: o.known?.at ?? null, stale: true },
    idle: [],
    positions: [],
    gas: { symbol: o.gasSymbol, amount: '0' },
    totalUsdc: (o.known?.totalUsdc ?? 0n).toString(),
  }
}

export function explorerOf(chainId: number, safe: string): string {
  return `https://${chainOf(chainId).explorerHost}/address/${safe}`
}

/** The map: total = Σ chains + Σ in flight, always; complete unless a chain was never read. */
export function buildMoneyMap(chains: readonly MoneyChain[], inFlight: readonly MoneyInFlight[]): MoneyMap {
  const total = chains.reduce((s, c) => s + BigInt(c.totalUsdc), 0n) + inFlight.reduce((s, f) => s + BigInt(f.amountUsdc), 0n)
  return { totalUsdc: total.toString(), complete: chains.every((c) => c.read.at !== null && !c.partial) && inFlight.every((f) => !f.unsure), chains: [...chains], inFlight: [...inFlight] }
}

/** The value of a chain's leg as one number, for the journal's last good value. */
export function legTotal(c: Pick<MoneyChain, 'totalUsdc'>): bigint {
  return BigInt(c.totalUsdc)
}
