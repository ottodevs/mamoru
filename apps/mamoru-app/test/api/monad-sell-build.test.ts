import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, hashTypedData, toFunctionSelector, type Hex } from 'viem'
import type { MonadSellInput } from '@mamoru/domain'
import { ownerSafeTx } from '@mamoru/account/live'
import { buildMonadSell, MONAD_SELL_TWAP_WINDOW_SECONDS, monadSellCalls, monadSellLines, monadSellMinOut, monadSellTwapValue } from '@mamoru/account/return-home'
import { safeTxTypedData } from '@mamoru/account/safe'
import { address, monadRegistry } from '@mamoru/registry'
import { resetOperatorHealth } from '../../src/api/sleeves.ts'
import { harness, ORIGIN, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#428 (spec 014 RH-07; SCN-RH-02, threats S8 and S8a): the owner sale before a return home (step A0) is rebuilt
// by the Worker with buildMonadSell and checked against its own reads of Monad before the owner signs: the Safe's whole
// WMON, a minimum within 30 bps of QuoterV2's answer, an answer within 300 bps of the TWAP value.

const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const MONAD_OPERATOR = 'https://operator-monad.test'
const SLEEVE = `0x${'77'.repeat(20)}` as Hex
const W = 120n * 10n ** 18n
// WMON (token0, 18 decimals) at about 0.03 USDC (token1, 6 decimals).
const TICK = Math.floor(Math.log(0.03e6 / 1e18) / Math.log(1.0001))
const WORTH = monadSellTwapValue(W, TICK, monadRegistry)

const BALANCE_OF = toFunctionSelector('balanceOf(address)')
const OBSERVE = toFunctionSelector('observe(uint32[])')
type Chain = { wmon: bigint; quote: bigint; tick: number | null; down?: boolean }
/** A Monad provider: WMON.balanceOf, the pool's observe (reverting when `tick` is null) and QuoterV2 for anything else. */
const node = (st: Chain, asked: string[] = []) => async (_url: string, init: RequestInit) => {
  if (st.down) throw new TypeError('connect ECONNREFUSED')
  const { params } = JSON.parse(String(init.body)) as { params: [{ to: Hex; data: Hex }] }
  const { to, data } = params[0]
  asked.push(`${to.toLowerCase()} ${data.slice(0, 10)}`)
  const ok = (result: Hex) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
  if (data.startsWith(BALANCE_OF)) return ok(encodeAbiParameters([{ type: 'uint256' }], [st.wmon]))
  if (data.startsWith(OBSERVE)) {
    if (st.tick === null) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'OLD' } }), { headers: { 'content-type': 'application/json' } })
    return ok(encodeAbiParameters([{ type: 'int56[]' }, { type: 'uint160[]' }], [[0n, BigInt(st.tick) * BigInt(MONAD_SELL_TWAP_WINDOW_SECONDS)], [0n, 0n]]))
  }
  return ok(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint160' }, { type: 'uint32' }, { type: 'uint256' }], [st.quote, 1n, 1, 1n]))
}

function world(prepare: () => unknown, st: Partial<Chain> = {}) {
  resetOperatorHealth()
  const seen: string[] = []
  const asked: string[] = []
  const operatorFetch = async (url: string, init?: RequestInit) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
    const who = url.startsWith(MONAD_OPERATOR) ? 'monad' : 'base'
    if (url.endsWith('/health')) return json({ ok: true, chainId: who === 'monad' ? 143 : 8453 })
    seen.push(`${who} ${init?.method ?? 'GET'} ${url.slice(url.indexOf('/monad-sell'))}`)
    if (url.endsWith('/monad-sell/prepare')) return json(prepare())
    return json({ ok: true })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET, OPERATOR_URL_143: `${MONAD_OPERATOR}/`, MONAD_RPC_URLS: 'https://monad-rpc.test' }, operatorFetch, chainFetch: node({ wmon: W, quote: WORTH, tick: TICK, ...st }, asked) })
  h.db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('monad_sleeves', 1, 'ot', 'test', '2026-10-23T00:00:00Z')`).run()
  return {
    seen,
    asked,
    async owner() {
      const res = await register(h, PASSKEY_A)
      const cookie = sessionCookie(res)
      const base = (await res.json()) as { accountKey: string; address: Hex }
      const sleeveKey = crypto.randomUUID()
      h.db.raw
        .query(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, created_at, env, is_test, remote_json)
          SELECT ?, user_id, 143, ?, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, created_at, env, is_test, '{"chainId":143}' FROM accounts WHERE account_key = ?`)
        .run(sleeveKey, SLEEVE, base.accountKey)
      const post = (key: string, path: string) => h.app.request(`${ORIGIN}/api/accounts/${key}${path}`, { method: 'POST', body: '{}', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' } }, h.env)
      return { call: (path: string) => post(sleeveKey, path), callBase: (path: string) => post(base.accountKey, path), base: base.address }
    },
  }
}

/** The Worker's clock in these tests (helpers.ts harness), in unix seconds. */
const NOW = Math.floor(Date.parse('2026-09-26T18:00:00Z') / 1000)
const input = (o: Partial<MonadSellInput> = {}): MonadSellInput => ({ chainId: 143, safe: SLEEVE, safeNonce: '2', amountIn: W.toString(), amountOutMinimum: monadSellMinOut(WORTH).toString(), deadline: String(NOW + 900), ...o })
const linesOf = (i: MonadSellInput) => monadSellLines(BigInt(i.amountIn), BigInt(i.amountOutMinimum))
const offer = (i: MonadSellInput, hash?: string, summary: unknown = linesOf(i)) => ({ safe: i.safe, chainId: i.chainId, safeTxHash: hash ?? buildMonadSell(i, monadRegistry).safeTxHash, summary, expiresAt: 'x', prepareId: 'p1', monadSell: i })
const refused = async (res: Response, status = 502, code = 'BUILD_MISMATCH') => {
  expect(res.status).toBe(status)
  const body = (await res.json()) as { code: string; monadSell?: unknown; safeTxHash?: unknown }
  expect(body.code).toBe(code)
  // Nothing to sign reaches the browser.
  expect(body.monadSell).toBeUndefined()
  expect(body.safeTxHash).toBeUndefined()
}

describe('monad-sell/prepare is rebuilt and priced by the Worker (#428, RH-07)', () => {
  test("the builder's sale of the Safe's whole WMON at a fair minimum: passed on, read from the Worker's own provider", async () => {
    const w = world(() => offer(input()))
    const { call } = await w.owner()
    const res = await call('/monad-sell/prepare')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { monadSell: MonadSellInput }).monadSell).toEqual(input())
    // No fence for a sale (nothing leaves the Safe): only the Monad operator is asked.
    expect(w.seen).toEqual(['monad POST /monad-sell/prepare'])
    expect(w.asked.map((a) => a.split(' ')[0])).toEqual([address('WMON', monadRegistry), address('QuoterV2', monadRegistry), address('pool:WMON/USDC/3000', monadRegistry)].map((a) => a.toLowerCase()))
  })

  /** The SafeTx hash of the sale's calls with one of them replaced: what an operator would offer for a tx the builder does not make. */
  const tamperedHash = (i: MonadSellInput, change: (calls: ReturnType<typeof monadSellCalls>) => ReturnType<typeof monadSellCalls>): Hex =>
    hashTypedData(safeTxTypedData(i.safe as Hex, i.chainId, ownerSafeTx(change(monadSellCalls(i, monadRegistry)), BigInt(i.safeNonce), monadRegistry)))
  const ATTACKER = `0x${'99'.repeat(20)}` as Hex

  test.each([
    ['another Safe', () => offer(input({ safe: `0x${'66'.repeat(20)}` }))],
    ['another chain named by the prepare', () => ({ ...offer(input()), chainId: 8453 })],
    ['a hash the input does not give', () => offer(input(), `0x${'12'.repeat(32)}`)],
    ['no input', () => ({ ...offer(input()), monadSell: undefined })],
    ['the proceeds paid to another recipient', () => offer(input(), tamperedHash(input(), (c) => [c[0]!, c[1]!, { ...c[2]!, data: c[2]!.data.replace(SLEEVE.slice(2), ATTACKER.slice(2)) as Hex }, c[3]!]))],
    ['another router', () => offer(input(), tamperedHash(input(), (c) => [c[0]!, c[1]!, { ...c[2]!, to: ATTACKER }, c[3]!]))],
    ['another token sold', () => offer(input(), tamperedHash(input(), (c) => [c[0]!, { ...c[1]!, to: address('USDC', monadRegistry) }, c[2]!, c[3]!]))],
    ['an extra call in the batch', () => offer(input(), tamperedHash(input(), (c) => [...c, { to: ATTACKER, value: 0n, data: '0x' as Hex }]))],
    ['no minimum', () => offer(input({ amountOutMinimum: '0' }), `0x${'12'.repeat(32)}`)],
    ['the deadline check dropped from the batch', () => offer(input(), tamperedHash(input(), (c) => c.slice(1)))],
    ['a deadline already passed', () => offer(input({ deadline: String(NOW) }))],
    ['a deadline more than 20 minutes ahead', () => offer(input({ deadline: String(NOW + 1201) }))],
    ['no deadline', () => offer({ ...input(), deadline: undefined } as unknown as MonadSellInput, `0x${'12'.repeat(32)}`)],
    ['a summary that names a smaller sale', () => offer(input(), undefined, monadSellLines(W / 10n, monadSellMinOut(WORTH)))],
    ['a summary that names a higher minimum than the transaction carries', () => offer(input(), undefined, monadSellLines(W, WORTH * 2n))],
    ['the summary of another kind of approval', () => offer(input(), undefined, ["Renew Mamoru's approval on your Safe"])],
    ['no summary', () => offer(input(), undefined, null)],
  ])('%s: refused (BUILD_MISMATCH), nothing to sign', async (_why, prepare) => {
    const w = world(prepare)
    const { call } = await w.owner()
    await refused(await call('/monad-sell/prepare'))
  })

  test.each([
    ['amountIn under the Safe\'s WMON (some left behind)', {}, { wmon: W + 1n }],
    ['amountIn over the Safe\'s WMON (reverts)', {}, { wmon: W - 1n }],
    ['a minimum more than 30 bps under the Worker\'s quote', { amountOutMinimum: (monadSellMinOut(WORTH) - 1n).toString() }, {}],
    ['the Worker\'s quote is higher than the operator\'s: its minimum is too low now', {}, { quote: WORTH + WORTH / 100n }],
    ['a quote more than 300 bps under the TWAP value (the pool is too shallow)', { amountOutMinimum: monadSellMinOut((WORTH * 9_699n) / 10_000n).toString() }, { quote: (WORTH * 9_699n) / 10_000n }],
  ] as [string, Partial<MonadSellInput>, Partial<Chain>][])('%s: refused (BUILD_MISMATCH)', async (_why, o, st) => {
    const w = world(() => offer(input(o)), st)
    const { call } = await w.owner()
    await refused(await call('/monad-sell/prepare'))
  })

  test('a quote exactly 300 bps under the TWAP value with its own minimum: passed on', async () => {
    const quote = (WORTH * 9_700n) / 10_000n + 1n
    const w = world(() => offer(input({ amountOutMinimum: monadSellMinOut(quote).toString() })), { quote })
    const { call } = await w.owner()
    expect((await call('/monad-sell/prepare')).status).toBe(200)
  })

  test.each([
    ['the provider is down', { down: true }],
    ['the pool has no TWAP for the window', { tick: null }],
  ] as [string, Partial<Chain>][])('%s: 503 RETURN_HOME_CHECK_UNAVAILABLE, nothing to sign', async (_why, st) => {
    const w = world(() => offer(input()), st)
    const { call } = await w.owner()
    await refused(await call('/monad-sell/prepare'), 503, 'RETURN_HOME_CHECK_UNAVAILABLE')
  })

  test('through a Base account: refused (the sale exists on the Monad Safe only)', async () => {
    const w = world(() => offer(input()))
    const { callBase } = await w.owner()
    await refused(await callBase('/monad-sell/prepare'))
  })

  test("the operator's own refusal (409 MONAD_DEPTH_TOO_LOW) is passed on as it is", async () => {
    resetOperatorHealth()
    const operatorFetch = async (url: string) => {
      if (url.endsWith('/health')) return new Response(JSON.stringify({ ok: true, chainId: url.startsWith(MONAD_OPERATOR) ? 143 : 8453 }), { headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ error: 'the pool on Monad is too shallow', code: 'MONAD_DEPTH_TOO_LOW' }), { status: 409, headers: { 'content-type': 'application/json' } })
    }
    const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET, OPERATOR_URL_143: `${MONAD_OPERATOR}/`, MONAD_RPC_URLS: 'https://monad-rpc.test' }, operatorFetch, chainFetch: node({ wmon: W, quote: WORTH, tick: TICK }) })
    h.db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('monad_sleeves', 1, 'ot', 'test', '2026-10-23T00:00:00Z')`).run()
    const reg = await register(h, PASSKEY_A)
    const base = (await reg.clone().json()) as { accountKey: string }
    const sleeveKey = crypto.randomUUID()
    h.db.raw
      .query(`INSERT INTO accounts (account_key, user_id, chain_id, address, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, created_at, env, is_test, remote_json)
        SELECT ?, user_id, 143, ?, owners_json, passkey_credential_id, passkey_x, passkey_y, salt_nonce, preset, policy_version, created_at, env, is_test, '{"chainId":143}' FROM accounts WHERE account_key = ?`)
      .run(sleeveKey, SLEEVE, base.accountKey)
    const res = await h.app.request(`${ORIGIN}/api/accounts/${sleeveKey}/monad-sell/prepare`, { method: 'POST', body: '{}', headers: { cookie: sessionCookie(reg), origin: ORIGIN, 'content-type': 'application/json' } }, h.env)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('MONAD_DEPTH_TOO_LOW')
  })
})
