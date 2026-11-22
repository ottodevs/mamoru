import { describe, expect, test } from 'bun:test'
import type { Address, Hex } from 'viem'
import { baseRegistry } from '@mamoru/registry'
import type { AccountState, StoredOp } from '../src/state.ts'
import { DEPOSITS_KEPT, type DepositRow } from '../src/deposits.ts'
import { BACKFILL_MARGIN_BLOCKS, backfillTick, verifyCovers, coverAfterLook, coverWire, mergeMints, mintsOf, planBackfill, sweepThrough, withCover, type CoverSource, type FlowBackfillJob } from '../src/flow-cover.ts'
import type { Snapshot } from '../src/snapshot.ts'
import type { AccountReceiptsWire } from '../src/yield-receipts.ts'

// otto/mamoru#438: what the operator vouches of an account's flows.
const SAFE = '0x00000000000000000000000000000000000000b1' as Address
const SAFE2 = '0x00000000000000000000000000000000000000b2' as Address
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address
const WALLET = '0x00000000000000000000000000000000000000aa' as Address

const acct = (key: string, safe: Address, o: Partial<AccountState> = {}): AccountState => ({ accountKey: key, ctx: { address: safe }, ops: [], historyFromBlock: '0', ...o }) as unknown as AccountState
const log = (from: Address, to: Address, value: bigint, block: bigint, tx = `0x${block.toString(16).padStart(4, '0')}`, logIndex = 0) => ({ args: { from, to, value }, transactionHash: tx as Hex, logIndex, blockNumber: block, blockTimestamp: 1_762_000_000n + block })
const dep = (block: string, i = 0): DepositRow => ({ txHash: `0xd${block}` as Hex, logIndex: i, block, amountUsdc: '1000000', from: WALLET as Hex, at: '2026-11-10T10:00:00.000Z' })

function source(accounts: AccountState[], logs: ReturnType<typeof log>[], o: { over?: boolean; fail?: boolean; balance?: (safe: Address, block: bigint) => bigint; code?: (safe: Address) => boolean } = {}) {
  const calls: { safes: Address[]; from: bigint; to: bigint }[] = []
  const state: { job?: FlowBackfillJob } = {}
  const src: CoverSource = {
    accounts: () => accounts.map((acc) => ({ acc, usdc: USDC })),
    registry: baseRegistry,
    readLogs: async (_u, safes, from, to) => {
      calls.push({ safes, from, to })
      if (o.fail) throw new Error('rpc down')
      const set = new Set(safes.map((s) => s.toLowerCase()))
      return logs.filter((l) => set.has(l.args.to.toLowerCase()) && l.blockNumber >= from && l.blockNumber <= to)
    },
    blockTime: async (b) => 1_762_000_000n + b,
    balanceAt: async (_u, safe, block) => {
      calls.push({ safes: [safe], from: block, to: block })
      return o.balance?.(safe, block) ?? 0n
    },
    deployedAt: async (safe) => o.code?.(safe) ?? false,
    job: () => state.job,
    setJob: (j) => (state.job = j),
    save: () => {},
    overBudget: () => !!o.over,
  }
  return { src, calls, state }
}

describe('coverAfterLook', () => {
  test('a first look covers from where it starts; a look that skipped a hole starts again and needs the backfill; a look going on changes nothing', () => {
    expect(coverAfterLook(undefined, SAFE, undefined, 100n)).toEqual({ safe: SAFE, fromBlock: '100' })
    const c = { safe: SAFE, fromBlock: '100' }
    expect(coverAfterLook(c, SAFE, 500n, 501n)).toBe(c)
    expect(coverAfterLook(c, SAFE, 500n, 9_000n)).toEqual({ safe: SAFE, fromBlock: '9000', backfill: true })
    // A look whose cursor predates the cover: none until the backfill.
    expect(coverAfterLook(undefined, SAFE, 500n, 501n)).toBeUndefined()
    // Another Safe's cover is not this one's.
    expect(coverAfterLook({ safe: SAFE2, fromBlock: '1' }, SAFE, 500n, 501n)).toBeUndefined()
  })
})

describe('coverWire', () => {
  test('nothing without a cover, for another Safe, while a hole waits for the backfill, or before its start is proven', () => {
    expect(coverWire(acct('k', SAFE, { flowCover: { safe: SAFE, fromBlock: '1' } }), SAFE, 10n)).toBeUndefined()
    expect(coverWire(acct('k', SAFE), SAFE, 10n)).toBeUndefined()
    expect(coverWire(acct('k', SAFE, { flowCover: { safe: SAFE2, fromBlock: '1' } }), SAFE, 10n)).toBeUndefined()
    expect(coverWire(acct('k', SAFE, { flowCover: { safe: SAFE, fromBlock: '1', backfill: true } }), SAFE, 10n)).toBeUndefined()
  })

  test('open: a deposit list at its cap and a withdrawal not dated yet; through and mints as kept', () => {
    const pending = { opId: 'own-1', kind: 'transfer', state: 'confirmed', txHash: '0xe1', amountUsdc: '5000000', updatedAt: '' } as unknown as StoredOp
    const dated = { ...pending, opId: 'own-2', txHash: '0xe2', facts: { txHash: '0xe2', at: '2026-11-10T10:00:00.000Z' } } as unknown as StoredOp
    const a = acct('k', SAFE, { flowCover: { safe: SAFE, fromBlock: '7', verified: true }, ops: [pending, dated], flowMints: [{ txHash: '0xm', logIndex: 0, block: '9', amountUsdc: '3000000', at: '2026-11-10T10:00:00.000Z' }] })
    expect(coverWire(a, SAFE, 10n)).toEqual({ from: 7, through: 10, open: ['out:own-1'], mints: [{ block: 9, t: Date.parse('2026-11-10T10:00:00.000Z') / 1000, usdc: '3000000' }] })
    // Its receipt facts arrive: the reason is gone on the next snapshot.
    pending.facts = { txHash: '0xe1', at: '2026-11-10T11:00:00.000Z' } as never
    expect(coverWire(a, SAFE, undefined)).toEqual({ from: 7, open: [], mints: expect.any(Array) })
    a.deposits = Array.from({ length: DEPOSITS_KEPT }, (_, i) => dep(String(i + 1)))
    expect(coverWire(a, SAFE, 10n)!.open).toEqual(['deposits-cap'])
  })
})

describe('mints', () => {
  test('only USDC minted to the Safe, not dust nor its own transactions; merged once in chain order', () => {
    const logs = [log(ZERO, SAFE, 5_000_000n, 20n), log(WALLET, SAFE, 5_000_000n, 21n), log(ZERO, SAFE, 10n, 22n), log(ZERO, SAFE, 9_000_000n, 23n, '0xown'), log(ZERO, SAFE2, 9_000_000n, 24n)]
    const m = mintsOf(logs, SAFE, 'x', new Set(['0xown']))
    expect(m.map((r) => r.block)).toEqual(['20'])
    expect(mergeMints(m, [...m, ...mintsOf([log(ZERO, SAFE, 2_000_000n, 3n)], SAFE, 'x')]).map((r) => r.block)).toEqual(['3', '20'])
  })
})

describe('log backfill', () => {
  test('plans one job for every Safe with a cursor and no cover, from the margin before its first known block to the latest cursor', () => {
    const own = { opId: 'own-1', block: '2000000', kind: 'activate', state: 'confirmed' } as unknown as StoredOp
    const legacy = acct('a', SAFE, { depositsSeen: { safe: SAFE, block: '3000000' }, ops: [own] })
    const covered = acct('b', SAFE2, { depositsSeen: { safe: SAFE2, block: '3100000' }, flowCover: { safe: SAFE2, fromBlock: '3000000' } })
    const fresh = acct('c', '0x00000000000000000000000000000000000000b3' as Address)
    expect(planBackfill([legacy, covered, fresh].map((acc) => ({ acc, usdc: USDC })))).toEqual({ from: (2_000_000n - BACKFILL_MARGIN_BLOCKS).toString(), to: '3000000', next: (2_000_000n - BACKFILL_MARGIN_BLOCKS).toString(), accounts: [{ accountKey: 'a', safe: SAFE }] })
    expect(planBackfill([covered, fresh].map((acc) => ({ acc, usdc: USDC })))).toBeUndefined()
    // A cover that starts after the account's activation (its first look came late) is read back too.
    const late = acct('d', SAFE2, { depositsSeen: { safe: SAFE2, block: '3100000' }, flowCover: { safe: SAFE2, fromBlock: '3000000' }, historyFromBlock: '2900000' })
    expect(planBackfill([{ acc: late, usdc: USDC }])).toMatchObject({ to: '2999999', accounts: [{ accountKey: 'd', safe: SAFE2 }] })
  })

  test('reads pages with one filter for every Safe, keeps deposits and mints, and covers each account from the start when done', async () => {
    const a = acct('a', SAFE, { depositsSeen: { safe: SAFE, block: '5000' } })
    const b = acct('b', SAFE2, { depositsSeen: { safe: SAFE2, block: '4000' }, flowCover: { safe: SAFE2, fromBlock: '4500', backfill: true } })
    const { src, calls, state } = source([a, b], [log(WALLET, SAFE, 3_000_000n, 100n), log(ZERO, SAFE2, 4_000_000n, 3_000n), log(WALLET, SAFE2, 1_000n, 3_001n)])
    await backfillTick(src, 2)
    expect(state.job).toEqual({ from: '0', to: '5000', next: '4000', accounts: [{ accountKey: 'a', safe: SAFE }, { accountKey: 'b', safe: SAFE2 }] })
    expect(calls.map((c) => [c.safes.length, c.from, c.to])).toEqual([[2, 0n, 1999n], [2, 2000n, 3999n]])
    expect(a.deposits?.map((d) => d.block)).toEqual(['100'])
    expect(b.flowMints?.map((m) => m.block)).toEqual(['3000'])
    expect(b.deposits).toBeUndefined() // dust
    expect(a.flowCover).toBeUndefined()
    await backfillTick(src, 2)
    expect(state.job).toBeUndefined()
    expect(a.flowCover).toEqual({ safe: SAFE, fromBlock: '0' })
    expect(b.flowCover).toEqual({ safe: SAFE2, fromBlock: '0' })
  })

  test('a failed page is read again; over the RPC budget nothing is read; a hole opened after the job keeps its account waiting', async () => {
    const a = acct('a', SAFE, { depositsSeen: { safe: SAFE, block: '1000' } })
    const over = source([a], [], { over: true })
    await backfillTick(over.src)
    expect(over.calls).toEqual([])
    const failing = source([a], [], { fail: true })
    await backfillTick(failing.src)
    expect(failing.state.job?.next).toBe('0')
    const { src, state } = source([a], [])
    state.job = failing.state.job
    a.flowCover = { safe: SAFE, fromBlock: '50000', backfill: true } // its look skipped past the job's end meanwhile
    await backfillTick(src)
    expect(state.job).toBeUndefined()
    expect(a.flowCover).toEqual({ safe: SAFE, fromBlock: '50000', backfill: true })
  })
})

describe('through', () => {
  test('the snapshot block when (cursor, block] holds no deposit or mint; not with an arrival there, nor a cursor too far behind', async () => {
    const quiet = acct('q', SAFE, { depositsSeen: { safe: SAFE, block: '9900' }, flowCover: { safe: SAFE, fromBlock: '1', verified: true } })
    const busy = acct('b', SAFE2, { depositsSeen: { safe: SAFE2, block: '9950' }, flowCover: { safe: SAFE2, fromBlock: '1', verified: true } })
    const far = acct('f', '0x00000000000000000000000000000000000000b3' as Address, { depositsSeen: { safe: '0x00000000000000000000000000000000000000b3', block: '1' }, flowCover: { safe: '0x00000000000000000000000000000000000000b3', fromBlock: '1', verified: true } })
    const { src, calls } = source([quiet, busy, far], [log(WALLET, SAFE, 5_000_000n, 9_800n), log(WALLET, SAFE2, 5_000_000n, 9_990n)])
    const t = await sweepThrough(src, 10_000n)
    expect([...t]).toEqual([['q', 10_000n]])
    expect(calls.map((c) => [c.safes.length, c.from, c.to])).toEqual([[2, 9_901n, 10_000n]])
  })

  test('withCover puts the cover on the receipts entry, adding one for an account with none, with the flows as the state holds them now', async () => {
    // A deposit recorded after the receipts were built: the cover vouches its cursor, so the flows carry it.
    const a = acct('a', SAFE, { depositsSeen: { safe: SAFE, block: '1000' }, flowCover: { safe: SAFE, fromBlock: '5', verified: true }, deposits: [dep('900')] })
    const b = acct('b', SAFE2, { depositsSeen: { safe: SAFE2, block: '1000' }, flowCover: { safe: SAFE2, fromBlock: '6', verified: true } })
    const { src } = source([a, b], [])
    const snap = { chainId: 8453, block: 1_000n, readAt: '', pools: {}, safes: [], calls: 0, receipts: [{ safe: SAFE, days: [] }] } as Snapshot & { receipts: AccountReceiptsWire[] }
    const out = await withCover(snap, src)
    expect(out.receipts).toEqual([
      { safe: SAFE, days: [], flows: [{ id: 'in:0xd900:0', t: Date.parse('2026-11-10T10:00:00.000Z') / 1000, kind: 'in', usdc: '1000000' }], cover: { from: 5, through: 1000, open: [], mints: [] } },
      { safe: SAFE2, days: [], cover: { from: 6, through: 1000, open: [], mints: [] } },
    ])
  })
})

describe('verifyCovers', () => {
  test('a start with no op before it and only dust at the block before is proven; a balance there sends it back to the backfill; a start after an op waits for planBackfill', async () => {
    const own = { opId: 'own-1', block: '600', kind: 'activate', state: 'confirmed' } as unknown as StoredOp
    const clean = acct('a', SAFE, { flowCover: { safe: SAFE, fromBlock: '500' }, ops: [own] })
    const funded = acct('b', SAFE2, { flowCover: { safe: SAFE2, fromBlock: '500' } })
    const late = acct('c', '0x00000000000000000000000000000000000000b3' as Address, { flowCover: { safe: '0x00000000000000000000000000000000000000b3', fromBlock: '700' }, ops: [own] })
    const { src, calls } = source([clean, funded, late], [], { balance: (safe) => (safe === SAFE2 ? 50_000_000n : 9_999n) })
    await verifyCovers(src)
    expect(clean.flowCover).toEqual({ safe: SAFE, fromBlock: '500', verified: true })
    expect(funded.flowCover).toEqual({ safe: SAFE2, fromBlock: '500', backfill: true })
    expect(late.flowCover).toEqual({ safe: '0x00000000000000000000000000000000000000b3', fromBlock: '700' })
    expect(calls.map((c) => c.from)).toEqual([499n, 499n])
    // The funded one is read back from 30 days before its start.
    const job = planBackfill([{ acc: funded, usdc: USDC }, { acc: { ...funded, depositsSeen: { safe: SAFE2, block: '900' } } as AccountState, usdc: USDC }])
    expect(job).toMatchObject({ from: '0', to: '499' })
  })
})

describe('verifyCovers: code and read limits', () => {
  test('a Safe that already had code at the block before the start is read back (it may have held a position); a failed read waits an hour', async () => {
    const a = acct('a', SAFE, { flowCover: { safe: SAFE, fromBlock: '500' } })
    await verifyCovers(source([a], [], { code: () => true }).src)
    expect(a.flowCover).toEqual({ safe: SAFE, fromBlock: '500', backfill: true })
    const b = acct('b', SAFE2, { flowCover: { safe: SAFE2, fromBlock: '500' } })
    const failing = source([b], [], { fail: true })
    failing.src.balanceAt = async () => {
      throw new Error('no history')
    }
    await verifyCovers(failing.src, 1_000)
    const again = source([b], [])
    await verifyCovers(again.src, 1_000 + 60_000)
    expect(b.flowCover).toEqual({ safe: SAFE2, fromBlock: '500' })
    await verifyCovers(again.src, 1_000 + 3_600_000)
    expect(b.flowCover).toEqual({ safe: SAFE2, fromBlock: '500', verified: true })
  })

  test('at most VERIFY_PER_TICK starts per tick, none over the budget', async () => {
    const many = Array.from({ length: 7 }, (_, i) => acct(`k${i}`, `0x00000000000000000000000000000000000000${(0xc0 + i).toString(16)}` as Address, { flowCover: { safe: `0x00000000000000000000000000000000000000${(0xc0 + i).toString(16)}`, fromBlock: '500' } }))
    await verifyCovers(source(many, [], { over: true }).src)
    expect(many.filter((a) => a.flowCover?.verified).length).toBe(0)
    await verifyCovers(source(many, []).src)
    expect(many.filter((a) => a.flowCover?.verified).length).toBe(5)
  })
})
