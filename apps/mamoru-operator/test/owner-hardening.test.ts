// otto/mamoru#140, Astra audit part 2, findings 3-7 on the owner flows of the live operator.
import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, type Hex } from 'viem'
import { safeAbi } from '@mamoru/registry'
import type { Address } from '@mamoru/domain'
import { FakeChain } from '../../../packages/rpc/test/fake-chain.ts'
import { MAX_INVENTORY, readSafe } from '../src/chain.ts'
import { parseTrustedRpc } from '../src/boot.ts'
import { MAX_STOP_POSITIONS, mintAllowed, type Operator } from '../src/operator.ts'
import { DEFAULT_SPONSOR, activationRefusal, boundedSponsor, sponsorRefusal, type SponsorEntry } from '../src/sponsorship.ts'
import type { AccountState } from '../src/state.ts'
import { RELAYER, SAFE, TO, ctx, odd, quiet, sign, trusted, world, type Answer } from './owner-world.ts'

type Privates = { fireArmed(a: AccountState, usdc: bigint): Promise<void> }
const priv = (op: Operator) => op as unknown as Privates
const GRANT = { name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}` as Hex, grant: {} as never }

describe('#3 activation prepares are serialized and bound to the account generation', () => {
  test('a prepare holds the account lock: an activation submitted meanwhile is not sent until the prepare is stored', async () => {
    const w = world(10_000_000n)
    const b = await w.op.prepareActivate(ctx)
    let release!: () => void
    w.knobs.stall = new Promise<void>((r) => (release = r))
    const a = w.op.prepareActivate(ctx)
    const submitted = quiet(() => w.op.submit(ctx, 'activate', sign(b)))
    await Bun.sleep(30)
    expect(w.sent).toHaveLength(0)
    release()
    w.knobs.stall = null
    const aTx = await a
    await submitted
    expect(w.state.accounts.k!.active).toBe(true)
    // A was built before B ran, so it is for the nonce B spent; and the running account refuses it before any send.
    const before = w.sent.length
    expect(await w.op.submit(ctx, 'activate', sign(aTx)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ALREADY_ACTIVE' })
    expect(w.sent).toHaveLength(before)
  })

  test('an activation prepared before an owner change lands is refused at submit as stale, nothing sent', async () => {
    const w = world(10_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    w.op.account(ctx).acc.gen = 3
    expect(await w.op.submit(ctx, 'activate', sign(tx)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ACTIVATION_STALE' })
    expect(w.sent).toHaveLength(0)
  })

  test('an armed activation whose account generation moved is dropped by the watcher, nothing sent', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    expect(await w.op.submit(ctx, 'activate', sign(tx))).toMatchObject({ code: 'ARMED' })
    const acc = w.state.accounts.k!
    expect(acc.armed?.gen).toBe(0)
    acc.gen = 1
    w.chain.usdc = 10_000_000n
    await priv(w.op).fireArmed(acc, 10_000_000n)
    expect(acc.armed).toBeUndefined()
    expect(w.op.ops(ctx, null).ops[0]).toMatchObject({ state: 'failed', code: 'ACTIVATION_STALE' })
    expect(w.sent).toHaveLength(0)
  })

  test('activation, stop and renewal that land bump the generation; a transfer does not', async () => {
    const w = world(10_000_000n)
    await quiet(async () => w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx))))
    const acc = w.state.accounts.k!
    expect(acc.gen).toBe(1)
    await quiet(async () => w.op.submit(ctx, 'transfer', sign((await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })).ownerTx)))
    expect(acc.gen).toBe(1)
    await quiet(async () => w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx))))
    expect(acc.gen).toBe(2)
  })
})

describe('#4 position NFTs sent to the Safe never block Stop', () => {
  const big = (tokenId: bigint) => ({ tokenId, liquidity: 1_000_000_000n })
  const dust = (tokenId: bigint) => ({ tokenId, liquidity: 1_000n })

  test('Stop closes at most MAX_STOP_POSITIONS of the admitted ones, largest first, never one sent unasked, and says what is left', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    const acc = w.op.account(ctx).acc
    acc.grants = [GRANT]
    acc.admittedTokenIds = [...Array.from({ length: 10 }, (_, i) => String(100 + i)), '900']
    w.chain.positions = [...Array.from({ length: 40 }, (_, i) => big(BigInt(i + 1))), ...Array.from({ length: 10 }, (_, i) => big(BigInt(100 + i))), { tokenId: 900n, liquidity: 5_000_000_000n }]
    const tx = await w.op.prepareStop(ctx)
    const closes = tx.summary.filter((l) => l.startsWith('Close and burn'))
    expect(closes).toHaveLength(MAX_STOP_POSITIONS)
    expect(closes[0]).toContain('#900')
    expect(closes.every((l) => /#(1\d\d|900) /.test(l))).toBe(true)
    expect(tx.summary).toContain(`${11 - MAX_STOP_POSITIONS} more position(s) stay in your Safe: Stop again to close them`)
    expect(tx.summary[0]).toBe("Revoke the engine's 1 session grant(s)")
  })

  test('an account from before the record: Stop leaves dust alone', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [GRANT]
    w.chain.positions = [dust(1n), big(2n)]
    const closes = (await w.op.prepareStop(ctx)).summary.filter((l) => l.startsWith('Close and burn'))
    expect(closes).toEqual(['Close and burn position #2 (USDC/cbBTC 0.05%)'])
  })

  test('revoke-only Stop reads no position, price or quote and revokes every grant', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [GRANT]
    w.chain.positions = Array.from({ length: 200 }, (_, i) => big(BigInt(i + 1)))
    w.knobs.npmDown = true
    const tx = await w.op.prepareStop(ctx, { revokeOnly: true })
    expect(w.npmCalls).toHaveLength(0)
    expect(tx.summary).toEqual(["Revoke the engine's 1 session grant(s)", 'Your positions and tokens stay in your Safe as they are; Stop again closes them'])
    const done = await quiet(() => w.op.submit(ctx, 'stop', sign(tx)))
    expect(done.out).toMatchObject({ kind: 'exit', state: 'confirmed' })
    expect(w.state.accounts.k!.active).toBe(false)
    expect(w.state.accounts.k!.revoked).toContain(GRANT.permissionId)
  })

  test('a full Stop whose positions cannot be read falls back to revoking only', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [GRANT]
    w.chain.positions = [big(1n)]
    w.knobs.npmDown = true
    const { out } = await quiet(() => w.op.prepareStop(ctx))
    expect(out.summary).toEqual(["Revoke the engine's 1 session grant(s)", 'Your positions could not be read just now: they stay in your Safe as they are, and Stop again closes them'])
  })

  test('withdrawals size from, and funding shows, only the positions Mamoru admitted', async () => {
    const w = world(0n)
    w.chain.deployed = true
    const acc = w.op.account(ctx).acc
    acc.admittedTokenIds = ['7']
    w.chain.positions = [{ tokenId: 7n, liquidity: 100_000_000n }, big(8n)]
    expect((await w.op.funding(ctx)).positions.map((p) => p.tokenId)).toEqual(['7'])
    const plan = await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' }))
    expect(plan.out.reduce.map((r) => r.tokenId)).toEqual(['7'])
  })

  test('an account from before the record counts every non-dust position, largest first, at most 16', async () => {
    const w = world(0n)
    w.chain.deployed = true
    w.op.account(ctx)
    w.chain.positions = [dust(1n), big(2n), ...Array.from({ length: 20 }, (_, i) => ({ tokenId: BigInt(10 + i), liquidity: 10_000_000n }))]
    const shown = (await w.op.funding(ctx)).positions.map((p) => p.tokenId)
    expect(shown).toHaveLength(16)
    expect(shown[0]).toBe('2')
    expect(shown).not.toContain('1')
  })

  test('readSafe past MAX_INVENTORY reads the admitted ids only, skipping one no longer owned', async () => {
    const chain = new FakeChain()
    const safe = '0x00000000000000000000000000000000000000aa' as Address
    chain.code.set(safe.toLowerCase(), '0x6001')
    for (let i = 1n; i <= BigInt(MAX_INVENTORY + 36); i++) chain.addPosition(safe, i, 'pool:USDC/cbBTC/500')
    const all = await readSafe(chain.client, safe)
    expect(all.positionCount).toBe(MAX_INVENTORY + 36)
    expect(all.positions).toHaveLength(MAX_INVENTORY)
    const named = await readSafe(chain.client, safe, { admitted: [3n, 99n, 5_000n] })
    expect(named.positions.map((p) => p.tokenId)).toEqual([3n, 99n])
  })
})

describe('#5 a signature the off-chain check refuses is paid for only on independent proof', () => {
  const pool = (a: Answer, b: Answer) => {
    const x = { v: a }
    const y = { v: b }
    return { knobs: [x, y], trustedClients: [{ label: 'one', client: trusted(x) }, { label: 'two', client: trusted(y) }] }
  }

  test('two trusted providers agree: sent, and the mismatch is logged', async () => {
    const t = pool('ok', 'ok')
    const w = world(5_000_000n, { trustedClients: t.trustedClients })
    w.chain.deployed = true
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    const { out, logged } = await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx, odd)))
    expect(out).toMatchObject({ state: 'confirmed' })
    expect(w.sent).toHaveLength(1)
    expect(logged.some((l) => l.includes('OWNER_SIG_MIRROR_MISMATCH'))).toBe(true)
  })

  test('one trusted provider sees a revert: refused, whatever the others say', async () => {
    const w = world(5_000_000n, { trustedClients: pool('ok', 'revert').trustedClients })
    w.chain.deployed = true
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    expect((await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx, odd)).catch((e: unknown) => e))).out).toMatchObject({ status: 400, code: 'BAD_SIGNATURE' })
    expect(w.sent).toHaveLength(0)
  })

  test('only one trusted answer, or an answer that is not `true`: not proven, nothing sent', async () => {
    for (const [a, b, code] of [['ok', 'down', 'OWNER_CHECK_UNAVAILABLE'], ['ok', 'empty', 'BAD_SIGNATURE']] as const) {
      const w = world(5_000_000n, { trustedClients: pool(a, b).trustedClients })
      w.chain.deployed = true
      w.knobs.sim = 'down'
      const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
      expect((await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx, odd)).catch((e: unknown) => e))).out).toMatchObject({ code })
      expect(w.sent).toHaveLength(0)
    }
  })

  test('MAMORU_RPC_TRUSTED: two https providers on distinct hosts, labelled by host only', () => {
    expect(parseTrustedRpc(undefined)).toEqual([])
    expect(parseTrustedRpc('https://a.example/v2/KEY,https://b.example/rpc').map((t) => t.label)).toEqual(['a.example', 'b.example'])
    expect(() => parseTrustedRpc('https://a.example/1,https://a.example/2')).toThrow('listed twice')
    expect(() => parseTrustedRpc('https://a.example/1')).toThrow('at least two')
    expect(() => parseTrustedRpc('http://a.example,https://b.example')).toThrow('not https')
  })

  test('an eth_call that does not decode to true is a revert, also for a proven signature', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.knobs.sim = 'down'
    w.knobs.call = 'empty'
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    expect((await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))).out).toMatchObject({ state: 'failed', code: 'OWNER_TX_REVERTS' })
    expect(w.sent).toHaveLength(0)
  })
})

describe('#6 sponsorship of owner transactions is bounded', () => {
  const at = (msAgo: number, kind: SponsorEntry['kind'], wei = 1n) => ({ at: new Date(Date.now() - msAgo).toISOString(), wei: wei.toString(), kind })

  test('limits: per account, stops apart, and a reserve of the daily budget only stops may use', () => {
    const p = { ...DEFAULT_SPONSOR, perAccount: 2, stopsPerAccount: 1, weiPerDay: 1_000n, reserveBps: 2_000 }
    const now = Date.now()
    const two = [at(1_000, 'transfer'), at(2_000, 'renew')]
    expect(sponsorRefusal(p, two, two, 'transfer', 1n, now)).toMatchObject({ code: 'SPONSOR_ACCOUNT_LIMIT' })
    expect(sponsorRefusal(p, two, two, 'stop', 1n, now)).toBeNull()
    const spent = [at(1_000, 'transfer', 790n)]
    expect(sponsorRefusal(p, [], spent, 'transfer', 20n, now)).toMatchObject({ code: 'SPONSOR_DAILY_BUDGET' })
    expect(sponsorRefusal(p, [], spent, 'stop', 20n, now)).toBeNull()
    // Older than 24 h no longer counts (the operator prunes with recentSponsored before asking).
    expect(sponsorRefusal({ ...p, weiPerDay: 0n }, [], [], 'stop', 1n, now)).toMatchObject({ code: 'SPONSOR_DAILY_BUDGET' })
  })

  test('a policy outside the code bounds falls back to the defaults, field by field', () => {
    expect(boundedSponsor({ perAccount: 1_000, stopsPerAccount: 2, weiPerDay: 10n ** 30n, reserveBps: -1 })).toEqual({ ...DEFAULT_SPONSOR, stopsPerAccount: 2 })
  })

  test('past the account limit the Safe pays its own fee: refund to the relayer in the signed SafeTx, said in the summary', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 1 } })
    w.chain.deployed = true
    w.chain.safeEth = 10n ** 16n
    const first = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    expect(first.ownerTx.summary.some((l) => l.includes('network fee'))).toBe(false)
    await quiet(() => w.op.submit(ctx, 'transfer', sign(first.ownerTx)))
    expect(w.state.accounts.k!.sponsored).toHaveLength(1)
    // The receipt's cost replaces the estimate.
    expect(w.state.accounts.k!.sponsored![0]!.wei).toBe((200_000n * w.knobs.gasPrice).toString())
    const second = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    expect(second.ownerTx.summary.at(-1)).toContain("Your Safe pays this transaction's network fee to Mamoru's relayer")
    const done = await quiet(() => w.op.submit(ctx, 'transfer', sign(second.ownerTx)))
    expect(done.out).toMatchObject({ state: 'confirmed' })
    const exec = decodeFunctionData({ abi: safeAbi, data: w.sent.at(-1)!.data! })
    // Safe 1.4.1 forwards exactly safeTxGas to the inner call when gasPrice != 0: it must be set.
    expect(exec.args[4]).toBe(4_000_000n)
    expect(exec.args[6]).toBe(w.knobs.gasPrice * 2n)
    expect((exec.args[8] as string).toLowerCase()).toBe(RELAYER.toLowerCase())
    expect(w.state.accounts.k!.sponsored).toHaveLength(1)
  })

  test('a Safe without the ETH for its fee is told how much to send; nothing is prepared', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 0 } })
    w.chain.deployed = true
    const err = (await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' }).catch((e: unknown) => e)) as Error
    expect(err).toMatchObject({ status: 429, code: 'SPONSOR_ACCOUNT_LIMIT' })
    expect(err.message).toContain(`ETH to your Safe ${SAFE}`)
  })

  test('stops stay sponsored after transfers used the shared part of the budget', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, weiPerDay: 100_000_000_000_000n, reserveBps: 5_000 } })
    w.chain.deployed = true
    const acc = w.op.account(ctx).acc
    acc.grants = [GRANT]
    acc.sponsored = [at(1_000, 'transfer', 15_000_000_000_000n)]
    expect(await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' }).catch((e: unknown) => e)).toMatchObject({ code: 'SPONSOR_DAILY_BUDGET' })
    const stop = await w.op.prepareStop(ctx, { revokeOnly: true })
    expect(stop.summary.some((l) => l.includes('network fee'))).toBe(false)
  })

  test('past every limit, with a Safe that cannot pay: Stop falls back to an emergency revocation, counted, two a day', async () => {
    const w = world(5_000_000n, { sponsor: { perAccount: 0, stopsPerAccount: 0, weiPerDay: 0n, reserveBps: 0 } })
    w.chain.deployed = true
    const acc = w.op.account(ctx).acc
    for (let i = 0; i < 2; i++) {
      acc.grants = [GRANT]
      // A full Stop is not sponsored past the limits: it becomes the revoke-only one, which does no other work.
      const { out: tx } = await quiet(() => w.op.prepareStop(ctx))
      expect(tx.summary.filter((l) => l.startsWith('Close'))).toHaveLength(0)
      expect(tx.summary[0]).toBe("Revoke the engine's 1 session grant(s)")
      expect((await quiet(() => w.op.submit(ctx, 'stop', sign(tx)))).out).toMatchObject({ kind: 'exit', state: 'confirmed' })
      expect(decodeFunctionData({ abi: safeAbi, data: w.sent.at(-1)!.data! }).args[6]).toBe(0n)
    }
    expect(acc.sponsored?.map((e) => e.kind)).toEqual(['revoke', 'revoke'])
    acc.grants = [GRANT]
    expect((await quiet(() => w.op.prepareStop(ctx).catch((e: unknown) => e))).out).toMatchObject({ status: 429, code: 'SPONSOR_ACCOUNT_LIMIT' })
    // With ETH in the Safe the owner still stops, paying the fee: never locked out.
    w.chain.safeEth = 10n ** 16n
    expect((await w.op.prepareStop(ctx)).summary.at(-1)).toContain('network fee')
  })

  test('renewals are counted too, and refused (never Safe-paid) past the limit', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 0 } })
    w.chain.deployed = true
    w.chain.safeEth = 10n ** 18n
    const acc = w.op.account(ctx).acc
    const fee = await (w.op as unknown as { feePlan(a: AccountState, l: unknown, k: string, r: boolean): Promise<unknown> }).feePlan(acc, { safe: SAFE }, 'renew', false).catch((e: unknown) => e)
    expect(fee).toMatchObject({ status: 429, code: 'SPONSOR_ACCOUNT_LIMIT' })
  })

  test('a revoke-only Stop is not queued behind another prepare holding the account lock', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [GRANT]
    let release!: () => void
    w.knobs.stall = new Promise<void>((r) => (release = r))
    const slow = w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    const stop = await Promise.race([w.op.prepareStop(ctx, { revokeOnly: true }), Bun.sleep(500).then(() => null)])
    expect(stop?.summary[0]).toBe("Revoke the engine's 1 session grant(s)")
    release()
    w.knobs.stall = null
    await slow
  })

  test('the sponsorship is reserved before the deploy: a limit filled after the prepare sends nothing at all', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 1 } })
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    w.op.account(ctx).acc.sponsored = [at(1_000, 'transfer')]
    expect((await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))).out).toMatchObject({ state: 'failed', code: 'SPONSOR_ACCOUNT_LIMIT' })
    expect(w.sent).toHaveLength(0)
    expect(w.chain.deployed).toBe(false)
  })

  test('a reservation is released when nothing is sent after all', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 1 } })
    w.chain.deployed = true
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    w.knobs.sim = 'revert'
    expect((await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))).out).toMatchObject({ state: 'failed', code: 'OWNER_TX_REVERTS' })
    expect(w.state.accounts.k!.sponsored ?? []).toHaveLength(0)
  })

  test('a sponsored prepare whose limit filled before the send fails without sending', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 1 } })
    w.chain.deployed = true
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    w.op.account(ctx).acc.sponsored = [at(1_000, 'transfer')]
    expect((await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))).out).toMatchObject({ state: 'failed', code: 'SPONSOR_ACCOUNT_LIMIT' })
    expect(w.sent).toHaveLength(0)
  })
})

describe('#7 unproven prepares leave nothing behind', () => {
  test('a prepare for an unknown account writes no account and no session key; a proven submit stores both', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    expect(w.state.accounts).toEqual({})
    expect(w.saves()).toBe(0)
    expect((await quiet(() => w.op.submit(ctx, 'activate', sign(tx)))).out).toMatchObject({ code: 'ARMED' })
    expect(w.state.accounts.k?.sessionKey).toMatch(/^0x[0-9a-f]{64}$/)
  })

  test('a forged submit stores nothing either', async () => {
    const w = world(0n)
    const tx = await w.op.prepareActivate(ctx)
    w.knobs.sim = 'revert'
    expect((await quiet(() => w.op.submit(ctx, 'activate', sign(tx, odd)).catch((e: unknown) => e))).out).toMatchObject({ code: 'BAD_SIGNATURE' })
    expect(w.state.accounts).toEqual({})
  })

  test('two prepares with fresh keys: once one is signed, the other is stale', async () => {
    const w = world(0n)
    const a = await w.op.prepareActivate(ctx)
    const b = await w.op.prepareActivate(ctx)
    await quiet(() => w.op.submit(ctx, 'activate', sign(a)))
    expect(await w.op.submit(ctx, 'activate', sign(b)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ACTIVATION_STALE' })
  })

  test('at most four prepares per account are open: the oldest goes', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    const plans: Awaited<ReturnType<Operator['prepareTransfer']>>[] = []
    for (let i = 0; i < 5; i++) plans.push(await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' }))
    expect(await w.op.submit(ctx, 'transfer', sign(plans[0]!.ownerTx)).catch((e: unknown) => e)).toMatchObject({ code: 'PREPARE_UNKNOWN' })
    expect((await quiet(() => w.op.submit(ctx, 'transfer', sign(plans[4]!.ownerTx)))).out).toMatchObject({ state: 'confirmed' })
  })
})

describe('GPT-6 Sol review (NO-GO) findings', () => {
  test('#1 two first submits for one Safe under two accountKeys: only one is stored', async () => {
    const w = world(0n)
    const a = await w.op.prepareActivate(ctx)
    const other = { ...ctx, accountKey: 'k2' }
    const b = await w.op.prepareActivate(other)
    await quiet(() => w.op.submit(ctx, 'activate', sign(a)))
    expect(await w.op.submit(other, 'activate', sign(b)).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'ACCOUNT_MISMATCH' })
    expect(Object.keys(w.state.accounts)).toEqual(['k'])
  })

  test('#2 a Stop prepared before a grant was added is refused under the lock, not sent', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    const acc = w.op.account(ctx).acc
    acc.grants = [GRANT]
    const tx = await w.op.prepareStop(ctx, { revokeOnly: true })
    acc.grants = [GRANT, { ...GRANT, permissionId: `0x${'bb'.repeat(32)}` as Hex }]
    expect((await quiet(() => w.op.submit(ctx, 'stop', sign(tx)))).out).toMatchObject({ state: 'failed', code: 'STOP_STALE' })
    expect(w.sent).toHaveLength(0)
  })

  test('#3 activations that land are bounded per Safe', async () => {
    const w = world(10_000_000n)
    const acc = w.op.account(ctx).acc
    acc.sponsored = Array.from({ length: 3 }, () => ({ at: new Date().toISOString(), wei: '1', kind: 'activate' as const }))
    const tx = await w.op.prepareActivate(ctx)
    expect((await quiet(() => w.op.submit(ctx, 'activate', sign(tx)))).out).toMatchObject({ state: 'failed', code: 'ACTIVATION_LIMIT' })
    expect(w.sent).toHaveLength(0)
  })

  test('#4 an undeployed Safe: the deploy is reserved with the transaction and settled with both receipts', async () => {
    const w = world(5_000_000n)
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))
    expect(w.sent).toHaveLength(2)
    expect(w.state.accounts.k!.sponsored![0]!.wei).toBe((2n * 200_000n * w.knobs.gasPrice).toString())
  })

  test('#6 admitted ids the Safe no longer owns are pruned', async () => {
    const w = world(0n)
    w.chain.deployed = true
    const acc = w.op.account(ctx).acc
    acc.admittedTokenIds = ['7', '8', '9']
    w.chain.positions = [{ tokenId: 7n, liquidity: 100_000_000n }]
    await w.op.funding(ctx)
    expect(acc.admittedTokenIds).toEqual(['7'])
  })

  test('race: an id admitted while a read is in flight is not pruned by that read', async () => {
    const w = world(0n)
    w.chain.deployed = true
    const acc = w.op.account(ctx).acc
    acc.admittedTokenIds = ['7']
    w.chain.positions = [{ tokenId: 7n, liquidity: 100_000_000n }]
    let release!: () => void
    w.knobs.stall = new Promise<void>((r) => (release = r))
    const read = w.op.funding(ctx, true)
    await Bun.sleep(10)
    acc.admittedTokenIds = [...acc.admittedTokenIds, '42']
    release()
    w.knobs.stall = null
    await read
    expect(acc.admittedTokenIds).toEqual(['7', '42'])
  })
})

describe('Sol review round 2 on 411bf85', () => {
  test('#1 activation spend is bounded across all accounts, apart from the owner-transaction budget', () => {
    const now = Date.now()
    const at = new Date(now - 3_600_000).toISOString()
    const p = { ...DEFAULT_SPONSOR, activationWeiPerDay: 1_000n }
    const other: SponsorEntry[] = [{ at, wei: '900', kind: 'activation', opId: 'x' }]
    expect(activationRefusal(p, other, 100n, now)).toBeNull()
    expect(activationRefusal(p, other, 101n, now)).toMatchObject({ code: 'SPONSOR_DAILY_BUDGET' })
    // Landed activations (`activate`) and owner transactions do not count toward it, nor does it toward theirs.
    expect(activationRefusal(p, [{ at, wei: '10000', kind: 'activate' }, { at, wei: '10000', kind: 'transfer' }], 1_000n, now)).toBeNull()
    expect(sponsorRefusal({ ...p, weiPerDay: 1_000n }, [], [{ at, wei: '10000', kind: 'activation' }], 'transfer', 1n, now)).toBeNull()
    expect(boundedSponsor({ ...p, activationWeiPerDay: 10n ** 30n }).activationWeiPerDay).toBe(DEFAULT_SPONSOR.activationWeiPerDay!)
  })

  test('#1 an activation past the daily activation budget is refused before anything is sent', async () => {
    const w = world(10_000_000n, { sponsor: { ...DEFAULT_SPONSOR, activationWeiPerDay: 0n } })
    const tx = await w.op.prepareActivate(ctx)
    const op = await quiet(() => w.op.submit(ctx, 'activate', sign(tx)))
    expect((op as unknown as { out: unknown }).out).toMatchObject({ state: 'failed', code: 'SPONSOR_DAILY_BUDGET' })
    expect(w.sent).toHaveLength(0)
    expect(w.state.accounts.k!.active).toBe(false)
  })

  test('#1 an activation that lands keeps its reservation: deploy, top-up and exec, one entry', async () => {
    const w = world(10_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    await quiet(() => w.op.submit(ctx, 'activate', sign(tx)))
    const acc = w.state.accounts.k!
    expect(acc.active).toBe(true)
    const spend = (acc.sponsored ?? []).filter((e) => e.kind === 'activation')
    expect(spend).toHaveLength(1)
    expect(BigInt(spend[0]!.wei)).toBeGreaterThan(0n)
  })

  test('#2 a Safe-paid transfer from a Safe not deployed yet refunds the deploy too', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 0 } })
    w.chain.safeEth = 10n ** 16n
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    expect(plan.ownerTx.summary.at(-1)).toContain("Your Safe pays this transaction's network fee")
    await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))
    const exec = decodeFunctionData({ abi: safeAbi, data: w.sent.at(-1)!.data! })
    // baseGas: the refund's own overhead plus the factory deploy the relayer sent first.
    expect(exec.args[5]).toBe(120_000n + 500_000n)
  })

  test('#2 a Safe that can pay the transfer but not the deploy too is told to send more; nothing is prepared', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 0 } })
    // Enough for the transfer's own refund at twice the gas price, not for the deploy on top.
    w.chain.safeEth = (4_000_000n + 120_000n) * w.knobs.gasPrice * 2n
    expect(await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' }).catch((e: unknown) => e)).toMatchObject({ status: 429 })
    expect(w.sent).toHaveLength(0)
  })

  test('#3 a read from a block before an id was minted never prunes it; one from after does', async () => {
    const w = world(0n)
    w.chain.deployed = true
    const acc = w.op.account(ctx).acc
    acc.admittedTokenIds = ['7', '8', '9']
    // 9 was minted at a block far past what the provider answers from; 8 has no block (before this record).
    acc.admittedAt = { '9': '1000000000' }
    w.chain.positions = [{ tokenId: 7n, liquidity: 100_000_000n }]
    await w.op.funding(ctx)
    expect(acc.admittedTokenIds).toEqual(['7', '9'])
    acc.admittedAt = { '9': '1' }
    ;(w.op as unknown as { fundingMoved(a: AccountState): void }).fundingMoved(acc)
    await w.op.funding(ctx, true)
    expect(acc.admittedTokenIds).toEqual(['7'])
    expect(acc.admittedAt).toEqual({})
  })

  test('round 3 #1: a Safe-paid first transfer whose deploy went out but lost its receipt still counts the deploy', async () => {
    const w = world(5_000_000n, { sponsor: { ...DEFAULT_SPONSOR, perAccount: 0 } })
    w.chain.safeEth = 10n ** 16n
    const plan = await w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' })
    // Fees rose since the prepare: the deploy was signed at a far higher maxFeePerGas than the SafeTx's price.
    const maxFee = 500_000n * w.knobs.gasPrice * 50n
    type R = { relayer: { send(tx: unknown, onSent?: unknown, onSending?: (maxFeeWei: bigint) => void): Promise<unknown> } }
    ;(w.op as unknown as R).relayer.send = async (_tx, _onSent, onSending) => {
      onSending?.(maxFee)
      throw new Error('timed out waiting for the receipt')
    }
    await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx))).catch(() => undefined)
    const spent = w.state.accounts.k!.sponsored ?? []
    expect(spent).toHaveLength(1)
    // Round 4: counted at the most the signed deploy could cost, not at the SafeTx's earlier gas price.
    expect(spent[0]).toMatchObject({ kind: 'transfer', wei: maxFee.toString() })
  })

  test('round 3 #2: an activation whose deploy fails before it is sent releases its reservation', async () => {
    const w = world(10_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    type R = { relayer: { send(tx: unknown, onSent?: unknown, onSending?: () => void): Promise<unknown> } }
    ;(w.op as unknown as R).relayer.send = async () => {
      throw new Error('gas estimation failed')
    }
    await quiet(() => w.op.submit(ctx, 'activate', sign(tx))).catch(() => undefined)
    expect((w.state.accounts.k!.sponsored ?? []).filter((e) => e.kind === 'activation')).toHaveLength(0)
  })

  test('#60 on #65: a revoke-only Stop reads every known id first, so a revoked grant the owner enabled again is revoked too', async () => {
    const w = world(10_000_000n)
    const tx = await w.op.prepareActivate(ctx)
    await quiet(() => w.op.submit(ctx, 'activate', sign(tx)))
    const acc = w.state.accounts.k!
    const old = acc.grants.map((g) => g.permissionId)
    await quiet(async () => w.op.submit(ctx, 'stop', sign(await w.op.prepareStop(ctx, { revokeOnly: true }))))
    expect(acc.active).toBe(false)
    expect(await w.op.prepareStop(ctx, { revokeOnly: true }).catch((e: unknown) => e)).toMatchObject({ status: 409, code: 'NOTHING_TO_STOP' })
    w.knobs.reenabled.add(old[0]!.toLowerCase())
    const again = await w.op.prepareStop(ctx, { revokeOnly: true })
    expect(again.summary[0]).toBe("Revoke the engine's 1 session grant(s)")
    w.knobs.grantsDown = true
    expect(await w.op.prepareStop(ctx, { revokeOnly: true }).catch((e: unknown) => e)).toMatchObject({ status: 503, code: 'GRANT_CHECK_UNAVAILABLE' })
  })

  test('#4 no further mint once the admitted positions fill one bounded read', () => {
    expect(mintAllowed(undefined)).toBe(true)
    expect(mintAllowed(Array.from({ length: MAX_INVENTORY - 1 }, (_, i) => String(i)))).toBe(true)
    expect(mintAllowed(Array.from({ length: MAX_INVENTORY }, (_, i) => String(i)))).toBe(false)
  })
})
