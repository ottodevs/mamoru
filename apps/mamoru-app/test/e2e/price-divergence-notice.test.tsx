import { describe, expect, test } from 'bun:test'
import type { PriceDivergenceWarning } from '@mamoru/domain'
import { PriceDivergenceNotice } from '../../src/web/components/price-divergence-notice.tsx'
import { render } from './render.ts'

const warning: PriceDivergenceWarning = {
  code: 'PRICE_DIVERGENCE',
  legs: [{ token: 'USDC', decimals: 6, fairAmount: '1000000', quotedAmount: '975000', shortfall: '25000', shortfallBps: 250 }],
  shortfallUsdc: '25000',
  quoteId: 'qd_1',
}

describe('PriceDivergenceNotice: rendering with numbers', () => {
  test('en: the sentence, the why, and the checkbox label are all on the page', () => {
    const { text, html } = render(<PriceDivergenceNotice warning={warning} accepted={false} onAcceptedChange={() => {}} locale="en" />)
    expect(text).toContain('0.97 USDC instead of about 1 USDC')
    expect(text).toContain('0.02 USDC less')
    expect(text).toContain('2.50%')
    expect(text).toContain('fair price over the last 30 minutes')
    expect(text).toContain('I understand I will receive about $0.02 less.')
    expect(html).toContain('data-testid="price-divergence"')
    expect(html).toContain('type="checkbox"')
  })
  test('es and ja switch the whole notice, same numbers', () => {
    const es = render(<PriceDivergenceNotice warning={warning} accepted={false} onAcceptedChange={() => {}} locale="es" />)
    expect(es.text).toContain('Recibirías')
    expect(es.text).toContain('0.97')
    const ja = render(<PriceDivergenceNotice warning={warning} accepted={false} onAcceptedChange={() => {}} locale="ja" />)
    expect(ja.text).toContain('0.97')
    expect(ja.text).toContain('少なくなります')
  })
  test('unchecked by default, checked when accepted is true (the confirm gate reads this)', () => {
    const unchecked = render(<PriceDivergenceNotice warning={warning} accepted={false} onAcceptedChange={() => {}} locale="en" />)
    expect(unchecked.html).not.toContain('checked=""')
    const checked = render(<PriceDivergenceNotice warning={warning} accepted={true} onAcceptedChange={() => {}} locale="en" />)
    expect(checked.html).toContain('checked=""')
  })
  test('a fresh (stale-rewarn) quoteId with different numbers re-renders with those numbers, not the old ones', () => {
    const fresh: PriceDivergenceWarning = { ...warning, quoteId: 'qd_2', legs: [{ ...warning.legs[0]!, quotedAmount: '950000', shortfall: '50000', shortfallBps: 500 }] }
    const { text } = render(<PriceDivergenceNotice warning={fresh} accepted={false} onAcceptedChange={() => {}} locale="en" />)
    expect(text).toContain('0.95 USDC')
    expect(text).toContain('5%')
    expect(text).not.toContain('2.50%')
  })
})
