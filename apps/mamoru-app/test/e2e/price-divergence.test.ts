import { describe, expect, test } from 'bun:test'
import type { PriceDivergenceWarning } from '@mamoru/domain'
import { fixtureClient, fixtureDivergence } from '../../src/web/fixtures/client.ts'
import {
  acceptancePayload,
  detectLocale,
  divergenceCheckboxLabel,
  divergenceLines,
  divergenceWhy,
  transferConfirmDisabled,
  waitLabel,
  withdrawAnywayLabel,
} from '../../src/web/lib/price-divergence.ts'

const warning: PriceDivergenceWarning = {
  code: 'PRICE_DIVERGENCE',
  legs: [{ token: 'USDC', decimals: 6, fairAmount: '1000000', quotedAmount: '975000', shortfall: '25000', shortfallBps: 250 }],
  shortfallUsdc: '25000',
  quoteId: 'qd_1',
}

describe('price divergence: copy, numbers, no DeFi jargon', () => {
  test('en: one plain sentence per leg with the numbers, no TWAP anywhere', () => {
    const lines = divergenceLines('en', warning)
    expect(lines).toEqual(['You would receive about 0.97 USDC instead of about 1 USDC — 0.02 USDC less (2.50%).'])
    expect(lines.join(' ') + divergenceWhy('en')).not.toMatch(/TWAP/i)
    expect(divergenceWhy('en')).toContain('fair price over the last 30 minutes')
  })
  test('es and ja ship their own strings, same numbers, still no TWAP', () => {
    for (const locale of ['es', 'ja'] as const) {
      const lines = divergenceLines(locale, warning)
      expect(lines[0]).toContain('0.97')
      expect(lines[0]).toContain('1')
      expect(lines[0]).toContain('2.50%')
      expect(lines.join(' ')).not.toMatch(/TWAP/i)
    }
    expect(waitLabel('es')).toBe('Esperar')
    expect(withdrawAnywayLabel('ja')).toBe('このまま引き出す')
  })
  test('checkbox label carries the USDC shortfall', () => {
    expect(divergenceCheckboxLabel('en', warning)).toBe('I understand I will receive about $0.02 less.')
  })
  test('no exclamation marks anywhere in the copy, in any locale', () => {
    for (const locale of ['en', 'es', 'ja'] as const) {
      const text = [...divergenceLines(locale, warning), divergenceWhy(locale), divergenceCheckboxLabel(locale, warning), waitLabel(locale), withdrawAnywayLabel(locale)].join(' ')
      expect(text).not.toContain('!')
    }
  })
  test('detectLocale: browser language to a shipped locale, else English', () => {
    expect(detectLocale('es-ES')).toBe('es')
    expect(detectLocale('ja-JP')).toBe('ja')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale('fr-FR')).toBe('en')
    expect(detectLocale(undefined)).toBe('en')
  })
})

describe('price divergence: confirm gating never auto-accepts', () => {
  test('no warning: never gated, whatever was ticked', () => {
    expect(transferConfirmDisabled(null, undefined, null)).toBe(false)
    expect(transferConfirmDisabled(null, undefined, 'anything')).toBe(false)
  })
  test('a warning with nothing ticked: disabled', () => {
    expect(transferConfirmDisabled(null, warning, null)).toBe(true)
  })
  test('ticked for this exact quoteId: enabled, unless busy', () => {
    expect(transferConfirmDisabled(null, warning, warning.quoteId)).toBe(false)
    expect(transferConfirmDisabled('signing', warning, warning.quoteId)).toBe(true)
  })
  test('stale: ticked for an old quoteId, a fresh warning carries a new one -> re-disabled, never auto-accepted', () => {
    const fresh: PriceDivergenceWarning = { ...warning, quoteId: 'qd_2', legs: [{ ...warning.legs[0]!, shortfallBps: 410 }] }
    expect(transferConfirmDisabled(null, fresh, warning.quoteId)).toBe(true)
    expect(divergenceLines('en', fresh)[0]).toContain('4.10%')
  })
})

describe('price divergence: submit carries the acceptance, and only the matching one', () => {
  test('ticked for this quoteId: the exact acceptDivergence payload', () => {
    expect(acceptancePayload(warning, warning.quoteId)).toEqual({ acceptDivergence: { quoteId: 'qd_1' } })
  })
  test('nothing ticked, no warning, or ticked for a different (stale) quoteId: no field added at all', () => {
    expect(acceptancePayload(warning, null)).toEqual({})
    expect(acceptancePayload(undefined, null)).toEqual({})
    expect(acceptancePayload(warning, 'qd_old')).toEqual({})
  })
})

describe('price divergence: fixture wiring (backward compatible when the operator sends nothing)', () => {
  test('?divergence off (default): prepare carries no divergence field at all, exactly like before this ticket', async () => {
    const plan = await fixtureClient.transferPrepare('k', { to: `0x${'1'.repeat(40)}`, amountUsdc: '10000000' })
    expect(plan.divergence).toBeUndefined()
  })
  test('fixtureDivergence: one leg, fair minus quoted equals the stated shortfall', () => {
    const d = fixtureDivergence(10_000_000n)
    expect(d.code).toBe('PRICE_DIVERGENCE')
    const leg = d.legs[0]!
    expect(BigInt(leg.fairAmount) - BigInt(leg.quotedAmount)).toBe(BigInt(leg.shortfall))
    expect(d.shortfallUsdc).toBe(leg.shortfall)
  })
})
