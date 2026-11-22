import { describe, expect, test } from 'bun:test'
import type { StoredOp } from '../src/state.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state.ts'
import { YIELD_FEE_FROM, YIELD_FEE_MIN, vaultGrowth, yieldFee } from '../src/yield-fee.ts'

const fee = (usdc?: string) => ({ tokenId: '1', pool: 'pool:WETH/USDC/3000', fee0: '1', fee1: '1', ...(usdc === undefined ? {} : { usdc }) })
const harvest = (at: string, ...usdc: (string | undefined)[]): StoredOp =>
  ({ opId: `eng-${at}`, kind: 'reduce', state: 'confirmed', updatedAt: at, txHash: `0x${Buffer.from(at).toString('hex')}`, facts: { at, gasWei: '1', fees: usdc.map(fee), feeable: true } }) as StoredOp
const outOfScope = (at: string, usdc: string): StoredOp => {
  const op = harvest(at, usdc)
  delete (op.facts as { feeable?: true }).feeable
  return op
}
const withdrawal = (state: StoredOp['state'], feeUsdc?: string, txHash?: string): StoredOp =>
  ({ opId: `own-${state}-${feeUsdc}-${txHash}`, kind: 'transfer', state, updatedAt: '2026-11-06T00:00:00Z', amountUsdc: '1000000', ...(feeUsdc ? { feeUsdc } : {}), ...(txHash ? { txHash } : {}) }) as StoredOp

describe('yieldFee (otto/mamoru#371)', () => {
  test('otto/mamoru#391: the remote Safes fee base adds to the home one, and home withdrawals cover both', () => {
    const at = '2026-11-10T00:00:00.000Z'
    expect(yieldFee([harvest(at, '20000000')], undefined, undefined, 30_000_000n)).toMatchObject({ collectedUsdc: 50_000_000n, feeUsdc: 5_000_000n, owedUsdc: 5_000_000n })
    expect(yieldFee([], undefined, undefined, 30_000_000n)).toMatchObject({ collectedUsdc: 30_000_000n, owedUsdc: 3_000_000n })
    expect(yieldFee([harvest(at, '20000000'), withdrawal('confirmed', '4000000', '0x01')], undefined, undefined, 30_000_000n)).toMatchObject({ chargedUsdc: 4_000_000n, owedUsdc: 1_000_000n })
    expect(yieldFee([harvest(at, '20000000')], undefined, undefined, -5n).collectedUsdc).toBe(20_000_000n)
  })

  test('otto/mamoru#423: a collect read on several stored ops is charged once', () => {
    const retry = (i: number, txHash = '0xAB'): StoredOp =>
      ({ opId: `eng-r${i}`, kind: 'reduce', state: 'confirmed', updatedAt: '2026-11-15T21:07:00.000Z', txHash, facts: { txHash, at: '2026-11-15T21:07:00.000Z', gasWei: '1', fees: [{ ...fee('5670000'), logIndex: 121 }], feeable: true } }) as StoredOp
    const ops = [...Array.from({ length: 130 }, (_, i) => retry(i)), retry(999, '0xab')]
    expect(yieldFee(ops).collectedUsdc).toBe(5_670_000n)
    expect(yieldFee([...ops, retry(1000, '0xcd')]).collectedUsdc).toBe(11_340_000n)
  })

  test('otto/mamoru#423: an out-of-scope or unpriced copy does not hide the charged one', () => {
    const copy = (id: string, feeable: boolean, usdc?: string): StoredOp =>
      ({ opId: id, kind: 'reduce', state: 'confirmed', updatedAt: '2026-11-15T21:07:00.000Z', txHash: '0xef', facts: { txHash: '0xef', v: 2, at: '2026-11-15T21:07:00.000Z', gasWei: '1', fees: [{ ...fee(usdc), logIndex: 3 }], ...(feeable ? { feeable: true } : {}) } }) as StoredOp
    // A collect is charged only when every copy of it was read in scope: when in doubt, the owner is not charged.
    expect(yieldFee([copy('eng-a', false, '5000000'), copy('eng-b', true, '5000000')]).collectedUsdc).toBe(0n)
    expect(yieldFee([copy('eng-a', true), copy('eng-b', false, '5000000')])).toMatchObject({ collectedUsdc: 0n, unpriced: 0 })
    // An unpriced copy does not hide a priced one.
    expect(yieldFee([copy('eng-a', true), copy('eng-b', true, '5000000')])).toMatchObject({ collectedUsdc: 5_000_000n, unpriced: 0 })
    // Copies of both layouts (the receipt is being read again): nothing is charged until the re-read is done.
    const legacy = { ...copy('own-l', true, '5000000'), facts: { txHash: '0xef', at: '2026-11-15T21:07:00.000Z', gasWei: '1', fees: [fee('5000000')], feeable: true } } as StoredOp
    const current = (feeable: boolean) => ({ ...copy('eng-c', feeable, '5000000'), userOpHash: '0x01' }) as StoredOp
    expect(yieldFee([legacy, current(true)]).collectedUsdc).toBe(0n)
    expect(yieldFee([current(true)]).collectedUsdc).toBe(5_000_000n)
    // Two older-layout reads, whole and per userOp: the whole one is the read.
    const legacyOwn = { ...legacy, opId: 'eng-l2', userOpHash: '0x01' } as StoredOp
    expect(yieldFee([legacy, legacyOwn]).collectedUsdc).toBe(5_000_000n)
    expect(yieldFee([{ ...legacy, facts: { ...legacy.facts!, feeable: undefined } } as StoredOp, legacyOwn]).collectedUsdc).toBe(0n)
    // Older-layout reads of two userOps of one bundle are distinct collects; one out of scope keeps both uncharged.
    const own = (id: string, hash: string, usdc: string, feeable: boolean) => ({ ...legacy, opId: id, userOpHash: hash, facts: { ...legacy.facts!, fees: [fee(usdc)], ...(feeable ? {} : { feeable: undefined }) } }) as StoredOp
    expect(yieldFee([own('eng-u1', '0x01', '5000000', true), own('eng-u2', '0x02', '3000000', false)]).collectedUsdc).toBe(0n)
    expect(yieldFee([own('eng-u1', '0x01', '5000000', true), own('eng-u2', '0x02', '3000000', true)]).collectedUsdc).toBe(8_000_000n)
    // A collect with an unreadable time is never charged.
    expect(yieldFee([{ ...copy('eng-n', true, '5000000'), facts: { ...copy('eng-n', true, '5000000').facts!, at: 'bad' } } as StoredOp]).collectedUsdc).toBe(0n)
  })

  test('10 % of the priced yield collected since the fee started; nothing before', () => {
    const f = yieldFee([harvest('2026-11-04T23:59:59.000Z', '5000000'), harvest('2026-11-05T10:00:00.000Z', '2000000', '1000000')])
    expect(f).toEqual({ collectedUsdc: 3_000_000n, vaultGrowthUsdc: 0n, unpriced: 0, feeUsdc: 300_000n, chargedUsdc: 0n, owedUsdc: 300_000n })
  })

  test('an unpriced fee is counted as pending, not owed yet', () => {
    const f = yieldFee([harvest('2026-11-05T10:00:00.000Z', '2000000', undefined)])
    expect(f.unpriced).toBe(1)
    expect(f.owedUsdc).toBe(200_000n)
  })

  test('a withdrawal that did not fail has paid its fee; in flight counts, failed does not', () => {
    const ops = [harvest('2026-11-05T10:00:00.000Z', '3000000'), withdrawal('confirmed', '100000'), withdrawal('submitted', '50000'), withdrawal('failed', '150000')]
    const f = yieldFee(ops)
    expect(f.chargedUsdc).toBe(150_000n)
    expect(f.owedUsdc).toBe(150_000n)
  })

  test('a signed withdrawal being sent (proposed, no transaction yet) has paid: a prepare meanwhile never prices it again', () => {
    const base = harvest('2026-11-05T10:00:00.000Z', '3000000')
    expect(yieldFee([base, withdrawal('proposed', '100000')]).chargedUsdc).toBe(100_000n)
    expect(yieldFee([base, withdrawal('failed', '100000', '0xab')]).chargedUsdc).toBe(0n)
  })

  test('only yield whose facts were taken while in scope is charged: out-of-scope yield never, whenever it was', () => {
    const ops = [outOfScope('2026-11-06T10:00:00.000Z', '5000000'), harvest('2026-11-08T10:00:00.000Z', '1000000'), outOfScope('2026-11-09T10:00:00.000Z', '4000000')]
    expect(yieldFee(ops).collectedUsdc).toBe(1_000_000n)
    expect(yieldFee(ops).owedUsdc).toBe(100_000n)
  })

  test('leaving scope and coming back keeps the books right: paid fees and in-scope yield both accumulate', () => {
    // In scope: 100 collected, 10 charged. Out: 50 collected (not feeable). Back in: 50 collected -> owed 5.
    const ops = [harvest('2026-11-06T10:00:00.000Z', '100000000'), withdrawal('confirmed', '10000000'), outOfScope('2026-11-20T10:00:00.000Z', '50000000'), harvest('2027-01-02T10:00:00.000Z', '50000000')]
    expect(yieldFee(ops).owedUsdc).toBe(5_000_000n)
  })

  test('the charged fee survives a restart: what the state file keeps is what is counted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mamoru-fee-'))
    const store = new StateStore(dir)
    store.state.accounts.k = { accountKey: 'k', ops: [harvest('2026-11-05T10:00:00.000Z', '3000000'), withdrawal('confirmed', '300000')] } as never
    store.save()
    const again = new StateStore(dir)
    expect(yieldFee(again.state.accounts.k!.ops).owedUsdc).toBe(0n)
  })

  test('never below zero, and nothing under a cent', () => {
    expect(yieldFee([harvest('2026-11-05T10:00:00.000Z', '1000000'), withdrawal('confirmed', '500000')]).owedUsdc).toBe(0n)
    const tiny = yieldFee([harvest('2026-11-05T10:00:00.000Z', String(YIELD_FEE_MIN * 10n - 1n))])
    expect(tiny.feeUsdc).toBe(YIELD_FEE_MIN - 1n)
    expect(tiny.owedUsdc).toBe(0n)
  })

  test('no ops, no fee; the start is exactly YIELD_FEE_FROM', () => {
    expect(yieldFee([]).owedUsdc).toBe(0n)
    expect(yieldFee([harvest(YIELD_FEE_FROM, '1000000')]).owedUsdc).toBe(100_000n)
  })
})

import { RELAYER, TO, ctx, quiet, sign, world } from './owner-world.ts'

/** The ERC-20 transfers (recipient, amount) inside the execTransaction the relayer sent (its MultiSend payload). */
function transfers(data: string): { to: string; amount: bigint }[] {
  const out: { to: string; amount: bigint }[] = []
  // a9059cbb + 32-byte recipient + 32-byte amount, wherever they sit in the packed MultiSend payload
  for (const m of data.matchAll(/a9059cbb([0-9a-f]{64})([0-9a-f]{64})/gi)) out.push({ to: `0x${m[1]!.slice(24)}`.toLowerCase(), amount: BigInt(`0x${m[2]}`) })
  return out
}

describe('a withdrawal pays the yield fee (otto/mamoru#371)', () => {
  const owedOps = (acc: { ops: unknown[] }) =>
    acc.ops.push({ opId: 'eng-h1', kind: 'reduce', state: 'confirmed', updatedAt: '2026-11-05T10:00:00Z', txHash: '0xaa', facts: { at: '2026-11-05T10:00:00.000Z', gasWei: '1', fees: [{ tokenId: '1', pool: 'pool:WETH/USDC/3000', fee0: '1', fee1: '1', usdc: '2000000' }], feeable: true } })

  async function prepared(inScope: boolean, usdc: bigint, amount: string) {
    const w = world(usdc, { opsFlags: () => ({ yield_fee: inScope }), opsScopedFlags: () => (inScope ? { yield_fee: null } : {}) })
    w.chain.deployed = true
    // The account's state, with 2 USDC of yield collected since the fee started.
    const { acc } = (w.op as unknown as { account: (c: typeof ctx) => { acc: { ops: unknown[] } } }).account(ctx)
    owedOps(acc)
    const plan = (await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: amount }))).out
    await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))
    const sentData = String(w.sent.at(-1)?.data ?? '')
    const op = (acc as unknown as { ops: { kind: string; amountUsdc?: string; feeUsdc?: string }[] }).ops.find((o) => o.kind === 'transfer')
    return { w, plan, sentData, op }
  }

  test('in scope: 0.2 USDC to the relayer on top of the amount, on its own summary line, recorded on the op', async () => {
    const { plan, sentData, op } = await prepared(true, 5_000_000n, '1000000')
    const t = transfers(sentData)
    expect(t).toContainEqual({ to: TO.toLowerCase(), amount: 1_000_000n })
    expect(t).toContainEqual({ to: RELAYER.toLowerCase(), amount: 200_000n })
    expect(plan.ownerTx.summary.some((l: string) => l.startsWith("Pay Mamoru's fee: 0.20 USDC to Mamoru's relayer") && l.includes('10% of the 2.00 USDC'))).toBe(true)
    expect(plan.receive).toMatchObject({ quoted: '1000000' })
    expect(op).toMatchObject({ amountUsdc: '1000000', feeUsdc: '200000' })
    expect(plan.fee).toEqual({ feeUsdc: '200000', requestedUsdc: '1000000', sentUsdc: '1000000' })
  })

  test('out of scope: no fee, nothing to the relayer', async () => {
    const { plan, sentData, op } = await prepared(false, 5_000_000n, '1000000')
    expect(op?.feeUsdc).toBeUndefined()
    expect(transfers(sentData).some((x) => x.to === RELAYER.toLowerCase())).toBe(false)
    expect(plan.ownerTx.summary.some((l: string) => l.includes("Mamoru's fee"))).toBe(false)
    expect(plan.fee).toBeUndefined()
  })

  test('the Safe cannot free amount + fee: the fee comes out of the amount, and the owner is told', async () => {
    const { plan, sentData, op } = await prepared(true, 1_000_000n, '1000000')
    const t = transfers(sentData)
    expect(op).toMatchObject({ amountUsdc: '800000', feeUsdc: '200000' })
    expect(t).toContainEqual({ to: TO.toLowerCase(), amount: 800_000n })
    expect(t).toContainEqual({ to: RELAYER.toLowerCase(), amount: 200_000n })
    expect(plan.receive).toMatchObject({ quoted: '800000' })
    expect(plan.fee).toEqual({ feeUsdc: '200000', requestedUsdc: '1000000', sentUsdc: '800000' })
    expect(plan.ownerTx.summary.some((l: string) => l.includes('The fee comes out of this withdrawal'))).toBe(true)
  })
})

describe('the real wiring (otto/mamoru#371): Operator.yieldFeeScope and op stamping', () => {
  test('an owner op recorded in scope is stamped; yieldFeeScope answers by the state key; out of scope neither', async () => {
    for (const inScope of [true, false]) {
      const w = world(5_000_000n, { opsFlags: () => ({ yield_fee: inScope }), opsScopedFlags: () => (inScope ? { yield_fee: null } : {}) })
      w.chain.deployed = true
      const plan = (await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: '1000000' }))).out
      await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))
      const [key, acc] = Object.entries(w.state.accounts)[0]!
      expect(w.op.yieldFeeScope(key)).toBe(inScope)
      expect((acc.ops.find((o) => o.kind === 'transfer') as { feeScoped?: true }).feeScoped).toBe(inScope ? true : undefined)
    }
  })
})

describe('vault growth in the fee (otto/mamoru#433)', () => {
  const V = 'vault:gtUSDCp'
  const FROM = '2026-11-23T00:00:00.000Z'
  let n = 0
  const flow = (kind: 'deposit' | 'withdraw', assets: bigint, shares: bigint, at: string, opts: { feeable?: boolean; tx?: string } = {}): StoredOp => {
    const txHash = opts.tx ?? `0x${(++n).toString(16).padStart(4, '0')}`
    return { opId: `eng-v${n}`, kind: 'reduce', state: 'confirmed', updatedAt: at, txHash, facts: { txHash, v: 2, at, gasWei: '1', fees: [], ...(opts.feeable === false ? {} : { feeable: true as const }), vaultFlows: [{ vault: V, kind, assets: assets.toString(), shares: shares.toString(), logIndex: 1 }] } } as StoredOp
  }
  const input = (shares: bigint, assets: bigint, from = FROM) => ({ from, now: [{ name: V, shares, assets }] })
  const D1 = '2026-11-24T00:00:00.000Z'
  const D2 = '2026-11-25T00:00:00.000Z'

  test('deposit, growth, withdrawal: 10 % of the growth', () => {
    const ops = [flow('deposit', 100_000_000n, 100_000_000n, D1)]
    // Still held: 100 USDC in, worth 120 now: growth 20, fee 2.
    expect(yieldFee(ops, undefined, undefined, 0n, input(100_000_000n, 120_000_000n))).toMatchObject({ vaultGrowthUsdc: 20_000_000n, collectedUsdc: 0n, feeUsdc: 2_000_000n, owedUsdc: 2_000_000n })
    // Redeemed whole at 120: the growth is realized, the same fee; nothing held.
    const out = [...ops, flow('withdraw', 120_000_000n, 100_000_000n, D2)]
    expect(yieldFee(out, undefined, undefined, 0n, input(0n, 0n))).toMatchObject({ vaultGrowthUsdc: 20_000_000n, feeUsdc: 2_000_000n })
    // The fee that withdrawal paid (confirmed or in flight) is not charged again.
    expect(yieldFee([...out, withdrawal('submitted', '2000000')], undefined, undefined, 0n, input(0n, 0n))).toMatchObject({ chargedUsdc: 2_000_000n, owedUsdc: 0n })
  })

  test('a partial redemption keeps the basis of what is left', () => {
    // 100 in for 100 shares; 40 shares redeemed for 50 (realized 10); 60 left worth 72 (unrealized 12): growth 22.
    const ops = [flow('deposit', 100_000_000n, 100_000_000n, D1), flow('withdraw', 50_000_000n, 40_000_000n, D2)]
    expect(vaultGrowth(ops, input(60_000_000n, 72_000_000n))).toBe(22_000_000n)
    // The same without the redemption having been read yet: the held shares cap the tracked ones (under-charges).
    expect(vaultGrowth([ops[0]!], input(60_000_000n, 72_000_000n))).toBe(12_000_000n)
  })

  test('no double charge with collected fees: a harvest swept into the vault has its entry value as basis', () => {
    // 10 USDC of fees collected (fee 1), swept in at 10 (basis 10), still 10 a day later: no vault growth.
    const ops = [harvest(D1, '10000000'), flow('deposit', 10_000_000n, 10_000_000n, D1)]
    expect(yieldFee(ops, undefined, undefined, 0n, input(10_000_000n, 10_000_000n))).toMatchObject({ collectedUsdc: 10_000_000n, vaultGrowthUsdc: 0n, feeUsdc: 1_000_000n })
    // It then grows by 1: only the growth adds to the base.
    expect(yieldFee(ops, undefined, undefined, 0n, input(10_000_000n, 11_000_000n))).toMatchObject({ vaultGrowthUsdc: 1_000_000n, feeUsdc: 1_100_000n })
  })

  test('nothing before the start, out of scope, or without a basis; never below zero', () => {
    const early = flow('deposit', 100_000_000n, 100_000_000n, '2026-11-22T00:00:00.000Z')
    expect(vaultGrowth([early], input(100_000_000n, 150_000_000n))).toBe(0n)
    expect(vaultGrowth([flow('deposit', 100_000_000n, 100_000_000n, D1, { feeable: false })], input(100_000_000n, 150_000_000n))).toBe(0n)
    // Shares held before the start: their redemption realizes nothing, and the growth is not counted.
    expect(vaultGrowth([flow('withdraw', 150_000_000n, 100_000_000n, D1)], input(0n, 0n))).toBe(0n)
    // A deposit before YIELD_FEE_FROM stays out even with an earlier start.
    expect(vaultGrowth([flow('deposit', 1n, 1n, '2026-11-04T00:00:00.000Z')], input(1n, 100n, '2026-11-01T00:00:00.000Z'))).toBe(0n)
    // A loss refunds nothing and is not netted against another vault's growth.
    expect(vaultGrowth([flow('deposit', 100_000_000n, 100_000_000n, D1)], input(100_000_000n, 90_000_000n))).toBe(0n)
    // An unreadable vault counts only what it realized; an absent start counts none.
    expect(vaultGrowth([flow('deposit', 100n, 100n, D1)], { from: FROM, now: [] })).toBe(0n)
    expect(vaultGrowth([flow('deposit', 100n, 100n, D1)], { from: 'bad', now: [{ name: V, shares: 100n, assets: 200n }] })).toBe(0n)
    expect(yieldFee([flow('deposit', 100n, 100n, D1)]).vaultGrowthUsdc).toBe(0n)
  })

  test('a transaction read on two stored ops counts once, and only when every copy was feeable', () => {
    const a = flow('deposit', 100_000_000n, 100_000_000n, D1, { tx: '0xaa' })
    const b = { ...flow('deposit', 100_000_000n, 100_000_000n, D1, { tx: '0xAA' }), opId: 'own-dup' } as StoredOp
    expect(vaultGrowth([a, b], input(100_000_000n, 110_000_000n))).toBe(10_000_000n)
    const c = { ...b, facts: { ...b.facts!, feeable: undefined } } as StoredOp
    expect(vaultGrowth([a, c], input(100_000_000n, 110_000_000n))).toBe(0n)
  })

  test('a redemption below the fee minimum owes nothing', () => {
    expect(yieldFee([flow('deposit', 1_000_000n, 1_000_000n, D1)], undefined, undefined, 0n, input(1_000_000n, 1_050_000n)).owedUsdc).toBe(0n)
  })
})
