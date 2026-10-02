import { describe, expect, test } from 'bun:test'
import { enableUnit, listServiceUnits, restartUnit, stopUnit, unitRegressedSince, unitSnapshot, type UnitSnapshot } from './systemctl.ts'

const FAKE_UNIT = 'mamoru-operator-deploy-test-definitely-does-not-exist.service'

describe('unitRegressedSince', () => {
  const base: UnitSnapshot = { activeState: 'active', subState: 'running', nRestarts: 3, mainPid: 100, transient: false, fragmentPath: '/home/otto/.config/systemd/user/mamoru-operatord.service' }

  test('no regression: same restart count, still active', () => {
    expect(unitRegressedSince(base, { ...base })).toBeNull()
  })

  test('regression: an extra restart happened during the window', () => {
    const after: UnitSnapshot = { ...base, nRestarts: 4 }
    expect(unitRegressedSince(base, after)).toMatch(/restarted again/)
  })

  test('regression: no longer active even with the same restart count', () => {
    const after: UnitSnapshot = { ...base, activeState: 'failed', subState: 'failed' }
    expect(unitRegressedSince(base, after)).toMatch(/not active/)
  })

  test('a lower NRestarts than baseline (e.g. a counter reset) is not by itself flagged as a restart regression', () => {
    const after: UnitSnapshot = { ...base, nRestarts: 0 }
    expect(unitRegressedSince(base, after)).toBeNull()
  })
})

describe('unitSnapshot (read-only; queried against a unit that is guaranteed not to exist, never the live operator)', () => {
  test('a never-loaded unit reports inactive with no main pid, and does not throw', async () => {
    const snap = await unitSnapshot(FAKE_UNIT)
    expect(snap.mainPid).toBeNull()
    expect(snap.activeState === 'inactive' || snap.activeState === 'unknown').toBe(true)
    // A never-loaded unit has no fragment and systemd reports it as not transient either.
    expect(snap.fragmentPath).toBe('')
    expect(snap.transient).toBe(false)
  })
})

describe('listServiceUnits (read-only)', () => {
  test('returns a non-empty list of unit names, each ending in .service', async () => {
    const units = await listServiceUnits()
    expect(units.length).toBeGreaterThan(0)
    for (const u of units) expect(u.endsWith('.service')).toBe(true)
  })
})

describe('restartUnit / stopUnit / enableUnit (never called against the live operator)', () => {
  test('restartUnit rejects for a unit that does not exist, rather than silently succeeding', async () => {
    await expect(restartUnit(FAKE_UNIT)).rejects.toThrow()
  })

  test('enableUnit rejects for a unit that does not exist, rather than silently succeeding', async () => {
    await expect(enableUnit(FAKE_UNIT)).rejects.toThrow()
  })

  test('stopUnit rejects for a unit that does not exist, rather than silently succeeding', async () => {
    await expect(stopUnit(FAKE_UNIT)).rejects.toThrow()
  })
})
