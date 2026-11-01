import { describe, expect, test } from 'bun:test'
import { REFRESH_BURST, REFRESH_FRESH_MS, REFRESH_GAP_MS, REFRESH_WINDOW_MS, refreshVerdict } from '../../src/web/lib/refresh-throttle.ts'

const T = 1_000_000_000

describe('refreshVerdict (#255)', () => {
  test('first refresh, an old reading: goes through', () => {
    expect(refreshVerdict(T, [], T - 30_000)).toEqual({ ok: true })
  })

  test('the last reading is younger than REFRESH_FRESH_MS: refused as fresh, no request', () => {
    expect(refreshVerdict(T, [], T - REFRESH_FRESH_MS + 1)).toEqual({ ok: false, reason: 'fresh' })
  })

  test('within REFRESH_GAP_MS of the last manual one: refused', () => {
    expect(refreshVerdict(T, [T - REFRESH_GAP_MS + 1], T - 30_000)).toEqual({ ok: false, reason: 'cooldown' })
    expect(refreshVerdict(T, [T - REFRESH_GAP_MS], T - 30_000)).toEqual({ ok: true })
  })

  test('REFRESH_BURST in the window: refused until the oldest leaves it', () => {
    const past = Array.from({ length: REFRESH_BURST }, (_, i) => T - REFRESH_WINDOW_MS + 1 + i * REFRESH_GAP_MS)
    const now = past[past.length - 1]! + REFRESH_GAP_MS
    expect(refreshVerdict(now, past, 0)).toEqual({ ok: false, reason: 'cooldown' })
    expect(refreshVerdict(past[0]! + REFRESH_WINDOW_MS, past, 0)).toEqual({ ok: true })
  })

  test('no reading yet (0): only the manual history counts', () => {
    expect(refreshVerdict(T, [], 0)).toEqual({ ok: true })
  })
})
