import { describe, expect, test } from 'bun:test'
import type { BridgeStuckReason, FundingView } from '@mamoru/domain'
import { DIY_MINT_URL, isLate, isStuck, MoneyMapCard, moneyCopy, stuckReasonText } from '../../src/web/components/money-map.tsx'
import { braisFunding, withStuckTransfer } from '../../src/web/fixtures/money.ts'
import { split } from '../../src/web/lib/money.ts'
import { bridgeLine } from '../../src/web/lib/positions.ts'
import { Working } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

// otto/mamoru#245: a Base to Monad burn past its deadline. The operator flags it stuck with a reason code and keeps
// retrying; the app says why in plain words, that the money is safe, and how to finish it without Mamoru.

const NOW = Date.parse('2026-11-01T10:30:00.000Z')
const card = (f: FundingView) => render(<MoneyMapCard money={f.money!} now={NOW} />)
const working = (f: FundingView) => render(<Working f={f} s={split(f, null)} onStop={null} />)

const GROUPS: [string, BridgeStuckReason[]][] = [
  [moneyCopy.stuck.circle, ['no_attestation', 'burn_unmatched']],
  [moneyCopy.stuck.monad, ['mint_pending', 'mint_reverted', 'gas_ceiling', 'monad_unreachable']],
  [moneyCopy.stuck.ours, ['mint_budget', 'relayer_unfunded', 'mint_off', 'not_sent']],
]

describe('the reason, by who the wait is on', () => {
  for (const [sentence, codes] of GROUPS) {
    for (const code of codes) {
      test(`${code}: ${sentence}`, () => {
        expect(stuckReasonText(code)).toBe(sentence)
        const { text } = card(withStuckTransfer(code, NOW))
        expect(text).toContain(`${sentence} ${moneyCopy.stuckSafe}`)
      })
    }
  }

  test('every code of the domain type is in a group', () => {
    const all = GROUPS.flatMap(([, c]) => c)
    expect(new Set(all).size).toBe(10)
    for (const code of all) expect(stuckReasonText(code)).not.toBe(moneyCopy.stuckUnknown)
  })

  test('an unknown code, or none, gets generic words and never throws', () => {
    expect(stuckReasonText('relay_on_vacation')).toBe(moneyCopy.stuckUnknown)
    expect(stuckReasonText(undefined)).toBe(moneyCopy.stuckUnknown)
    expect(stuckReasonText('toString')).toBe(moneyCopy.stuckUnknown)
    const { text } = card(withStuckTransfer('relay_on_vacation', NOW))
    expect(text).toContain(`${moneyCopy.stuckUnknown} ${moneyCopy.stuckSafe}`)
    expect(text).not.toContain('relay_on_vacation')
  })

  test('the stuck copy says the money is safe, retried and known, and carries no amount', () => {
    expect(moneyCopy.stuckSafe).toContain('safe')
    expect(moneyCopy.stuckSafe).toContain('retrying')
    expect(moneyCopy.stuckSafe).toContain('already knows')
    for (const s of [...Object.values(moneyCopy.stuck), moneyCopy.stuckUnknown, moneyCopy.stuckSafe, moneyCopy.diyBody]) expect(s).not.toMatch(/\d/)
    const { html } = card(withStuckTransfer('gas_ceiling', NOW))
    const note = (/data-testid="stuck-note">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '').replace(/<[^>]+>/g, '')
    expect(note).toContain(moneyCopy.stuck.monad)
    expect(note).not.toMatch(/\d/)
  })
})

describe('stuck wins over late', () => {
  test('the late window is not shown once the operator flags it stuck', () => {
    const f = withStuckTransfer('no_attestation', NOW)
    const t = f.money!.inFlight[0]!
    expect(t.eta!.late).toBe(true)
    expect(isStuck(t)).toBe(true)
    expect(isLate(t, NOW)).toBe(false)
    const { text, html } = card(f)
    expect(text).not.toContain('Taking longer than expected')
    expect(text).not.toContain('Expected between')
    expect(html).toContain('data-stuck="true"')
  })

  test('the same row without the flag is late, as before', () => {
    const f = withStuckTransfer('no_attestation', NOW)
    const t = { ...f.money!.inFlight[0]!, stuckAt: undefined, stuckReason: undefined }
    expect(isLate(t, NOW)).toBe(true)
    const { text, html } = render(<MoneyMapCard money={{ ...f.money!, inFlight: [t] }} now={NOW} />)
    expect(text).toContain('Taking longer than expected')
    expect(html).not.toContain('stuck-note')
    expect(html).not.toContain('stuck-diy')
  })

  test('a minted or failed row is never stuck, even with a stale flag', () => {
    const f = withStuckTransfer('mint_pending', NOW)
    const t = f.money!.inFlight[0]!
    for (const stage of ['minted', 'failed'] as const) {
      expect(isStuck({ ...t, stage })).toBe(false)
      const { html } = render(<MoneyMapCard money={{ ...f.money!, inFlight: [{ ...t, stage }] }} now={NOW} />)
      expect(html).not.toContain('stuck-note')
    }
  })

  test('the in-flight row that is not stuck is unchanged', () => {
    const { html, text } = card(braisFunding('flight', NOW))
    expect(html).not.toContain('stuck-')
    expect(text).toContain('Expected between')
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
    const noHash = { ...f.money!, inFlight: [{ ...f.money!.inFlight[0]!, burnTx: undefined }] }
    expect(render(<MoneyMapCard money={noHash} now={NOW} />).html).not.toContain('stuck-diy')
    for (const code of ['not_sent', 'burn_unmatched']) {
      const { html } = card(withStuckTransfer(code, NOW))
      expect(html).toContain('stuck-note')
      expect(html).not.toContain('stuck-diy')
    }
  })
})

describe('the progress line under Working', () => {
  test('a stuck bridge says why, promises no arrival time, and offers the way out', () => {
    const f = withStuckTransfer('relayer_unfunded', NOW)
    const { text, html } = working(f)
    expect(text).toContain('Moving 2.07 USDC to Monad')
    expect(text).not.toContain('arrives in about 20 minutes')
    expect(text).toContain(`${moneyCopy.stuck.ours} ${moneyCopy.stuckSafe}`)
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
