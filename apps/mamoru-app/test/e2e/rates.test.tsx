import { describe, expect, test } from 'bun:test'
import type { ApyView, FundingView } from '@mamoru/domain'
import { fixtureFunding } from '../../src/web/fixtures/client.ts'
import { split } from '../../src/web/lib/money.ts'
import { bucketOf, currentRate, idleReason, monthlyRate, positionRates, sourceName, valueOf } from '../../src/web/lib/rates.ts'
import { agoText, Balance, Idle, Indicators, Working } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

// otto/mamoru#193: the dashboard's rates and the idle/working split.

const apy: ApyView = {
  pool: 'conservador-live-v2',
  currentPct: 6.4,
  currentWindow: '24h',
  currentSource: 'Plan pools, fee APR · GeckoTerminal/DefiLlama',
  monthlyPct: 5.9,
  monthlySource: 'Plan pools, 30-day mean · DefiLlama',
  byPool: [
    { pool: 'pool:USDC/USDT/100', weight: 5000, currentPct: 3.0, monthlyPct: 4.5 },
    { pool: 'pool:USDC/cbBTC/500', weight: 4000, currentPct: 7.3, monthlyPct: 18.9 },
    { pool: 'pool:WETH/USDC/3000', weight: 1000, currentPct: 20, monthlyPct: 55.1 },
  ],
  asOf: '2026-10-22T00:00:00.000Z',
}

const pos = (tokenId: string, pool: string, valueUsdc: string, inRange = true): FundingView['positions'][number] => ({ tokenId, pool, liquidity: '1', inRange, amountUsdc: '0', amountCbbtc: '0', valueUsdc })

// The mockup's account: 50.12 Stable, 39.80 Balanced, 9.97 Growth paused, 0.11 USDC idle.
const placed: FundingView = {
  ...fixtureFunding,
  active: true,
  usdc: '110000',
  idle: [{ token: 'USDC', amount: '110000', decimals: 6, valueUsdc: '110000' }],
  engine: { placing: false, nextReviewAt: null },
  positions: [pos('1', 'pool:USDC/USDT/100', '50120000'), pos('2', 'pool:USDC/cbBTC/500', '39800000'), pos('3', 'pool:WETH/USDC/3000', '9970000', false)],
}

describe('rates per position', () => {
  test('bucket, share and the pool rates; a paused position earns 0% today', () => {
    const rows = positionRates(placed, apy)
    expect(rows.map((r) => r.bucket)).toEqual(['Stable', 'Balanced', 'Growth'])
    expect(rows.map((r) => Math.round(r.sharePct!))).toEqual([50, 40, 10])
    expect(rows.map((r) => r.currentPct)).toEqual([3.0, 7.3, 0])
    expect(rows.map((r) => r.monthlyPct)).toEqual([4.5, 18.9, 55.1])
  })
  test('a pool given by address resolves to its plan pool and bucket', () => {
    expect(bucketOf('0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef')).toBe('Balanced')
    const rows = positionRates({ ...placed, positions: [pos('1', '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef', '1000000')] }, apy)
    expect(rows[0]!.currentPct).toBe(7.3)
  })
  test('a pool with no rate source is null (n/a), not a guess', () => {
    const rows = positionRates({ ...placed, positions: [pos('1', 'pool:WETH/USDC/500', '1000000')] }, apy)
    expect(rows[0]!.currentPct).toBeNull()
    expect(rows[0]!.monthlyPct).toBeNull()
  })
})

// otto/mamoru#198: the current rate is the whole balance's last 24 h: paused positions and idle money at 0%.
describe('current rate', () => {
  test('over the whole balance: paused and idle count at 0%', () => {
    const r = currentRate(positionRates(placed, apy), apy, split(placed, null))
    // (50.12 * 3.0 + 39.80 * 7.3) / (50.12 + 39.80 + 9.97 + 0.11) = 4.41
    expect(r.pct).toBeCloseTo(4.41, 2)
    expect(r.gap).toBeNull()
    expect([r.covered, r.of]).toEqual([2, 2])
  })
  test('10 USDC earning 3% beside 90 paused is 0.3% for the account, never 3%', () => {
    const big = { ...placed, positions: [pos('1', 'pool:USDC/USDT/100', '10000000'), pos('2', 'pool:WETH/USDC/3000', '90000000', false)] }
    expect(currentRate(positionRates(big, apy), apy).pct).toBe(0.3)
  })
  test('idle money counts at 0% too', () => {
    const idle = { ...placed, positions: [pos('1', 'pool:USDC/USDT/100', '10000000')], usdc: '90000000', idle: [{ token: 'USDC', amount: '90000000', decimals: 6, valueUsdc: '90000000' }] }
    expect(currentRate(positionRates(idle, apy), apy, split(idle, null)).pct).toBe(0.3)
  })
  test('everything paused earns 0%, said as a figure', () => {
    const paused = { ...placed, positions: [pos('1', 'pool:USDC/USDT/100', '1000000', false)] }
    expect(currentRate(positionRates(paused, apy), apy)).toMatchObject({ pct: 0, gap: null })
  })
  test('n/a with a reason: loading, nothing placed, no data', () => {
    expect(currentRate([], undefined).gap).toBe('loading')
    expect(currentRate([], apy).gap).toBe('no-positions')
    const noData = { ...apy, byPool: [] }
    expect(currentRate(positionRates(placed, noData), noData)).toMatchObject({ pct: null, gap: 'no-data' })
  })
  test('a position earning at an unknown rate makes the account rate n/a, never dropped from the base', () => {
    const mixed = { ...placed, positions: [pos('1', 'pool:USDC/USDT/100', '10000000'), pos('2', 'pool:WETH/USDC/500', '90000000')] }
    expect(currentRate(positionRates(mixed, apy), apy)).toMatchObject({ pct: null, gap: 'no-data', covered: 1, of: 2 })
  })
  test('a cbBTC position with no price is not weighted on a guess', () => {
    const old = { ...placed, positions: [{ tokenId: '1', pool: 'pool:USDC/cbBTC/500', liquidity: '1', inRange: true, amountUsdc: '1000000', amountCbbtc: '1000' }] }
    expect(currentRate(positionRates(old, apy, null), apy)).toMatchObject({ pct: null, gap: 'no-value' })
    expect(currentRate(positionRates(old, apy, 100_000_000_000n), apy).pct).toBe(7.3)
  })
  test('an unpriced idle token makes it n/a: the base would be short', () => {
    const s = { ...split(placed, null), idleTokens: [{ token: 'cbBTC', amount: 1000n, decimals: 8, valueUsdc: 0n, unpriced: true }] }
    expect(currentRate(positionRates(placed, apy), apy, s)).toMatchObject({ pct: null, gap: 'no-value' })
  })
})

// otto/mamoru#193 review (P2 1): a view without valueUsdc never values a USDT or WETH leg at 0.
describe('positions without valueUsdc', () => {
  const noValue = (tokenId: string, pool: string, amounts?: NonNullable<FundingView['positions'][number]['amounts']>, inRange = true): FundingView['positions'][number] => ({ tokenId, pool, liquidity: '1', inRange, amountUsdc: '1000000', amountCbbtc: '0', ...(amounts ? { amounts } : {}) })
  const usdt = noValue('2', 'pool:USDC/USDT/100', [{ token: 'USDC', amount: '1000000', decimals: 6 }, { token: 'USDT', amount: '1000000', decimals: 6 }])
  const weth = noValue('3', 'pool:WETH/USDC/3000')
  test('each leg with its own value counts; a leg nothing prices leaves the value unknown', () => {
    expect(valueOf(noValue('1', 'pool:USDC/USDT/100', [{ token: 'USDC', amount: '1000000', decimals: 6, valueUsdc: '1000000' }, { token: 'USDT', amount: '1000000', decimals: 6, valueUsdc: '999000' }]), null)).toEqual({ value: 1_999_000n, unpriced: [] })
    expect(valueOf(usdt, null)).toEqual({ value: null, unpriced: ['USDT'] })
    // An older view without amounts: the WETH leg's amount is not even known.
    expect(valueOf(weth, null)).toEqual({ value: null, unpriced: ['WETH'] })
    // A leg holding nothing needs no price.
    expect(valueOf(noValue('4', 'pool:USDC/USDT/100', [{ token: 'USDC', amount: '1000000', decimals: 6 }, { token: 'USDT', amount: '0', decimals: 6 }]), null)).toEqual({ value: 1_000_000n, unpriced: [] })
  })
  test('an unvalued position makes value, share and both account rates n/a, even with the rest valued', () => {
    const f = { ...placed, positions: [pos('1', 'pool:USDC/cbBTC/500', '5000000'), usdt] }
    const rows = positionRates(f, apy)
    expect(rows.map((r) => r.valueUsdc)).toEqual([5_000_000n, null])
    expect(rows.map((r) => r.sharePct)).toEqual([null, null])
    // Round 2: the unvalued one may hold most of the capital, so no rate that leaves it out.
    expect(currentRate(rows, apy)).toMatchObject({ pct: null, gap: 'no-value', of: 2 })
    expect(monthlyRate(rows, apy)).toMatchObject({ pct: null, gap: 'no-value', of: 2 })
    const { text } = render(<Working f={f} s={split(f, null)} apy={apy} onStop={null} />)
    expect(text).toContain('n/a: no USDC price for USDT in this view yet, so its value, its share and the account rates show n/a.')
    expect(text).toContain('Share n/a')
  })
  test('a paused unvalued position makes both account rates n/a', () => {
    const rows = positionRates({ ...placed, positions: [pos('1', 'pool:USDC/USDT/100', '1000000'), noValue('2', 'pool:WETH/USDC/3000', undefined, false)] }, apy)
    // A paused unvalued position is in the base now (#198): no current rate without its value either.
    expect(currentRate(rows, apy)).toMatchObject({ pct: null, gap: 'no-value' })
    expect(monthlyRate(rows, apy)).toMatchObject({ pct: null, gap: 'no-value' })
  })
  test('nothing valued: n/a for the account rates, with the reason', () => {
    const rows = positionRates({ ...placed, positions: [weth] }, apy)
    expect(currentRate(rows, apy)).toMatchObject({ pct: null, gap: 'no-value', covered: 0, of: 1 })
    expect(monthlyRate(rows, apy)).toMatchObject({ pct: null, gap: 'no-value' })
  })
  test('the compact rates line carries labels for screen readers, not aria-hidden', () => {
    const { html } = render(<Working f={placed} s={split(placed, null)} apy={apy} onStop={null} />)
    const compact = html.match(/<span class="wc-rates-m"[^>]*>.*?<\/span><\/span><\/span>/)?.[0] ?? ''
    expect(html).not.toMatch(/class="wc-rates-m"[^>]*aria-hidden/)
    expect(compact).toContain('<span class="sr-only">Current rate </span>')
    expect(compact).toContain('<span class="sr-only">, Monthly rate </span>')
  })
})

describe('monthly rate', () => {
  test('every position, paused ones included, weighted by USDC value', () => {
    // (50.12 * 4.5 + 39.80 * 18.9 + 9.97 * 55.1) / 99.89 = 15.3
    expect(monthlyRate(positionRates(placed, apy), apy).pct).toBeCloseTo(15.3, 1)
  })
  test('before any position: the plan pools figure, marked as such', () => {
    expect(monthlyRate([], apy)).toMatchObject({ pct: 5.9, plan: true, gap: null })
  })
  test('the source is the name after the last dot', () => {
    expect(sourceName(apy.monthlySource)).toBe('DefiLlama')
    expect(sourceName(apy.currentSource)).toBe('GeckoTerminal/DefiLlama')
    expect(sourceName(undefined)).toBeNull()
  })
})

// otto/mamoru#193 review (P2 2): a view without the operator's idle list keeps its cbBTC visible.
describe('idle breakdown without the operator list', () => {
  const old: FundingView = { ...placed, idle: undefined, usdc: '2000000', cbbtc: '5000', positions: [] }
  test('USDC and cbBTC rebuilt from the view, cbBTC valued at the pool price', () => {
    const s = split(old, 100_000_000_000n)
    expect(s.idleTokens.map((t) => [t.token, String(t.amount), String(t.valueUsdc)])).toEqual([
      ['USDC', '2000000', '2000000'],
      ['cbBTC', '5000', '5000000'],
    ])
    const { text, html } = render(<Idle f={old} s={s} />)
    expect(html).toContain('data-testid="idle-tokens"')
    expect(text).toContain('0.00005 cbBTC 5.00 USDC')
  })
  test('cbBTC with no price stays listed, its value n/a and named on the line', () => {
    const s = split(old, null)
    expect(s.idleTokens.map((t) => [t.token, t.unpriced ?? false])).toEqual([
      ['USDC', false],
      ['cbBTC', true],
    ])
    const { text } = render(<Idle f={old} s={s} />)
    expect(text).toContain('cbBTC not priced yet, not counted in the total')
    expect(text).not.toContain('nothing idle')
    expect(text).toContain('0.00005 cbBTC n/a USDC')
  })
  test('only unpriced cbBTC idle: listed, never "nothing idle"', () => {
    const only = { ...old, usdc: '0' }
    const s = split(only, null)
    expect(s.idle).toBe(0n)
    expect(idleReason(only, s)).toBe('waiting to be placed')
    const { text } = render(<Idle f={only} s={s} />)
    expect(text).toContain('0.00005 cbBTC')
    expect(text).not.toContain('nothing idle')
  })
  test('compact rows keep the token line and range in the markup', () => {
    const { html } = render(<Working f={placed} s={split(placed, null)} apy={apy} onStop={null} />)
    expect(html).toContain('class="wc-legs"')
    expect(html).toContain('In range')
  })
  test('a single non-USDC idle token is named on the line', () => {
    const only = { ...old, usdc: '0' }
    const { text, html } = render(<Idle f={only} s={split(only, 100_000_000_000n)} />)
    expect(html).not.toContain('data-testid="idle-tokens"')
    expect(text).toContain('Idle capital 5.00 USDC · 0.00005 cbBTC')
  })
})

describe('idle and working split', () => {
  test('working is every position, paused included; idle is what sits outside', () => {
    const s = split(placed, null)
    expect(s.working).toBe(99_890_000n)
    expect(s.idle).toBe(110_000n)
    expect(s.total).toBe(100_000_000n)
    expect(idleReason(placed, s)).toBe('waiting to be placed')
  })
  test('the reason follows the engine', () => {
    const placing = { ...placed, engine: { placing: true, nextReviewAt: null } }
    expect(idleReason(placing, split(placing, null))).toBe('being placed')
    const stopped = { ...placed, active: false }
    expect(idleReason(stopped, split(stopped, null))).toBe('Mamoru is stopped')
    const dust = { ...placed, usdc: '300', idle: [{ token: 'USDC', amount: '300', decimals: 6, valueUsdc: '300' }] }
    expect(idleReason(dust, split(dust, null))).toBe('nothing idle')
  })
  // otto/mamoru#194 (Brais 21-oct): «Being placed 0.01» while the engine was mid-entry.
  test('under the smallest entry, what is outside is left over, not being placed', () => {
    const crumbs = { ...placed, usdc: '10000', idle: [{ token: 'USDC', amount: '10000', decimals: 6, valueUsdc: '10000' }], engine: { placing: true, nextReviewAt: null } }
    expect(idleReason(crumbs, split(crumbs, null))).toBe('left over, under the 0.10 USDC minimum')
    const idle = { ...crumbs, engine: { placing: false, nextReviewAt: null } }
    expect(idleReason(idle, split(idle, null))).toBe('left over, under the 0.10 USDC minimum')
  })
})

// otto/mamoru#198: earned so far sits under the balance as its gain; not measured yet says so, never a guess.
describe('earned so far with the balance', () => {
  const s = split(fixtureFunding, null)
  test('a known figure is a gain in USDC', () => {
    const { text } = render(<Balance s={s} earnedSoFarUsd="42000" onAdd={() => {}} onWithdraw={() => {}} />)
    expect(text).toContain('+0.04 USDC earned so far')
  })
  test('no figure yet: n/a and why', () => {
    const { text } = render(<Balance s={s} earnedSoFarUsd={null} onAdd={() => {}} onWithdraw={() => {}} />)
    expect(text).toContain('n/a earned so far not measured yet')
    expect(text).not.toContain('+')
  })
})

// otto/mamoru#198: the current rate is the account's, so its label is one line with no scope words.
describe('rate labels', () => {
  test('"APY · 24h avg" and "APY · 30-day avg", one line each', () => {
    const { text } = render(<Indicators f={placed} apy={apy} price={null} />)
    expect(text).toContain('Current rate APY · 24h avg')
    expect(text).toContain('Monthly rate APY · 30-day avg')
    expect(text).not.toContain('earning now')
  })
})

// otto/mamoru#208: with no live read (the operator unreachable, incident #205), the last snapshot stands in, marked as past.
describe('past reading when the live balance cannot be read', () => {
  const past = { totalUsd: '6001234', readAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }
  test('no live read: the last reading, how old it is, and Withdraw stays off', () => {
    const { text, html } = render(<Balance s={null} past={past} onAdd={() => {}} onWithdraw={() => {}} />)
    expect(text).toContain('6.00 USDC')
    expect(text).toContain('Last reading 3 h ago')
    expect(html).toContain('sum past')
    expect(html).toMatch(/data-testid="withdraw-button"[^>]*disabled/)
    // The add dialog needs the live read, so Add is off too while only a past reading shows.
    expect(html).toMatch(/<button type="button" class="act" disabled/)
  })
  test('the rates say there is no live read instead of loading forever', () => {
    const { text } = render(<Indicators f={undefined} apy={undefined} price={null} noRead />)
    expect(text).toContain('no live read')
    expect(text).not.toContain('loading')
  })
  test('a live read always wins over a past one', () => {
    const s = split(fixtureFunding, null)
    const { text } = render(<Balance s={s} past={past} onAdd={() => {}} onWithdraw={() => {}} />)
    expect(text).not.toContain('Last reading')
    expect(text).not.toContain('6.00 USDC')
  })
})

describe('agoText', () => {
  const now = Date.parse('2026-10-26T10:00:00.000Z')
  test('minutes, hours under two days, then days', () => {
    expect(agoText('2026-10-26T09:55:00.000Z', now)).toBe('5 min')
    expect(agoText('2026-10-26T07:00:00.000Z', now)).toBe('3 h')
    expect(agoText('2026-10-24T01:30:00.000Z', now)).toBe('2 days')
    expect(agoText('2026-10-26T10:05:00.000Z', now)).toBe('0 min')
  })
})
