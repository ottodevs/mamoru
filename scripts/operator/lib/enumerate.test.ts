import { afterEach, describe, expect, test } from 'bun:test'
import { decide, enumerateOperator, getAncestry, getPpid, listOperatorProcesses, resolveOwningUnits, waitForNoProcesses, type Enumeration, type OperatorProcess, type UnitOwner } from './enumerate.ts'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

describe('getPpid / getAncestry (real /proc, never the live operator)', () => {
  test('a spawned child reports this test process as its parent', async () => {
    const child = Bun.spawn(['sleep', '5'], { stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => child.kill())
    await Bun.sleep(150)
    expect(await getPpid(child.pid)).toBe(process.pid)
  })

  test('getAncestry starts with the pid itself and includes its parent', async () => {
    const child = Bun.spawn(['sleep', '5'], { stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => child.kill())
    await Bun.sleep(150)
    const chain = await getAncestry(child.pid)
    expect(chain[0]).toBe(child.pid)
    expect(chain).toContain(process.pid)
  })

  test('getPpid is null for a pid that does not exist, not a throw', async () => {
    expect(await getPpid(999_999_999)).toBeNull()
  })
})

describe('listOperatorProcesses (real pgrep, a spawned marker process, never the live operator)', () => {
  test('finds a process whose command line contains the entrypoint text', async () => {
    const marker = `mamorutest-${crypto.randomUUID()}`
    const child = Bun.spawn(['bun', '-e', `await Bun.sleep(3000) // ${marker}`], { stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => child.kill())
    await Bun.sleep(300)
    const found = await listOperatorProcesses(marker, -1)
    expect(found.some((p) => p.pid === child.pid)).toBe(true)
    const self = found.find((p) => p.pid === child.pid)!
    expect(self.cwd).not.toBeNull()
  })
})

describe('resolveOwningUnits (pure)', () => {
  test('finds a unit one hop away from the pgrep-matched pid (the "bun run operator" -> "bun main.ts" indirection)', () => {
    const chains = [[200, 100]] // pid 200 (the real entrypoint process) is a child of pid 100 (the unit's ExecStart process)
    const units = [{ name: 'mamoru-operator.service', mainPid: 100, transient: true }]
    expect(resolveOwningUnits(chains, units)).toEqual([{ name: 'mamoru-operator.service', transient: true, mainPid: 100 }])
  })

  test('finds a unit whose MainPID is the matched pid directly (no indirection, the durable unit)', () => {
    const chains = [[300]]
    const units = [{ name: 'mamoru-operatord.service', mainPid: 300, transient: false }]
    expect(resolveOwningUnits(chains, units)).toEqual([{ name: 'mamoru-operatord.service', transient: false, mainPid: 300 }])
  })

  test('an orphan process (no unit anywhere in its ancestry) resolves to no units', () => {
    const chains = [[400, 401, 1]]
    const units = [{ name: 'mamoru-operatord.service', mainPid: 999, transient: false }]
    expect(resolveOwningUnits(chains, units)).toEqual([])
  })

  test('deduplicates when two processes both hit the same unit', () => {
    const chains = [
      [200, 100],
      [201, 100],
    ]
    const units = [{ name: 'mamoru-operator.service', mainPid: 100, transient: true }]
    expect(resolveOwningUnits(chains, units)).toEqual([{ name: 'mamoru-operator.service', transient: true, mainPid: 100 }])
  })

  test('units with no mainPid (not running) are never matched', () => {
    const chains = [[200]]
    const units = [{ name: 'mamoru-operatord.service', mainPid: null, transient: false }]
    expect(resolveOwningUnits(chains, units)).toEqual([])
  })
})

const DURABLE = 'mamoru-operatord.service'
const TRANSIENT = 'mamoru-operator.service'
const proc = (pid: number, cwd: string | null = '/some/dir'): OperatorProcess => ({ pid, cwd })
const unit = (name: string, mainPid: number, transient: boolean): UnitOwner => ({ name, mainPid, transient })

describe('decide (pure, the core policy)', () => {
  test('(b) nothing running -> proceed-start', () => {
    const e: Enumeration = { processes: [], units: [] }
    expect(decide(e, DURABLE, null)).toEqual({ kind: 'proceed-start' })
  })

  test('(a) only the durable unit alone -> proceed-restart', () => {
    const e: Enumeration = { processes: [proc(500)], units: [unit(DURABLE, 500, false)] }
    expect(decide(e, DURABLE, null)).toEqual({ kind: 'proceed-restart' })
  })

  test('the durable unit name running but flagged transient is NOT treated as the safe durable case', () => {
    // Defends against a future bug where the durable unit is somehow started as a systemd-run transient.
    const e: Enumeration = { processes: [proc(500)], units: [unit(DURABLE, 500, true)] }
    const d = decide(e, DURABLE, null)
    expect(d.kind).toBe('refuse')
  })

  test('an orphan process with no owning unit refuses (no --migrate-from-transient given)', () => {
    const e: Enumeration = { processes: [proc(600)], units: [] }
    const d = decide(e, DURABLE, null)
    expect(d.kind).toBe('refuse')
    if (d.kind === 'refuse') expect(d.reason).toMatch(/orphan/)
  })

  test('the transient unit alone refuses without --migrate-from-transient', () => {
    const e: Enumeration = { processes: [proc(700)], units: [unit(TRANSIENT, 700, true)] }
    const d = decide(e, DURABLE, null)
    expect(d.kind).toBe('refuse')
  })

  test('the transient unit alone proceeds to migrate when --migrate-from-transient names it', () => {
    const e: Enumeration = { processes: [proc(700)], units: [unit(TRANSIENT, 700, true)] }
    expect(decide(e, DURABLE, TRANSIENT)).toEqual({ kind: 'migrate', transientUnit: TRANSIENT })
  })

  test('--migrate-from-transient given but nothing is running at all: there is nothing to migrate from, so a plain start is still safe', () => {
    const e: Enumeration = { processes: [], units: [] }
    expect(decide(e, DURABLE, TRANSIENT)).toEqual({ kind: 'proceed-start' })
  })

  test('--migrate-from-transient naming a unit that is not the one actually running refuses', () => {
    const e: Enumeration = { processes: [proc(700)], units: [unit('some-other-unit.service', 700, true)] }
    const d = decide(e, DURABLE, TRANSIENT)
    expect(d.kind).toBe('refuse')
    if (d.kind === 'refuse') expect(d.reason).toMatch(/not among the operator units found/)
  })

  test('more than one unit running refuses even with --migrate-from-transient', () => {
    const e: Enumeration = { processes: [proc(700), proc(800)], units: [unit(TRANSIENT, 700, true), unit(DURABLE, 800, false)] }
    const d = decide(e, DURABLE, TRANSIENT)
    expect(d.kind).toBe('refuse')
    if (d.kind === 'refuse') expect(d.reason).toMatch(/more than one unit/)
  })

  test('--migrate-from-transient naming a unit that is NOT transient refuses, never migrates (systemd Transient=no is authoritative, not just the name)', () => {
    // A unit matches by name but Transient=no — stopping it would not be "migrating off the
    // transient unit", it would be stopping some other durable thing. This unit also is not the
    // configured --unit, so it cannot be mistaken for the already-safe (a) "durable unit alone" case.
    const notTransientUnit = 'some-other-durable-unit.service'
    const e: Enumeration = { processes: [proc(900)], units: [unit(notTransientUnit, 900, false)] }
    const d = decide(e, DURABLE, notTransientUnit)
    expect(d.kind).toBe('refuse')
    if (d.kind === 'refuse') expect(d.reason).toMatch(/is not transient/)
  })

  test('more than one bare process (no owning unit at all) refuses', () => {
    const e: Enumeration = { processes: [proc(900), proc(901)], units: [] }
    expect(decide(e, DURABLE, null).kind).toBe('refuse')
  })
})

describe('waitForNoProcesses (real pgrep against a spawned marker process)', () => {
  test('returns empty once the process is gone', async () => {
    const marker = `mamorutest-${crypto.randomUUID()}`
    const child = Bun.spawn(['bun', '-e', `await Bun.sleep(10000) // ${marker}`], { stdout: 'ignore', stderr: 'ignore' })
    await Bun.sleep(300)
    setTimeout(() => child.kill(), 300)
    const remaining = await waitForNoProcesses(marker, -1, 5_000, 100)
    expect(remaining).toEqual([])
  })

  test('returns the remaining pid(s) if the timeout elapses first', async () => {
    const marker = `mamorutest-${crypto.randomUUID()}`
    const child = Bun.spawn(['bun', '-e', `await Bun.sleep(10000) // ${marker}`], { stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => child.kill())
    await Bun.sleep(300)
    const remaining = await waitForNoProcesses(marker, -1, 200, 50)
    expect(remaining).toContain(child.pid)
  })
})

describe('enumerateOperator (the real IO wiring: pgrep + /proc ancestry + systemctl list-units/show; never touches the live operator since it only reads)', () => {
  test('a bare spawned process with no owning systemd unit shows up as an orphan (processes non-empty, units empty)', async () => {
    const marker = `mamorutest-${crypto.randomUUID()}`
    const child = Bun.spawn(['bun', '-e', `await Bun.sleep(5000) // ${marker}`], { stdout: 'ignore', stderr: 'ignore' })
    try {
      await Bun.sleep(300)
      const e = await enumerateOperator(marker, -1)
      expect(e.processes.map((p) => p.pid)).toContain(child.pid)
      expect(e.units).toEqual([])
    } finally {
      child.kill()
    }
  })

  test('a marker that matches nothing reports a fully empty enumeration', async () => {
    const e = await enumerateOperator(`mamorutest-nonexistent-${crypto.randomUUID()}`, -1)
    expect(e.processes).toEqual([])
    expect(e.units).toEqual([])
  })
})
