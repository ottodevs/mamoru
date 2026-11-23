// otto/mamoru#456: funding's display read of a Safe without code does not ask eth_getCode again for 10 minutes;
// owner reads always do, and anything that moves the account asks again.
import { describe, expect, test } from 'bun:test'
import type { Address } from '@mamoru/domain'
import type { SafeRead } from '../src/chain.ts'
import type { AccountState } from '../src/state.ts'
import { SAFE, ctx, sign, world } from './owner-world.ts'

type Priv = { client: { getCode: (a: unknown) => Promise<unknown> }; readOf(a: AccountState, s: Address, display?: boolean): Promise<SafeRead>; fundingMoved(a: AccountState): void; noCodeAt: Map<string, number> }

describe('otto/mamoru#456: an undeployed Safe is not asked for its code on every funding read', () => {
  function setup() {
    const w = world(0n)
    const p = w.op as unknown as Priv
    let codes = 0
    const real = p.client.getCode.bind(p.client)
    p.client.getCode = async (a) => (codes++, real(a))
    return { w, p, codes: () => codes }
  }

  test('display reads: one eth_getCode, then none for 10 minutes; owner reads always ask', async () => {
    const { w, p, codes } = setup()
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    await p.readOf(acc, SAFE, true)
    const first = codes()
    expect(first).toBeGreaterThan(0)
    expect((await p.readOf(acc, SAFE, true)).deployed).toBe(false)
    expect((await p.readOf(acc, SAFE, true)).deployed).toBe(false)
    expect(codes()).toBe(first)
    // An owner prepare's read asks the chain.
    await p.readOf(acc, SAFE)
    expect(codes()).toBe(first + 1)
    // Ten minutes later the display read asks again.
    p.noCodeAt.set(`k:${SAFE.toLowerCase()}`, Date.now() - 10 * 60_000 - 1)
    await p.readOf(acc, SAFE, true)
    expect(codes()).toBe(first + 2)
  })

  test('the account moving (an owner op, a deposit) asks again, and a deployed Safe is never taken as undeployed', async () => {
    const { w, p, codes } = setup()
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    await p.readOf(acc, SAFE, true)
    const before = codes()
    p.fundingMoved(acc)
    await p.readOf(acc, SAFE, true)
    expect(codes()).toBe(before + 1)
    // Deployed (the activation ran): the next display read asks and sees it, and nothing is kept.
    w.chain.deployed = true
    p.fundingMoved(acc)
    expect((await p.readOf(acc, SAFE, true)).deployed).toBe(true)
    expect(p.noCodeAt.size).toBe(0)
  })

  test('a read in flight when the account moves keeps nothing, whatever the clock does', async () => {
    const { w, p } = setup()
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    p.noCodeAt.clear()
    const real = Date.now
    try {
      const read = p.readOf(acc, SAFE, true)
      // The move lands while the read runs, stamped by a clock set back an hour.
      Date.now = () => real() - 3_600_000
      p.fundingMoved(acc)
      await read
    } finally {
      Date.now = real
    }
    expect(p.noCodeAt.size).toBe(0)
  })
})

describe('otto/mamoru#456: background reconciliation that concludes nothing backs off', () => {
  type R = { reconcileSoon(a: AccountState): void; reconcileOwner(a: AccountState): Promise<void>; reconciled: Map<string, number>; reconcileQuiet: Map<string, { until: number; delay: number }>; reconcileTimers: Map<string, { timer: unknown; delay: number }>; patchOp(a: AccountState, id: string, p: object): void }
  async function setup(conclude = () => false, fail = false) {
    const w = world(0n)
    await w.op.submit(ctx, 'activate', sign(await w.op.prepareActivate(ctx)))
    const acc = w.state.accounts.k!
    acc.ops.push({ opId: 'own-9-activate', kind: 'activate', state: 'failed', code: 'OWNER_TX_ERROR', updatedAt: '2026-09-27T00:00:00.000Z' } as never)
    const r = w.op as unknown as R
    let passes = 0
    r.reconcileOwner = async (a) => {
      passes++
      if (fail) throw new Error('rpc down')
      if (conclude()) Object.assign(a.ops.find((o) => o.opId === 'own-9-activate')!, { state: 'confirmed', code: 'EXEC_OK' })
    }
    // One pass: the 20 s gap is waived (as reconcileLater's timer does), then the lock and the bookkeeping settle.
    const pass = async () => {
      r.reconciled.delete('k')
      r.reconcileSoon(acc)
      for (let i = 0; i < 5; i++) await Bun.sleep(0)
    }
    const stop = () => {
      for (const t of r.reconcileTimers.values()) clearTimeout(t.timer as never)
    }
    return { acc, r, pass, stop, passes: () => passes }
  }

  test('held 30 s after a pass that concluded nothing, then 1, 2, 4 min… up to an hour; a clock set back is not held', async () => {
    const s = await setup()
    try {
      await s.pass()
      expect(s.passes()).toBe(1)
      await s.pass()
      await s.pass()
      expect(s.passes()).toBe(1)
      expect(s.r.reconcileQuiet.get('k')!.delay).toBe(30_000)
      s.r.reconcileQuiet.get('k')!.until = Date.now() - 1
      await s.pass()
      expect(s.passes()).toBe(2)
      expect(s.r.reconcileQuiet.get('k')!.delay).toBe(60_000)
      for (let i = 0; i < 12; i++) {
        s.r.reconcileQuiet.get('k')!.until = Date.now() - 1
        await s.pass()
      }
      expect(s.r.reconcileQuiet.get('k')!.delay).toBe(3_600_000)
      s.r.reconcileQuiet.get('k')!.until = Date.now() + 2 * 3_600_000
      const n = s.passes()
      await s.pass()
      expect(s.passes()).toBe(n + 1)
    } finally {
      s.stop()
    }
  })

  test('a pass that throws is held too; an owner op changing state ends the hold', async () => {
    const s = await setup(() => false, true)
    try {
      await s.pass()
      await s.pass()
      expect(s.passes()).toBe(1)
      const own = s.acc.ops.find((o) => o.opId.startsWith('own-') && o.opId !== 'own-9-activate')!
      s.r.patchOp(s.acc, own.opId, { state: own.state })
      await s.pass()
      expect(s.passes()).toBe(2)
    } finally {
      s.stop()
    }
  })

  test('a timer that fires just short of the hold keeps the backoff step and waits out only the rest', async () => {
    const s = await setup()
    const realSetTimeout = globalThis.setTimeout
    try {
      await s.pass()
      const t = s.r.reconcileTimers.get('k')!
      expect(t.delay).toBe(30_000)
      // The retry timer fires while the hold still has a minute to go (as Date.now rounding can leave 1 ms): no pass,
      // no doubling, and the next timer is set for the rest of the hold. The timer is captured, not left to run.
      clearTimeout(t.timer as never)
      t.timer = null
      s.r.reconcileQuiet.get('k')!.until = Date.now() + 60_000
      const waits: number[] = []
      let fire: (() => void) | undefined
      globalThis.setTimeout = ((fn: () => void, ms: number) => {
        waits.push(ms)
        fire = fn
        return realSetTimeout(() => {}, 0)
      }) as never
      await s.pass()
      globalThis.setTimeout = realSetTimeout
      expect(s.passes()).toBe(1)
      expect(s.r.reconcileTimers.get('k')!.delay).toBe(30_000)
      expect(waits).toHaveLength(1)
      expect(waits[0]).toBeGreaterThan(59_000)
      expect(waits[0]).toBeLessThanOrEqual(60_000)
      // The hold ends and that timer fires: the pass runs, and only it doubles the wait.
      s.r.reconcileQuiet.get('k')!.until = Date.now() - 1
      fire!()
      for (let i = 0; i < 5; i++) await Bun.sleep(0)
      expect(s.passes()).toBe(2)
      expect(s.r.reconcileTimers.get('k')!.delay).toBe(60_000)
    } finally {
      globalThis.setTimeout = realSetTimeout
      s.stop()
    }
  })

  test('a pass that concludes ends the hold and nothing is left to reconcile', async () => {
    let go = false
    const s = await setup(() => go)
    try {
      await s.pass()
      expect(s.r.reconcileQuiet.has('k')).toBe(true)
      s.r.reconcileQuiet.get('k')!.until = Date.now() - 1
      go = true
      await s.pass()
      expect(s.passes()).toBe(2)
      expect(s.r.reconcileQuiet.has('k')).toBe(false)
    } finally {
      s.stop()
    }
  })
})

describe('otto/mamoru#456: a peer asking for the exposure of a Safe with no code here asks eth_getCode once per 10 min', () => {
  test('unowned reads: one eth_getCode, then none until the mark ages out; code found clears it', async () => {
    const w = world(0n)
    const p = w.op as unknown as Priv & { readUnowned(s: Address): Promise<SafeRead> }
    let codes = 0
    const real = p.client.getCode.bind(p.client)
    p.client.getCode = async (a) => (codes++, real(a))
    const other = `0x${'9'.repeat(40)}` as Address
    await p.readUnowned(other)
    await p.readUnowned(other)
    await p.readUnowned(other)
    expect(codes).toBe(1)
    p.noCodeAt.set(`unowned:${other.toLowerCase()}`, Date.now() - 10 * 60_000 - 1)
    await p.readUnowned(other)
    expect(codes).toBe(2)
    w.chain.deployed = true
    p.noCodeAt.delete(`unowned:${other.toLowerCase()}`)
    expect((await p.readUnowned(other)).deployed).toBe(true)
    expect(p.noCodeAt.has(`unowned:${other.toLowerCase()}`)).toBe(false)
  })
})
