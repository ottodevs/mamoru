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

// otto/mamoru#401 (spec 012 HRV-R4, V3): a design-C sleeve's idle USDC due home has no signed way back. The account is
// recorded as needing a renewal (paged once, listed on /metrics) instead of the return being dropped silently.
describe('a V3 sleeve whose idle USDC is due home is recorded as needing a renewal (otto/mamoru#401)', () => {
  type Note = (acc: unknown, due: { bucket: string; chainId: number; amount: bigint } | undefined) => void
  function harness(v4: boolean) {
    const self = { onV4: () => v4, returnBlocked: new Map() }
    const note = (Operator.prototype as unknown as { noteReturnBlocked: Note }).noteReturnBlocked.bind(self)
    const list = (Operator.prototype as unknown as { remoteReturnBlocked: () => unknown[] }).remoteReturnBlocked.bind(self)
    const acc = { accountKey: '3e4d1d49-7487-4d6a-b247-8bbddc637937', remote: { chainId: 143, address: '0x0003d8021BBeC02291b7F0001e05d56BeC3734Cc' } }
    return { note: (due?: { bucket: string; chainId: number; amount: bigint }) => note(acc, due), list }
  }
  const due = { bucket: 'growth', chainId: 143, amount: 449_550_202n }

  test('paged once while due, listed, cleared when nothing is due; V4 goes home instead and is never listed', () => {
    const h = harness(false)
    const lines: string[] = []
    const error = console.error
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(' '))
    try {
      h.note(due)
      h.note(due)
    } finally {
      console.error = error
    }
    expect(lines.filter((l) => l.includes('needs a renewal'))).toHaveLength(1)
    expect(h.list()).toEqual([{ account: '3e4d1d49', amountUsdc: '449550202', sinceS: expect.any(Number) }])
    h.note(undefined)
    expect(h.list()).toEqual([])
    const v4 = harness(true)
    v4.note(due)
    expect(v4.list()).toEqual([])
  })
})

// otto/mamoru#401: the home reads its design-C sleeve with the idle threshold (so HRV-R4 can see idle USDC) and its cap.
describe("the home's view of a design-C sleeve carries its idle USDC and its own cap (otto/mamoru#401)", () => {
  test('remote() is asked with the idle threshold (minEntry, or past the sleeve band) and the spec cap is added', async () => {
    const asked: unknown[][] = []
    const policy = { minEntry: 3_000_000n, remoteBuckets: [{ id: 'growth', chainId: 143 }], execution: { twapWindowSeconds: 1_800 } }
    const self = {
      cfg: { bridgeMonad: { remote: async (...a: unknown[]) => (asked.push(a), { value: 10n, inFlight: 0n, ready: true, idle: 10n }) } },
      enginePolicyOf: () => policy,
      onV4: () => false,
      idleMinOf: (Operator.prototype as unknown as { idleMinOf: unknown }).idleMinOf,
    }
    const acc = { accountKey: 'a', remote: { chainId: 143, address: '0x00000000000000000000000000000000000000cc', permissionIds: [], spec: { validUntil: 4_000_000_000, capUsdc: '1233333333' } } }
    const of = (Operator.prototype as unknown as { remoteOf: (a: unknown) => { remote?: (b: bigint) => Promise<unknown> } }).remoteOf.bind(self)
    const r = await of(acc).remote!(1n)
    const min = asked[0]!.at(-1) as (v: bigint) => bigint
    // The account's smallest entry, or more than the sleeve engine's 3 % band of the sleeve's value when that is larger.
    expect(min(10_000_000n)).toBe(3_000_000n)
    expect(min(1_000_000_000n)).toBe(30_000_001n)
    expect(r).toEqual({ value: 10n, inFlight: 0n, ready: true, idle: 10n, cap: 1_233_333_333n })
  })
})
