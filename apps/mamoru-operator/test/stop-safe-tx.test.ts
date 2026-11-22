// otto/mamoru#430: a Stop prepare carries its Safe tx, and what the operator plans is what the Worker's check admits
// (whyNotStop): revokes, closes and burns, swaps back to USDC, all paying the Safe.
import { describe, expect, test } from 'bun:test'
import type { Hex } from 'viem'
import { whyNotStop } from '@mamoru/account/stop-check'
import { baseRegistry } from '@mamoru/registry'
import { SAFE, ctx, world } from './owner-world.ts'

const GRANT = { name: 'enter-swap', permissionId: `0x${'aa'.repeat(32)}` as Hex, grant: {} as never }

describe('Stop prepare carries a Safe tx the Worker admits (#430)', () => {
  test('a full Stop (revoke, close and burn, swap cbBTC back): safeTx present and admitted', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [GRANT]
    w.chain.positions = [{ tokenId: 2n, liquidity: 1_000_000_000n }]
    w.knobs.idle = { cbBTC: 50_000n }
    const tx = await w.op.prepareStop(ctx)
    expect(tx.summary.some((l) => l.startsWith('Close and burn position #2'))).toBe(true)
    expect(tx.summary.some((l) => l.startsWith('Swap '))).toBe(true)
    expect(tx.safeTx?.operation).toBe(1)
    expect(whyNotStop(SAFE, ctx.chainId, tx, baseRegistry)).toBeNull()
  })

  test('a revoke-only Stop: one call, admitted', async () => {
    const w = world(5_000_000n)
    w.chain.deployed = true
    w.op.account(ctx).acc.grants = [GRANT]
    const tx = await w.op.prepareStop(ctx, { revokeOnly: true })
    expect(tx.safeTx?.operation).toBe(0)
    expect(whyNotStop(SAFE, ctx.chainId, tx, baseRegistry)).toBeNull()
  })
})
