// Agent Lab runner (008 task 5, otto/mamoru#204): the daily budget guard — max N agent jobs/day across requesters,
// enforced on the runner side, a plain local JSON file (one writer, one job at a time, no locking needed).
import { defaultAgentBudgetStatePath, mkdtempSync, rmSync } from 'node:fs'
import { defaultAgentBudgetStatePath, tmpdir } from 'node:os'
import { defaultAgentBudgetStatePath, join } from 'node:path'
import { defaultAgentBudgetStatePath, afterEach, describe, expect, test } from 'bun:test'
import { defaultAgentBudgetStatePath, agentDailyBudget, checkAndIncrementAgentBudget, DEFAULT_AGENT_DAILY_BUDGET, peekAgentBudget } from '../src/agent-budget.ts'

describe('checkAndIncrementAgentBudget', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  test('the Nth+1 job of the day is refused; the state file never goes over the limit', () => {
    dir = mkdtempSync(join(tmpdir(), 'lab-agent-budget-'))
    const statePath = join(dir, 'budget.json')
    const now = new Date('2026-10-23T12:00:00Z')
    for (let i = 1; i <= 3; i++) {
      const check = checkAndIncrementAgentBudget({ statePath, limit: 3, now })
      expect(check).toEqual({ ok: true, count: i, limit: 3 })
    }
    const refused = checkAndIncrementAgentBudget({ statePath, limit: 3, now })
    expect(refused).toEqual({ ok: false, count: 3, limit: 3 })
    // A refused check must not itself consume budget — still refused, same count, not 4.
    expect(checkAndIncrementAgentBudget({ statePath, limit: 3, now })).toEqual({ ok: false, count: 3, limit: 3 })
  })

  test('a new UTC day resets the counter, even mid-run', () => {
    dir = mkdtempSync(join(tmpdir(), 'lab-agent-budget-'))
    const statePath = join(dir, 'budget.json')
    const day1 = new Date('2026-10-23T23:59:00Z')
    const day2 = new Date('2026-10-24T00:01:00Z')
    expect(checkAndIncrementAgentBudget({ statePath, limit: 1, now: day1 })).toEqual({ ok: true, count: 1, limit: 1 })
    expect(checkAndIncrementAgentBudget({ statePath, limit: 1, now: day1 })).toEqual({ ok: false, count: 1, limit: 1 })
    expect(checkAndIncrementAgentBudget({ statePath, limit: 1, now: day2 })).toEqual({ ok: true, count: 1, limit: 1 })
  })

  test('a missing or corrupt state file starts a fresh day at 0, never throws', () => {
    dir = mkdtempSync(join(tmpdir(), 'lab-agent-budget-'))
    const statePath = join(dir, 'does-not-exist', 'budget.json')
    expect(checkAndIncrementAgentBudget({ statePath, limit: 5 })).toEqual({ ok: true, count: 1, limit: 5 })
  })

  test('peekAgentBudget reads without incrementing', () => {
    dir = mkdtempSync(join(tmpdir(), 'lab-agent-budget-'))
    const statePath = join(dir, 'budget.json')
    const now = new Date('2026-10-23T12:00:00Z')
    checkAndIncrementAgentBudget({ statePath, limit: 5, now })
    expect(peekAgentBudget({ statePath, limit: 5, now })).toEqual({ ok: true, count: 1, limit: 5 })
    expect(peekAgentBudget({ statePath, limit: 5, now })).toEqual({ ok: true, count: 1, limit: 5 }) // unchanged, not incremented
  })
})

describe('agentDailyBudget', () => {
  test('defaults to 30, the contract\'s own number', () => {
    expect(DEFAULT_AGENT_DAILY_BUDGET).toBe(30)
    expect(agentDailyBudget({})).toBe(30)
  })
  test('reads a positive integer override, ignores garbage', () => {
    expect(agentDailyBudget({ LAB_AGENT_DAILY_BUDGET: '10' })).toBe(10)
    expect(agentDailyBudget({ LAB_AGENT_DAILY_BUDGET: '0' })).toBe(30)
    expect(agentDailyBudget({ LAB_AGENT_DAILY_BUDGET: 'nope' })).toBe(30)
  })
})

test('the default budget path follows systemd STATE_DIRECTORY when set', () => {
  const prev = process.env.STATE_DIRECTORY
  process.env.STATE_DIRECTORY = '/run/x/state-a:/run/x/state-b'
  try {
    expect(defaultAgentBudgetStatePath()).toBe('/run/x/state-a/agent-budget.json')
  } finally {
    if (prev === undefined) delete process.env.STATE_DIRECTORY
    else process.env.STATE_DIRECTORY = prev
  }
})
