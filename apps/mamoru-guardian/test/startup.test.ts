// otto/mamoru#293, review of #202 r3 (Sol 2): a startup failure (an RPC down, an RPC on the wrong chain) is paged: the
// alerter is built from configuration before anything can fail, and the page is not repeated within the hour.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Alerter } from '../src/alerts.ts'
import { readdirSync } from 'node:fs'
import { alerterFrom, clearStartupStamps, pageStartupFailure, run, shortWhy, type MakeClient } from '../src/main.ts'

const env = () => ({ MAMORU_GUARDIAN_HOME_RPC_URL: 'http://127.0.0.1:9/', MAMORU_GUARDIAN_V4_ADDRESS: '0x00000000000000000000000000000000000000a2', MAMORU_GUARDIAN_GAS_POLICY_ADDRESS: '0x00000000000000000000000000000000000000a3', MAMORU_GUARDIAN_STATE_DIR: mkdtempSync(join(tmpdir(), 'guardian-start-')), MAMORU_GUARDIAN_FROM_BLOCK_8453: '1', MAMORU_GUARDIAN_DRY_RUN: '1' })
const capture = () => {
  const alerts: string[] = []
  const a: Alerter = { alert: async (t) => void alerts.push(t) }
  return { a, alerts }
}

describe('guardian startup failures are paged', () => {
  test('an RPC on the wrong chain: run throws before any pass, and the failure is paged once an hour', async () => {
    const e = env()
    const { a, alerts } = capture()
    const wrong: MakeClient = () => ({ getChainId: async () => 1 }) as never
    const err = await run(e, a, wrong, true).catch((x) => x)
    expect(shortWhy(err)).toContain('answers another chain id')
    expect(await pageStartupFailure(a, e, shortWhy(err), 1_000_000)).toBe(true)
    expect(await pageStartupFailure(a, e, shortWhy(err), 1_000_000 + 60_000)).toBe(false) // a restart within the hour
    expect(await pageStartupFailure(a, e, shortWhy(err), 1_000_000 + 3_700_000)).toBe(true)
    expect(alerts.length).toBe(2)
    expect(alerts[0]).toContain('guardian failed to start')
  })

  test('an RPC that is down: the failure is paged, without the RPC URL', async () => {
    const e = env()
    const { a, alerts } = capture()
    const down: MakeClient = () => ({ getChainId: async () => { throw Object.assign(new Error('fetch failed http://127.0.0.1:9/ KEY'), { shortMessage: 'HTTP request failed.' }) } }) as never
    const err = await run(e, a, down, true).catch((x) => x)
    await pageStartupFailure(a, e, shortWhy(err))
    expect(alerts[0]).toContain('HTTP request failed.')
    expect(alerts[0]).not.toContain('KEY')
  })

  test('the alerter needs configuration only: an unreadable webhook file still leaves the console sink', async () => {
    const a = alerterFrom({ MAMORU_GUARDIAN_WEBHOOK_FILE: '/nonexistent/webhook' })
    await a.alert('test line') // no throw
  })
  test('a failed delivery leaves no stamp (the next restart pages); stamps per reason; future stamps expired; cleared on start', async () => {
    const e = env()
    const failing: Alerter = { alert: async () => { throw new Error('webhook down') } }
    expect(await pageStartupFailure(failing, e, 'rpc down', 1_000)).toBe(false)
    expect(readdirSync(e.MAMORU_GUARDIAN_STATE_DIR).filter((f) => f.startsWith('startup-alerted-'))).toEqual([])
    const { a, alerts } = capture()
    expect(await pageStartupFailure(a, e, 'rpc down', 2_000)).toBe(true) // retried: delivered
    expect(await pageStartupFailure(a, e, 'wrong chain', 2_000)).toBe(true) // another reason pages too
    expect(await pageStartupFailure(a, e, 'rpc down', 2_500)).toBe(false) // same reason within the hour
    expect(await pageStartupFailure(a, e, 'rpc down', 1_000)).toBe(true) // a stamp from the future: expired
    expect(alerts.length).toBe(3)
    clearStartupStamps(e)
    expect(readdirSync(e.MAMORU_GUARDIAN_STATE_DIR).filter((f) => f.startsWith('startup-alerted-'))).toEqual([])
  })
})
