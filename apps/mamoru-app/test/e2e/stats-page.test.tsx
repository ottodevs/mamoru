import { describe, expect, test } from 'bun:test'
import type { StatsView } from '@mamoru/domain'
import { fixtureStats } from '../../src/web/fixtures/stats.ts'
import { StatsBody } from '../../src/web/routes/stats.tsx'
import { render } from './render.ts'

// Spec 013 amendment A1: the approved Stats page, in Ot's order, and nothing the API did not send.
describe('Stats page', () => {
  test('the approved order: deposits, earnings, charts, donuts, APR, accounts', () => {
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
  test('no stables-vs-pools split, no by-chain chart, no per-chain APR selector', () => {
    const { text } = render(<StatsBody v={fixtureStats} />)
    for (const s of ['Stable vaults', 'Liquidity pools', 'By chain', 'Chain']) expect(text).not.toContain(s)
  })
})
