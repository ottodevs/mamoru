import { describe, expect, test } from 'bun:test'
import { runYieldLedger } from '../../src/worker.ts'
import type { Env } from '../../src/api/env.ts'
import { memoryD1 } from './d1.ts'

function envOf(db: ReturnType<typeof memoryD1>, over: Partial<Env> = {}): Env {
  return { DB: db, MODE: 'production', CHAIN_ID: '8453', CORE_DRY_RUN: 'true', SESSION_SECRET: 'x'.repeat(32), OPERATOR_URL: 'http://operator', OPERATOR_SECRET: 'op-secret', ...over }
}

function turnOn(db: ReturnType<typeof memoryD1>) {
  db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('yield_ledger', 1, 'ot', 'test', '2026-10-18T00:00:00Z')`).run()
}

describe('runYieldLedger cron gate (otto/mamoru#129: D1 flag, not an env var)', () => {
  test('no ops_flag_changes row: the flag is off, the cron never calls the operator', async () => {
    const db = memoryD1()
    let called = false
    await runYieldLedger(envOf(db), async () => {
      called = true
      return new Response(JSON.stringify({ error: 'snapshot off' }), { status: 404 })
    })
    expect(called).toBe(false)
  })

  test('the newest row turns the flag on: the cron pulls the operator', async () => {
    const db = memoryD1()
    turnOn(db)
    let called = false
    await runYieldLedger(envOf(db), async () => {
      called = true
      return new Response(JSON.stringify({ error: 'no snapshot yet' }), { status: 503 })
    })
    expect(called).toBe(true)
  })

  test('the flag on is not enough without OPERATOR_URL and OPERATOR_SECRET', async () => {
    const db = memoryD1()
    turnOn(db)
    let called = false
    const fetcher = async () => {
      called = true
      return new Response('{}', { status: 404 })
    }
    await runYieldLedger(envOf(db, { OPERATOR_URL: undefined }), fetcher)
    await runYieldLedger(envOf(db, { OPERATOR_SECRET: undefined }), fetcher)
    expect(called).toBe(false)
  })

  test('an operator error during a pull never throws out of the cron', async () => {
    const db = memoryD1()
    turnOn(db)
    await expect(
      runYieldLedger(envOf(db), async () => {
        throw new Error('connect refused')
      }),
    ).resolves.toBeUndefined()
  })
})
