import { describe, expect, test } from 'bun:test'
import { braisAfterMove, BRAIS_BASE_SAFE, BRAIS_MONAD_SAFE_REAL } from '../../src/web/fixtures/brais-after.ts'
import { braisFunding, braisToday } from '../../src/web/fixtures/money.ts'
import { idleWhyLine, knownIdleWhy } from '../../src/web/lib/idle-why.ts'
import { mixVsTarget } from '../../src/web/lib/mix.ts'
import { moneyTotal, split, wholeMoney } from '../../src/web/lib/money.ts'
import { Idle, Working } from '../../src/web/routes/home.tsx'
import { count, render } from './render.ts'

// otto/mamoru#265: Brais's account after the move (1 Nov 11:43): positions by chain under each Safe, the 2.08 USDC idle on
// his Monad Safe with why it waits (in words, never the code), and the mix against its target (50.3/34.6/15.1 vs 50/35/15).

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
  test('the mix against the target: 50.3 / 34.6 / 15.1 vs 50 / 35 / 15', () => {
    const mix = mixVsTarget(braisAfterMove(NOW))!
    expect(mix.map((r) => r.bucket)).toEqual(['Stable', 'Balanced', 'Growth'])
    expect(mix.map((r) => r.targetPct)).toEqual([50, 35, 15])
    const [stable, balanced, growth] = mix.map((r) => r.nowPct)
    expect(stable).toBeCloseTo(50.3, 0)
    expect(balanced).toBeCloseTo(34.6, 0)
    expect(growth).toBeCloseTo(15.1, 0)
    expect(stable! + balanced! + growth!).toBeLessThanOrEqual(100)
  })

  test('Working: the Base positions under a Base header, no Safe address (Brais, 3 Nov), and the mix line', () => {
    const { working } = views(braisAfterMove(NOW))
    expect(count(working.html, 'data-testid="chain-group"')).toBe(1)
    expect(working.html).not.toContain('data-testid="safe-ref"')
    expect(working.html).not.toContain(BRAIS_BASE_SAFE)
    expect(working.text).toContain('11.70 USDC')
    expect(working.text).toContain('Your mix')
    expect(working.text).toContain('Growth 15.1%')
    expect(working.text).toContain('target 15%')
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
  test('positions on Base and Monad: two groups, the larger first, each named by its chain', () => {
    const { f: w, s } = wholeMoney(braisToday(NOW))
    const { html } = render(<Working f={w} s={s} onStop={null} />)
    const groups = html.split('data-testid="chain-group"').slice(1)
    expect(groups.length).toBe(2)
    expect(groups[0]).toContain('Base')
    expect(groups[1]).toContain('Monad')
    expect(html).not.toContain('data-testid="safe-ref"')
    // The rows of each group follow its head, largest first (#350).
    expect(groups[0]!.indexOf('Gauntlet USDC Prime')).toBeLessThan(groups[0]!.indexOf('WETH/USDC'))
    expect(groups[1]).toContain('WMON/USDC')
  })

  test('one chain only (no Monad yet): nothing new, no Safe, no mix', () => {
    const f = braisFunding('before', NOW)
    const { f: w, s } = wholeMoney(f)
    const working = render(<Working f={w} s={s} onStop={null} />)
    const idle = render(<Idle f={w} s={s} />)
    expect(working.html).not.toContain('data-testid="chain-group"')
    expect(working.html).not.toContain('data-testid="mix"')
    expect(idle.html).not.toContain('data-testid="safe-ref"')
    expect(mixVsTarget(f)).toBeNull()
  })

  test('a map that is not complete gives no mix (a share of a partial total would be wrong)', () => {
    const f = braisAfterMove(NOW)
    f.money!.complete = false
    expect(mixVsTarget(f)).toBeNull()
  })
})
