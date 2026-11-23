import { describe, expect, test } from 'bun:test'
import type { StatsView } from '@mamoru/domain'
import { fixtureStats } from '../../src/web/fixtures/stats.ts'
import { resolveSplit, StatsBody } from '../../src/web/routes/stats.tsx'
import { render } from './render.ts'

// Spec 013 amendment A1: the approved Stats page, in Ot's order, and nothing the API did not send.
describe('Stats page', () => {
  test('the approved order: deposits and the split bar, earnings, charts, APR, accounts', () => {
    const { text } = render(<StatsBody v={fixtureStats} />)
    const at = (s: string) => text.indexOf(s)
    for (const s of ['Total deposits $4,363', 'Money working 66%', 'Earned in the last 24h $0.98', 'Total earned $3.20', '7-day APR 27.6%', 'Earned per day', 'By asset', 'APR over time', 'Total accounts 57', 'Average account $291', 'Largest account $1,728']) expect(at(s)).toBeGreaterThan(-1)
    expect(at('7-day APR')).toBeLessThan(at('Earned per day'))
    expect(at('By asset')).toBeLessThan(at('APR over time'))
    expect(at('APR over time')).toBeLessThan(at('Total accounts'))
  })
  test('a figure or block the API left out is not drawn, never as 0 or "not counted"', () => {
    const v: StatsView = { dataAsOf: fixtureStats.dataAsOf, snapshots: { totalDeposits: fixtureStats.snapshots.totalDeposits }, distributions: {}, series: {} }
    const { text } = render(<StatsBody v={v} />)
    expect(text).toContain('Total deposits $4,363')
    for (const s of ['Money working', 'Earned in the last 24h', 'Total earned', 'By asset', 'APR over time', 'Total accounts', 'not counted', '$0.00']) expect(text).not.toContain(s)
  })
  test('the hero bar shows the split by asset by default, with a By chain option; no donuts, no stables-vs-pools', () => {
    const { text, html } = render(<StatsBody v={fixtureStats} />)
    expect(text).toContain('By asset')
    expect(text).toContain('By chain')
    for (const s of ['USDC $3,453', 'WETH $740']) expect(text).toContain(s)
    expect(text).not.toContain('Base $3,973')
    expect(text.indexOf('By asset')).toBeLessThan(text.indexOf('Earned in the last 24h'))
    for (const s of ['Stable vaults', 'Liquidity pools', 'in stablecoins']) expect(text).not.toContain(s)
    expect(html).not.toContain('cx-donut')
  })
  test('only the by-chain split sent: the bar shows it, no selector', () => {
    const v: StatsView = { ...fixtureStats, distributions: { byChain: fixtureStats.distributions.byChain } }
    const { text } = render(<StatsBody v={v} />)
    expect(text).toContain('Base $3,973')
    expect(text).not.toContain('By asset')
  })
  test('a refresh that withholds the split on screen falls back to the other one, the bar stays', () => {
    const { byToken, byChain } = fixtureStats.distributions
    expect(resolveSplit('asset', byToken, byChain)).toBe('asset')
    expect(resolveSplit('asset', undefined, byChain)).toBe('chain')
    expect(resolveSplit('chain', byToken, byChain)).toBe('chain')
    expect(resolveSplit('chain', byToken, [])).toBe('asset')
  })
})
