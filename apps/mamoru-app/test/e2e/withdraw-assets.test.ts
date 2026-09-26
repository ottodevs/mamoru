import { describe, expect, test } from 'bun:test'
import { fixtureClient, fixtureReceive } from '../../src/web/fixtures/client.ts'
import { FALLBACK_WITHDRAW_ASSETS, JPYT_CAPTION, assetLabel, formatReceive, receiveLine, withdrawOptions } from '../../src/web/lib/withdraw-assets.ts'

describe('withdraw assets', () => {
  test('fallback: all on; the JPYC slot is JPY paid in JPYT with its caption', () => {
    expect(withdrawOptions(undefined)).toEqual(FALLBACK_WITHDRAW_ASSETS)
    expect(FALLBACK_WITHDRAW_ASSETS.find((o) => o.asset === 'JPYC')).toEqual({ asset: 'JPYC', available: true, reason: 'Dephaser JPYT, backed by USDC. Not a regulated issuer.' })
    expect(JPYT_CAPTION).toBe('Dephaser JPYT, backed by USDC. Not a regulated issuer.')
    expect(assetLabel('JPYC')).toBe('JPY')
    expect(assetLabel('EURC')).toBe('EURC')
  })
  test('API list keeps the fixed order, USDC always on, missing assets off', () => {
    const opts = withdrawOptions([{ asset: 'ETH', available: true }, { asset: 'USDC', available: false }])
    expect(opts.map((o) => o.asset)).toEqual(['USDC', 'EURC', 'ETH', 'JPYC'])
    expect(opts.map((o) => o.available)).toEqual([true, false, true, false])
  })
  test('precision: ETH 6 decimals, EURC 2, JPY whole, truncated', () => {
    expect(formatReceive('3846153846153846', 18, 'ETH')).toBe('0.003846')
    expect(formatReceive('9219999', 6, 'EURC')).toBe('9.21')
    expect(formatReceive('1616123456', 6, 'JPYC')).toBe('1,616')
  })
  test('receive line and fixture plan', async () => {
    expect(receiveLine(fixtureReceive('EURC', 10_000_000n))).toBe('You receive ≈ 9.21 EURC (at least 9.16)')
    expect(receiveLine(fixtureReceive('JPYC', 10_000_000n))).toBe('You receive ≈ 1,616 JPY (at least 1,607)')
    const plan = await fixtureClient.transferPrepare('k', { to: `0x${'1'.repeat(40)}`, amountUsdc: '10000000', asset: 'ETH' })
    expect(plan.receive?.asset).toBe('ETH')
    expect(plan.receive?.route).toContain('WETH')
    const plain = await fixtureClient.transferPrepare('k', { to: `0x${'1'.repeat(40)}`, amountUsdc: '10000000' })
    expect(plain.receive).toBeUndefined()
    expect((await fixtureClient.withdrawAssets('k')).assets).toHaveLength(4)
  })
})
