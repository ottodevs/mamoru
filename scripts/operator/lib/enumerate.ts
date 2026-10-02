// Enumerates every process and systemd user unit that could be running the operator, and decides
// whether it is safe to restart. The transient and durable units can (today, during a migration)
// share process ancestry trees, and `bun run operator` wraps the real `bun apps/mamoru-operator/
// src/main.ts` process in a parent shell-less wrapper process — so "is a unit running the
// operator" is answered by walking each matched process's parent chain up to a unit's MainPID, not
// by grepping a unit's ExecStart text (which for the transient unit just says "bun run operator",
// not the entrypoint path at all).
import { readFile, realpath } from 'node:fs/promises'
import { listServiceUnits, unitSnapshot } from './systemctl.ts'
import { pgrepByCommand } from './verify.ts'

export type OperatorProcess = { pid: number; cwd: string | null }

async function readCwd(pid: number): Promise<string | null> {
  try {
    return await realpath(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

/** Every running process whose command line contains `entrypoint` (any cwd), excluding `excludePid`. */
export async function listOperatorProcesses(entrypoint: string, excludePid: number): Promise<OperatorProcess[]> {
  const pids = await pgrepByCommand(entrypoint, excludePid)
  return Promise.all(pids.map(async (pid) => ({ pid, cwd: await readCwd(pid) })))
}

/** The parent pid of `pid` (4th field of `/proc/<pid>/stat`, after the last `)` so a `(comm)` containing spaces/parens never shifts the fields). Null if unreadable (the process raced away, or we lack permission). */
export async function getPpid(pid: number): Promise<number | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2)
    const ppid = Number(afterComm.split(' ')[1])
    return Number.isFinite(ppid) && ppid > 0 ? ppid : null
  } catch {
    return null
  }
}

/** `[pid, ppid, ppid-of-ppid, ...]`, stopping at pid 1, an unreadable process, or `maxHops`. */
export async function getAncestry(pid: number, maxHops = 12): Promise<number[]> {
  const chain = [pid]
  let cur = pid
  for (let i = 0; i < maxHops; i++) {
    const parent = await getPpid(cur)
    if (!parent || parent === 1 || chain.includes(parent)) break
    chain.push(parent)
    cur = parent
  }
  return chain
}

export type UnitOwner = { name: string; transient: boolean; mainPid: number }

/**
 * Pure: given each operator process's full ancestor-pid chain and the (name, mainPid, transient)
 * of every candidate unit, returns the units whose mainPid appears in at least one chain —
 * regardless of how many process hops separate the unit's own ExecStart process from the actual
 * entrypoint process pgrep found (the `bun run operator` -> `bun main.ts` indirection is exactly
 * one hop, but this does not hardcode that depth).
 */
export function resolveOwningUnits(chains: number[][], units: { name: string; mainPid: number | null; transient: boolean }[]): UnitOwner[] {
  const byPid = new Map<number, { name: string; transient: boolean }>()
  for (const u of units) if (u.mainPid) byPid.set(u.mainPid, { name: u.name, transient: u.transient })
  const found = new Map<string, UnitOwner>()
  for (const chain of chains) {
    for (const pid of chain) {
      const hit = byPid.get(pid)
      if (hit) {
        found.set(hit.name, { name: hit.name, transient: hit.transient, mainPid: pid })
        break
      }
    }
  }
  return [...found.values()]
}

export type Enumeration = { processes: OperatorProcess[]; units: UnitOwner[] }

/** The real, impure IO wiring: pgrep + /proc ancestry + `systemctl --user list-units`/`show`. Read-only. */
export async function enumerateOperator(entrypoint: string, excludePid: number): Promise<Enumeration> {
  const processes = await listOperatorProcesses(entrypoint, excludePid)
  const chains = await Promise.all(processes.map((p) => getAncestry(p.pid)))
  const names = await listServiceUnits()
  const snaps = await Promise.all(names.map((name) => unitSnapshot(name)))
  const candidates = names.map((name, i) => ({ name, mainPid: snaps[i]!.mainPid, transient: snaps[i]!.transient }))
  const units = resolveOwningUnits(chains, candidates)
  return { processes, units }
}

export type Decision =
  | { kind: 'proceed-restart' } // (a): only the durable unit's MainPID exists
  | { kind: 'proceed-start' } // (b): nothing is running
  | { kind: 'migrate'; transientUnit: string } // --migrate-from-transient matches the single running (transient) unit
  | { kind: 'refuse'; reason: string }

function describeState(e: Enumeration): string {
  const procs = e.processes.map((p) => `pid ${p.pid} (cwd ${p.cwd ?? 'unknown'})`).join(', ') || 'no bare processes'
  const units = e.units.length ? e.units.map((u) => `${u.name}${u.transient ? ' [transient]' : ' [durable]'} (MainPID ${u.mainPid})`).join(', ') : 'no owning unit found (orphan process, not tracked by any unit)'
  return `processes: ${procs}; units: ${units}`
}

/**
 * The core policy from the review: before any restart, exactly one of (a) only the durable unit
 * alone is running, or (b) nothing is running, is allowed to proceed. Anything else — an orphan
 * process, a transient unit, more than one process/unit — refuses, unless `migrateFrom` is given and
 * it exactly matches what is actually running (a single unit, which must be the named one).
 */
export function decide(e: Enumeration, durableUnit: string, migrateFrom: string | null): Decision {
  if (e.processes.length === 0 && e.units.length === 0) return { kind: 'proceed-start' }
  if (e.processes.length === 1 && e.units.length === 1 && e.units[0]!.name === durableUnit && !e.units[0]!.transient) return { kind: 'proceed-restart' }

  if (migrateFrom) {
    const match = e.units.find((u) => u.name === migrateFrom)
    if (!match) return { kind: 'refuse', reason: `--migrate-from-transient ${migrateFrom} was given, but that unit is not among the operator units found right now (${describeState(e)}).` }
    if (!match.transient) {
      return {
        kind: 'refuse',
        reason: `--migrate-from-transient ${migrateFrom} names a unit that is not transient (systemctl --user show ${migrateFrom} -p Transient reports "no" — it is already a file-based unit). Refusing to stop something that is not the transient unit this flag exists to migrate away from.`,
      }
    }
    if (e.units.length > 1) return { kind: 'refuse', reason: `more than one unit is running the operator (${describeState(e)}); --migrate-from-transient only handles exactly one source unit at a time.` }
    return { kind: 'migrate', transientUnit: migrateFrom }
  }

  return {
    kind: 'refuse',
    reason: `unexpected operator process state before restart (${describeState(e)}). Exactly one of (the durable unit "${durableUnit}" alone) or (nothing running) is allowed. If this is the transient-to-durable migration, rerun with --migrate-from-transient <unit-name>.`,
  }
}

/** Polls until no process matches `entrypoint` (excluding `excludePid`), or `timeoutMs` elapses. Returns whatever pids remain (empty = success). */
export async function waitForNoProcesses(entrypoint: string, excludePid: number, timeoutMs: number, pollMs = 500): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const pids = await pgrepByCommand(entrypoint, excludePid)
    if (pids.length === 0) return []
    if (Date.now() >= deadline) return pids
    await Bun.sleep(pollMs)
  }
}
