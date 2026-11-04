import type { FundingView, Hex0x, MoneyChain } from '@mamoru/domain'

// otto/mamoru#265: Brais's account on 1 Nov at 11:43 UTC, after the move to v6 (1-projects/mamoru/operations/
// brais-v6-beta-2026-11-01.md, section c): Base keeps USDC/USDT and two WETH/USDC positions, Monad holds 2.075638 USDC
// that the Monad engine could not place (EHG_SIM_UNAVAILABLE). Real Safes, positions and amounts; the funding view's
// shape is the operator's (money map, #269). Dev (?braismoney=after) and tests.

export const BRAIS_BASE_SAFE: Hex0x = '0x99aC3d214D4CE2E761F3108ee592D2A17Ec3c01C'
export const BRAIS_MONAD_SAFE_REAL: Hex0x = '0xD72A7cB9773Dc58a9B944f9737996F45dBD1F108'

const min = 60_000
const at = (now: number, offsetMin: number) => new Date(now + offsetMin * min).toISOString()

/** `why`: the Monad engine's reason for the idle USDC (the operator sends it with Base's today; Monad's is the shape it would take). */
export function braisAfterMove(now: number = Date.now(), why: { code: string; since?: string } | null = { code: 'EHG_SIM_UNAVAILABLE', since: at(now, -3) }): FundingView {
  const stable = {
    tokenId: '6357817', chainId: 8453, pool: 'pool:USDC/USDT/100', liquidity: '1', inRange: true, amountUsdc: '6782995', amountCbbtc: '0', valueUsdc: '6936327',
    range: { lower: 11, upper: 52, tick: 11 },
    amounts: [
      { token: 'USDC', amount: '6782995', decimals: 6, valueUsdc: '6782995' },
      { token: 'USDT', amount: '153332', decimals: 6, valueUsdc: '153332' },
    ],
  } satisfies MoneyChain['positions'][number]
  const wethOld = {
    tokenId: '6296546', chainId: 8453, pool: 'pool:WETH/USDC/3000', liquidity: '1', inRange: true, amountUsdc: '225825', amountCbbtc: '0', valueUsdc: '1329270',
    range: { lower: -199380, upper: -197400, tick: -199053 },
    amounts: [
      { token: 'WETH', amount: '486482000000000', decimals: 18, valueUsdc: '1103445' },
      { token: 'USDC', amount: '225825', decimals: 6, valueUsdc: '225825' },
    ],
  } satisfies MoneyChain['positions'][number]
  const wethNew = {
    tokenId: '6436365', chainId: 8453, pool: 'pool:WETH/USDC/3000', liquidity: '1', inRange: true, amountUsdc: '1715173', amountCbbtc: '0', valueUsdc: '3439440',
    range: { lower: -200040, upper: -198060, tick: -199053 },
    amounts: [
      { token: 'WETH', amount: '760214000000000', decimals: 18, valueUsdc: '1724267' },
      { token: 'USDC', amount: '1715173', decimals: 6, valueUsdc: '1715173' },
    ],
  } satisfies MoneyChain['positions'][number]
  const baseIdle = 5_371n
  const monadIdle = 2_075_638n
  const base: MoneyChain = {
    chainId: 8453, safe: BRAIS_BASE_SAFE, explorerUrl: `https://basescan.org/address/${BRAIS_BASE_SAFE}`,
    read: { block: 53_370_900, at: at(now, 0), stale: false },
    idle: [{ token: 'USDC', amount: baseIdle.toString(), decimals: 6, valueUsdc: baseIdle.toString() }],
    positions: [stable, wethOld, wethNew],
    gas: { symbol: 'ETH', amount: '398000000000000', reserveTarget: '412000000000000' },
    totalUsdc: (baseIdle + 6_936_327n + 1_329_270n + 3_439_440n).toString(),
  }
  const monad: MoneyChain = {
    chainId: 143, safe: BRAIS_MONAD_SAFE_REAL, explorerUrl: `https://monadscan.com/address/${BRAIS_MONAD_SAFE_REAL}`,
    read: { block: 41_806_100, at: at(now, 0), stale: false },
    idle: [{ token: 'USDC', amount: monadIdle.toString(), decimals: 6, valueUsdc: monadIdle.toString(), ...(why ? { why } : {}) }],
    positions: [],
    gas: { symbol: 'MON', amount: '3040400000000000000', reserveTarget: '4040000000000000000' },
    totalUsdc: monadIdle.toString(),
  }
  const total = BigInt(base.totalUsdc) + BigInt(monad.totalUsdc)
  const { chainId: _a, ...s } = stable
  const { chainId: _b, ...wo } = wethOld
  const { chainId: _c, ...wn } = wethNew
  return {
    address: BRAIS_BASE_SAFE, deployed: true, block: 53_370_900, eth: '398000000000000', cbbtc: '0', gasReserveWei: '412000000000000', active: true, capUsdc: '100000000',
    engine: { placing: false, nextReviewAt: at(now, 4), reviewedAt: at(now, -1) },
    approval: { validUntil: 2_000_000_000, renewDue: false, expired: false, policyId: 'conservador-live-v6' },
    remote: { chainId: 143, address: BRAIS_MONAD_SAFE_REAL, ready: true, spec: { chainId: 143, policyId: 'live-wmon-usdc-monad-v6', sessionKey: '0x0000000000000000000000000000000000000143', validAfter: 0, validUntil: 2_000_000_000, capUsdc: '100000000' } },
    usdc: baseIdle.toString(),
    idle: [{ token: 'USDC', amount: baseIdle.toString(), decimals: 6, valueUsdc: baseIdle.toString() }],
    positions: [s, wo, wn],
    money: { totalUsdc: total.toString(), complete: true, chains: [base, monad], inFlight: [] },
  }
}
