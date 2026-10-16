// Review finding (otto/mamoru#135 Codex gpt-6-sol, post-merge): a tick that reaches a decision stored
// runner.waiting/reviewedAt — both of which /funding reports (engineView) — without invalidating the funding
// cache, so a fresh decision (the engine having just observed a deposit, say) could be paired with a balance
// /funding still answers from before it. sameWaiting is the pure comparison startLoop's tick now calls to
// decide whether that decision actually changed anything, so it does not invalidate on every tick a repeated
// wait holds through (that would undo the cache's point).
import { describe, expect, test } from 'bun:test'
import { sameWaiting } from '../src/operator.ts'

const w = (bucket: string, amountUsdc: string, pool: string | null = 'p', code = 'POOL_DEPTH') => ({ bucket, pool, code, amountUsdc })

describe('sameWaiting', () => {
  test('both empty (absent or []): same', () => {
    expect(sameWaiting(undefined, undefined)).toBe(true)
    expect(sameWaiting([], undefined)).toBe(true)
    expect(sameWaiting(undefined, [])).toBe(true)
  })

  test('a new wait where there was none: different', () => {
    expect(sameWaiting(undefined, [w('b1', '10')])).toBe(false)
  })

  test('a wait cleared: different', () => {
    expect(sameWaiting([w('b1', '10')], [])).toBe(false)
  })

  test('identical lists: same', () => {
    expect(sameWaiting([w('b1', '10')], [w('b1', '10')])).toBe(true)
  })

  test('same bucket, amount moved (the deposit this review just observed): different', () => {
    expect(sameWaiting([w('b1', '10')], [w('b1', '11')])).toBe(false)
  })

  test('same bucket and amount, different reason code: different', () => {
    expect(sameWaiting([w('b1', '10', 'p', 'POOL_DEPTH')], [w('b1', '10', 'p', 'MIN_SIZE')])).toBe(false)
  })

  test('same bucket and amount, resolved to a different pool: different', () => {
    expect(sameWaiting([w('b1', '10', 'p1')], [w('b1', '10', 'p2')])).toBe(false)
  })

  test('a second bucket started waiting too: different (length differs)', () => {
    expect(sameWaiting([w('b1', '10')], [w('b1', '10'), w('b2', '5')])).toBe(false)
  })

  test('same buckets, different order: different (order is part of what the UI shows)', () => {
    expect(sameWaiting([w('b1', '10'), w('b2', '5')], [w('b2', '5'), w('b1', '10')])).toBe(false)
  })
})
