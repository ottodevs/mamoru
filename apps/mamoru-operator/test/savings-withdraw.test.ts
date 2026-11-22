import { describe, expect, test } from 'bun:test'
import { conservadorLiveV8, conservadorLiveV2 } from '@mamoru/policy'
import { ctx, quiet, sign, TO, world } from './owner-world.ts'
import type { StoredOp } from '../src/state.ts'

// otto/mamoru#413 (spec 012 SAV-R5): a withdrawal takes savings first; the split is stored on the op at prepare.
const POOL = 'pool:WETH/USDC/3000'

async function withdrawn(policyId: string, amount: string, pendingUsdc: bigint) {
  const w = world(10_000_000n, { v8Policy: conservadorLiveV8 })
  w.chain.deployed = true
  const { acc } = (w.op as unknown as { account: (c: typeof ctx) => { acc: { ops: StoredOp[]; policyId?: string } } }).account(ctx)
  acc.policyId = policyId
  // A harvest the savings books count: its USDC fee is pending savings.
  acc.ops.push({ opId: 'eng-h1', kind: 'reduce', state: 'confirmed', updatedAt: '2026-11-22T10:00:00Z', block: 50, step: 'harvest', pool: POOL, savingsIn: true, txHash: '0xaa', facts: { at: '2026-11-22T10:00:00.000Z', gasWei: '1', fees: [{ tokenId: '1', pool: POOL, fee0: '0', fee1: pendingUsdc.toString() }] } } as StoredOp)
  const plan = (await quiet(() => w.op.prepareTransfer(ctx, { to: TO, amountUsdc: amount }))).out
  await quiet(() => w.op.submit(ctx, 'transfer', sign(plan.ownerTx)))
  return { plan, op: acc.ops.find((o) => o.kind === 'transfer') }
}

describe('a withdrawal takes savings first (otto/mamoru#413)', () => {
  test('smaller than the pending savings: it takes the withdrawal from them, nothing from the vault books', async () => {
    const { op } = await withdrawn(conservadorLiveV8.policyId, '1000000', 2_000_000n)
    expect(op?.savingsOut).toEqual({ pending: '1000000', shares: {} })
  })

  test('larger: all of the pending savings, the rest is bucket money and not in the books', async () => {
    const { op } = await withdrawn(conservadorLiveV8.policyId, '5000000', 2_000_000n)
    expect(op?.savingsOut).toEqual({ pending: '2000000', shares: {} })
  })

  test('the owner\'s summary is unchanged: no new line for the books', async () => {
    const a = await withdrawn(conservadorLiveV8.policyId, '1000000', 2_000_000n)
    const b = await withdrawn(conservadorLiveV8.policyId, '1000000', 0n)
    expect(a.plan.ownerTx.summary).toEqual(b.plan.ownerTx.summary)
    expect(b.op?.savingsOut).toBeUndefined()
  })

  test('a policy without a vault bucket keeps no books: nothing is stored', async () => {
    const { op } = await withdrawn(conservadorLiveV2.policyId, '1000000', 2_000_000n)
    expect(op?.savingsOut).toBeUndefined()
  })
})
