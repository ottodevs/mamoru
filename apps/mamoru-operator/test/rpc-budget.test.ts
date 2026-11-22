// otto/mamoru#418: each provider's monthly budget, alerts at 70% and 90% with a forecast, kept across restarts.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CU_TABLE, QUICKNODE_CREDITS_PER_CALL, RpcMetrics } from '../src/metrics.ts'
import { BudgetBook, budgetsFromEnv, unitsFor } from '../src/rpc-budget.ts'

let lines: string[] = []
const real = console.error
beforeEach(() => {
  lines = []
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
})
afterEach(() => {
  console.error = real
})
const alerts = () => lines.filter((l) => l.startsWith('[alert]'))

const NOV1 = Date.UTC(2026, 10, 1)
const DAY = 86_400_000

describe('budgets from env', () => {
  test('defaults for Alchemy and QuickNode; env overrides and adds; 0 turns one off; junk ignored', () => {
    expect(budgetsFromEnv({})).toEqual({ 'alchemy.com': 30_000_000, 'quiknode.pro': 80_000_000 })
    expect(budgetsFromEnv({ MAMORU_RPC_MONTHLY_BUDGET: 'alchemy.com=0, quiknode.pro=1000, drpc.org=50, bad=-1, x=' })).toEqual({ 'quiknode.pro': 1000, 'drpc.org': 50 })
  })

  test('units: Alchemy CU by method, QuickNode flat credits, any other provider one per request', () => {
    expect(unitsFor('alchemy.com', 'eth_getLogs')).toBe(CU_TABLE.eth_getLogs!)
    expect(unitsFor('quiknode.pro', 'eth_getLogs')).toBe(QUICKNODE_CREDITS_PER_CALL)
    expect(unitsFor('drpc.org', 'eth_getLogs')).toBe(1)
  })
})

describe('BudgetBook', () => {
  test('one alert at 70% and one at 90% per cycle, with the forecast day; every key of a provider counts toward it', () => {
    const b = new BudgetBook({ 'quiknode.pro': 1000 }, {})
    // 35 credits... 20 each: 35 requests = 700 credits, on day 10 of the month.
    const t = NOV1 + 10 * DAY
    b.record('quiknode.pro#1', 'eth_call', NOV1 + 1)
    for (let i = 1; i < 35; i++) b.record(i % 2 ? 'quiknode.pro#2' : 'quiknode.pro#1', 'eth_call', t)
    expect(alerts()).toHaveLength(1)
    // 700 in 10 days: 70 a day, the last 300 in about 4.3 days.
    expect(alerts()[0]).toMatch(/^\[alert\] RPC provider quiknode\.pro at 70% of its monthly budget \(700\/1000 credits since 2026-11-01\): spent ~2026-11-15T\d\d:\d\dZ at this rate, resets 2026-12-01$/)
    for (let i = 0; i < 10; i++) b.record('quiknode.pro', 'eth_call', t)
    expect(alerts()).toHaveLength(2)
    expect(alerts()[1]).toContain('at 90% of its monthly budget (900/1000 credits')
    for (let i = 0; i < 20; i++) b.record('quiknode.pro', 'eth_call', t)
    expect(alerts()).toHaveLength(2)
  })

  test('a jump past both lines pages once, at 90%; a slow rate says it lasts until the reset', () => {
    const b = new BudgetBook({ 'alchemy.com': 260 }, {})
    // One send is 250 CU: 96% in one request.
    b.record('alchemy.com', 'eth_sendRawTransaction', NOV1 + 29 * DAY)
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0]).toContain('at 96% of its monthly budget')
    const slow = new BudgetBook({ 'drpc.org': 100 }, {})
    slow.record('drpc.org', 'eth_call', NOV1)
    for (let i = 1; i < 71; i++) slow.record('drpc.org', 'eth_call', NOV1 + 29 * DAY)
    expect(alerts()[1]).toContain('at 70%')
    expect(alerts()[1]).toMatch(/lasts to its reset 2026-12-01$/)
  })

  test('a new cycle starts the count and the alerts again; a provider without a budget is counted, never paged', () => {
    const b = new BudgetBook({ 'drpc.org': 10 }, {})
    for (let i = 0; i < 7; i++) b.record('drpc.org', 'eth_call', NOV1 + 5 * DAY)
    for (let i = 0; i < 100; i++) b.record('publicnode.com', 'eth_call', NOV1 + 5 * DAY)
    expect(alerts()).toHaveLength(1)
    const dec = Date.UTC(2026, 11, 1)
    expect(b.snapshot(dec).find((s) => s.provider === 'drpc.org')!.used).toBe(0)
    for (let i = 0; i < 7; i++) b.record('drpc.org', 'eth_call', dec + DAY)
    expect(alerts()).toHaveLength(2)
    const pub = b.snapshot(NOV1 + 6 * DAY).find((s) => s.provider === 'publicnode.com')!
    expect(pub).toMatchObject({ used: 100, budget: null, usedPct: null, unit: 'requests', forecastExhaustedAt: null })
  })

  test('the cycle follows MAMORU_RPC_QUOTA_RESET_DAY', () => {
    const b = new BudgetBook({ 'quiknode.pro': 1_000_000 }, { 'quiknode.pro': 14 })
    b.record('quiknode.pro', 'eth_call', Date.UTC(2026, 10, 13))
    b.record('quiknode.pro', 'eth_call', Date.UTC(2026, 10, 14, 1))
    const s = b.snapshot(Date.UTC(2026, 10, 20)).find((x) => x.provider === 'quiknode.pro')!
    expect(s.used).toBe(QUICKNODE_CREDITS_PER_CALL)
    expect(s.cycleStart).toBe('2026-11-14T00:00:00.000Z')
    expect(s.resetAt).toBe('2026-12-14T00:00:00.000Z')
    expect(s.countedSince).toBe('2026-11-14T01:00:00.000Z')
  })
})

describe('RpcMetrics budget', () => {
  test('use and alert marks survive a restart: a restart never pages again for the same line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-'))
    const book = () => new BudgetBook({ 'alchemy.com': 10 * CU_TABLE.eth_call! }, {})
    const now = Date.now()
    const a = new RpcMetrics(dir, book())
    for (let i = 0; i < 7; i++) a.recordRequest('alchemy.com', 'eth_call', false, now)
    expect(alerts()).toHaveLength(1)
    // Saved at once on the alert, not at the next minute's write.
    expect(JSON.parse(readFileSync(join(dir, 'rpc-usage.json'), 'utf8')).budget['alchemy.com'].alerted).toBe(0.7)
    const b = new RpcMetrics(dir, book())
    b.recordRequest('alchemy.com', 'eth_call', false, now)
    expect(alerts()).toHaveLength(1)
    const s = b.budgetSnapshot(now).find((x) => x.provider === 'alchemy.com')!
    expect(s).toMatchObject({ used: 8 * CU_TABLE.eth_call!, budget: 10 * CU_TABLE.eth_call!, usedPct: 80, unit: 'cu' })
    const raw = readFileSync(join(dir, 'rpc-usage.json'), 'utf8')
    expect(raw).not.toMatch(/https?:/)
  })
})

describe('budget alert order (review)', () => {
  test('rpc-usage.json holds the alert mark when the [alert] line is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-order-'))
    const m = new RpcMetrics(dir, new BudgetBook({ 'drpc.org': 10 }, {}))
    let seen = null as number | null
    console.error = (...a: unknown[]) => {
      if (String(a[0]).startsWith('[alert]')) seen = JSON.parse(readFileSync(join(dir, 'rpc-usage.json'), 'utf8')).budget['drpc.org'].alerted
    }
    for (let i = 0; i < 7; i++) m.recordRequest('drpc.org', 'eth_call', false)
    expect(seen).toBe(0.7)
  })
})
