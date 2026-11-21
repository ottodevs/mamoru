import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import type { ReturnHomeInput } from '@mamoru/domain'
import { buildReturnHome } from '@mamoru/account/return-home'
import { monadRegistry } from '@mamoru/registry'
import { resetOperatorHealth } from '../../src/api/sleeves.ts'
import { harness, ORIGIN, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#428 (spec 014, step 1 of leaving Monad): the Worker rebuilds a return home with buildReturnHome before the
// owner signs it, and passes it on only when it burns from the row's own Monad Safe to the owner's own Base Safe.

const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const MONAD_OPERATOR = 'https://operator-monad.test'
const SLEEVE = `0x${'77'.repeat(20)}` as Hex

function world(prepare: (home: Hex) => unknown) {
  resetOperatorHealth()
  let home: Hex = '0x0000000000000000000000000000000000000000'
  const operatorFetch = async (url: string) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
    if (url.endsWith('/health')) return json({ ok: true, chainId: url.startsWith(MONAD_OPERATOR) ? 143 : 8453 })
    if (url.endsWith('/return-home/prepare')) return json(prepare(home))
    return json({ ok: true })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET, OPERATOR_URL_143: `${MONAD_OPERATOR}/` }, operatorFetch })
  h.db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('monad_sleeves', 1, 'ot', 'test', '2026-10-23T00:00:00Z')`).run()
  return {
    h,
    async owner() {
      const res = await register(h, PASSKEY_A)
      const cookie = sessionCookie(res)
      const base = (await res.json()) as { accountKey: string; address: Hex }
      home = base.address
      const sleeveKey = crypto.randomUUID()
      h.db.raw
        .query(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, created_at, env, is_test, remote_json)
          SELECT ?, user_id, 143, ?, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, created_at, env, is_test, '{"chainId":143}' FROM accounts WHERE account_key = ?`)
        .run(sleeveKey, SLEEVE, base.accountKey)
      const call = (path: string) => h.app.request(`${ORIGIN}/api/accounts/${sleeveKey}${path}`, { method: 'POST', body: JSON.stringify({ home }), headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } }, h.env)
      return { call, home: base.address }
    },
  }
}

const input = (home: Hex, o: Partial<ReturnHomeInput> = {}): ReturnHomeInput => ({ chainId: 143, safe: SLEEVE, safeNonce: '2', home, amountUsdc: '28850000', removeIds: [`0x${'01'.repeat(32)}`], ...o })
const offer = (i: ReturnHomeInput, hash?: string) => ({ safe: i.safe, chainId: i.chainId, safeTxHash: hash ?? buildReturnHome(i, monadRegistry).safeTxHash, summary: [], expiresAt: 'x', prepareId: 'p1', returnHome: i })

describe('return-home/prepare is rebuilt by the Worker (#428)', () => {
  test("the builder's tx, from the row's own Monad Safe to the owner's Base Safe: passed on", async () => {
    const w = world((home) => offer(input(home)))
    const { call } = await w.owner()
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { returnHome: ReturnHomeInput }).returnHome.safe).toBe(SLEEVE)
  })

  test.each([
    ['another home', (home: Hex) => offer(input(home, { home: `0x${'99'.repeat(20)}` }))],
    ['another Safe', (home: Hex) => offer(input(home, { safe: `0x${'66'.repeat(20)}` }))],
    ['another chain', (home: Hex) => ({ ...offer(input(home)), chainId: 8453 })],
    ['a hash the input does not give', (home: Hex) => offer(input(home), `0x${'12'.repeat(32)}`)],
    ['no input', (home: Hex) => ({ ...offer(input(home)), returnHome: undefined })],
  ])('%s: refused (BUILD_MISMATCH), nothing to sign', async (_why, prepare) => {
    const w = world(prepare)
    const { call } = await w.owner()
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
  })
})
