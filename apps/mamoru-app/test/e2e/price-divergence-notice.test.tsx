import { describe, expect, test } from 'bun:test'
import type { PriceDivergenceWarning } from '@mamoru/domain'
import { PriceDivergenceNotice } from '../../src/web/components/price-divergence-notice.tsx'
import { render } from './render.ts'

const swapBack: PriceDivergenceWarning = {
  code: 'PRICE_DIVERGENCE',
  legs: [{ kind: 'swap-back', token: 'USDC', sellToken: 'cbBTC', decimals: 6, fairAmount: '1000000', quotedAmount: '985000', minAmount: '975000', shortfall: '25000', shortfallBps: 250 }],
  shortfallUsdc: '25000',
  quoteId: 'qd_1',
}

const payout: PriceDivergenceWarning = {
  code: 'PRICE_DIVERGENCE',
  legs: [{ kind: 'payout', token: 'EURC', decimals: 6, fairAmount: '921000', quotedAmount: '915000', minAmount: '909000', shortfall: '12000', shortfallBps: 130 }],
  shortfallUsdc: '13000',
  quoteId: 'qd_2',
}

describe('PriceDivergenceNotice: rendering with the worst-case numbers', () => {
  test('swap-back: "your account", the signed minimum ("at least"), no em dash', () => {
    const { text, html } = render(<PriceDivergenceNotice warning={swapBack} accepted={false} onAcceptedChange={() => {}} locale="en" />)
    expect(text).toContain('Your account would get at least 0.975 USDC instead of about 1 USDC from selling cbBTC')
    // shortfall 25000 = 0.025 USDC exactly: ceiled to 0.03, the reviewer's exact never-understate case.
    expect(text).toContain('0.03 USDC less')
    expect(text).toContain('2.50%')
    expect(text).toContain('fair price over the last 30 minutes')
    expect(text).toContain('I understand your account will get about 0.03 USDC less.')
    expect(text).not.toContain('—')
    expect(html).toContain('data-testid="price-divergence"')
    expect(html).toContain('type="checkbox"')
  })
  test('payout: "the recipient", not "your account"', () => {
    const { text } = render(<PriceDivergenceNotice warning={payout} accepted={false} onAcceptedChange={() => {}} locale="en" />)
    expect(text).toContain('The recipient would receive at least 0.909 EURC instead of about 0.921 EURC')
    // shortfall 12000 = 0.012 EURC exactly: ceiled to 0.02, never truncated down to 0.01.
    expect(text).toContain('I understand the recipient will get about 0.02 EURC less.')
    expect(text).not.toContain('your account')
  })
  test('es and ja switch the whole notice, same worst-case numbers, no em dash', () => {
    const es = render(<PriceDivergenceNotice warning={swapBack} accepted={false} onAcceptedChange={() => {}} locale="es" />)
    expect(es.text).toContain('Tu cuenta recibiría al menos 0.975 USDC')
    expect(es.text).not.toContain('—')
    const ja = render(<PriceDivergenceNotice warning={swapBack} accepted={false} onAcceptedChange={() => {}} locale="ja" />)
    expect(ja.text).toContain('0.975')
    expect(ja.text).toContain('少なくなります')
    expect(ja.text).not.toContain('—')
  })
  test('unchecked by default, checked when accepted is true (the confirm gate reads this)', () => {
    const unchecked = render(<PriceDivergenceNotice warning={swapBack} accepted={false} onAcceptedChange={() => {}} locale="en" />)
    expect(unchecked.html).not.toContain('checked=""')
    const checked = render(<PriceDivergenceNotice warning={swapBack} accepted={true} onAcceptedChange={() => {}} locale="en" />)
    expect(checked.html).toContain('checked=""')
  })
  test('a fresh (stale-rewarned) warning with different numbers re-renders with those numbers, not the old ones', () => {
    const fresh: PriceDivergenceWarning = { ...swapBack, quoteId: 'qd_new', legs: [{ ...swapBack.legs[0]!, minAmount: '950000', shortfall: '50000', shortfallBps: 500 }] }
    const { text } = render(<PriceDivergenceNotice warning={fresh} accepted={false} onAcceptedChange={() => {}} locale="en" />)
    // 0.05 USDC is already exact at 2 decimals, so ceiling leaves it untouched.
    expect(text).toContain('at least 0.95 USDC')
    expect(text).toContain('0.05 USDC less')
    expect(text).toContain('5%')
    expect(text).not.toContain('0.975 USDC')
  })
  test('a dust shortfall never ceils into a wildly overstated headline: "less than" instead of "0.01"', () => {
    const dust: PriceDivergenceWarning = {
      ...swapBack,
      legs: [{ kind: 'payout', token: 'ETH', decimals: 18, fairAmount: '1000000000000000', quotedAmount: '999999999999963', minAmount: '999999999999963', shortfall: '37', shortfallBps: 1 }],
    }
    const { text } = render(<PriceDivergenceNotice warning={dust} accepted={false} onAcceptedChange={() => {}} locale="en" />)
    // render()'s text extraction leaves `<` HTML-escaped as `&lt;` (see render.ts); the "less than" number is
    // the behavior under test, not the literal glyph, so assert against what toStaticMarkup actually emits.
    expect(text).toContain('&lt; 0.0001 ETH less')
    expect(text).not.toContain('0.01 ETH less')
    expect(text).not.toContain('0 ETH less')
  })
})
