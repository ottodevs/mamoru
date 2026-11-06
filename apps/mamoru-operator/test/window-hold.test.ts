// otto/mamoru#376, spec 011 SCN-CAP-09: a spending-limit refusal holds every spending op of the account; one probe per
// 6 h at most; a landed probe lifts it; exits, collects and redeems are never held.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { toFunctionSelector } from 'viem'
import { Operator } from '../src/operator.ts'
import { SpendHold, SPEND_HOLD_PROBE_MS, isSpend, spendDenialOf } from '../src/window-hold.ts'

const H = 3600_000
const T0 = Date.parse('2026-11-07T00:00:00Z')
const spends = ['enter_swap', 'enter_mint', 'increase_liquidity', 'rerange', 'vault_deposit'] as const
const others = ['harvest', 'reduce', 'vault_redeem', 'bridge_out'] as const

describe('spendDenialOf: the refusals that mean a spending limit is used up', () => {
  test('V4 Cap24hExceeded, Cap30Exceeded, BudgetExceeded and the V3 session PolicyViolation, by selector or name', () => {
    expect(spendDenialOf('UserOperation reverted during simulation with reason: 0x7689e277000000')).toBe('Cap24hExceeded')
    expect(spendDenialOf('revert 0x0B18B78C...')).toBe('Cap30Exceeded')
    expect(spendDenialOf('{"revert":"0x32912740"}')).toBe('BudgetExceeded')
    expect(spendDenialOf('AA23 reverted 0x3b577361')).toBe('PolicyViolation')
    expect(spendDenialOf('BudgetExceeded(key, value)')).toBe('BudgetExceeded')
  })
  test('anything else is not a spending limit', () => {
    expect(spendDenialOf('AA25 invalid account nonce')).toBeNull()
    expect(spendDenialOf(undefined)).toBeNull()
  })
})

describe('SpendHold (SCN-CAP-09)', () => {
  test('which proposals spend', () => {
    for (const k of spends) expect(isSpend({ kind: k })).toBe(true)
    for (const k of others) expect(isSpend({ kind: k })).toBe(false)
  })

  test('after a refusal no spend goes between probes; at most one probe per 6 h, at most 4 refusals a day', () => {
    const h = new SpendHold()
    expect(h.denied('a', 'Cap24hExceeded', T0)).toBe(true)
    let refused = 1
    let probes = 0
    // A review every 10 minutes for 24 h, every probe refused again.
    for (let t = T0 + 10 * 60_000; t < T0 + 24 * H; t += 10 * 60_000) {
      if (h.admit('a', { kind: 'enter_mint' }, t)) {
        probes++
        expect(h.denied('a', 'Cap24hExceeded', t)).toBe(false)
        refused++
      }
    }
    expect(probes).toBe(3)
    expect(refused).toBeLessThanOrEqual(4)
  })

  test('exits, collects, reduces, redeems and bridges are never held', () => {
    const h = new SpendHold()
    h.denied('a', 'PolicyViolation', T0)
    for (const k of others) expect(h.admit('a', { kind: k }, T0 + 1)).toBe(true)
    expect(h.admit('a', { kind: 'enter_swap' }, T0 + 1)).toBe(false)
  })

  test('a probe that lands lifts the hold and every spend goes again; other accounts are not held', () => {
    const h = new SpendHold()
    h.denied('a', 'Cap30Exceeded', T0)
    expect(h.admit('b', { kind: 'enter_swap' }, T0 + 1)).toBe(true)
    expect(h.admit('a', { kind: 'vault_deposit' }, T0 + SPEND_HOLD_PROBE_MS)).toBe(true)
    expect(h.landed('a')).toBe(true)
    expect(h.admit('a', { kind: 'enter_mint' }, T0 + SPEND_HOLD_PROBE_MS + 1)).toBe(true)
    expect(h.landed('a')).toBe(false)
  })
})

describe('the V4 refusals match the deployed contract (review of #315)', () => {
  test('MamoruActionPolicyV4 declares the errors with the argument types the selectors are taken from', () => {
    const src = readFileSync(join(import.meta.dir, '../../../contracts/action-policy/src/MamoruActionPolicyV4.sol'), 'utf8')
    expect(src).toContain('error Cap24hExceeded(uint256 spent, uint256 value);')
    expect(src).toContain('error Cap30Exceeded(uint256 spent, uint256 value);')
    expect(src).toContain('error BudgetExceeded(address key, uint256 value);')
    expect(spendDenialOf(toFunctionSelector('function Cap24hExceeded(uint256,uint256)'))).toBe('Cap24hExceeded')
  })
})

describe('the operator follows spend ops across reviews (journal transitions)', () => {
  type T = { opId: string; seq: number; to: string; detail?: string }
  const watch = (Operator.prototype as unknown as { watchSpendHold: (acc: unknown, engine: unknown) => void }).watchSpendHold
  function rig() {
    const ops = new Map<string, { intent: { kind: string } }>([['s1', { intent: { kind: 'enter_mint' } }], ['h1', { intent: { kind: 'harvest' } }], ['s2', { intent: { kind: 'enter_swap' } }]])
    const transitions: T[] = []
    const journal = { transitions, op: (id: string) => ops.get(id) ?? (() => { throw new Error('no op') })() }
    const self = { spendHold: new SpendHold(), spendHoldSeen: new Map<string, { journal: object; at: number }>([['a', { journal, at: 0 }]]), spendHoldKey: () => 'a:g' }
    const acc = { accountKey: 'a', grants: [] }
    return { self, journal, transitions, run: () => watch.call(self, acc, { journal }) }
  }

  test('a refusal seen in one review holds; a confirmation of a later probe, seen in another review, lifts', () => {
    const r = rig()
    r.transitions.push({ opId: 's1', seq: 1, to: 'pending_reconciliation', detail: 'AA23 reverted 0x7689e277' })
    r.run()
    expect(r.self.spendHold.of('a:g')?.reason).toBe('Cap24hExceeded')
    r.transitions.push({ opId: 's2', seq: 2, to: 'submitted' })
    r.run()
    expect(r.self.spendHold.of('a:g')).toBeDefined()
    r.transitions.push({ opId: 's2', seq: 3, to: 'confirmed' })
    r.run()
    expect(r.self.spendHold.of('a:g')).toBeUndefined()
  })

  test('non-spend ops and unknown ops are ignored; each transition is read once', () => {
    const r = rig()
    r.transitions.push({ opId: 'h1', seq: 1, to: 'discarded', detail: '0x7689e277' }, { opId: 'gone', seq: 2, to: 'discarded', detail: '0x7689e277' })
    r.run()
    r.run()
    expect(r.self.spendHold.of('a:g')).toBeUndefined()
  })

  test('a journal the watcher was not seeded with (rebuilt with old transitions) is read from its end, never replayed', () => {
    const r = rig()
    r.self.spendHoldSeen.clear()
    r.transitions.push({ opId: 's1', seq: 1, to: 'discarded', detail: '0x7689e277' })
    r.run()
    expect(r.self.spendHold.of('a:g')).toBeUndefined()
  })
})

