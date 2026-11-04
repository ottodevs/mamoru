import { describe, expect, test } from 'bun:test'
import type { BridgeStuckReason, FundingView, MoneyInFlight } from '@mamoru/domain'
import { DIY_MINT_URL, isStuck, moneyCopy, StuckNote } from '../../src/web/components/money-map.tsx'
import { braisFunding, withStuckTransfer } from '../../src/web/fixtures/money.ts'
import { split } from '../../src/web/lib/money.ts'
import { bridgeLine } from '../../src/web/lib/positions.ts'
import { Working } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

// otto/mamoru#245: a Base to Monad burn past its deadline. The operator flags it stuck with a reason code and keeps
// retrying; the app says why in plain words, that the money is safe, and how to finish it without Mamoru.

const NOW = Date.parse('2026-11-01T10:30:00.000Z')
const working = (f: FundingView) => render(<Working f={f} s={split(f, null)} onStop={null} />)
// otto/mamoru#350: the money map card is gone; the stuck note lives under Working capital. A transfer row renders it as
// the card did, for the cases the fixture's progress does not carry.
const note = (t: MoneyInFlight) => render(<StuckNote reason={t.stuckReason} from={t.from} to={t.to} burnTx={t.burnTx} landed={t.stage !== 'sending'} />)
const card = working

const CODES: BridgeStuckReason[] = ['no_attestation', 'burn_unmatched', 'mint_pending', 'mint_reverted', 'gas_ceiling', 'monad_unreachable', 'mint_budget', 'relayer_unfunded', 'mint_off', 'not_sent']

describe('one sentence, whatever the reason (Brais, 4 Nov)', () => {
  test('the copy is Brais\'s sentence, with no amount', () => {
    expect(moneyCopy.stuck).toBe('Taking longer than usual, Mamoru is trying. Your money is safe.')
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

describe('finish it yourself', () => {
  test('a closed disclosure with the burn on Basescan and the walkaway section', () => {
    const f = withStuckTransfer('mint_budget', NOW)
    const { html, text } = card(f)
    expect(html).toContain('<details class="mm-diy" data-testid="stuck-diy">')
    expect(html).not.toContain('<details class="mm-diy" data-testid="stuck-diy" open')
    expect(text).toContain(moneyCopy.diy)
    expect(html).toContain(`https://basescan.org/tx/0x${'b'.repeat(64)}`)
    expect(html).toContain(`href="${DIY_MINT_URL}"`)
    expect(DIY_MINT_URL).toBe('https://github.com/ottodevs/mamoru/blob/main/docs/walkaway.md#a-transfer-to-monad-that-never-arrives')
  })

  test('no disclosure without a burn to finish: no hash, or a burn that never landed', () => {
    const f = withStuckTransfer('mint_budget', NOW)
    expect(note({ ...f.money!.inFlight[0]!, burnTx: undefined }).html).not.toContain('stuck-diy')
    for (const code of ['not_sent', 'burn_unmatched']) {
      const { html } = card(withStuckTransfer(code, NOW))
      expect(html).toContain('stuck-note')
      expect(html).not.toContain('stuck-diy')
    }    // An allowlist: a code this app does not know, or none, never offers it, even with a burn hash.
    for (const code of ['burn_reverted', '']) {
      const f2 = withStuckTransfer(code, NOW)
      const row = { ...f2.money!.inFlight[0]!, stuckReason: (code || undefined) as never }
      expect(note(row).html).not.toContain('stuck-diy')
    }
    // A burn not confirmed on Base yet (sending) has nothing to finish.
    const sending = withStuckTransfer('mint_budget', NOW)
    const row = { ...sending.money!.inFlight[0]!, stage: 'sending' as const }
    expect(note(row).html).not.toContain('stuck-diy')
    const w = working({ ...sending, progress: { ...sending.progress!, bridge: { ...sending.progress!.bridge!, state: 'sending' } } })
    expect(w.text).toContain(moneyCopy.stuck)
    expect(w.html).not.toContain('stuck-diy')
  })
})

describe('the progress line under Working', () => {
  test('a stuck bridge says why, promises no arrival time, and offers the way out', () => {
    const f = withStuckTransfer('relayer_unfunded', NOW)
    const { text, html } = working(f)
    expect(text).toContain('Moving 2.07 USDC to Monad')
    expect(text).not.toContain('arrives in about 20 minutes')
    expect(text).toContain(moneyCopy.stuck)
    expect(html).toContain('stuck-diy')
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
