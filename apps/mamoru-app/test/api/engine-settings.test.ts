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
    expect(p.flags).toEqual({ yield_ledger: false, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false, multichain_v6: false, merged_grants_v7: false })
  })

  test('otto/mamoru#129: the payload carries the newest row for a flag that was turned on', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    insert(h, 'prod', today)
    h.db.raw
      .query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('yield_ledger', 1, 'ot', 'turn on for canary', ?)`)
      .run(NOW.toISOString())
    const p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(p.flags).toEqual({ yield_ledger: true, onchain_action_policy_v4: false, onchain_action_policy_v5: false, monad_sleeves: false, multichain_v6: false, merged_grants_v7: false })
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

  test('otto/mamoru#212: an override counts only in the environment it was written for, and holds every sleeve of the owner', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    insert(h, 'prod', depth)
    const user = (id: string) => h.db.raw.query(`INSERT INTO users (user_id, created_at) VALUES (?, '2026-10-23')`).run(id)
    const account = (key: string, userId: string, chainId: number, addr: string, cred: string, env: 'prod' | 'beta' = 'prod') =>
      h.db.raw
        .query(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at, env) VALUES (?, ?, ?, ?, '[]', ?, '0x1', '0x2', '1', 'v', '2026-10-23', ?)`)
        .run(key, userId, chainId, addr, cred, env)
    const cap = (key: string, usdc: number | null, env: 'prod' | 'beta' = 'prod') =>
      h.db.raw.query(`INSERT INTO account_cap_overrides (env, account_key, cap_usdc, author, reason, created_at) VALUES (?, ?, ?, 'ot', 'test', ?)`).run(env, key, usdc, NOW.toISOString())
    user('u1')
    user('u2')
    user('u3')
    // u1: a Base account and its Monad sleeve (same Safe address), prod.
    account('base-1', 'u1', 8453, '0x00000000000000000000000000000000000000a1', 'c1')
    account('monad-1', 'u1', 143, '0x00000000000000000000000000000000000000a1', 'c2')
    // u2: a beta account; u3: a prod one.
    account('beta-2', 'u2', 8453, '0x00000000000000000000000000000000000000b2', 'c3', 'beta')
    account('prod-3', 'u3', 8453, '0x00000000000000000000000000000000000000c3', 'c4')
    cap('base-1', 2000)
    cap('beta-2', 9000, 'prod') // written for prod, the account is beta: no effect
    cap('prod-3', 7000, 'beta') // written for beta, the account is prod: no effect
    cap('prod-3', 3000)
    let p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(p.accountCaps).toEqual({ 'base-1': 2000, 'monad-1': 2000, 'prod-3': 3000 })
    // The newest row of either sleeve is the owner's cap; a removal on one removes it for both.
    cap('monad-1', 4000)
    cap('beta-2', 1500, 'beta')
    p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(p.accountCaps).toEqual({ 'base-1': 4000, 'beta-2': 1500, 'monad-1': 4000, 'prod-3': 3000 })
    cap('base-1', null)
    p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(p.accountCaps).toEqual({ 'beta-2': 1500, 'prod-3': 3000 })
  })

  test('merge gate round 1: overrides for 150 owners, and an owner with a second Safe, in one pull with no bound list', async () => {
    const h = harness(() => NOW, { env: { OPERATOR_SECRET: OP } })
    insert(h, 'prod', depth)
    const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
    for (let i = 1; i <= 150; i++) {
      h.db.raw.query(`INSERT INTO users (user_id, created_at) VALUES (?, '2026-10-23')`).run(`u${i}`)
      h.db.raw
        .query(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES (?, ?, 8453, ?, '[]', ?, '0x1', '0x2', '1', 'v', '2026-10-23')`)
        .run(`acct-${i}`, `u${i}`, addr(i), `cred-${i}`)
      h.db.raw.query(`INSERT INTO account_cap_overrides (env, account_key, cap_usdc, author, reason, created_at) VALUES ('prod', ?, ?, 'ot', 'test', ?)`).run(`acct-${i}`, 1000 + i, NOW.toISOString())
    }
    // u1 also holds a second Base Safe (the D1 does not forbid it): its override holds both, and each names the other.
    h.db.raw
      .query(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES ('acct-1b', 'u1', 8453, ?, '[]', 'cred-1b', '0x1', '0x2', '2', 'v', '2026-10-24')`)
      .run(addr(9999))
    const p = JSON.parse(await (await pull(h)).text()) as EngineSettingsPayload
    expect(Object.keys(p.accountCaps)).toHaveLength(151)
    expect(p.accountCaps['acct-150']).toBe(1150)
    expect(p.accountCaps['acct-1b']).toBe(1001)
    expect(p.ownerSafes).toEqual({ 'acct-1': [addr(9999)], 'acct-1b': [addr(1)] })
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
