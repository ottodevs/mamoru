// otto/mamoru#430: every Stop the operator prepares is exactly what buildStop gives for the `stop` input it returns, so the
// Worker can rebuild it on the row's own Safe and chain before the owner signs.
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { buildStop } from '@mamoru/account/stop'
import { baseRegistry } from '@mamoru/registry'
import type { OwnerTxToSign } from '@mamoru/domain'
import { SAFE, ctx, quiet, sign, world } from './owner-world.ts'

const GRANT = { name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}` as Hex, grant: {} as never }

function rebuilds(tx: OwnerTxToSign) {
  expect(tx.stop).toBeDefined()
  expect(tx.stop!.safe.toLowerCase()).toBe(SAFE.toLowerCase())
  expect(tx.stop!.chainId).toBe(8453)
  expect(buildStop(tx.stop!, baseRegistry).safeTxHash).toBe(tx.safeTxHash)
}

describe('a prepared Stop carries the builder input it was built from (#430)', () => {
  test('a full Stop with positions and a swap back', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [GRANT]
    w.chain.positions = [{ tokenId: 7n, liquidity: 1_000_000_000n }]
    w.knobs.idle = { cbBTC: 5_000_000n }
    const tx = await w.op.prepareStop(ctx)
    rebuilds(tx)
    expect(tx.stop!.positions.map((p) => p.tokenId)).toEqual(['7'])
    expect(tx.stop!.revokes).toEqual([GRANT.permissionId])
    expect(tx.stop!.swaps.length).toBeGreaterThan(0)
    expect(tx.stop!.refund).toBeUndefined()
    expect((await quiet(() => w.op.submit(ctx, 'stop', sign(tx)))).out).toMatchObject({ kind: 'exit', state: 'confirmed' })
  })

  test('a revoke-only Stop', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [GRANT]
    const tx = await w.op.prepareStop(ctx, { revokeOnly: true })
    rebuilds(tx)
    expect(tx.stop).toMatchObject({ positions: [], vaultExits: [], swaps: [], deadline: '0', revokes: [GRANT.permissionId] })
  })

  test('a Safe-paid Stop carries its refund, within what the builder accepts', async () => {
    const w = world(5_000_000n, { sponsor: { perAccount: 0, stopsPerAccount: 0, weiPerDay: 0n, reserveBps: 0 } })
    w.chain.deployed = true
    w.chain.safeEth = 10n ** 16n
    w.op.account(ctx).acc.grants = [GRANT]
    w.chain.positions = [{ tokenId: 7n, liquidity: 1_000_000_000n }]
    const tx = await w.op.prepareStop(ctx)
    rebuilds(tx)
    expect(tx.stop!.refund).toBeDefined()
    expect(BigInt(tx.stop!.refund!.gasPrice)).toBeGreaterThan(0n)
  })
})
