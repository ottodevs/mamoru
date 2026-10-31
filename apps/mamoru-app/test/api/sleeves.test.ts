import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionView, SleeveView } from '@mamoru/domain'
import { resetOperatorHealth } from '../../src/api/sleeves.ts'
import { upsertActivity } from '../../src/api/accounts/activity.ts'
import { harness, ORIGIN, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#67, #64: Monad sleeves behind the `monad_sleeves` ops flag, honored on beta.mamoru.lol only.

const BETA = 'https://beta.mamoru.lol'
const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'

function flag(h: ReturnType<typeof harness>, on: 0 | 1) {
  h.db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('monad_sleeves', ?, 'ot', 'test', '2026-10-23T00:00:00Z')`).run(on)
}

const MONAD_OPERATOR = 'https://operator-monad.test'

/**
 * A harness whose Monad chain is ready (review of PR #115): live funds, OPERATOR_URL_143 set and its /health
 * reporting `healthChain` (143 unless a test says otherwise). `monadUrl: null` leaves OPERATOR_URL_143 unset.
 * Every operator call is recorded.
 */
function monadHarness(opts: { monadUrl?: string | null; healthChain?: number } = {}) {
  resetOperatorHealth()
  const calls: { url: string; account: string }[] = []
  const operatorFetch = async (url: string, init: RequestInit) => {
    calls.push({ url, account: new Headers(init.headers).get('x-mamoru-account') ?? '' })
    const body = url.endsWith('/health') ? { ok: true, chainId: url.startsWith(MONAD_OPERATOR) ? (opts.healthChain ?? 143) : 8453 } : { ok: true }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  }
  const monadUrl = opts.monadUrl === undefined ? `${MONAD_OPERATOR}/` : opts.monadUrl
  const env = { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET, ...(monadUrl ? { OPERATOR_URL_143: monadUrl } : {}) }
  return { h: harness(undefined, { env, operatorFetch }), calls }
}

async function owner(h: ReturnType<typeof harness>) {
  const res = await register(h, PASSKEY_A)
  expect(res.status).toBe(201)
  return { cookie: sessionCookie(res), base: (await res.json()) as { accountKey: string; address: string } }
}

/** The row the Worker upserts once the Base operator reports the owner's remote Safe (remote.ts), written straight to D1. */
function seedSleeve(h: ReturnType<typeof harness>, base: { accountKey: string }, address = `0x${'77'.repeat(20)}`): SleeveView {
  const accountKey = crypto.randomUUID()
  h.db.raw
    .query(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, created_at, env, is_test, remote_json)
      SELECT ?, user_id, 143, ?, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, created_at, env, is_test, '{"chainId":143}' FROM accounts WHERE account_key = ?`)
    .run(accountKey, address, base.accountKey)
  return { accountKey, chainId: 143, chain: 'Monad', address: address as SleeveView['address'] }
}

const at = (h: ReturnType<typeof harness>, origin: string, path: string, cookie: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers)
  headers.set('cookie', cookie)
  if (init.method === 'POST') {
    headers.set('origin', origin)
    headers.set('content-type', 'application/json')
  }
  return h.app.request(`${origin}${path}`, { ...init, headers }, h.env)
}

describe('the monad_sleeves gate', () => {
  test('flag off on beta: the session is what it was', async () => {
    const h = harness()
    const { cookie, base } = await owner(h)
    const session = (await (await at(h, BETA, '/api/session', cookie)).json()) as SessionView
    expect(session).toEqual({ userId: session.userId, accountKey: base.accountKey })
    expect((await at(h, BETA, '/api/sleeves', cookie, { method: 'POST', body: JSON.stringify({ chainId: 143 }) })).status).toBe(404)
  })

  test('flag on, prod host: still off, whatever the shared row says', async () => {
    const h = harness()
    flag(h, 1)
    const { cookie, base } = await owner(h)
    const session = (await (await at(h, ORIGIN, '/api/session', cookie)).json()) as SessionView
    expect(session).toEqual({ userId: session.userId, accountKey: base.accountKey })
    expect((await at(h, ORIGIN, '/api/sleeves', cookie, { method: 'POST', body: JSON.stringify({ chainId: 143 }) })).status).toBe(404)
  })
})

describe('a Monad sleeve on beta', () => {
  test('the session lists the Monad sleeve beside Base, Base stays the default, and POST /api/sleeves is gone', async () => {
    const { h } = monadHarness()
    flag(h, 1)
    const { cookie, base } = await owner(h)
    const before = (await (await at(h, BETA, '/api/session', cookie)).json()) as SessionView
    expect(before.sleeves).toEqual([{ accountKey: base.accountKey, chainId: 8453, chain: 'Base', address: base.address as SleeveView['address'] }])
    expect('addableChains' in before).toBe(false)

    expect((await at(h, BETA, '/api/sleeves', cookie, { method: 'POST', body: JSON.stringify({ chainId: 143 }) })).status).toBe(404)
    expect(h.db.raw.query('SELECT COUNT(*) AS n FROM accounts WHERE chain_id = 143').get()).toEqual({ n: 0 })

    const sleeve = seedSleeve(h, base)
    const after = (await (await at(h, BETA, '/api/session', cookie)).json()) as SessionView
    expect(after.accountKey).toBe(base.accountKey)
    expect(after.sleeves).toEqual([{ accountKey: base.accountKey, chainId: 8453, chain: 'Base', address: base.address as SleeveView['address'] }, sleeve])
    expect('addableChains' in after).toBe(false)
  })

  test('the database holds one sleeve per owner off Base', () => {
    const h = harness()
    const row = (key: string, addr: string, cred: string) =>
      h.db.raw
        .query(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES (?, 'u1', 143, ?, '[]', ?, '0x1', '0x2', '1', 'v', '2026-10-23')`)
        .run(key, addr, cred)
    h.db.raw.query(`INSERT INTO users (user_id, created_at) VALUES ('u1', '2026-10-23')`).run()
    row('k1', '0xa', 'c1')
    expect(() => row('k2', '0xb', 'c2')).toThrow(/UNIQUE/)
  })

  test('operator routes of the Monad sleeve go to OPERATOR_URL_143 with chain 143 in the context; Base to OPERATOR_URL', async () => {
    const { h, calls } = monadHarness()
    flag(h, 1)
    const { cookie, base } = await owner(h)
    const sleeve = seedSleeve(h, base)
    calls.length = 0
    expect((await at(h, BETA, `/api/accounts/${sleeve.accountKey}/funding`, cookie)).status).toBe(200)
    expect((await at(h, BETA, `/api/accounts/${base.accountKey}/funding`, cookie)).status).toBe(200)
    const forwarded = calls.filter((c) => !c.url.endsWith('/health'))
    expect(forwarded.map((c) => c.url)).toEqual([`${MONAD_OPERATOR}/api/accounts/${sleeve.accountKey}/funding`, `https://operator.test/api/accounts/${base.accountKey}/funding`])
    expect(JSON.parse(Buffer.from(forwarded[0]!.account, 'base64url').toString()).chainId).toBe(143)
  })

  test('activity carries the chain of the sleeve it was recorded for', async () => {
    const { h } = monadHarness()
    flag(h, 1)
    const { base } = await owner(h)
    const sleeve = seedSleeve(h, base)
    await upsertActivity(h.db, sleeve.accountKey, new Date('2026-10-23T08:00:00Z'))
    expect(h.db.raw.query('SELECT chain_id, hits FROM account_activity WHERE account_key = ? AND day = ?').get(sleeve.accountKey, '2026-10-23')).toEqual({ chain_id: 143, hits: 1 })
  })
})

describe('review of PR #115: a Monad sleeve only where someone can operate it, fail closed', () => {
  async function withSleeve(opts: Parameters<typeof monadHarness>[0] = {}) {
    // The sleeve is opened while everything is ready, then the condition under test is broken on the same D1.
    const ready = monadHarness()
    flag(ready.h, 1)
    const { cookie, base } = await owner(ready.h)
    const sleeve = seedSleeve(ready.h, base)
    const broken = monadHarness(opts)
    broken.h.env.DB = ready.h.env.DB
    return { ...broken, db: ready.h.db, cookie, base, sleeve }
  }

  async function hidden(h: ReturnType<typeof harness>, calls: { url: string }[], origin: string, cookie: string, base: { accountKey: string }, sleeve: SleeveView) {
    calls.length = 0
    for (const path of ['funding', 'ops', 'dashboard', 'yield', 'other-chains']) {
      expect((await at(h, origin, `/api/accounts/${sleeve.accountKey}/${path}`, cookie)).status).toBe(404)
    }
    expect((await at(h, origin, `/api/accounts/${sleeve.accountKey}/activate/prepare`, cookie, { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await at(h, origin, `/api/onboarding/kit?accountKey=${sleeve.accountKey}`, cookie)).status).toBe(404)
    // Nothing reached any operator for the Monad account.
    expect(calls.filter((c) => c.url.includes(sleeve.accountKey))).toEqual([])
    const session = (await (await at(h, origin, '/api/session', cookie)).json()) as SessionView
    expect(session.accountKey).toBe(base.accountKey)
    expect((session.sleeves ?? []).map((s) => s.chainId)).not.toContain(143)
  }

  test('prod host: the Monad account is hidden on every route, and nothing is forwarded', async () => {
    const t = await withSleeve()
    await hidden(t.h, t.calls, ORIGIN, t.cookie, t.base, t.sleeve)
  })

  test('flag turned off on beta: the same', async () => {
    const t = await withSleeve()
    t.db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('monad_sleeves', 0, 'ot', 'test', '2026-10-23T01:00:00Z')`).run()
    await hidden(t.h, t.calls, BETA, t.cookie, t.base, t.sleeve)
  })

  test('OPERATOR_URL_143 unset: an existing sleeve is hidden', async () => {
    const t = await withSleeve({ monadUrl: null })
    await hidden(t.h, t.calls, BETA, t.cookie, t.base, t.sleeve)
  })

  test('an operator at OPERATOR_URL_143 that reports another chain (or no health) is not ready', async () => {
    const t = await withSleeve({ healthChain: 8453 })
    await hidden(t.h, t.calls, BETA, t.cookie, t.base, t.sleeve)
    expect(t.calls.some((c) => c.url === `${MONAD_OPERATOR}/health`)).toBe(true)
  })
})

describe('migrations/d1/0017_chain_keyed_sleeves.sql', () => {
  const dir = join(import.meta.dir, '../../../../migrations/d1')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const mine = files.find((f) => f.endsWith('_chain_keyed_sleeves.sql'))!

  test('existing Base rows keep every column and get their chain; the previous Worker statement still runs', () => {
    const db = new Database(':memory:', { strict: true })
    for (const f of files) if (f !== mine) db.exec(readFileSync(join(dir, f), 'utf8'))
    db.exec(`INSERT INTO users (user_id, created_at) VALUES ('u1', '2026-10-01')`)
    db.exec(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES ('k1', 'u1', 8453, '0xa', '[]', 'c1', '0x1', '0x2', '1', 'v', '2026-10-01')`)
    db.exec(`INSERT INTO account_activity (account_key, day, hits, first_at, last_at) VALUES ('k1', '2026-10-01', 7, '2026-10-01T01:00:00Z', '2026-10-01T09:00:00Z'), ('gone', '2026-10-02', 2, 'a', 'b')`)
    db.exec(`INSERT INTO proj_account_state (account_key, chain_id, block, block_hash, observed_at, deployed, tokens_json, total_value) VALUES ('k1', 8453, 10, '0xh', 't', 1, '[]', '5')`)
    const before = db.query('SELECT * FROM account_activity ORDER BY account_key').all()
    db.exec(readFileSync(join(dir, mine), 'utf8'))
    const after = db.prepare('SELECT * FROM account_activity ORDER BY account_key').all() as Record<string, unknown>[]
    expect(after.map(({ chain_id, ...rest }) => rest)).toEqual(before as Record<string, unknown>[])
    expect(after.map((r) => r.chain_id)).toEqual([8453, 8453])
    expect(db.query('SELECT account_key, total_value FROM proj_account_state').all()).toEqual([{ account_key: 'k1', total_value: '5' }])
    // The Worker before this change writes without chain_id: its upsert still lands, on the same key.
    db.exec(`INSERT INTO account_activity (account_key, day, hits, first_at, last_at) VALUES ('k1', '2026-10-01', 1, 'x', 'z') ON CONFLICT(account_key, day) DO UPDATE SET hits = hits + 1`)
    expect(db.query(`SELECT hits, chain_id FROM account_activity WHERE account_key = 'k1'`).get()).toEqual({ hits: 8, chain_id: 8453 })
  })

  test('before the migration, the new writer falls back to the old statement', async () => {
    const h = harness()
    h.db.raw.exec('CREATE TABLE activity_old AS SELECT account_key, day, hits, first_at, last_at FROM account_activity; DROP TABLE account_activity; CREATE TABLE account_activity (account_key TEXT NOT NULL, day TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 1, first_at TEXT NOT NULL, last_at TEXT NOT NULL, PRIMARY KEY (account_key, day))')
    await upsertActivity(h.db, 'k9', new Date('2026-10-23T08:00:00Z'))
    await upsertActivity(h.db, 'k9', new Date('2026-10-23T09:00:00Z'))
    expect(h.db.raw.query('SELECT hits FROM account_activity').get()).toEqual({ hits: 2 })
  })
})

describe('migrations/d1/*_remote_safe.sql', () => {
  const dir = join(import.meta.dir, '../../../../migrations/d1')
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  const mine = files.find((f) => f.endsWith('_remote_safe.sql'))!

  test('the same-address sleeve rows and what hangs off them go; Base rows and their data stay', () => {
    const db = new Database(':memory:', { strict: true })
    db.exec('PRAGMA foreign_keys = ON')
    for (const f of files) if (f !== mine) db.exec(readFileSync(join(dir, f), 'utf8'))
    db.exec(`INSERT INTO users (user_id, created_at) VALUES ('u1', '2026-10-01')`)
    const acc = (key: string, chain: number, addr: string) => db.exec(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES ('${key}', 'u1', ${chain}, '${addr}', '[]', 'c1', '0x1', '0x2', '1', 'v', '2026-10-01')`)
    acc('base', 8453, '0xa')
    acc('sleeve', 143, '0xa')
    // Any other row off Base (another address) is not one the old flow wrote: it stays.
    db.exec(`INSERT INTO users (user_id, created_at) VALUES ('u2', '2026-10-01')`)
    db.exec(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at) VALUES ('other', 'u2', 143, '0xc', '[]', 'c2', '0x1', '0x2', '1', 'v', '2026-10-01')`)
    for (const k of ['base', 'sleeve']) {
      db.exec(`INSERT INTO proj_account_state (account_key, chain_id, block, block_hash, observed_at, deployed, tokens_json, total_value) VALUES ('${k}', 1, 10, '0xh', 't', 1, '[]', '5')`)
      db.exec(`INSERT INTO account_activity (account_key, day, hits, first_at, last_at) VALUES ('${k}', '2026-10-01', 1, 'a', 'b')`)
    }
    db.exec(readFileSync(join(dir, mine), 'utf8'))
    expect(db.query('SELECT account_key FROM accounts ORDER BY account_key').all()).toEqual([{ account_key: 'base' }, { account_key: 'other' }])
    expect(db.query('SELECT account_key FROM proj_account_state').all()).toEqual([{ account_key: 'base' }])
    expect(db.query('SELECT account_key FROM account_activity').all()).toEqual([{ account_key: 'base' }])
    // A remote row written after the migration survives a second run (it carries its remote_json).
    db.exec(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, policy_version, created_at, remote_json) VALUES ('remote', 'u1', 143, '0xb', '[]', 'c1', '0x1', '0x2', '1', 'v', '2026-10-02', '{}')`)
    db.exec(`DELETE FROM accounts WHERE chain_id <> 8453 AND remote_json IS NULL`)
    expect(db.query('SELECT account_key FROM accounts ORDER BY account_key').all()).toEqual([{ account_key: 'base' }, { account_key: 'remote' }])
  })
})
