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
})
