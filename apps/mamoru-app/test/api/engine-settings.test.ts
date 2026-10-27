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

  test('otto/mamoru#172: a lazy re-range version is served; one out of the rerange bounds is not', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    const lazy = ENGINE_SETTINGS_TEMPLATES['conservador-live-v2 + lazy-h24h-b100-d30']!
    insert(h, 'prod', today)
    insert(h, 'prod', lazy, ['acct-canary'])
    insert(h, 'beta', lazy)
    insert(h, 'beta', { ...lazy, rerange: { ...lazy.rerange, horizonSeconds: 60 } })
    const p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(p.versions.map((v) => [v.id, v.env, v.accountKeys])).toEqual([
      [1, 'prod', null],
      [2, 'prod', ['acct-canary']],
      [3, 'beta', null],
    ])
    expect(p.versions[1]!.settings).toEqual(lazy)
  })

  test('the migration seeds exactly the templates the code defines', () => {
    const h = harness(() => NOW)
    const rows = h.db.raw.query('SELECT name, settings_json FROM engine_settings_templates ORDER BY name').all() as { name: string; settings_json: string }[]
    expect(rows.map((r) => r.name).sort()).toEqual(Object.keys(ENGINE_SETTINGS_TEMPLATES).sort())
    for (const r of rows) expect(r.settings_json).toBe(canonicalSettingsJson(ENGINE_SETTINGS_TEMPLATES[r.name]!))
  })

  test('otto/mamoru#129: the payload carries ops flags from D1, every flag off with no rows', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    insert(h, 'prod', today)
    const p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(p.flags).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false, multichain_v6: false })
  })

  test('otto/mamoru#129: the payload carries the newest row for a flag that was turned on', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    insert(h, 'prod', today)
    h.db.raw
      .query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('yield_ledger', 1, 'ot', 'turn on for canary', ?)`)
      .run(NOW.toISOString())
    const p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(p.flags).toEqual({ yield_ledger: true, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false, multichain_v6: false })
  })
  test('otto/mamoru#26: accountCaps carries the newest valid row per account; a removal and bad rows are left out', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    insert(h, 'prod', depth)
    const cap = (key: string, usdc: number | null, env = 'prod') =>
      h.db.raw.query(`INSERT INTO account_cap_overrides (env, account_key, cap_usdc, author, reason, created_at) VALUES (?, ?, ?, 'ot', 'test', ?)`).run(env, key, usdc, NOW.toISOString())
    cap('AAAA-1', 2000)
    cap('bbbb-2', 2000)
    cap('cccc-3', 5000)
    cap('bbbb-2', null) // removed: back on the env cap
    cap('aaaa-1', 3000) // newest wins, keys compared lowercase
    cap('cccc-3', 2_000_000) // out of bounds: skipped, the previous row stands
    cap('dddd-4', 0)
    cap('eeee 5', 100, 'beta')
    const p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(p.accountCaps).toEqual({ 'aaaa-1': 3000, 'cccc-3': 5000 })
  })

  test('otto/mamoru#26: without the account_cap_overrides table (migration not applied) the map is empty', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    insert(h, 'prod', depth)
    h.db.raw.query('DROP TABLE account_cap_overrides').run()
    const res = await pull(h)
    expect(res.status).toBe(200)
    expect((JSON.parse(await res.text()) as EngineSettingsPayload).accountCaps).toEqual({})
  })
})
