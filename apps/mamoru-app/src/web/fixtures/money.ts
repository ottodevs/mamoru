import type { BridgeStuckReason, FundingView, Hex0x, MoneyChain, MoneyInFlight } from '@mamoru/domain'
import { FIXTURE_ADDRESS } from './empty-account.ts'

// otto/mamoru#269: Brais's account around the 2.075638 USDC that crossed Base to Monad by CCTP. In all three moments the
// whole money is 13.78 USDC; the incident was Home showing 11.70 while it was on its way. Dev (?braismoney=...) and tests.
export type BraisMoment = 'before' | 'flight' | 'minted' | 'arriving'
export const BRAIS_MONAD_SAFE: Hex0x = '0xD72A7bC0aB2f18bD5CCe7d6C4a5E3F9E3c3dF108'
export const BRAIS_TOTAL = 13_780_000n
const CROSSING = 2_075_638n
const PLACED = 10_600_000n
const BASE_IDLE = BRAIS_TOTAL - PLACED // all of it before the burn

const position = {
  tokenId: '5101', pool: 'pool:USDC/USDT/100', liquidity: '1', inRange: true, amountUsdc: '5300000', amountCbbtc: '0', valueUsdc: PLACED.toString(),
  range: { lower: -10, upper: 10, tick: 3 },
  amounts: [
    { token: 'USDC', amount: '5300000', decimals: 6, valueUsdc: '5300000' },
    { token: 'USDT', amount: '5300000', decimals: 6, valueUsdc: '5300000' },
  ],
} satisfies FundingView['positions'][number]

const min = 60_000
const at = (now: number, offsetMin: number) => new Date(now + offsetMin * min).toISOString()
const idleOf = (raw: bigint) => (raw > 0n ? [{ token: 'USDC', amount: raw.toString(), decimals: 6, valueUsdc: raw.toString() }] : [])

function baseChain(now: number, idle: bigint): MoneyChain {
  return {
    chainId: 8453, safe: FIXTURE_ADDRESS, explorerUrl: `https://basescan.org/address/${FIXTURE_ADDRESS}`,
    read: { block: 36_000_000, at: at(now, 0), stale: false },
    idle: idleOf(idle), positions: [{ ...position, chainId: 8453 }], gas: { symbol: 'ETH', amount: '300000000000000' }, totalUsdc: (idle + PLACED).toString(),
  }
}

function monadChain(now: number, read: MoneyChain['read'], total: bigint): MoneyChain {
  return {
    chainId: 143, safe: BRAIS_MONAD_SAFE, explorerUrl: `https://monadscan.com/address/${BRAIS_MONAD_SAFE}`,
    read, idle: idleOf(total), positions: [], gas: { symbol: 'MON', amount: '500000000000000000' }, totalUsdc: total.toString(),
  }
}

function crossing(now: number): MoneyInFlight {
  return {
    id: 'cctp-brais-1', kind: 'cctp', from: 8453, to: 143, recipient: BRAIS_MONAD_SAFE, amountUsdc: CROSSING.toString(), stage: 'burned',
    burnTx: `0x${'b'.repeat(64)}`, burnedAt: at(now, -3), eta: { from: at(now, 3), to: at(now, 9), late: false }, feeUsdc: '0', finality: 'standard',
  }
}

/** Brais's Base funding view with the operator's money map, at one moment of the crossing. */
export function braisFunding(moment: BraisMoment, now: number = Date.now()): FundingView {
  const baseIdle = moment === 'before' ? BASE_IDLE : BASE_IDLE - CROSSING
  // 'arriving': minted on Monad, but the Monad read is from before the mint: counted once, as a transfer in flight (PR 1's rule).
  const chains = moment === 'minted'
    ? [baseChain(now, baseIdle), monadChain(now, { block: 41_802_330, at: at(now, 0), stale: false }, CROSSING)]
    : moment === 'arriving'
      ? [baseChain(now, baseIdle), monadChain(now, { block: 41_802_300, at: at(now, 0), stale: false }, 0n)]
      : [baseChain(now, baseIdle)]
  return {
    address: FIXTURE_ADDRESS, deployed: true, block: 36_000_000, eth: '0', cbbtc: '0', gasReserveWei: '300000000000000', active: true, capUsdc: '100000000', engine: { placing: false, nextReviewAt: null },
    approval: { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v6' },
    usdc: baseIdle.toString(),
    idle: idleOf(baseIdle),
    positions: [structuredClone(position)],
    money: { totalUsdc: BRAIS_TOTAL.toString(), complete: true, chains, inFlight: moment === 'flight' ? [crossing(now)] : moment === 'arriving' ? [{ ...crossing(now), stage: 'minted', mintTx: `0x${'c'.repeat(64)}`, mintedAt: at(now, -1), eta: undefined }] : [] },
  }
}

/** The same view with Monad's last read 6 minutes old and failing now: its last value stays, marked. */
export function withStaleMonad(f: FundingView, now: number = Date.now()): FundingView {
  const m = f.money!
  return { ...f, money: { ...m, chains: m.chains.map((c) => (c.chainId === 143 ? { ...c, read: { ...c.read, at: at(now, -6), stale: true } } : c)) } }
}

/** Monad never read: its money is not in the total and the map says so. */
export function withUnreadMonad(f: FundingView): FundingView {
  const m = f.money!
  const chains = [...m.chains.filter((c) => c.chainId !== 143), monadChain(0, { block: 0, at: null, stale: true }, 0n)]
  const totalUsdc = chains.reduce((a, c) => a + BigInt(c.totalUsdc), 0n) + m.inFlight.reduce((a, t) => a + BigInt(t.amountUsdc), 0n)
  return { ...f, money: { ...m, totalUsdc: totalUsdc.toString(), complete: false, chains } }
}

/** Base's position list could not be read in full (no ids to read them by): the total may be short and the map is not complete. */
export function withPartialBase(f: FundingView): FundingView {
  const m = f.money!
  return { ...f, money: { ...m, complete: false, chains: m.chains.map((c) => (c.chainId === 8453 ? { ...c, partial: true } : c)) } }
}

/** An operator from before the money map: only the Base balance. */
export function withoutMoney(f: FundingView): FundingView {
  const { money: _m, ...old } = f
  return old
}

/** A transfer that failed before anything was burned: the money never left Base, so it is in Base's total and not in flight's. */
export function withFailedTransfer(f: FundingView, now: number = Date.now()): FundingView {
  const m = f.money!
  return { ...f, money: { ...m, inFlight: [...m.inFlight, { ...crossing(now), id: 'cctp-brais-failed', stage: 'failed', eta: undefined, burnTx: undefined, burnedAt: undefined }] } }
}

/** Every position is on Monad; Base holds only idle money. */
export function withMonadOnlyPositions(now: number = Date.now()): FundingView {
  const f = braisFunding('minted', now)
  const m = f.money!
  const base = m.chains.find((c) => c.chainId === 8453)!
  const monad = m.chains.find((c) => c.chainId === 143)!
  const placed = base.positions
  base.positions = []
  base.totalUsdc = base.idle.reduce((a, t) => a + BigInt(t.valueUsdc), 0n).toString()
  monad.positions = placed.map((p) => ({ ...p, chainId: 143, pool: 'pool:WMON/USDC/3000', tokenId: '5101' }))
  monad.totalUsdc = (BigInt(monad.totalUsdc) + PLACED).toString()
  return { ...f, positions: [] }
}

/**
 * otto/mamoru#245: the crossing past its deadline, flagged stuck by the operator for `reason` (any string: an unknown code
 * reads as generic words). The money map's row and the engine's bridging progress both carry the flag and the burn.
 */
export function withStuckTransfer(reason: BridgeStuckReason | string = 'mint_budget', now: number = Date.now()): FundingView {
  const f = braisFunding('flight', now)
  const t = crossing(now)
  const stuck = { stuckAt: at(now, -2), stuckReason: reason as BridgeStuckReason }
  const burnedAt = at(now, -45)
  const eta = { from: at(now, -32), to: at(now, -26), late: true }
  return {
    ...f,
    progress: { step: 'bridging', pool: 'pool:WMON/USDC/3000', since: burnedAt, bridge: { chainId: 143, amountUsdc: CROSSING.toString(), state: 'burned', burnTx: t.burnTx, burnedAt, recipient: BRAIS_MONAD_SAFE, eta, ...stuck } },
    money: { ...f.money!, inFlight: [{ ...t, burnedAt, eta, ...stuck }] },
  }
}

/** otto/mamoru#350: the minted moment with a WMON/USDC position on Monad beside the Base one, worth `valueUsdc`. */
export function withMonadPosition(f: FundingView, valueUsdc: string): FundingView {
  const monad = f.money!.chains.find((c) => c.chainId === 143)!
  monad.positions = [{ tokenId: '9001', chainId: 143, pool: 'pool:WMON/USDC/3000', liquidity: '1', inRange: true, amountUsdc: '1000000', amountCbbtc: '0', valueUsdc, amounts: [{ token: 'WMON', amount: '1000000000000000000', decimals: 18, valueUsdc: '1000000' }, { token: 'USDC', amount: '1000000', decimals: 6, valueUsdc: '1000000' }] }]
  monad.idle = []
  // Totals follow: the chain holds only the position now, and the account total is the chains plus what is in flight.
  monad.totalUsdc = valueUsdc
  f.money!.totalUsdc = (f.money!.chains.reduce((a, c) => a + BigInt(c.totalUsdc), 0n) + f.money!.inFlight.filter((t) => t.stage !== 'failed').reduce((a, t) => a + BigInt(t.amountUsdc), 0n)).toString()
  return f
}
