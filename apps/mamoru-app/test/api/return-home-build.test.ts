import { describe, expect, test } from 'bun:test'
import { encodeAbiParameters, encodeFunctionData, hashTypedData, pad, toFunctionSelector, type Hex } from 'viem'
import type { ReturnHomeInput } from '@mamoru/domain'
import { ownerSafeTx } from '@mamoru/account/live'
import { buildReturnHome, returnHomeCalls, returnHomeLines, TOKEN_MESSENGER_V2 } from '@mamoru/account/return-home'
import { safeTxTypedData } from '@mamoru/account/safe'
import { address, monadRegistry, tokenMessengerV2Abi } from '@mamoru/registry'
import { resetOperatorHealth } from '../../src/api/sleeves.ts'
import { harness, ORIGIN, PASSKEY_A, register, sessionCookie } from './helpers.ts'

// otto/mamoru#428 (spec 014, step 1 of leaving Monad): the Worker rebuilds a return home with buildReturnHome before the
// owner signs it, and passes it on only when it burns from the row's own Monad Safe to the owner's own Base Safe.

const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const MONAD_OPERATOR = 'https://operator-monad.test'
const SLEEVE = `0x${'77'.repeat(20)}` as Hex

const SESSION = `0x${'01'.repeat(32)}` as Hex
const BALANCE = 28_850_000n
const GET_PERMISSION_IDS = toFunctionSelector('getPermissionIDs(address)')
/** A Monad provider: SmartSession.getPermissionIDs answers `enabled`, any other eth_call (USDC.balanceOf) `usdc`; down when `usdc` is null. */
const WMON = address('WMON', monadRegistry).toLowerCase()
const node = (usdc: bigint | null, enabled: Hex[], wmon = 0n) => async (_url: string, init: RequestInit) => {
  if (usdc === null) throw new TypeError('connect ECONNREFUSED')
  const { params } = JSON.parse(String(init.body)) as { params: [{ to: Hex; data: Hex }] }
  const result = params[0].data.startsWith(GET_PERMISSION_IDS) ? encodeAbiParameters([{ type: 'bytes32[]' }], [enabled]) : encodeAbiParameters([{ type: 'uint256' }], [params[0].to.toLowerCase() === WMON ? wmon : usdc])
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } })
}

type Fence = () => Response | Promise<Response>
const jsonRes = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

function world(prepare: (home: Hex) => unknown, chainState: { usdc: bigint | null; enabled: Hex[]; wmon?: bigint } = { usdc: BALANCE, enabled: [SESSION] }, fence: Fence = () => jsonRes({ fenced: true, at: 't' })) {
  resetOperatorHealth()
  let home: Hex = '0x0000000000000000000000000000000000000000'
  /** Every operator request, in order: `base` or `monad`, and its path after the account key. */
  const seen: string[] = []
  const operatorFetch = async (url: string, init?: RequestInit) => {
    const json = (b: unknown) => jsonRes(b)
    const who = url.startsWith(MONAD_OPERATOR) ? 'monad' : 'base'
    if (url.endsWith('/health')) return json({ ok: true, chainId: who === 'monad' ? 143 : 8453 })
    seen.push(`${who} ${init?.method ?? 'GET'} ${url.slice(url.indexOf('/return-home'))}`)
    if (url.endsWith('/return-home/fence')) return fence()
    if (url.endsWith('/return-home/prepare')) return json(prepare(home))
    return json({ ok: true })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.test', OPERATOR_SECRET, OPERATOR_URL_143: `${MONAD_OPERATOR}/`, MONAD_RPC_URLS: 'https://monad-rpc.test' }, operatorFetch, chainFetch: node(chainState.usdc, chainState.enabled, chainState.wmon) })
  h.db.raw.query(`INSERT INTO ops_flag_changes (flag, enabled, author, reason, created_at) VALUES ('monad_sleeves', 1, 'ot', 'test', '2026-10-23T00:00:00Z')`).run()
  return {
    h,
    seen,
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

const input = (home: Hex, o: Partial<ReturnHomeInput> = {}): ReturnHomeInput => ({ chainId: 143, safe: SLEEVE, safeNonce: '2', home, amountUsdc: BALANCE.toString(), removeIds: [SESSION], ...o })
/** The lines the operator writes for `i` on a Safe holding `wmon` (planReturnHome). */
const linesOf = (i: ReturnHomeInput, wmon = 0n) => returnHomeLines({ sessions: i.removeIds.length, usdc: BigInt(i.amountUsdc), home: i.home, ...(wmon > 10n ** 16n ? { wmonStays: wmon } : {}) })
const offer = (i: ReturnHomeInput, hash?: string, summary: unknown = linesOf(i)) => ({ safe: i.safe, chainId: i.chainId, safeTxHash: hash ?? buildReturnHome(i, monadRegistry).safeTxHash, summary, expiresAt: 'x', prepareId: 'p1', returnHome: i })

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

  // SCN-RH-01 (RH-03, threats S2): the same recipient and amount with a caller restriction, or through depositForBurnWithHook,
  // is another Safe tx: the hash the operator would have to offer is not the builder's.
  test.each([
    ['a destinationCaller', (i: ReturnHomeInput) => tampered(i, (args) => encodeFunctionData({ abi: tokenMessengerV2Abi, functionName: 'depositForBurn', args: [args.amount, 6, pad(i.home as Hex, { size: 32 }), args.usdc, pad('0x99', { size: 32 }), 0n, 2000] }))],
    ['a hook', (i: ReturnHomeInput) => tampered(i, (args) => encodeFunctionData({ abi: HOOK_ABI, functionName: 'depositForBurnWithHook', args: [args.amount, 6, pad(i.home as Hex, { size: 32 }), args.usdc, `0x${'00'.repeat(32)}`, 0n, 2000, '0x1234'] }))],
  ])('%s: refused (BUILD_MISMATCH)', async (_why, hashOf) => {
    const w = world((home) => offer(input(home), hashOf(input(home))))
    const { call } = await w.owner()
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
  })
})

const HOOK_ABI = [{ type: 'function', name: 'depositForBurnWithHook', stateMutability: 'nonpayable', inputs: [{ type: 'uint256' }, { type: 'uint32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'bytes' }], outputs: [] }] as const
/** The SafeTx hash of `i` with its burn call replaced by `burn`: what an operator would offer for a tx the builder does not make. */
function tampered(i: ReturnHomeInput, burn: (a: { amount: bigint; usdc: Hex }) => Hex): Hex {
  const calls = returnHomeCalls(i, monadRegistry)
  const last = calls[calls.length - 1]!
  expect(last.to).toBe(TOKEN_MESSENGER_V2)
  const swapped = [...calls.slice(0, -1), { ...last, data: burn({ amount: BigInt(i.amountUsdc), usdc: calls[calls.length - 2]!.to as Hex }) }]
  return hashTypedData(safeTxTypedData(i.safe as Hex, i.chainId, ownerSafeTx(swapped, BigInt(i.safeNonce), monadRegistry)))
}

describe('return-home/prepare is checked against the chain by the Worker (#428, RH-03)', () => {
  const S2 = `0x${'02'.repeat(32)}` as Hex
  test.each([
    ['less than the Safe holds (funds left behind)', { usdc: BALANCE + 1n, enabled: [SESSION] }, {}],
    ['more than the Safe holds (reverts)', { usdc: BALANCE - 1n, enabled: [SESSION] }, {}],
    ['an enabled session missing from removeIds', { usdc: BALANCE, enabled: [SESSION, S2] }, {}],
    ['a session the Safe does not have enabled', { usdc: BALANCE, enabled: [SESSION] }, { removeIds: [SESSION, S2] }],
    ['no session removed while one is enabled', { usdc: BALANCE, enabled: [SESSION] }, { removeIds: [] }],
  ] as const)('%s: refused (BUILD_MISMATCH), nothing to sign', async (_why, chainState, o) => {
    const w = world((home) => offer(input(home, o as Partial<ReturnHomeInput>)), { usdc: chainState.usdc, enabled: [...chainState.enabled] })
    const { call } = await w.owner()
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
  })

  test("the owner's Base Safe is in another environment: refused (BUILD_MISMATCH)", async () => {
    const w = world((home) => offer(input(home)))
    const { call } = await w.owner()
    const env = (w.h.db.raw.query('SELECT env FROM accounts WHERE chain_id = 8453').get() as { env: string }).env
    w.h.db.raw.query('UPDATE accounts SET env = ? WHERE chain_id = 8453').run(env === 'prod' ? 'beta' : 'prod')
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
  })

  test('a send-only step (no session left on the Safe) passes with an empty removeIds', async () => {
    const w = world((home) => offer(input(home, { removeIds: [] })), { usdc: BALANCE, enabled: [] })
    const { call } = await w.owner()
    expect((await call('/return-home/prepare')).status).toBe(200)
  })

  test('a revoke-only step (no USDC) passes with amount 0', async () => {
    const w = world((home) => offer(input(home, { amountUsdc: '0' })), { usdc: 0n, enabled: [SESSION] })
    const { call } = await w.owner()
    expect((await call('/return-home/prepare')).status).toBe(200)
  })

  test('the chain cannot be read: 503 RETURN_HOME_CHECK_UNAVAILABLE, nothing to sign', async () => {
    const w = world((home) => offer(input(home)), { usdc: null, enabled: [] })
    const { call } = await w.owner()
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; returnHome?: unknown }
    expect(body.code).toBe('RETURN_HOME_CHECK_UNAVAILABLE')
    expect(body.returnHome).toBeUndefined()
  })
})

describe('what the owner reads is the transaction the Worker checked (#428, review r1)', () => {
  const expectRefused = async (res: Response) => {
    expect(res.status).toBe(502)
    expect(((await res.json()) as { code: string }).code).toBe('BUILD_MISMATCH')
  }
  test.each([
    ['a smaller amount in the text than the burn', (i: ReturnHomeInput) => linesOf({ ...i, amountUsdc: '2885000' })],
    ['another destination in the text', (i: ReturnHomeInput) => linesOf({ ...i, home: `0x${'99'.repeat(20)}` })],
    ['the revocation left out of the text', (i: ReturnHomeInput) => linesOf(i).slice(1)],
    ['an extra line', (i: ReturnHomeInput) => [...linesOf(i), 'Nothing else changes']],
    ['the text of another kind of approval', () => ["Renew Mamoru's approval on your Safe"]],
    ['no summary', () => null],
  ])('%s: refused (BUILD_MISMATCH), nothing to sign', async (_why, summary) => {
    const w = world((home) => offer(input(home), undefined, summary(input(home))))
    const { call } = await w.owner()
    await expectRefused(await call('/return-home/prepare'))
  })

  test('WMON above dust stays on the Safe: passed on only when the summary says so', async () => {
    const W = 120n * 10n ** 18n
    const silent = world((home) => offer(input(home)), { usdc: BALANCE, enabled: [SESSION], wmon: W })
    await expectRefused(await (await silent.owner()).call('/return-home/prepare'))
    const said = world((home) => offer(input(home), undefined, linesOf(input(home), W)), { usdc: BALANCE, enabled: [SESSION], wmon: W })
    const res = await (await said.owner()).call('/return-home/prepare')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { summary: string[] }).summary).toContain('Your 120 WMON stays in this Safe: it cannot be sold at a fair price right now. You can withdraw it')
    // And the line is refused where no WMON stays.
    const lied = world((home) => offer(input(home), undefined, linesOf(input(home), W)))
    await expectRefused(await (await lied.owner()).call('/return-home/prepare'))
  })
})

describe('the Base fence comes before the Monad prepare (#428, RH-11)', () => {
  test('fence on the Base operator for the owner\'s Base account, then the Monad prepare', async () => {
    const w = world((home) => offer(input(home)))
    const { call } = await w.owner()
    expect((await call('/return-home/prepare')).status).toBe(200)
    expect(w.seen).toEqual(['base POST /return-home/fence', 'monad POST /return-home/prepare'])
  })

  test('a bridge to Monad still in flight: the Base operator\'s 409 BRIDGE_IN_FLIGHT is passed on and Monad is never asked', async () => {
    const w = world((home) => offer(input(home)), undefined, () => jsonRes({ error: 'a transfer to your Safe on Monad is still on its way', code: 'BRIDGE_IN_FLIGHT' }, 409))
    const { call } = await w.owner()
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('BRIDGE_IN_FLIGHT')
    expect(w.seen).toEqual(['base POST /return-home/fence'])
  })

  test.each([
    ['the Base operator is down', () => { throw new TypeError('connect ECONNREFUSED') }],
    ['the Base operator does not know the route (an older one)', () => jsonRes({ error: 'not found' }, 404)],
    ['the Base operator fails', () => jsonRes({ error: 'x', code: 'REMOTE_UNAVAILABLE' }, 503)],
    ['an answer that does not say fenced', () => jsonRes({ ok: true })],
    ['an answer that is not JSON', () => new Response('ok')],
  ] as [string, Fence][])('%s: 503, nothing prepared', async (_why, fence) => {
    const w = world((home) => offer(input(home)), undefined, fence)
    const { call } = await w.owner()
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(503)
    expect(((await res.json()) as { code: string }).code).toBe('OPERATOR_UNAVAILABLE')
    expect(w.seen).toEqual(['base POST /return-home/fence'])
  })

  test('no Base account of this owner in the same environment: refused before any operator is asked', async () => {
    const w = world((home) => offer(input(home)))
    const { call } = await w.owner()
    const env = (w.h.db.raw.query('SELECT env FROM accounts WHERE chain_id = 8453').get() as { env: string }).env
    w.h.db.raw.query('UPDATE accounts SET env = ? WHERE chain_id = 8453').run(env === 'prod' ? 'beta' : 'prod')
    const res = await call('/return-home/prepare')
    expect(res.status).toBe(502)
    expect(w.seen).toEqual([])
  })

  test('the signed submit is not fenced again: it goes to the Monad operator alone', async () => {
    const w = world((home) => offer(input(home)))
    const { call } = await w.owner()
    expect((await call('/return-home')).status).toBe(200)
    expect(w.seen).toEqual(['monad POST /return-home'])
  })
})
