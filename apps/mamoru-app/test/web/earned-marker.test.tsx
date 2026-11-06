import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Balance } from '../../src/web/routes/home.tsx'

const render = (notCounted?: string[], usd: string | null = '1234567') =>
  renderToStaticMarkup(<Balance s={null} earnedSoFarUsd={usd} earnedNotCounted={notCounted} onAdd={() => {}} onWithdraw={() => {}} />)

describe('earned so far marker (spec 012 HRV-R10, HRV-S15)', () => {
  test('a complete figure has no marker', () => {
    expect(render([])).not.toContain('earned-not-counted')
    expect(render(undefined)).not.toContain('earned-not-counted')
  })
  test('vault yield left out says so; anything else gets the general line', () => {
    expect(render(['vault-yield'])).toContain('vault yield not counted yet')
    expect(render(['fees'])).toContain('some earnings not counted yet')
  })
  test('no figure at all keeps the older "not measured yet", without the marker', () => {
    const html = render(['vault-yield'], null)
    expect(html).toContain('not measured yet')
    expect(html).not.toContain('earned-not-counted')
  })
})
