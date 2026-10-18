import { describe, expect, test } from 'bun:test'
import { memoryD1 } from './d1.ts'
import { fetchOperatorMetrics, pullOperatorMetrics, toStoredMetrics, writeOperatorMetrics, type OperatorMetricsWire } from '../../src/api/operator-metrics.ts'
import type { OperatorFetch } from '../../src/api/yield-ledger.ts'

const SECRET = 'test-operator-secret'

function rawMetrics(over: Partial<OperatorMetricsWire> = {}): OperatorMetricsWire {
  return {
    generatedAt: '2026-10-18T09:00:00.000Z',
    operator: {
      uptimeSeconds: 123,
      gitSha: '5efba44',
      chainId: 8453,
      live: true,
      policyId: 'conservador-live-v2',
      relayer: { address: '0x1111111111111111111111111111111111111111', balanceWei: '812345678901234567', balanceCachedAgeMs: 12 },
      accounts: { known: 14, active: 9, armed: 1 },
      settings: null,
    },
    rpc: {
      cumulative: { 'base-mainnet.g.alchemy.com#1': { eth_call: { requests: 1820, errors: { rateCapacity: 3, invalidParams: 0, timeout: 1, other: 0 }, fallbacks: 2, getLogsChunks: 0, cuEstimate: 47320 } } },
      cuEstimateTotal: 1_452_300,
      last48h: [{ hourStart: '2026-10-17T10:00:00.000Z', data: {} }],
      logRanges: { 'base-mainnet.g.alchemy.com#1': { accepted: 10, no_witness: 0, hash_mismatch: 0, provider_error: 0 } },
      byComponent: { cumulative: { engine: { eth_call: { requests: 100, cuEstimate: 2600 } } }, last48h: [] },
      note: "cuEstimate is a static per-method estimate (see metrics.ts CU_TABLE), not Alchemy's billed figure",
    },
    engines: [{ account: '3f9a7c21', lastReviewAt: '2026-10-18T08:59:00.000Z', lastDecisionCode: 'DECIDE_HOLD', consecutiveErrors: 0, lastErrorClass: null, lastErrorAt: null, reviewsLastHour: 58, errorsLastHour: 0 }],
    opsRecent: [{ accountKey: '3f9a7c21', kind: 'enter', state: 'confirmed', at: '2026-10-18T08:58:00.000Z', code: null }],
    ...over,
  }
}

const okFetcher = (body: OperatorMetricsWire): OperatorFetch => async () => new Response(JSON.stringify(body), { status: 200 })
const row = (db: ReturnType<typeof memoryD1>) => db.raw.query('SELECT * FROM operator_metrics_latest WHERE id = 1').get() as Record<string, unknown> | null

describe('toStoredMetrics (otto/mamoru#129 follow-up)', () => {
  test('drops rpc.cumulative, rpc.logRanges and the chainId/live/policyId/balanceCachedAgeMs fields', () => {
    const stored = toStoredMetrics(rawMetrics())
    expect('cumulative' in stored.rpc).toBe(false)
    expect('logRanges' in stored.rpc).toBe(false)
    expect('chainId' in stored.operator).toBe(false)
    expect('live' in stored.operator).toBe(false)
    expect('policyId' in stored.operator).toBe(false)
    expect('balanceCachedAgeMs' in stored.operator.relayer).toBe(false)
    expect(JSON.stringify(stored)).not.toContain('base-mainnet.g.alchemy.com')
  })

  test('keeps gitSha, uptimeSeconds, relayer.{address,balanceWei}, accounts, settings, rpc.{last48h,cuEstimateTotal,byComponent}, engines, opsRecent', () => {
    const stored = toStoredMetrics(rawMetrics())
    expect(stored.operator.gitSha).toBe('5efba44')
    expect(stored.operator.uptimeSeconds).toBe(123)
    expect(stored.operator.relayer).toEqual({ address: '0x1111111111111111111111111111111111111111', balanceWei: '812345678901234567' })
    expect(stored.operator.accounts).toEqual({ known: 14, active: 9, armed: 1 })
    expect(stored.rpc.cuEstimateTotal).toBe(1_452_300)
    expect(stored.rpc.last48h).toEqual([{ hourStart: '2026-10-17T10:00:00.000Z', data: {} }])
    expect(stored.engines.length).toBe(1)
    expect(stored.opsRecent).toEqual([{ accountKey: '3f9a7c21', kind: 'enter', state: 'confirmed', at: '2026-10-18T08:58:00.000Z', code: null }])
  })
})

describe('fetchOperatorMetrics', () => {
  test('null, not thrown, on a non-200 answer', async () => {
    const got = await fetchOperatorMetrics('http://operator', SECRET, async () => new Response('{}', { status: 503 }))
    expect(got).toBeNull()
  })

  test('null, not thrown, when the fetcher itself throws (operator unreachable)', async () => {
    const got = await fetchOperatorMetrics('http://operator', SECRET, async () => {
      throw new Error('connect refused')
    })
    expect(got).toBeNull()
  })

  test('a 200 answer parses to the raw JSON, untyped (never cast to OperatorMetricsWire)', async () => {
    const got = await fetchOperatorMetrics('http://operator', SECRET, okFetcher(rawMetrics()))
    expect((got as { operator: { gitSha: string } }).operator.gitSha).toBe('5efba44')
  })
})

describe('toStoredMetrics never spreads the input (code-review finding, PR #92)', () => {
  test('an opsRecent item carrying ownerGrants/sessionKey/signature is stored without them', () => {
    const dirty = rawMetrics({
      opsRecent: [
        {
          accountKey: '3f9a7c21',
          kind: 'enter',
          state: 'confirmed',
          at: '2026-10-18T08:58:00.000Z',
          code: null,
          // @ts-expect-error extra fields a real engine op may carry, that must never reach storage
          ownerGrants: [{ name: 'enter-swap', grant: {}, permissionId: '0x01' }],
          sessionKey: '0xdeadbeef',
          signature: '0xabc123',
          permissionId: '0x01',
          calls: [{ to: '0x1', data: '0x2' }],
        },
      ],
    })
    const stored = toStoredMetrics(dirty)
    expect(stored.opsRecent).toEqual([{ accountKey: '3f9a7c21', kind: 'enter', state: 'confirmed', at: '2026-10-18T08:58:00.000Z', code: null }])
    expect(Object.keys(stored.opsRecent[0]!).sort()).toEqual(['accountKey', 'at', 'code', 'kind', 'state'])
    const dump = JSON.stringify(stored)
    expect(dump).not.toContain('ownerGrants')
    expect(dump).not.toContain('sessionKey')
    expect(dump).not.toContain('signature')
    expect(dump).not.toContain('permissionId')
    expect(dump).not.toContain('deadbeef')
  })

  test('a response without opsRecent at all stores opsRecent: [] (older operator, otto/mamoru#129)', () => {
    const noOpsRecent = rawMetrics() as unknown as Record<string, unknown>
    delete noOpsRecent.opsRecent
    const stored = toStoredMetrics(noOpsRecent)
    expect(stored.opsRecent).toEqual([])
    expect('opsRecent' in stored).toBe(true)
  })

  test('a non-array opsRecent, or an item missing a required field, is dropped rather than stored malformed', () => {
    expect(toStoredMetrics(rawMetrics({ opsRecent: 'not an array' as unknown as never })).opsRecent).toEqual([])
    const stored = toStoredMetrics(rawMetrics({ opsRecent: [{ accountKey: '3f9a7c21', kind: 'enter' } as never, { accountKey: '9b0e41aa', kind: 'renew', state: 'confirmed', at: '2026-10-18T08:00:00.000Z', code: null }] }))
    expect(stored.opsRecent).toEqual([{ accountKey: '9b0e41aa', kind: 'renew', state: 'confirmed', at: '2026-10-18T08:00:00.000Z', code: null }])
  })

  test('a whole operator/rpc/engines section that is missing, or not the right shape, defaults rather than throws', () => {
    expect(toStoredMetrics({})).toEqual({
      generatedAt: '',
      operator: { gitSha: '', uptimeSeconds: 0, relayer: { address: '', balanceWei: '' }, accounts: { known: 0, active: 0, armed: 0 }, settings: null },
      rpc: { last48h: [], cuEstimateTotal: 0, byComponent: { cumulative: {}, last48h: [] } },
      engines: [],
      opsRecent: [],
    })
    expect(toStoredMetrics(null)).toEqual(toStoredMetrics({}))
    expect(toStoredMetrics('garbage')).toEqual(toStoredMetrics({}))
  })

  test('an extra top-level or nested property anywhere in the input never reaches the stored object', () => {
    const dirty = { ...rawMetrics(), operatorSecret: 'OPERATOR_SECRET_LEAK', operator: { ...rawMetrics().operator, relayer: { ...rawMetrics().operator.relayer, privateKey: '0xleaked' } } }
    const dump = JSON.stringify(toStoredMetrics(dirty))
    expect(dump).not.toContain('OPERATOR_SECRET_LEAK')
    expect(dump).not.toContain('privateKey')
    expect(dump).not.toContain('0xleaked')
  })
})

describe('writeOperatorMetrics / pullOperatorMetrics (otto/mamoru#129 follow-up)', () => {
  test('writes one row', async () => {
    const db = memoryD1()
    await writeOperatorMetrics(db, toStoredMetrics(rawMetrics()), new Date('2026-10-18T09:00:05.000Z'))
    const r = row(db)
    expect(r?.id).toBe(1)
    expect(r?.generated_at).toBe('2026-10-18T09:00:00.000Z')
    expect(r?.fetched_at).toBe('2026-10-18T09:00:05.000Z')
    const payload = JSON.parse(r?.payload_json as string)
    expect(payload.operator.gitSha).toBe('5efba44')
  })

  test('overwrites on the next pull, not a second row', async () => {
    const db = memoryD1()
    await pullOperatorMetrics(db, 'http://operator', SECRET, okFetcher(rawMetrics()), new Date('2026-10-18T09:00:05.000Z'))
    await pullOperatorMetrics(db, 'http://operator', SECRET, okFetcher(rawMetrics({ generatedAt: '2026-10-18T09:10:00.000Z', operator: { ...rawMetrics().operator, gitSha: '6a01bee' } })), new Date('2026-10-18T09:10:05.000Z'))
    expect(db.raw.query('SELECT COUNT(*) as n FROM operator_metrics_latest').get()).toEqual({ n: 1 })
    const r = row(db)
    expect(r?.generated_at).toBe('2026-10-18T09:10:00.000Z')
    expect(JSON.parse(r?.payload_json as string).operator.gitSha).toBe('6a01bee')
  })

  test('an older payload after a newer one leaves the newer row (freshness guard, code-review finding PR #92)', async () => {
    const db = memoryD1()
    await pullOperatorMetrics(db, 'http://operator', SECRET, okFetcher(rawMetrics({ generatedAt: '2026-10-18T09:10:00.000Z', operator: { ...rawMetrics().operator, gitSha: 'newer-sha' } })), new Date('2026-10-18T09:10:05.000Z'))
    await pullOperatorMetrics(db, 'http://operator', SECRET, okFetcher(rawMetrics({ generatedAt: '2026-10-18T09:00:00.000Z', operator: { ...rawMetrics().operator, gitSha: 'older-sha' } })), new Date('2026-10-18T09:00:05.000Z'))
    const r = row(db)
    expect(r?.generated_at).toBe('2026-10-18T09:10:00.000Z')
    expect(JSON.parse(r?.payload_json as string).operator.gitSha).toBe('newer-sha')
  })

  test('a non-ISO generatedAt is refused: nothing is written, the existing row (if any) is untouched', async () => {
    const db = memoryD1()
    await pullOperatorMetrics(db, 'http://operator', SECRET, okFetcher(rawMetrics({ generatedAt: '2026-10-18T09:00:00.000Z' })), new Date())
    const before = row(db)
    const wrote = await pullOperatorMetrics(db, 'http://operator', SECRET, okFetcher(rawMetrics({ generatedAt: 'not-a-date' })), new Date())
    expect(wrote).toBe(false)
    expect(row(db)).toEqual(before)

    const fresh = memoryD1()
    await expect(writeOperatorMetrics(fresh, toStoredMetrics(rawMetrics({ generatedAt: '' })), new Date())).resolves.toBeUndefined()
    expect(row(fresh)).toBeNull()
  })

  test('a failed fetch writes nothing and does not throw', async () => {
    const db = memoryD1()
    await expect(
      pullOperatorMetrics(db, 'http://operator', SECRET, async () => {
        throw new Error('connect refused')
      }, new Date()),
    ).resolves.toBe(false)
    expect(row(db)).toBeNull()
  })

  test('a 404 (operator reachable, no /metrics) also writes nothing and does not throw', async () => {
    const db = memoryD1()
    const wrote = await pullOperatorMetrics(db, 'http://operator', SECRET, async () => new Response('{}', { status: 404 }), new Date())
    expect(wrote).toBe(false)
    expect(row(db)).toBeNull()
  })

  test('the stored row never carries rpc.cumulative, rpc.logRanges, chainId/live/policyId or balanceCachedAgeMs', async () => {
    const db = memoryD1()
    await pullOperatorMetrics(db, 'http://operator', SECRET, okFetcher(rawMetrics()), new Date())
    const raw = row(db)?.payload_json as string
    expect(raw).not.toContain('base-mainnet.g.alchemy.com')
    expect(raw).not.toContain('balanceCachedAgeMs')
    expect(raw).not.toContain('logRanges')
    const payload = JSON.parse(raw)
    expect('cumulative' in payload.rpc).toBe(false)
    expect('chainId' in payload.operator).toBe(false)
    expect('live' in payload.operator).toBe(false)
    expect('policyId' in payload.operator).toBe(false)
  })
})
