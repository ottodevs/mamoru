import { describe, expect, test } from 'bun:test'
import { braisAfterMove, BRAIS_BASE_SAFE, BRAIS_MONAD_SAFE_REAL } from '../../src/web/fixtures/brais-after.ts'
import { braisToday } from '../../src/web/fixtures/money.ts'
import { moneyTotal, split, wholeMoney } from '../../src/web/lib/money.ts'
import { Idle, Working } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

// Ot, 5 Nov: Working capital and Idle capital on an account with Base and Monad look as they did before otto/mamoru#265:
// one list of positions (each row names its chain), one Idle line, no Safe address or explorer link, no mix line.

const NOW = Date.parse('2026-11-01T11:43:00.000Z')
const views = (f: ReturnType<typeof braisAfterMove>) => {
  const { f: w, s } = wholeMoney(f)
  return { working: render(<Working f={w} s={s} onStop={null} />), idle: render(<Idle f={w} s={s} home={split(f, null)} />) }
}

describe('Brais after the move', () => {
  test('Working: one list, no header per chain, no Safe, no mix line', () => {
    const { working } = views(braisAfterMove(NOW))
    expect(working.html).not.toContain('data-testid="chain-group"')
    expect(working.html).not.toContain('data-testid="safe-ref"')
    expect(working.html).not.toContain(BRAIS_BASE_SAFE)
    expect(working.text).toContain('11.70 USDC')
    expect(working.text).not.toContain('Your mix')
  })

  test('Idle: one line, no row per chain, no Safe, no explorer link, no reason sentence', () => {
    const { idle } = views(braisAfterMove(NOW))
    expect(idle.html).not.toContain('data-testid="idle-chain"')
    expect(idle.html).not.toContain('data-testid="safe-ref"')
    expect(idle.html).not.toContain(BRAIS_MONAD_SAFE_REAL)
    expect(idle.html).not.toContain('monadscan.com')
    expect(idle.text).not.toContain('Waiting to be invested')
  })

  test('the total is the whole money: Working + Idle', () => {
    const f = braisAfterMove(NOW)
    const { s } = wholeMoney(f)
    expect(s.working + s.idle).toBe(moneyTotal(f))
  })
})

describe('other moments', () => {
  test('positions on Base and Monad: one list, largest first', () => {
    const { f: w, s } = wholeMoney(braisToday(NOW))
    const { html } = render(<Working f={w} s={s} onStop={null} />)
    expect(html).not.toContain('data-testid="chain-group"')
    expect(html.indexOf('Gauntlet USDC Prime')).toBeLessThan(html.indexOf('WETH/USDC'))
    expect(html).toContain('WMON/USDC')
  })
})
