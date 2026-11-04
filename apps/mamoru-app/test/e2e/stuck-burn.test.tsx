import { describe, expect, test } from 'bun:test'
import type { BridgeStuckReason, FundingView } from '@mamoru/domain'
import { isStuck, moneyCopy } from '../../src/web/components/money-map.tsx'
import { braisFunding, withStuckTransfer } from '../../src/web/fixtures/money.ts'
import { split } from '../../src/web/lib/money.ts'
import { bridgeLine } from '../../src/web/lib/positions.ts'
import { Working } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

// otto/mamoru#245: a Base to Monad burn past its deadline. The operator flags it stuck with a reason code; the app says
// one sentence (Brais, 4 Nov): taking longer, Mamoru keeps trying, the money is safe. No reason, no way-out disclosure.

const NOW = Date.parse('2026-11-01T10:30:00.000Z')
const working = (f: FundingView) => render(<Working f={f} s={split(f, null)} onStop={null} />)
// otto/mamoru#350: the money map card is gone; the stuck note lives under Working capital.
const card = working

const CODES: BridgeStuckReason[] = ['no_attestation', 'burn_unmatched', 'mint_pending', 'mint_reverted', 'gas_ceiling', 'monad_unreachable', 'mint_budget', 'relayer_unfunded', 'mint_off', 'not_sent']

describe('one sentence, whatever the reason (Brais, 4 Nov)', () => {
  test('the copy is Brais\'s sentence, with no amount', () => {
    expect(moneyCopy.stuck).toBe('Taking longer than usual. Mamoru keeps trying. Your money is safe.')
    expect(moneyCopy.stuck).not.toMatch(/\d/)
  })

  for (const code of [...CODES, 'relay_on_vacation']) {
    test(`${code}: the same sentence, no reason code shown`, () => {
      const { text, html } = card(withStuckTransfer(code, NOW))
      expect(text).toContain(moneyCopy.stuck)
      expect(text).not.toContain(code)
      const note = (/data-testid="stuck-note">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, '').trim()
      expect(note).toBe(moneyCopy.stuck)
    })
  }
})

describe('stuck wins over late', () => {
  test('the late window is not shown once the operator flags it stuck', () => {
    const f = withStuckTransfer('no_attestation', NOW)
    const t = f.money!.inFlight[0]!
    expect(t.eta!.late).toBe(true)
    expect(isStuck(t)).toBe(true)
    const { text, html } = card(f)
    expect(text).not.toContain('arrives in about')
    expect(html).toContain('stuck-note')
  })

  test('a minted or failed row is never stuck, even with a stale flag', () => {
    const f = withStuckTransfer('mint_pending', NOW)
    const t = f.money!.inFlight[0]!
    for (const stage of ['minted', 'failed'] as const) {
      expect(isStuck({ ...t, stage })).toBe(false)
    }
  })

  test('the in-flight row that is not stuck is unchanged', () => {
    const { html } = card(braisFunding('flight', NOW))
    expect(html).not.toContain('stuck-')
  })
})

describe('no way-out disclosure (Brais, 4 Nov)', () => {
  test('a stuck bridge, landed or sending, shows the note and no «Finish it yourself»', () => {
    const f = withStuckTransfer('mint_budget', NOW)
    for (const v of [f, { ...f, progress: { ...f.progress!, bridge: { ...f.progress!.bridge!, state: 'sending' as const } } }]) {
      const { text, html } = working(v)
      expect(text).toContain(moneyCopy.stuck)
      expect(text).not.toContain('Finish it yourself')
      expect(html).not.toContain('stuck-diy')
    }
  })
})

describe('the progress line under Working', () => {
  test('a stuck bridge says the sentence and promises no arrival time', () => {
    const f = withStuckTransfer('relayer_unfunded', NOW)
    const { text, html } = working(f)
    expect(text).toContain('Moving 2.07 USDC to Monad')
    expect(text).not.toContain('arrives in about 20 minutes')
    expect(text).toContain(moneyCopy.stuck)
    expect(html).toContain('stuck-note')
    expect(bridgeLine(f.progress!.bridge!)).toBe('Moving 2.07 USDC to Monad')
  })

  test('a bridge that is not stuck keeps its line and no note', () => {
    const f = withStuckTransfer('relayer_unfunded', NOW)
    const bridge = { ...f.progress!.bridge!, stuckAt: undefined, stuckReason: undefined }
    const { text, html } = working({ ...f, progress: { ...f.progress!, bridge } })
    expect(text).toContain('Moving 2.07 USDC to Monad (arrives in about 20 minutes)')
    expect(html).not.toContain('stuck-')
  })
})
