// otto/mamoru#376, spec 011 SCN-CAP-13: the return leg (Monad → Base) is asked only for V4 accounts, which have no bridge
// total. A V3 account's grant caps what it bridges (bridge-left.ts), and nothing clips a return: if this guard ever opens
// to V3, it must come with that clip. The guard is exercised on the real method with its collaborators stubbed.
import { describe, expect, test } from 'bun:test'
import { Operator } from '../src/operator.ts'

type Ask = (acc: unknown, amount: bigint, remoteValue: bigint, observedAt: number) => Promise<void>

function harness(v4: boolean) {
  const asked: bigint[] = []
  const self = {
    cfg: {
      returnHome: { busy: () => false, lastClosedAt: () => 0, request: async (_k: string, _a: string, _r: unknown, _p: unknown, amount: bigint) => (asked.push(amount), { id: 'r1' }) },
      remotePeers: { 143: { release: async () => undefined, releaseStatus: async () => undefined } },
      bridgeMonad: { pending: () => undefined },
    },
    onV4: () => v4,
    stopInFlight: () => false,
    migrationHold: () => false,
    v4RemoteContext: () => ({ address: '0x00000000000000000000000000000000000000aa' }),
  }
  const acc = { accountKey: 'a', active: true, policyId: v4 ? 'one-auth-v4' : 'conservador-live-v7', ctx: { address: '0x00000000000000000000000000000000000000bb' } }
  const ask = (Operator.prototype as unknown as { askReturn: Ask }).askReturn.bind(self)
  return { asked, run: () => ask(acc, 50_000_000n, 200_000_000n, 1) }
}

describe('askReturn is V4-only (spec 011 SCN-CAP-13)', () => {
  test('a V3 account with a return due asks nothing', async () => {
    const h = harness(false)
    await h.run()
    expect(h.asked).toEqual([])
  })

  test('a V4 account with the same input asks once', async () => {
    const h = harness(true)
    await h.run()
    expect(h.asked).toEqual([50_000_000n])
  })
})
