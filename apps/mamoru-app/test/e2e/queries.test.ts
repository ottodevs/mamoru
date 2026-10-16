import { describe, expect, test } from 'bun:test'
import type { FundingView } from '@mamoru/domain'
import { QueryClient } from '@tanstack/react-query'
import { fetchFreshFunding, fundingInterval, queryKeys } from '../../src/web/api/queries.ts'
import { fixtureFunding } from '../../src/web/fixtures/client.ts'

// otto/mamoru#135: a home tab polled funding every 6 s regardless of what was happening, 24/7. The cadence is
// 30 s by default now, 4 s only while something of the account's own is in flight.
describe('fundingInterval', () => {
  test('nothing in flight and no data yet: the slow interval', () => {
    expect(fundingInterval(undefined, false, 30_000)).toBe(30_000)
  })

  test('nothing in flight, the engine idle: still the slow interval', () => {
    expect(fundingInterval({ progress: null, engine: { placing: false, nextReviewAt: null } }, false, 30_000)).toBe(30_000)
  })

  test('the caller says an owner op is in flight: the fast interval, even with no data', () => {
    expect(fundingInterval(undefined, true, 30_000)).toBe(4_000)
  })

  test('the engine reports progress on its own: the fast interval, with nothing in flight', () => {
    expect(fundingInterval({ progress: { step: 'opening', since: 'now' }, engine: null }, false, 30_000)).toBe(4_000)
  })

  test('the engine is placing between steps, no progress line yet: still the fast interval', () => {
    expect(fundingInterval({ progress: null, engine: { placing: true, nextReviewAt: null } }, false, 30_000)).toBe(4_000)
  })

  test('the fast interval never exceeds the slow one (add-money passes a 4 s intervalMs outright)', () => {
    expect(fundingInterval(undefined, true, 4_000)).toBe(4_000)
    expect(fundingInterval(undefined, false, 4_000)).toBe(4_000)
  })

  test('a custom fastMs is honored and still capped by intervalMs', () => {
    expect(fundingInterval(undefined, true, 30_000, 10_000)).toBe(10_000)
    expect(fundingInterval(undefined, true, 8_000, 10_000)).toBe(8_000)
  })
})

// otto/mamoru#135: a dialog's fresh=1 read must win the query cache against a plain poll already in flight,
// and never race another read of the same account.
describe('fetchFreshFunding', () => {
  const fresh: FundingView = { ...fixtureFunding, usdc: '9000000' }
  const stale: FundingView = { ...fixtureFunding, usdc: '1000000' }

  test('a background poll already in flight is cancelled: its answer, even settling after, never overwrites the fresh write', async () => {
    const qc = new QueryClient()
    const key = queryKeys.funding('k')
    let releaseOldPoll!: (v: FundingView) => void
    // The 30 s poll is already in flight (e.g. its refetchInterval fired) when the dialog opens. react-query's
    // own useQuery absorbs the CancelledError its cancellation below raises; fetchQuery's raw promise does not,
    // so the test catches it itself instead of leaving an unhandled rejection.
    void qc.fetchQuery<FundingView>({ queryKey: key, queryFn: () => new Promise<FundingView>((r) => (releaseOldPoll = r)) }).catch(() => undefined)
    expect(await fetchFreshFunding(qc, { funding: async () => fresh }, 'k')).toEqual(fresh)
    expect(qc.getQueryData<FundingView>(key)).toEqual(fresh)
    // The old poll finally answers, after the fresh write: cancelled, so it must not win.
    releaseOldPoll(stale)
    await new Promise((r) => setTimeout(r, 0))
    expect(qc.getQueryData<FundingView>(key)).toEqual(fresh)
  })

  // Review finding 6: one fetch per account at a time. A poll tick while the fresh read is in flight joins it.
  test('a poll that starts while the fresh read is in flight joins it instead of reading on its own', async () => {
    const qc = new QueryClient()
    const key = queryKeys.funding('k')
    let resolveFresh!: (v: FundingView) => void
    let freshCalls = 0
    const call = fetchFreshFunding(qc, { funding: () => (freshCalls++, new Promise<FundingView>((r) => (resolveFresh = r))) }, 'k')
    await new Promise((r) => setTimeout(r, 0))
    let pollCalls = 0
    const poll = qc.fetchQuery<FundingView>({ queryKey: key, queryFn: async () => (pollCalls++, stale) })
    resolveFresh(fresh)
    expect(await call).toEqual(fresh)
    expect(await poll).toEqual(fresh)
    expect(pollCalls).toBe(0)
    expect(freshCalls).toBe(1)
    expect(qc.getQueryData<FundingView>(key)).toEqual(fresh)
  })

  test('two fresh reads overlapping: the later one wins even when the earlier answers last', async () => {
    const qc = new QueryClient()
    const key = queryKeys.funding('k')
    const resolvers: ((v: FundingView) => void)[] = []
    const api = { funding: () => new Promise<FundingView>((r) => resolvers.push(r)) }
    const first = fetchFreshFunding(qc, api, 'k')
    await new Promise((r) => setTimeout(r, 0))
    const second = fetchFreshFunding(qc, api, 'k')
    await new Promise((r) => setTimeout(r, 0))
    resolvers[1]!(fresh)
    expect(await second).toEqual(fresh)
    resolvers[0]!(stale)
    expect(await first).toBeUndefined()
    await new Promise((r) => setTimeout(r, 0))
    expect(qc.getQueryData<FundingView>(key)).toEqual(fresh)
  })

  test('a failed fresh read resolves to undefined instead of an unhandled rejection, and leaves the cache as it was', async () => {
    const qc = new QueryClient()
    const key = queryKeys.funding('k')
    qc.setQueryData(key, stale)
    const result = await fetchFreshFunding(qc, { funding: async () => Promise.reject(new Error('offline')) }, 'k')
    expect(result).toBeUndefined()
    expect(qc.getQueryData<FundingView>(key)).toEqual(stale)
  })
})
