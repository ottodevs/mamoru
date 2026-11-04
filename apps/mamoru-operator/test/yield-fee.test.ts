import { describe, expect, test } from 'bun:test'
import type { StoredOp } from '../src/state.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore } from '../src/state.ts'
import { YIELD_FEE_FROM, YIELD_FEE_MIN, yieldFee } from '../src/yield-fee.ts'

const fee = (usdc?: string) => ({ tokenId: '1', pool: 'pool:WETH/USDC/3000', fee0: '1', fee1: '1', ...(usdc === undefined ? {} : { usdc }) })
const harvest = (at: string, ...usdc: (string | undefined)[]): StoredOp =>
  ({ opId: `eng-${at}`, kind: 'reduce', state: 'confirmed', updatedAt: at, txHash: '0xaa', facts: { at, gasWei: '1', fees: usdc.map(fee), feeable: true } }) as StoredOp
const outOfScope = (at: string, usdc: string): StoredOp => {
  const op = harvest(at, usdc)
  delete (op.facts as { feeable?: true }).feeable
  return op
}
const withdrawal = (state: StoredOp['state'], feeUsdc?: string, txHash?: string): StoredOp =>
  ({ opId: `own-${state}-${feeUsdc}-${txHash}`, kind: 'transfer', state, updatedAt: '2026-11-06T00:00:00Z', amountUsdc: '1000000', ...(feeUsdc ? { feeUsdc } : {}), ...(txHash ? { txHash } : {}) }) as StoredOp

describe('yieldFee (otto/mamoru#371)', () => {
  test('10 % of the priced yield collected since the fee started; nothing before', () => {
    const f = yieldFee([harvest('2026-11-04T23:59:59.000Z', '5000000'), harvest('2026-11-05T10:00:00.000Z', '2000000', '1000000')])
    expect(f).toEqual({ collectedUsdc: 3_000_000n, unpriced: 0, feeUsdc: 300_000n, chargedUsdc: 0n, owedUsdc: 300_000n })
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
