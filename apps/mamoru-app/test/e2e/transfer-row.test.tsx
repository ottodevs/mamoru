import { describe, expect, test } from 'bun:test'
import { totalScopeNote } from '../../src/web/components/money-map.tsx'
import { TransferRow, transferSummary } from '../../src/web/components/transfer-row.tsx'
import { BRAIS_BURN_TX, BRAIS_MINT_TX, BRAIS_MONAD_RECIPIENT, braisFlight, type FlightStage } from '../../src/web/fixtures/transfer.ts'
import { moneyTotal, split } from '../../src/web/lib/money.ts'
import { transferOfBridge, transferOfFlight } from '../../src/web/lib/transfer.ts'
import { Balance } from '../../src/web/routes/home.tsx'
import { render } from './render.ts'

// otto/mamoru#264: Brais's 2.075638 USDC from Base to his Monad Safe (1 Nov, burned 10:22:53, minted 10:38:34): one row
// under the balance with the stage, the arrival window and both transactions; the total counts it all along.

const NOW = Date.parse('2026-11-01T10:29:00.000Z')
const row = (stage: FlightStage) => render(<TransferRow flight={braisFlight(stage, NOW).money!.inFlight[0]!} now={NOW} />)

describe('the stage, in words', () => {
  const steps: [FlightStage, number, string][] = [
    ['sending', 0, 'leaving Base'],
    ['burned', 1, 'waiting for Circle to confirm'],
    ['attested', 2, 'arriving on Monad'],
    ['minting', 2, 'arriving on Monad'],
    ['minted', 3, 'updating your balance'],
  ]
  for (const [stage, step, words] of steps) {
    test(stage, () => {
      const t = transferOfFlight(braisFlight(stage, NOW).money!.inFlight[0]!, NOW)
      expect(t.step).toBe(step as never)
      expect(transferSummary(t, NOW)).toContain(words)
      expect(row(stage).html).toContain(`data-step="${step}"`)
    })
  }

  test('burned: the line is Brais\'s, then the stage and the window 13 to 19 minutes after the burn', () => {
    const { text } = row('burned')
    expect(text).toContain('2.07 USDC moving from Base to Monad')
    expect(text).toMatch(/arrives .+ to .+/)
    expect(text).toContain('Usually 13 to 19 minutes.')
    expect(text).toContain('Counted in your total while it travels.')
  })

  test('past the window: says it is taking longer, promises no time', () => {
    const { text } = row('late')
    expect(text).toContain('taking longer than usual')
    expect(text).not.toMatch(/arrives .+ to /)
  })

  test('arrived: says so, and no longer "moving"', () => {
    const { text } = row('minted')
    expect(text).toContain('2.07 USDC from Base arrived on Monad')
    expect(text).not.toContain('moving from')
    expect(text).toContain('Already counted in your total.')
  })

  test('a failed transfer has no row (it is not in the total)', () => {
    const f = braisFlight('burned', NOW).money!.inFlight[0]!
    expect(render(<TransferRow flight={{ ...f, stage: 'failed' }} now={NOW} />).html).toBe('')
  })
})

describe('links and Safe', () => {
  test('the burn on Basescan, the mint on Monadscan, the Safe on Monadscan with a copy button', () => {
    const { html } = row('minted')
    expect(html).toContain(`https://basescan.org/tx/${BRAIS_BURN_TX}`)
    expect(html).toContain(`https://monadscan.com/tx/${BRAIS_MINT_TX}`)
    expect(html).toContain(`https://monadscan.com/address/${BRAIS_MONAD_RECIPIENT}`)
    expect(html).toContain('Copy your Monad Safe address')
  })

  test('before the burn there is no transaction to link', () => {
    expect(row('sending').html).not.toContain('/tx/')
  })

  test('a bridge op of an older operator (no times, no hashes) still reads, without a window or links', () => {
    const t = transferOfBridge({ chainId: 143, amountUsdc: '2075638', state: 'burned' }, 8453, NOW)
    expect(t.step).toBe(1)
    expect(t.eta).toBeUndefined()
    expect(transferSummary(t, NOW)).toBe('waiting for Circle to confirm')
  })
})

describe('under the balance', () => {
  test('the total counts the transfer and its row replaces the plain line', () => {
    const f = braisFlight('burned', NOW)
    const { text } = render(<Balance s={split(f, null)} total={moneyTotal(f)} scopeNote={totalScopeNote(f, true, false)} transfers={f.money!.inFlight} onAdd={() => {}} onWithdraw={() => {}} />)
    expect(text).toContain('13.78')
    expect(text.match(/moving from Base to Monad/g)?.length).toBe(1)
    expect(totalScopeNote(f, true, false)).toBeNull()
  })
})

describe('review r1', () => {
  test('stuck while still leaving Base: the open row says it is taking longer, not only the closed line', () => {
    const f = braisFlight('sending', NOW).money!.inFlight[0]!
    const { text } = render(<TransferRow flight={{ ...f, stuckAt: new Date(NOW - 60_000).toISOString(), stuckReason: 'not_sent' }} now={NOW} />)
    expect(text).toContain('leaving Base · taking longer than usual')
    expect(text).toContain('Taking longer than usual. Your money is safe and counted in your total.')
  })

  test('the window turns late by the clock: the same row 30 min later promises no time', () => {
    const f = braisFlight('burned', NOW).money!.inFlight[0]!
    const late = render(<TransferRow flight={{ ...f, eta: { ...f.eta!, late: false } }} now={NOW + 30 * 60_000} />).text
    expect(late).toContain('taking longer than usual')
    expect(late).not.toMatch(/arrives .+ to /)
  })

  test('no 13-19 min window of ours for fast finality or a transfer that leaves Monad', () => {
    const f = braisFlight('burned', NOW).money!.inFlight[0]!
    for (const row of [{ ...f, finality: 'fast' as const, eta: undefined }, { ...f, from: 143, to: 8453, eta: undefined }]) {
      const t = transferOfFlight(row, NOW)
      expect(t.eta).toBeUndefined()
      const { text } = render(<TransferRow flight={row} now={NOW} />)
      expect(text).not.toContain('13 to 19')
      expect(text).not.toMatch(/arrives .+ to /)
    }
  })
})
