/**
 * Agent Lab runner (008 task 5, otto/mamoru#204): the daily budget guard — max `LAB_AGENT_DAILY_BUDGET` (default
 * 30) agent jobs per day, across every requester, enforced on the RUNNER side (not the landing's own per-
 * requester caps, which are a separate, independent limit this file knows nothing about). The runner claims and
 * runs one job at a time (`cli.ts`'s `cmdRun` loop), so this is a plain read-modify-write against a small local
 * JSON file — no locking needed, there is never a second writer.
 *
 * A day is the UTC calendar date (`toISOString().slice(0, 10)`), independent of lady's local timezone, so the
 * budget resets at the same instant regardless of where the runner happens to run.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const DEFAULT_AGENT_DAILY_BUDGET = 30
export const LAB_AGENT_BUDGET = 'LAB_AGENT_BUDGET'

export type AgentBudgetState = { date: string; count: number }

export function defaultAgentBudgetStatePath(): string {
  const stateHome = process.env.XDG_STATE_HOME || `${process.env.HOME}/.local/state`
  return `${stateHome}/mamoru-lab-runner/agent-budget.json`
}

export function agentDailyBudget(env: Record<string, string | undefined> = process.env): number {
  const raw = env.LAB_AGENT_DAILY_BUDGET
  if (!raw) return DEFAULT_AGENT_DAILY_BUDGET
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_AGENT_DAILY_BUDGET
}

function utcDateOf(now: Date): string {
  return now.toISOString().slice(0, 10)
}

function readState(path: string): AgentBudgetState | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentBudgetState>
    if (typeof raw.date === 'string' && typeof raw.count === 'number') return { date: raw.date, count: raw.count }
    return null
  } catch {
    return null // missing file, or corrupt — both start a fresh day at count 0, never crash the runner over this
  }
}

function writeState(path: string, state: AgentBudgetState): void {
  mkdirSync(dirname(path), { recursive: true })
  // temp + rename: a crash mid-write never leaves a half file that would read as a reset counter
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state), 'utf8')
  renameSync(tmp, path)
}

export type BudgetCheck = { ok: true; count: number; limit: number } | { ok: false; count: number; limit: number }

/**
 * Call once per claimed agent job, BEFORE running it. On `ok: false` the runner must refuse the job at once
 * (`LAB_AGENT_BUDGET`, posted to `/ops/lab/runner/result` as an error, never run) without incrementing further —
 * a refused job does not itself count against tomorrow's budget either, since it never consumed anything.
 */
export function checkAndIncrementAgentBudget(opts: { statePath?: string; limit?: number; now?: Date } = {}): BudgetCheck {
  const path = opts.statePath ?? defaultAgentBudgetStatePath()
  const limit = opts.limit ?? agentDailyBudget()
  const today = utcDateOf(opts.now ?? new Date())
  const prev = readState(path)
  const count = prev && prev.date === today ? prev.count : 0
  if (count >= limit) return { ok: false, count, limit }
  writeState(path, { date: today, count: count + 1 })
  return { ok: true, count: count + 1, limit }
}

/** Diagnostics / tests only — never mutates. */
export function peekAgentBudget(opts: { statePath?: string; limit?: number; now?: Date } = {}): BudgetCheck {
  const path = opts.statePath ?? defaultAgentBudgetStatePath()
  const limit = opts.limit ?? agentDailyBudget()
  const today = utcDateOf(opts.now ?? new Date())
  const prev = readState(path)
  const count = prev && prev.date === today ? prev.count : 0
  return { ok: count < limit, count, limit }
}
