import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireLock, LockHeldError } from './lock.ts'

const dirs: string[] = []
async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'mamoru-lock-'))
  dirs.push(d)
  return d
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('acquireLock', () => {
  test('a second acquire on the same file fails fast while the first holds it', async () => {
    const lockFile = join(await tmpDir(), 'deploy.lock')
    const first = acquireLock(lockFile)
    expect(() => acquireLock(lockFile)).toThrow(LockHeldError)
    first.release()
  })

  test('releasing frees it for the next acquire', async () => {
    const lockFile = join(await tmpDir(), 'deploy.lock')
    const first = acquireLock(lockFile)
    first.release()
    const second = acquireLock(lockFile)
    second.release()
  })

  test('release is idempotent', async () => {
    const lockFile = join(await tmpDir(), 'deploy.lock')
    const lock = acquireLock(lockFile)
    lock.release()
    expect(() => lock.release()).not.toThrow()
  })

  test('creates the lock file and its parent is otherwise untouched', async () => {
    const dir = await tmpDir()
    const lockFile = join(dir, 'deploy.lock')
    const lock = acquireLock(lockFile)
    lock.release()
    const { existsSync } = await import('node:fs')
    expect(existsSync(lockFile)).toBe(true)
  })

  test('two distinct lock files do not contend with each other', async () => {
    const dir = await tmpDir()
    const a = acquireLock(join(dir, 'a.lock'))
    const b = acquireLock(join(dir, 'b.lock'))
    a.release()
    b.release()
  })

  test('creates a missing parent directory for the lock file', async () => {
    const dir = await tmpDir()
    const lockFile = join(dir, 'nested', 'deeper', 'deploy.lock')
    const lock = acquireLock(lockFile)
    const { existsSync } = await import('node:fs')
    expect(existsSync(lockFile)).toBe(true)
    lock.release()
  })
})
