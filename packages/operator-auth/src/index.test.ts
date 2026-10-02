import { afterEach, describe, expect, test } from 'bun:test'
import { metricsSignature, timingSafeEqualHex, verifyMetricsSignature } from './index.ts'

const SECRET = 'test-secret'

describe('verifyMetricsSignature', () => {
  test('accepts a signature made for the current minute', async () => {
    const now = Date.parse('2026-10-02T09:15:30.000Z')
    const minute = Math.floor(now / 60_000)
    const sig = await metricsSignature(SECRET, 'GET', '/metrics', minute)
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', sig, now)).toBe(true)
  })

  test('accepts a signature made for the previous minute (clock skew)', async () => {
    const now = Date.parse('2026-10-02T09:15:00.000Z')
    const minute = Math.floor(now / 60_000)
    const sig = await metricsSignature(SECRET, 'GET', '/metrics', minute - 1)
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', sig, now)).toBe(true)
  })

  test('rejects a signature older than the previous minute (stale)', async () => {
    const now = Date.parse('2026-10-02T09:15:00.000Z')
    const minute = Math.floor(now / 60_000)
    const sig = await metricsSignature(SECRET, 'GET', '/metrics', minute - 2)
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', sig, now)).toBe(false)
  })

  test('rejects a bad signature', async () => {
    const now = Date.now()
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', 'not-a-real-signature', now)).toBe(false)
  })

  test('rejects a missing signature', async () => {
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', null)).toBe(false)
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', undefined)).toBe(false)
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', '')).toBe(false)
  })

  test('rejects a signature for a different path', async () => {
    const now = Date.now()
    const minute = Math.floor(now / 60_000)
    const sig = await metricsSignature(SECRET, 'GET', '/health', minute)
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', sig, now)).toBe(false)
  })

  test('rejects a signature made with a different secret', async () => {
    const now = Date.now()
    const minute = Math.floor(now / 60_000)
    const sig = await metricsSignature('other-secret', 'GET', '/metrics', minute)
    expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', sig, now)).toBe(false)
  })
})

const HEX_A = 'ab'.repeat(32)
const HEX_B_DIFFERENT = `${'ab'.repeat(31)}cd`
const HEX_SHORT = 'ab'.repeat(16)

describe('timingSafeEqualHex', () => {
  describe('the fast path (Bun/Node global crypto.timingSafeEqual)', () => {
    test('equal hex strings compare true, different ones compare false', async () => {
      expect(typeof crypto.timingSafeEqual).toBe('function') // sanity: this suite is actually exercising the fast path
      expect(await timingSafeEqualHex(HEX_A, HEX_A)).toBe(true)
      expect(await timingSafeEqualHex(HEX_A, HEX_B_DIFFERENT)).toBe(false)
    })

    test('different lengths compare false without throwing', async () => {
      expect(await timingSafeEqualHex(HEX_A, HEX_SHORT)).toBe(false)
    })

    test('invalid hex compares false without throwing', async () => {
      expect(await timingSafeEqualHex(HEX_A, 'not-hex-at-all')).toBe(false)
      expect(await timingSafeEqualHex('', '')).toBe(false)
    })
  })

  describe('the fallback path (double-HMAC, neither crypto.timingSafeEqual nor crypto.subtle.timingSafeEqual present)', () => {
    const originalBare = crypto.timingSafeEqual
    afterEach(() => {
      ;(crypto as any).timingSafeEqual = originalBare
    })

    test('equal hex strings still compare true, different ones still compare false, with both fast-path extensions hidden', async () => {
      ;(crypto as any).timingSafeEqual = undefined
      expect((crypto.subtle as { timingSafeEqual?: unknown }).timingSafeEqual).toBeUndefined() // Bun does not have this one at all; confirms the fallback is genuinely exercised
      expect(await timingSafeEqualHex(HEX_A, HEX_A)).toBe(true)
      expect(await timingSafeEqualHex(HEX_A, HEX_B_DIFFERENT)).toBe(false)
    })

    test('different lengths still compare false in the fallback path', async () => {
      ;(crypto as any).timingSafeEqual = undefined
      expect(await timingSafeEqualHex(HEX_A, HEX_SHORT)).toBe(false)
    })

    test('verifyMetricsSignature still works end to end through the fallback path', async () => {
      ;(crypto as any).timingSafeEqual = undefined
      const now = Date.now()
      const minute = Math.floor(now / 60_000)
      const sig = await metricsSignature(SECRET, 'GET', '/metrics', minute)
      expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', sig, now)).toBe(true)
      expect(await verifyMetricsSignature(SECRET, 'GET', '/metrics', 'deadbeef', now)).toBe(false)
    })
  })
})
