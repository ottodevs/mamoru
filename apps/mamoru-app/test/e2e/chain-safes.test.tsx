import { describe, expect, test } from 'bun:test'
import { braisAfterMove, BRAIS_BASE_SAFE, BRAIS_MONAD_SAFE_REAL } from '../../src/web/fixtures/brais-after.ts'
import { braisFunding, braisToday } from '../../src/web/fixtures/money.ts'
import { idleWhyLine, knownIdleWhy } from '../../src/web/lib/idle-why.ts'
import { moneyTotal, split, wholeMoney } from '../../src/web/lib/money.ts'
import { Idle, Working } from '../../src/web/routes/home.tsx'
import { count, render } from './render.ts'

// otto/mamoru#265: Brais's account after the move (1 Nov 11:43): positions by chain under each Safe, the 2.08 USDC idle on
// his Monad Safe with why it waits (in words, never the code).

const NOW = Date.parse('2026-11-01T11:43:00.000Z')
const views = (f: ReturnType<typeof braisAfterMove>) => {
  const { f: w, s } = wholeMoney(f)
  return { working: render(<Working f={w} s={s} onStop={null} />), idle: render(<Idle f={w} s={s} home={split(f, null)} />) }
}

describe('reasons in words', () => {
  test('every reason the beta saw has words, and the line never shows the code', () => {
    for (const code of ['EHG_SIM_UNAVAILABLE', 'DECIDE_NO_CAPITAL', 'OBS_RPC_UNAVAILABLE', 'DECIDE_WAIT_DEPTH', 'DECIDE_WAIT_BRIDGE']) {
      expect(knownIdleWhy(code)).toBe(true)
      const line = idleWhyLine({ code }, 143)
      expect(line.startsWith('Waiting to be invested: ')).toBe(true)
      expect(line).not.toContain(code)
      expect(line).not.toMatch(/[A-Z]{3,}_/)
    }
  })

  test('a reason that clears by itself says Mamoru retries; one that does not, does not', () => {
    expect(idleWhyLine({ code: 'EHG_SIM_UNAVAILABLE' }, 143)).toContain('Mamoru cannot check the swap on Monad before sending it')
    expect(idleWhyLine({ code: 'EHG_SIM_UNAVAILABLE' }, 143)).toContain('tries again on its own')
    expect(idleWhyLine({ code: 'DECIDE_WAIT_DEPTH' }, 8453)).not.toContain('tries again')
  })

  test('an unknown code (a newer operator) or none: only that it waits', () => {
    expect(idleWhyLine({ code: 'DECIDE_SOMETHING_NEW' }, 143)).toBe('Waiting to be invested.')
    expect(idleWhyLine(undefined, 143)).toBe('Waiting to be invested.')
  })
})

describe('Brais after the move', () => {
  test('Working: one list, no header per chain, no Safe address, no mix line (Ot, 5 Nov)', () => {
    const { working } = views(braisAfterMove(NOW))
    expect(working.html).not.toContain('data-testid="chain-group"')
    expect(working.html).not.toContain('data-testid="safe-ref"')
    expect(working.html).not.toContain(BRAIS_BASE_SAFE)
    expect(working.text).toContain('11.70 USDC')
    expect(working.text).not.toContain('Your mix')
  })

  test('Idle: the Monad Safe, its 2.07 USDC and why it waits; Base dust is not a row', () => {
    const { idle } = views(braisAfterMove(NOW))
    expect(count(idle.html, 'data-testid="idle-chain"')).toBe(1)
    expect(idle.text).toContain('Safe 0xD72A')
    expect(idle.html).toContain(`https://monadscan.com/address/${BRAIS_MONAD_SAFE_REAL}`)
    expect(idle.text).toContain('2.07 USDC')
    expect(idle.text).toContain('Waiting to be invested: Mamoru cannot check the swap on Monad')
    expect(idle.text).not.toContain('EHG_')
    // Open, since money waits on Monad.
    expect(idle.html).toContain('data-open="true"')
  })

  test('without a reason from Monad the row still says it waits', () => {
    const { idle } = views(braisAfterMove(NOW, null))
    expect(idle.text).toContain('Waiting to be invested.')
  })

  test('the total is the whole money: Working + Idle', () => {
    const f = braisAfterMove(NOW)
    const { s } = wholeMoney(f)
    expect(s.working + s.idle).toBe(moneyTotal(f))
  })
})

describe('other moments', () => {
  test('positions on Base and Monad: one list, largest first, each row names its chain', () => {
    const { f: w, s } = wholeMoney(braisToday(NOW))
    const { html } = render(<Working f={w} s={s} onStop={null} />)
    expect(html).not.toContain('data-testid="chain-group"')
    expect(html.indexOf('Gauntlet USDC Prime')).toBeLessThan(html.indexOf('WETH/USDC'))
    expect(html).toContain('WMON/USDC')
  })

  test('one chain only (no Monad yet): nothing new, no Safe, no mix', () => {
    const f = braisFunding('before', NOW)
    const { f: w, s } = wholeMoney(f)
    const working = render(<Working f={w} s={s} onStop={null} />)
    const idle = render(<Idle f={w} s={s} />)
    expect(working.html).not.toContain('data-testid="chain-group"')
    expect(idle.html).not.toContain('data-testid="safe-ref"')
  })

})
