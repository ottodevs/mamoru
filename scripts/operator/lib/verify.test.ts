import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { duplicateProcessCheck, pgrepByCommand, verifyRunningFrom } from './verify.ts'

const cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})

describe('verifyRunningFrom', () => {
  test('ok when the pid\'s /proc cwd resolves to the expected directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mamoru-verify-'))
    const child = Bun.spawn(['sleep', '5'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => child.kill())
    try {
      await Bun.sleep(150)
      const result = await verifyRunningFrom(dir, async () => child.pid)
      expect(result.ok).toBe(true)
      expect(result.pid).toBe(child.pid)
      expect(result.actualCwd).toBe(await realpath(dir))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('not ok when the pid is running from a different directory', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'mamoru-verify-a-'))
    const dirB = await mkdtemp(join(tmpdir(), 'mamoru-verify-b-'))
    const child = Bun.spawn(['sleep', '5'], { cwd: dirA, stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => child.kill())
    try {
      await Bun.sleep(150)
      const result = await verifyRunningFrom(dirB, async () => child.pid)
      expect(result.ok).toBe(false)
      expect(result.actualCwd).not.toBe(result.expectedDir)
    } finally {
      await rm(dirA, { recursive: true, force: true })
      await rm(dirB, { recursive: true, force: true })
    }
  })

  test('not ok (and does not throw) when there is no pid at all', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mamoru-verify-'))
    try {
      const result = await verifyRunningFrom(dir, async () => null)
      expect(result.ok).toBe(false)
      expect(result.pid).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('not ok (and does not throw) when the pid does not correspond to a running process', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mamoru-verify-'))
    try {
      // PID 1 exists but we cannot read its /proc/<pid>/cwd as an unprivileged user; a huge unused pid behaves the same (ESRCH/EACCES either way).
      const result = await verifyRunningFrom(dir, async () => 999_999_999)
      expect(result.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('pgrepByCommand', () => {
  test('finds a process by a unique marker in its command line, excluding the given pid', async () => {
    const marker = `mamorutest-${crypto.randomUUID()}`
    const child = Bun.spawn(['bun', '-e', `await Bun.sleep(3000) // ${marker}`], { stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => child.kill())
    await Bun.sleep(300)
    const pids = await pgrepByCommand(marker, -1)
    expect(pids).toContain(child.pid)
  })

  test('excludes the given pid even if it would otherwise match', async () => {
    const marker = `mamorutest-${crypto.randomUUID()}`
    const child = Bun.spawn(['bun', '-e', `await Bun.sleep(3000) // ${marker}`], { stdout: 'ignore', stderr: 'ignore' })
    cleanup.push(() => child.kill())
    await Bun.sleep(300)
    const pids = await pgrepByCommand(marker, child.pid)
    expect(pids).not.toContain(child.pid)
  })

  test('an empty result (no match) is not an error', async () => {
    const pids = await pgrepByCommand(`mamorutest-nonexistent-${crypto.randomUUID()}`, -1)
    expect(pids).toEqual([])
  })
})

describe('duplicateProcessCheck', () => {
  test('null (ok) for zero or one running process', () => {
    expect(duplicateProcessCheck([])).toBeNull()
    expect(duplicateProcessCheck([123])).toBeNull()
  })

  test('refuses when two or more are running', () => {
    expect(duplicateProcessCheck([123, 456])).toMatch(/2 operator processes/)
  })
})
