import { describe, expect, test } from 'bun:test'
import type { MigrateV4Input, OwnerTxToSign, RemoteSpec } from '@mamoru/domain'
import { liveWmonUsdcMonadV6, ONE_AUTH_V4_REMOTE, v4CapUsdOf, V4_REVOKE_FLAG } from '@mamoru/policy'
import { remoteInput, remoteSafe, v4RemoteFromSpec } from '@mamoru/account/remote'
import { buildMigrateV4 } from '@mamoru/account/one-auth'
import { registryFor, type Registry } from '@mamoru/registry'
import type { Address, Hex } from 'viem'
import { withPinnedV3 } from '../../../../packages/account/remote/fixture.ts'
import { accountContext } from '../../src/api/accounts/operator.ts'
import type { AccountRow } from '../../src/api/accounts/store.ts'
import { upsertRemoteSleeve, type RemoteOffer } from '../../src/api/remote.ts'
import { harness, PASSKEY_A, PASSKEY_B, register, sessionCookie } from './helpers.ts'

// otto/mamoru#295 x #293: the Worker rebuilds a migrate-v4 prepare with buildMigrateV4 from the input it carries, after
// validating every input field against what it knows itself, and requires the same hash and the same fields.

const BASE_OP = 'https://operator.test'
const OPERATOR_SECRET = 'operator-secret-for-tests-only-0123456789'
const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const ID = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex
const V4 = [A(0xa1), A(0xa2), A(0xa3), A(0xa4)]
const withV4 = (r: Registry): Registry => ({
  ...r,
  entries: [...r.entries, ...(['MamoruRegistry', 'MamoruActionPolicyV4', 'MamoruGasPolicyV2', 'MamoruMigrationCheck'] as const).map((name, i) => ({ name, kind: 'smart-sessions-policy', role: 't', address: V4[i]!, codeHash: null }) as never)],
})
const registry = (chainId: number) => withV4(chainId === 143 ? withPinnedV3() : registryFor(chainId))
const unpinned = (chainId: number) => (chainId === 143 ? withPinnedV3() : registryFor(chainId))
const OLD_SPEC: RemoteSpec = { chainId: 143, policyId: liveWmonUsdcMonadV6.policyId, sessionKey: A(0xbeef), validAfter: 1_790_000_000, validUntil: 1_821_536_000, capUsdc: '1500000000' }
const CAP = '100000000' // the account's D1 cap
const BASE_CAP = v4CapUsdOf(BigInt(CAP)).toString() // the C the Base step signs, from the shared policy function
const KEY = A(0x5e55e5)
const ELSEWHERE = A(0xbad01)
const TOKEN = registry(143).entries.find((e) => e.kind === 'token')!.address

async function world(registryOf: (c: number) => Registry = registry) {
  let prepare: unknown = {}
  const operatorFetch = async (url: string, init: RequestInit) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { headers: { 'content-type': 'application/json' } })
    return init.method === 'POST' && url.endsWith('/prepare') ? json(prepare) : json({ ok: true })
  }
  const h = harness(undefined, { env: { LIVE_FUNDS: '1', OPERATOR_URL: BASE_OP, OPERATOR_SECRET }, operatorFetch, remoteRegistry: registryOf })
  const mk = async (passkey: typeof PASSKEY_A) => {
    const res = await register(h, passkey)
    const { accountKey } = (await res.json()) as { accountKey: string }
    const base = h.db.raw.query('SELECT * FROM accounts WHERE account_key = ?').get(accountKey) as AccountRow
    const oldOffer: RemoteOffer = { chainId: 143, address: remoteSafe(remoteInput(accountContext(base), OLD_SPEC, registry(143))).address as RemoteOffer['address'], spec: OLD_SPEC }
    await upsertRemoteSleeve(h.db, base, oldOffer, new Date())
    const old = h.db.raw.query('SELECT * FROM accounts WHERE account_key = ?').get(`${accountKey}@143`) as AccountRow
    return { cookie: sessionCookie(res), accountKey, base, old }
  }
  const a = await mk(PASSKEY_A)
  const b = await mk(PASSKEY_B)
  const rows = () => JSON.stringify(h.db.raw.query('SELECT account_key, address, remote_json FROM accounts ORDER BY account_key').all())
  const post = (step: number, tx: unknown) => {
    prepare = tx
    return h.app.request(`https://app.mamoru.lol/api/accounts/${a.accountKey}/migrate-v4/prepare`, { method: 'POST', body: JSON.stringify({ step }), headers: { cookie: a.cookie, origin: 'https://app.mamoru.lol', 'content-type': 'application/json' } }, h.env)
  }
  // The V4 remote Safe this account's own keys give (what V4's remoteOf(account, 15) is).
  const destSpec = (sessionKey: Address = KEY): RemoteSpec => ({ chainId: 143, policyId: ONE_AUTH_V4_REMOTE, sessionKey, validAfter: 0, validUntil: 0, capUsdc: BASE_CAP, home: a.base.address as Address, homeDomain: 6 })
  const dest = v4RemoteFromSpec(accountContext(a.base), destSpec(), registry(143)).address
  return { a, b, post, rows, dest, destSpec }
}
type W = Awaited<ReturnType<typeof world>>

const input0 = (w: W, o: Partial<MigrateV4Input> = {}): MigrateV4Input => ({ chainId: 8453, safe: w.a.base.address as Address, safeNonce: '4', step: 0, capUsdc: BASE_CAP, sessionKey: KEY, generation: '1', admit: ['7'], oldPermissionIds: [ID(1), ID(2)], removeIds: [ID(1)], noncesBefore: ['0', '3'], home: A(0), homeDomain: 0, ...o })
const input1 = (w: W, o: Partial<MigrateV4Input> = {}): MigrateV4Input => ({
  chainId: 143, safe: w.a.old.address as Address, safeNonce: '9', step: 1, capUsdc: '1', sessionKey: KEY, generation: '1', admit: [], oldPermissionIds: [ID(3)], removeIds: [ID(3)], noncesBefore: ['1'],
  home: w.a.base.address as Address, homeDomain: 6, moveTo: w.dest, transfers: [{ token: TOKEN, amount: '1000000' }], ...o,
})
/** The prepare an honest operator answers: everything from `buildMigrateV4`. */
const prepareOf = (input: MigrateV4Input, over: Partial<OwnerTxToSign> = {}): OwnerTxToSign => {
  const b = buildMigrateV4(input, registry(input.chainId))
  return { safe: input.safe, chainId: input.chainId, safeTxHash: b.safeTxHash, summary: ['x'], expiresAt: 'x', prepareId: 'p', step: input.step, ...(input.moveTo ? { moveTo: input.moveTo } : {}), safeTx: b.safeTx, input, ...over } as OwnerTxToSign
}
/** An operator that answers with an honest build but names another input (the Worker judges the input it carries). */
const forged = (honest: MigrateV4Input, tampered: MigrateV4Input, over: Partial<OwnerTxToSign> = {}): OwnerTxToSign => ({ ...prepareOf(honest), input: tampered, ...over })
const refused = async (res: Response | Promise<Response>) => {
  const r = await res
  expect(r.status).toBe(502)
  expect(((await r.json()) as { code: string }).code).toBe('MIGRATE_TX_MISMATCH')
}

describe('happy paths', () => {
  test('Base step: passes through untouched', async () => {
    const w = await world()
    const tx = prepareOf(input0(w))
    const res = await w.post(0, tx)
    expect(res.status).toBe(200)
    expect(((await res.json()) as OwnerTxToSign).safeTxHash).toBe(tx.safeTxHash)
  })

  test("Monad step: the account's own pre-V4 Safe, moving funds to the remote Safe its keys give", async () => {
    const w = await world()
    expect((await w.post(1, prepareOf(input1(w)))).status).toBe(200)
  })

  test('step 1 of a Safe with nothing to move: no transfers and no destination, accepted (what the operator emits)', async () => {
    const w = await world()
    const honest = input1(w, { moveTo: undefined, transfers: undefined })
    expect((await w.post(1, prepareOf(honest))).status).toBe(200)
  })

  test('the id lists are not checked: on chain assertMigrated reads getPermissionIDs and reverts unless only V4 is enabled', async () => {
    const w = await world()
    expect((await w.post(0, prepareOf(input0(w, { removeIds: [], oldPermissionIds: [], noncesBefore: [] })))).status).toBe(200)
    expect((await w.post(0, prepareOf(input0(w, { sessionKey: ELSEWHERE })))).status).toBe(200)
  })
})

describe('fail closed', () => {
  test('V4 contracts not pinned in the registry json: nothing is accepted', async () => {
    const w = await world(unpinned)
    await refused(w.post(0, prepareOf(input0(w))))
    await refused(w.post(1, prepareOf(input1(w))))
  })

  test('no input, or no Safe transaction: refused', async () => {
    const w = await world()
    const noInput = prepareOf(input0(w)) as Record<string, unknown>
    delete noInput.input
    await refused(w.post(0, noInput))
    const noTx = prepareOf(input0(w)) as Record<string, unknown>
    delete noTx.safeTx
    await refused(w.post(0, noTx))
  })
})

describe('a tampered Safe transaction', () => {
  test('any field changed after the hash was made, or the hash itself', async () => {
    const w = await world()
    const honest = prepareOf(input0(w))
    const with_ = (k: string, v: string) => ({ ...honest, safeTx: { ...honest.safeTx!, [k]: v } })
    await refused(w.post(0, with_('data', `${honest.safeTx!.data}00`)))
    await refused(w.post(0, with_('nonce', '5')))
    await refused(w.post(0, with_('to', ELSEWHERE)))
    await refused(w.post(0, with_('operation', '0' as never)))
    await refused(w.post(0, with_('value', '1')))
    await refused(w.post(0, with_('gasPrice', '1')))
    await refused(w.post(0, with_('baseGas', '100000')))
    await refused(w.post(0, with_('refundReceiver', ELSEWHERE)))
    await refused(w.post(0, with_('gasToken', ELSEWHERE)))
    await refused(w.post(0, { ...honest, safeTxHash: `0x${'ab'.repeat(32)}` }))
  })

  test('calldata that is not what the input builds (a decoy, however well formed)', async () => {
    const w = await world()
    const other = buildMigrateV4(input0(w, { admit: ['8'] }), registry(8453))
    await refused(w.post(0, { ...prepareOf(input0(w)), safeTx: other.safeTx, safeTxHash: other.safeTxHash }))
  })
})

describe('the cap each step signs, from the shared policy function', () => {
  test('the raw D1 cap is not the Base C; the retired Safe signs one unit', async () => {
    const w = await world()
    await refused(w.post(0, prepareOf(input0(w, { capUsdc: CAP }))))
    await refused(w.post(0, prepareOf(input0(w, { capUsdc: '1' }))))
    await refused(w.post(1, prepareOf(input1(w, { capUsdc: BASE_CAP }))))
    await refused(w.post(1, prepareOf(input1(w, { capUsdc: CAP }))))
  })

  test('the destination is derived with the Base C, not the retired Safe\'s unit', async () => {
    const w = await world()
    const wrong = v4RemoteFromSpec(accountContext(w.a.base), { ...w.destSpec(), capUsdc: '1' }, registry(143)).address
    await refused(w.post(1, prepareOf(input1(w, { moveTo: wrong }))))
  })
})

describe('admit', () => {
  test('an entry with the revoke flag (bit 255) is refused; a plain position id passes', async () => {
    const w = await world()
    const flagged = ((1n << 255n) | 777n).toString()
    expect(V4_REVOKE_FLAG).toBe(1n << 255n)
    await refused(w.post(0, prepareOf(input0(w, { admit: ['7', flagged] }))))
    await refused(w.post(1, prepareOf(input1(w, { admit: [flagged] }))))
    expect((await w.post(0, prepareOf(input0(w, { admit: ['7', '8'] })))).status).toBe(200)
  })
})

describe('a tampered input', () => {
  test('safe, cap, home, chain and step on the Base step', async () => {
    const w = await world()
    await refused(w.post(0, prepareOf(input0(w, { safe: ELSEWHERE }))))
    await refused(w.post(0, prepareOf(input0(w, { capUsdc: '999000000' }))))
    await refused(w.post(0, forged(input0(w), input0(w, { home: w.a.base.address as Address }))))
    await refused(w.post(0, forged(input0(w), input0(w, { step: 1 }))))
    await refused(w.post(0, forged(input0(w), input0(w, { chainId: 143 }))))
    // The hash of a transaction on the right Safe but a prepare that names another Safe at the top.
    await refused(w.post(0, { ...prepareOf(input0(w)), safe: ELSEWHERE }))
  })

  test('safe, cap, home and moveTo on the Monad step', async () => {
    const w = await world()
    await refused(w.post(1, prepareOf(input1(w, { safe: ELSEWHERE }))))
    await refused(w.post(1, prepareOf(input1(w, { capUsdc: '999000000' }))))
    await refused(w.post(1, prepareOf(input1(w, { home: ELSEWHERE }))))
    await refused(w.post(1, forged(input1(w), input1(w, { homeDomain: 15 }))))
    await refused(w.post(1, prepareOf(input1(w, { moveTo: ELSEWHERE }))))
    await refused(w.post(1, prepareOf(input1(w), { moveTo: ELSEWHERE })))
  })

  test("another account's Safe, on either step", async () => {
    const w = await world()
    await refused(w.post(0, prepareOf(input0(w, { safe: w.b.base.address as Address }))))
    await refused(w.post(1, prepareOf(input1(w, { safe: w.b.old.address as Address }))))
    // The other account's home.
    await refused(w.post(1, prepareOf(input1(w, { home: w.b.base.address as Address }))))
    // The Monad step with the account's own Base Safe, or the Base step with the Monad one.
    await refused(w.post(1, prepareOf(input1(w, { safe: w.a.base.address as Address }))))
  })

  test('a half destination on step 1, or funds moved on step 0', async () => {
    const w = await world()
    await refused(w.post(1, forged(input1(w), input1(w, { moveTo: undefined }), { moveTo: undefined })))
    await refused(w.post(1, forged(input1(w), input1(w, { transfers: [] }))))
    // Funds with no destination, or a destination announced that the build does not carry.
    await refused(w.post(1, forged(input1(w), input1(w, { moveTo: undefined }))))
    await refused(w.post(1, forged(input1(w, { moveTo: undefined, transfers: undefined }), input1(w, { moveTo: undefined, transfers: undefined }), { moveTo: w.dest })))
    await refused(w.post(0, { ...prepareOf(input0(w)), moveTo: w.dest }))
    // The signed tx moves funds but the prepare drops its destination: the card would say "no funds move" (Sol r6).
    await refused(w.post(1, { ...prepareOf(input1(w)), moveTo: undefined }))
  })

  test('a step that does not exist', async () => {
    const w = await world()
    await refused(w.post(2, prepareOf(input0(w))))
  })
})

describe('a migrate prepare writes nothing', () => {
  test('passed or refused, the D1 rows are as they were', async () => {
    const w = await world()
    const before = w.rows()
    expect((await w.post(1, prepareOf(input1(w)))).status).toBe(200)
    await refused(w.post(1, prepareOf(input1(w, { moveTo: ELSEWHERE }))))
    expect(w.rows()).toBe(before)
  })
})
