import { describe, expect, test } from 'bun:test'
import { FundingCache, fundingCacheKey, isAccountKey } from '../src/funding-cache.ts'

/** A cache on a clock the test moves by hand. */
function cache(retainMs = 60_000) {
  const clock = { t: 0 }
  return { c: new FundingCache<number>(() => clock.t, retainMs), clock }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
function deferred() {
  const resolvers: ((v: number) => void)[] = []
  let calls = 0
  const fetch = () =>
    new Promise<number>((r) => {
      calls++
      resolvers.push(r)
    })
  return { fetch, resolvers, calls: () => calls }
}

// otto/mamoru#135: one readSafe answer shared by every open tab and poll of the same account + Safe, instead
// of each GET /funding paying for its own.
describe('FundingCache', () => {
  test('served while younger than the maxAge the caller asks for, read again once it is not', async () => {
    const { c, clock } = cache()
    let calls = 0
    const fetch = async () => ++calls
    expect(await c.get('a', 15_000, fetch)).toBe(1)
    clock.t = 14_999
    expect(await c.get('a', 15_000, fetch)).toBe(1)
    // The same entry is too old for a caller asking for a fresher read (fresh=1: 2 s).
    expect(await c.get('a', 2_000, fetch)).toBe(2)
    clock.t = 14_999 + 15_000
    expect(await c.get('a', 15_000, fetch)).toBe(3)
    // Over budget the operator asks for up to 60 s.
    clock.t += 59_999
    expect(await c.get('a', 60_000, fetch)).toBe(3)
  })

  // Review finding 5: an entry is stamped when its fetch completes, not when the caller came in.
  test('an entry is stamped at completion: a slow fetch is not born already old', async () => {
    const { c, clock } = cache()
    const d = deferred()
    const first = c.get('a', 2_000, d.fetch)
    clock.t = 5_000 // the read took 5 s
    d.resolvers[0]!(1)
    expect(await first).toBe(1)
    clock.t = 6_999
    expect(await c.get('a', 2_000, async () => 9)).toBe(1)
  })

  test('a loop after an invalidation judges age on the clock now, not on when the caller first came in', async () => {
    const { c, clock } = cache()
    const d = deferred()
    const waiter = c.get('a', 2_000, d.fetch)
    c.invalidate('a')
    // Someone else's fresh read fills the key meanwhile, at t = 10 s.
    clock.t = 10_000
    const other = c.get('a', 2_000, d.fetch)
    d.resolvers[1]!(2)
    expect(await other).toBe(2)
    d.resolvers[0]!(1)
    // The waiter loops onto that entry: 0 s old now, though 10 s after the waiter itself arrived.
    expect(await waiter).toBe(2)
    expect(d.calls()).toBe(2)
  })

  test('invalidate drops only its own key: one account moving never holds another hostage', async () => {
    const { c } = cache()
    await c.get('a', 15_000, async () => 1)
    await c.get('b', 15_000, async () => 2)
    c.invalidate('a')
    expect(await c.get('a', 15_000, async () => 9)).toBe(9)
    expect(await c.get('b', 15_000, async () => 99)).toBe(2)
    expect(c.size).toBe(2)
  })

  test('invalidateWhere drops every key it accepts', async () => {
    const { c } = cache()
    await c.get(fundingCacheKey('k', '0x01'), 15_000, async () => 1)
    await c.get(fundingCacheKey('k', '0x02'), 15_000, async () => 2)
    await c.get(fundingCacheKey('k2', '0x01'), 15_000, async () => 3)
    c.invalidateWhere((key) => isAccountKey(key, 'k'))
    expect(c.size).toBe(1)
    expect(await c.get(fundingCacheKey('k2', '0x01'), 15_000, async () => 99)).toBe(3)
  })

  test('invalidating a key that was never read is a no-op', () => {
    const { c } = cache()
    expect(() => c.invalidate('never')).not.toThrow()
    expect(c.size).toBe(0)
  })

  test('concurrent misses for the same key share one fetch, whatever maxAge each asks for', async () => {
    const { c } = cache()
    const d = deferred()
    const a = c.get('k', 15_000, d.fetch)
    const b = c.get('k', 2_000, d.fetch)
    expect(d.calls()).toBe(1)
    d.resolvers[0]!(7)
    expect(await a).toBe(7)
    expect(await b).toBe(7)
    expect(c.size).toBe(1)
  })

  test('a fetch in flight when invalidate runs is not written back, and its waiter retries onto a fresh fetch', async () => {
    const { c } = cache()
    const d = deferred()
    const first = c.get('k', 15_000, d.fetch)
    c.invalidate('k')
    d.resolvers[0]!(1)
    await tick()
    expect(d.calls()).toBe(2)
    d.resolvers[1]!(2)
    expect(await first).toBe(2)
    expect(await c.get('k', 15_000, async () => 9)).toBe(2)
  })

  test('back-to-back invalidations: a waiter keeps retrying until one attempt holds its generation for its whole wait', async () => {
    const { c } = cache()
    const d = deferred()
    const first = c.get('k', 15_000, d.fetch)
    c.invalidate('k')
    d.resolvers[0]!(1)
    await tick()
    c.invalidate('k')
    d.resolvers[1]!(2)
    await tick()
    expect(d.calls()).toBe(3)
    d.resolvers[2]!(3)
    expect(await first).toBe(3)
    expect(await c.get('k', 15_000, async () => 9)).toBe(3)
  })

  test('a caller arriving after invalidate, before an old shared fetch settles, never joins that old fetch', async () => {
    const { c } = cache()
    let resolveOld!: (v: number) => void
    const a = c.get('k', 15_000, () => new Promise<number>((r) => (resolveOld = r)))
    const b = c.get('k', 15_000, async () => {
      throw new Error('b must not start its own fetch: a is still pending')
    })
    c.invalidate('k')
    let freshCalls = 0
    const fresh = c.get('k', 15_000, async () => (freshCalls++, 42))
    resolveOld(1)
    expect(await fresh).toBe(42)
    expect(await a).toBe(42)
    expect(await b).toBe(42)
    expect(freshCalls).toBe(1)
  })

  // Review finding 4: a failed read costs the next caller nothing: nothing is cached, nothing is held back.
  test('a failed fetch is not cached, and the very next caller (a fresh=1 retry, say) reads at once', async () => {
    const { c } = cache()
    await expect(c.get('k', 2_000, () => Promise.reject(new Error('rpc down')))).rejects.toThrow('rpc down')
    let calls = 0
    expect(await c.get('k', 2_000, async () => (calls++, 5))).toBe(5)
    expect(calls).toBe(1)
  })

  test('a fetch that throws synchronously is a rejection like any other, and leaves nothing pending', async () => {
    const { c } = cache()
    await expect(
      c.get('k', 2_000, () => {
        throw new Error('sync')
      }),
    ).rejects.toThrow('sync')
    expect(await c.get('k', 2_000, async () => 5)).toBe(5)
  })

  // Review finding 8: values do not pile up for accounts nobody polls any more.
  test('a value older than retainMs is dropped when another one is written', async () => {
    const { c, clock } = cache(60_000)
    await c.get('a', 15_000, async () => 1)
    clock.t = 60_000
    await c.get('b', 15_000, async () => 2)
    expect(c.size).toBe(1)
  })
})

describe('fundingCacheKey', () => {
  test('accountKey plus the Safe, case-insensitive on the address', () => {
    expect(fundingCacheKey('k', '0xABCdef0000000000000000000000000000000001')).toBe(fundingCacheKey('k', '0xabcdef0000000000000000000000000000000001'))
  })

  test('two accounts on the same Safe do not collide, and each key belongs to its own account only', () => {
    const safe = '0x0000000000000000000000000000000000000001'
    expect(fundingCacheKey('k1', safe)).not.toBe(fundingCacheKey('k2', safe))
    expect(isAccountKey(fundingCacheKey('k1', safe), 'k1')).toBe(true)
    expect(isAccountKey(fundingCacheKey('k1', safe), 'k')).toBe(false)
    expect(isAccountKey(fundingCacheKey('a:b', safe), 'a')).toBe(false)
  })
})
