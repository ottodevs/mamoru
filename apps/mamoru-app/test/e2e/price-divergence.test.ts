import { describe, expect, test } from 'bun:test'
import type { PriceDivergenceLeg, PriceDivergenceWarning } from '@mamoru/domain'
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
import { recoverFromStaleDivergence } from '../../src/web/lib/owner-flow.ts'

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

const both: PriceDivergenceWarning = {
  code: 'PRICE_DIVERGENCE',
  legs: [...swapBack.legs, ...payout.legs],
  shortfallUsdc: '37000',
  quoteId: 'qd_3',
}

describe('price divergence: worst-case numbers, phrased by what the leg is', () => {
  test('swap-back: the account keeps the loss, not the recipient; "at least" is the signed minimum, not the quote', () => {
    const lines = divergenceLines('en', swapBack)
    // shortfall 25000 = 0.025 USDC exactly: ceiled up to the next cent (2.50% -> "0.03", never "0.02", see the
    // dedicated rounding-direction describe block below for the reviewer's exact 0.025 -> 0.03 case).
    expect(lines).toEqual(['Your account would get at least 0.975 USDC instead of about 1 USDC from selling cbBTC. That is 0.03 USDC less (2.50%).'])
    // minAmount (975000), not quotedAmount (985000), drives both the headline and the shortfall math.
    expect(lines[0]).not.toContain('0.985')
    expect(lines.join(' ') + divergenceWhy('en')).not.toMatch(/TWAP/i)
  })
  test('payout: the recipient gets less, the sentence says so directly', () => {
    const lines = divergenceLines('en', payout)
    // shortfall 12000 = 0.012 EURC exactly: ceiled up to "0.02", never truncated down to "0.01".
    expect(lines).toEqual(['The recipient would receive at least 0.909 EURC instead of about 0.921 EURC. That is 0.02 EURC less (1.30%).'])
    expect(lines[0]).toStartWith('The recipient')
  })
  test('both legs in one withdrawal: one sentence per leg, each in its own voice', () => {
    const lines = divergenceLines('en', both)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('Your account')
    expect(lines[1]).toContain('The recipient')
  })
  test('es and ja ship their own strings, same worst-case numbers, still no TWAP', () => {
    for (const locale of ['es', 'ja'] as const) {
      const lines = divergenceLines(locale, swapBack)
      expect(lines[0]).toContain('0.975')
      expect(lines[0]).toContain('cbBTC')
      expect(lines.join(' ')).not.toMatch(/TWAP/i)
    }
    expect(waitLabel('es')).toBe('Esperar')
    expect(withdrawAnywayLabel('ja')).toBe('このまま引き出す')
  })
  test('detectLocale: browser language to a shipped locale, else English', () => {
    expect(detectLocale('es-ES')).toBe('es')
    expect(detectLocale('ja-JP')).toBe('ja')
    expect(detectLocale('en-US')).toBe('en')
    expect(detectLocale('fr-FR')).toBe('en')
    expect(detectLocale(undefined)).toBe('en')
  })
})

describe('price divergence: checkbox repeats the same loss, same unit, right voice, never USD', () => {
  test('swap-back checkbox: "your account", same (ceiled) number and token as the sentence', () => {
    expect(divergenceCheckboxLabel('en', swapBack)).toBe('I understand your account will get about 0.03 USDC less.')
  })
  test('payout checkbox: "the recipient"', () => {
    expect(divergenceCheckboxLabel('en', payout)).toBe('I understand the recipient will get about 0.02 EURC less.')
  })
  test('both legs: joined, one clause per leg, each its own unit', () => {
    expect(divergenceCheckboxLabel('en', both)).toBe('I understand your account will get about 0.03 USDC less and the recipient will get about 0.02 EURC less.')
  })
  test('no $ / USD figure anywhere in the checkbox: the token is the unit, not shortfallUsdc', () => {
    for (const w of [swapBack, payout, both]) {
      for (const locale of ['en', 'es', 'ja'] as const) {
        expect(divergenceCheckboxLabel(locale, w)).not.toContain('$')
      }
    }
  })
})

describe('price divergence: the shortfall rounds UP, never down, never understating the loss', () => {
  test("gpt-6-sol's exact cases: 0.025 USDC -> 0.03, 0.012 EURC -> 0.02 (never truncated to 0.02 / 0.01)", () => {
    expect(divergenceLines('en', swapBack)[0]).toContain('0.03 USDC less')
    expect(divergenceLines('en', payout)[0]).toContain('0.02 EURC less')
  })
  test('an exact value at the display precision is left unchanged by ceiling (there is no remainder to round away)', () => {
    const exact: PriceDivergenceWarning = { ...swapBack, legs: [{ ...swapBack.legs[0]!, shortfall: '20000' }] } // 0.02 USDC exactly
    expect(divergenceLines('en', exact)[0]).toContain('0.02 USDC less')
  })
  test('received amounts ("at least", "instead of about") still round DOWN: 0.999999999999999999 ETH never reads as 1', () => {
    const leg: PriceDivergenceWarning = {
      code: 'PRICE_DIVERGENCE',
      legs: [{ kind: 'payout', token: 'ETH', decimals: 18, fairAmount: '1000000000000000000', quotedAmount: '999999999999999999', minAmount: '999999999999999999', shortfall: '1', shortfallBps: 0 }],
      shortfallUsdc: '1',
      quoteId: 'q',
    }
    const line = divergenceLines('en', leg)[0]!
    expect(line).toContain('at least 0.999999 ETH')
    expect(line).not.toContain('1 ETH instead')
    expect(line).not.toContain('at least 1 ETH')
  })
})

describe('price divergence: precision never flattens a positive shortfall to zero, and never ceils dust into a false headline', () => {
  test('a shortfall too fine to be exact within 4 decimals reads as "less than", not zero and not 18 raw places', () => {
    const tinyEth: PriceDivergenceWarning = {
      code: 'PRICE_DIVERGENCE',
      legs: [{ kind: 'payout', token: 'ETH', decimals: 18, fairAmount: '1000000000000000', quotedAmount: '999999999999963', minAmount: '999999999999963', shortfall: '37', shortfallBps: 1 }],
      shortfallUsdc: '1',
      quoteId: 'q',
    }
    const line = divergenceLines('en', tinyEth)[0]!
    expect(line).toContain('< 0.0001 ETH less')
    expect(line).not.toContain('0.00 ETH less')
    expect(line).not.toContain('0 ETH less')
    // not ceiled all the way up to the coarse 2-decimal bucket either (that would overstate 37 wei by many
    // orders of magnitude): "< 0.0001" stays honest about how small the loss actually is.
    expect(line).not.toContain('0.01 ETH less')
  })
  test('a shortfall exact within 4 decimals shows that exact figure, not a coarse 2-decimal ceiling', () => {
    const smallEth: PriceDivergenceWarning = {
      code: 'PRICE_DIVERGENCE',
      legs: [{ kind: 'payout', token: 'ETH', decimals: 18, fairAmount: '1000000000000000', quotedAmount: '998100000000000', minAmount: '998100000000000', shortfall: '1900000000000000', shortfallBps: 19 }],
      shortfallUsdc: '1',
      quoteId: 'q',
    }
    expect(divergenceLines('en', smallEth)[0]).toContain('0.0019 ETH less')
  })
  test('a whole-unit token (0 decimals, e.g. JPY) never shows a fraction, and ceiling an already-whole amount is a no-op', () => {
    const jpy: PriceDivergenceWarning = {
      code: 'PRICE_DIVERGENCE',
      legs: [{ kind: 'payout', token: 'JPY', decimals: 0, fairAmount: '1616', quotedAmount: '1608', minAmount: '1608', shortfall: '8', shortfallBps: 495 }],
      shortfallUsdc: '1',
      quoteId: 'q',
    }
    expect(divergenceLines('en', jpy)[0]).toContain('8 JPY less')
  })
})

/** A leg whose only job is to carry one shortfall (and a safely positive fair/quoted/min) through the formatter. */
function shortfallLeg(decimals: number, shortfall: string): PriceDivergenceLeg {
  const buffer = 10n ** BigInt(decimals + 2) // comfortably larger than any shortfall this file exercises
  const min = buffer
  const fair = BigInt(shortfall) + buffer
  return { kind: 'payout', token: 'TOK', decimals, fairAmount: String(fair), quotedAmount: String(min), minAmount: String(min), shortfall, shortfallBps: 1 }
}
const shortfallLine = (decimals: number, shortfall: string): string =>
  divergenceLines('en', { code: 'PRICE_DIVERGENCE', legs: [shortfallLeg(decimals, shortfall)], shortfallUsdc: shortfall, quoteId: 'q' })[0]!

/** Base-10 decimal string (plain or "< X") back to base units, exactly — for asserting against the true raw value. */
function toBaseUnits(displayed: string, decimals: number): bigint {
  const numeric = displayed.startsWith('< ') ? displayed.slice(2) : displayed
  const [whole, frac = ''] = numeric.replace(/,/g, '').split('.')
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac.padEnd(decimals, '0') || '0').slice(0, decimals) || '0')
}

describe('price divergence: a "less than" figure is used only when the true loss is strictly below it, never as a disguised ceiling', () => {
  test("gpt-6-sol pass-3 NO-GO's exact cases, on an 8-decimal token so each is an exact base-unit amount", () => {
    // 0.00012345: not exact at 4dp (fineCap), but NOT below the smallest 4dp unit (0.0001) either -> must ceil
    // there, not say "< 0.0001" (which would itself understate a loss that has already passed 0.0001).
    expect(shortfallLine(8, '12345')).toContain('0.0002 TOK less')
    // 0.00009: genuinely below the smallest 4dp unit -> "less than" is true here.
    expect(shortfallLine(8, '9000')).toContain('< 0.0001 TOK less')
    // 0.0001 exactly: no rounding needed at all, shown as-is.
    expect(shortfallLine(8, '10000')).toContain('0.0001 TOK less')
  })
  test('property-style: across a spread of raw shortfalls and token decimals, the displayed loss is never below the true one, and "<" only appears when the true loss is strictly below the stated threshold', () => {
    for (const decimals of [0, 2, 6, 8, 18]) {
      // A spread from 1 base unit up to a few whole units, scaled so every `decimals` gets dust-sized, cent-sized
      // and whole-unit-sized raw amounts in the same sweep.
      const top = 10n ** BigInt(decimals + 1)
      const step = top / 300n + 1n
      for (let raw = 1n; raw <= top; raw += step) {
        const displayed = shortfallLine(decimals, raw.toString())
        if (displayed.includes('< ')) {
          const match = displayed.match(/< ([\d.,]+) TOK less/)
          expect(match).not.toBeNull()
          const threshold = toBaseUnits(`< ${match![1]}`, decimals)
          expect(raw < threshold).toBe(true) // "less than" must be literally true
        } else {
          const match = displayed.match(/That is ([\d.,]+) TOK less/)
          expect(match).not.toBeNull()
          const shown = toBaseUnits(match![1]!, decimals)
          expect(shown >= raw).toBe(true) // never understated
        }
      }
    }
  })
})

describe('price divergence: no em dash anywhere, in any locale', () => {
  test('sentences, why, checkbox, and the two button labels', () => {
    for (const locale of ['en', 'es', 'ja'] as const) {
      const text = [...divergenceLines(locale, both), divergenceWhy(locale), divergenceCheckboxLabel(locale, both), waitLabel(locale), withdrawAnywayLabel(locale)].join(' ')
      expect(text).not.toContain('—')
      expect(text).not.toContain('!')
    }
  })
})

describe('price divergence: confirm gating is keyed to the warning object, never just its quoteId', () => {
  test('no warning: never gated, whatever was ticked', () => {
    expect(transferConfirmDisabled(null, undefined, null)).toBe(false)
  })
  test('a warning with nothing ticked: disabled', () => {
    expect(transferConfirmDisabled(null, swapBack, null)).toBe(true)
  })
  test('ticked for this exact object: enabled, unless busy', () => {
    expect(transferConfirmDisabled(null, swapBack, swapBack)).toBe(false)
    expect(transferConfirmDisabled('signing', swapBack, swapBack)).toBe(true)
  })
  test('a DIFFERENT warning object that happens to carry the SAME quoteId string: still disabled', () => {
    const reusedQuoteId: PriceDivergenceWarning = { ...swapBack, legs: [{ ...swapBack.legs[0]!, shortfallBps: 999 }] } // same quoteId as swapBack, different instance and numbers
    expect(reusedQuoteId.quoteId).toBe(swapBack.quoteId)
    expect(transferConfirmDisabled(null, reusedQuoteId, swapBack)).toBe(true)
  })
  test('a fresh (stale-rewarned) warning with a different quoteId: re-disabled too', () => {
    const fresh: PriceDivergenceWarning = { ...swapBack, quoteId: 'qd_new' }
    expect(transferConfirmDisabled(null, fresh, swapBack)).toBe(true)
  })
})

describe('price divergence: submit carries the acceptance, only for the exact accepted object', () => {
  test('ticked for this object: the exact acceptDivergence payload, using its quoteId', () => {
    expect(acceptancePayload(swapBack, swapBack)).toEqual({ acceptDivergence: { quoteId: 'qd_1' } })
  })
  test('nothing ticked, no warning, or a different object (even with the same quoteId string): no field added', () => {
    expect(acceptancePayload(swapBack, null)).toEqual({})
    expect(acceptancePayload(undefined, null)).toEqual({})
    const reusedQuoteId: PriceDivergenceWarning = { ...swapBack, legs: [...swapBack.legs] }
    expect(acceptancePayload(reusedQuoteId, swapBack)).toEqual({})
  })
})

describe('price divergence: a stale acceptance clears first, and a failed re-prepare leaves nothing submittable', () => {
  test('clears the prepared plan before the re-prepare resolves, then holds the fresh one on success', async () => {
    const calls: Array<'cleared' | 'set'> = []
    const state: { prepared: unknown; errored: string | null } = { prepared: { marker: 'old' }, errored: null }
    const setPrepared = (p: unknown) => {
      calls.push(p === null ? 'cleared' : 'set')
      state.prepared = p
    }
    const setError = (e: string | null) => {
      state.errored = e
    }
    const fakeTransferPrepare = async () => ({
      ownerTx: { safe: '0x0', chainId: 8453, safeTxHash: '0x0', summary: [], expiresAt: new Date(Date.now() + 60_000).toISOString(), prepareId: 'p2' },
      reduce: [],
      divergence: swapBack,
    })
    await recoverFromStaleDivergence('acct', { to: '0x1', amountUsdc: '1000000' }, fakeTransferPrepare as never, setPrepared, setError)
    // cleared first (nothing submittable while in flight), THEN set to the fresh plan.
    expect(calls).toEqual(['cleared', 'set'])
    expect((state.prepared as { divergence: unknown } | null)?.divergence).toBe(swapBack)
    expect(state.errored).toBeNull()
  })
  test('a failed re-prepare leaves prepared cleared, not reverted to the stale plan', async () => {
    const sets: unknown[] = []
    const state: { errored: string | null } = { errored: null }
    const setPrepared = (p: unknown) => sets.push(p)
    const setError = (e: string | null) => {
      state.errored = e
    }
    const fakeTransferPrepare = async () => {
      throw new Error('network down')
    }
    await recoverFromStaleDivergence('acct', { to: '0x1', amountUsdc: '1000000' }, fakeTransferPrepare as never, setPrepared, setError)
    // only ever called with null: cleared, and never set back to anything submittable.
    expect(sets).toEqual([null])
    expect(state.errored).toBe('network down')
  })
})

describe('price divergence: fixture wiring (backward compatible when the operator sends nothing)', () => {
  test('?divergence off (default): prepare carries no divergence field at all, exactly like before this ticket', async () => {
    const plan = await fixtureClient.transferPrepare('k', { to: `0x${'1'.repeat(40)}`, amountUsdc: '10000000' })
    expect(plan.divergence).toBeUndefined()
  })
  test('fixtureDivergence: swap-back leg, minAmount (worst case) drives the shortfall, a fresh quoteId every call', () => {
    const d1 = fixtureDivergence(10_000_000n)
    const d2 = fixtureDivergence(10_000_000n)
    expect(d1.legs[0]!.kind).toBe('swap-back')
    expect(d1.legs[0]!.sellToken).toBe('cbBTC')
    const leg = d1.legs[0]!
    expect(BigInt(leg.fairAmount) - BigInt(leg.minAmount)).toBe(BigInt(leg.shortfall))
    expect(d1.shortfallUsdc).toBe(leg.shortfall)
    expect(d1.quoteId).not.toBe(d2.quoteId)
  })
})
