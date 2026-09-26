import { describe, expect, test } from 'bun:test'
import type { FundingView } from '@mamoru/domain'
import { fixtureFunding } from '../../src/web/fixtures/client.ts'
import { split } from '../../src/web/lib/money.ts'
import { pairLabel, poolAddress, positionAmounts, positionTokens, progressLine } from '../../src/web/lib/positions.ts'
import { Working } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

const multi: FundingView = {
  ...fixtureFunding,
  usdc: '0',
  cbbtc: '0',
  active: true,
  positions: [
    { tokenId: '1', pool: 'pool:USDC/USDT/100', liquidity: '1', inRange: true, amountUsdc: '2000000', amountCbbtc: '0', amounts: [{ token: 'USDC', amount: '2000000', decimals: 6 }, { token: 'USDT', amount: '1000000', decimals: 6 }], valueUsdc: '3000000' },
    { tokenId: '2', pool: 'pool:WETH/USDC/500', liquidity: '1', inRange: false, amountUsdc: '1000000', amountCbbtc: '0', amounts: [{ token: 'WETH', amount: '250000000000000', decimals: 18 }, { token: 'USDC', amount: '1000000', decimals: 6 }], valueUsdc: '2000000' },
  ],
  progress: { step: 'swapping', pool: 'pool:USDC/cbBTC/500', since: '2026-09-26T22:00:00.000Z' },
}

describe('positions of every pool', () => {
  test('pair labels by pool pair, USDC first', () => {
    expect(pairLabel('pool:USDC/USDT/100')).toBe('USDC / USDT')
    expect(pairLabel('pool:WETH/USDC/500')).toBe('USDC / WETH')
    expect(pairLabel('0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef')).toBe('USDC / cbBTC')
    expect(poolAddress('pool:USDC/USDT/100')).toBe('0xD56da2B74bA826f19015E6B7Dd9Dae1903E85DA1')
  })
  test('old views fall back to the USDC and cbBTC legs', () => {
    const p = { tokenId: '1', pool: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', liquidity: '1', inRange: true, amountUsdc: '5', amountCbbtc: '7' }
    expect(positionAmounts(p).map((l) => `${l.token}:${l.amount}`)).toEqual(['USDC:5', 'cbBTC:7'])
  })
  test('working capital sums valueUsdc across pools', () => {
    expect(split(multi, null).working).toBe(5_000_000n)
    expect(positionTokens(multi)).toEqual(['USDC', 'USDT', 'WETH'])
  })
  test('progress lines', () => {
    expect(progressLine(null)).toBeNull()
    expect(progressLine({ step: 'deploying', since: '' })).toBe('Deploying your account')
    expect(progressLine({ step: 'swapping', pool: 'pool:USDC/cbBTC/500', since: '' })).toBe('Swapping USDC to cbBTC')
    expect(progressLine({ step: 'opening', pool: 'pool:USDC/cbBTC/500', since: '' })).toBe('Opening USDC/cbBTC position')
    expect(progressLine({ step: 'reranging', since: '' })).toBe('Adjusting range')
    expect(progressLine({ step: 'withdrawing', since: '' })).toBe('Sending your withdrawal')
  })
  test('Working renders the progress line and both legs of each pool', () => {
    const { text } = render(<Working f={multi} s={split(multi, null)} onStop={null} />)
    expect(text).toContain('Swapping USDC to cbBTC')
    expect(text).toContain('USDC / USDT')
    expect(text).toContain('USDC / WETH')
    expect(text).toContain('2.00 USDC + 1.00 USDT')
    expect(text).toContain('0.00025 WETH + 1.00 USDC')
    expect(text).toContain('$3.00')
    expect(render(<Working f={{ ...multi, progress: null }} s={split(multi, null)} onStop={null} />).text).not.toContain('Swapping')
  })
})
