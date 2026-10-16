import { describe, expect, test } from 'bun:test'
import { metricsSignature, verifySettingsResponse } from '@mamoru/operator-auth'
import { canonicalSettingsJson, ENGINE_SETTINGS_TEMPLATES } from '@mamoru/policy'
import { ENGINE_SETTINGS_PATH, type EngineSettingsPayload } from '../../src/api/engine-settings.ts'
import { harness } from './helpers.ts'

const OP = 'operator-secret-for-tests'
const NOW = new Date('2026-10-16T12:00:00Z')
const depth = ENGINE_SETTINGS_TEMPLATES['conservador + depth 30/500/5, cap 1000']!
const today = ENGINE_SETTINGS_TEMPLATES['conservador-live-v2 (today)']!

function insert(h: ReturnType<typeof harness>, env: 'prod' | 'beta', settings: unknown, accounts: string[] | null = null, template = 't') {
  h.db.raw
    .query(`INSERT INTO engine_settings_versions (env, account_keys_json, template, settings_json, settings_hash, author, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(env, accounts === null ? null : JSON.stringify(accounts), template, JSON.stringify(settings), 'h', 'otto@test', 'test', NOW.toISOString())
}

async function pull(h: ReturnType<typeof harness>, sig?: string) {
  const s = sig ?? (await metricsSignature(OP, 'GET', ENGINE_SETTINGS_PATH, Math.floor(NOW.getTime() / 60_000)))
  return h.request(ENGINE_SETTINGS_PATH, { headers: { 'x-mamoru-sig': s } })
}

describe('GET /api/internal/engine-settings (spec 006)', () => {
  test('refuses an unsigned or mis-signed request, and answers 404 when OPERATOR_SECRET is not set', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    expect((await h.request(ENGINE_SETTINGS_PATH)).status).toBe(401)
    expect((await pull(h, 'ab'.repeat(32))).status).toBe(401)
    const bare = harness(() => NOW)
    expect((await pull(bare)).status).toBe(404)
  })

  test('serves the newest environment-wide version and newer canaries, signed', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    insert(h, 'prod', today)
    insert(h, 'prod', depth, ['acct-canary'])
    insert(h, 'prod', today, null, 'rollback')
    insert(h, 'prod', depth, ['acct-later'])
    insert(h, 'beta', depth)
    insert(h, 'beta', { ...depth, capUsdc: 5_000_000 })
    const res = await pull(h)
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(await verifySettingsResponse(OP, body, res.headers.get('x-mamoru-sig'), NOW.getTime())).toBe(true)
    const p = JSON.parse(body) as EngineSettingsPayload
    // prod: the canary older than the newest env-wide row is gone; beta: the out-of-bounds row is never handed out.
    expect(p.versions.map((v) => [v.id, v.env, v.accountKeys])).toEqual([
      [3, 'prod', null],
      [4, 'prod', ['acct-later']],
      [5, 'beta', null],
    ])
    expect(p.betaAccounts).toEqual([])
  })

  test('the migration seeds exactly the templates the code defines', () => {
    const h = harness(() => NOW)
    const rows = h.db.raw.query('SELECT name, settings_json FROM engine_settings_templates ORDER BY name').all() as { name: string; settings_json: string }[]
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(ENGINE_SETTINGS_TEMPLATES).sort())
    for (const r of rows) expect(r.settings_json).toBe(canonicalSettingsJson(ENGINE_SETTINGS_TEMPLATES[r.name]!))
  })
})
