import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backupAccounts, backupsToPrune, fileDigest, sortBackups } from './backup.ts'

describe('sortBackups', () => {
  test('oldest first, ignores anything that is not a bak file', () => {
    expect(sortBackups(['accounts.json.bak-200', 'accounts.json.bak-10', 'accounts.json', 'relayer.key', 'accounts.json.bak-100'])).toEqual([
      'accounts.json.bak-10',
      'accounts.json.bak-100',
      'accounts.json.bak-200',
    ])
  })

  test('mixes the legacy bare-number shape with this tool\'s "<ms>-<suffix>" shape, sorted by the leading number', () => {
    expect(sortBackups(['accounts.json.bak-10011744', 'accounts.json.bak-2334', 'accounts.json.bak-1733000000000-a1b2c3d4'])).toEqual([
      'accounts.json.bak-2334',
      'accounts.json.bak-10011744',
      'accounts.json.bak-1733000000000-a1b2c3d4',
    ])
  })
})

describe('backupsToPrune', () => {
  test('keeps the newest `keep`, prunes the rest, oldest first', () => {
    const names = Array.from({ length: 12 }, (_, i) => `accounts.json.bak-${i}`)
    expect(backupsToPrune(names, 10)).toEqual(['accounts.json.bak-0', 'accounts.json.bak-1'])
  })

  test('nothing to prune when at or under the limit', () => {
    const names = Array.from({ length: 5 }, (_, i) => `accounts.json.bak-${i}`)
    expect(backupsToPrune(names, 10)).toEqual([])
  })

  test('never prunes the single newest entry, even if `keep` is misconfigured to 0', () => {
    const names = Array.from({ length: 5 }, (_, i) => `accounts.json.bak-${i}`)
    expect(backupsToPrune(names, 0)).toEqual(['accounts.json.bak-0', 'accounts.json.bak-1', 'accounts.json.bak-2', 'accounts.json.bak-3'])
  })

  test('never prunes the single newest entry with a negative `keep`', () => {
    const names = Array.from({ length: 3 }, (_, i) => `accounts.json.bak-${i}`)
    expect(backupsToPrune(names, -5)).toEqual(['accounts.json.bak-0', 'accounts.json.bak-1'])
  })
})

describe('backupAccounts', () => {
  test('returns null and copies nothing when accounts.json does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mamoru-backup-'))
    try {
      expect(backupAccounts(dir)).toBeNull()
      expect(await readdir(dir)).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('copies accounts.json to a uniquely-named 0600 backup that verifies byte-for-byte against the source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mamoru-backup-'))
    try {
      const content = '{"accounts":{"k":"v"}}'
      await writeFile(join(dir, 'accounts.json'), content)

      const dest = backupAccounts(dir, 10, 2_000_000)
      expect(dest).not.toBeNull()
      expect(dest!.startsWith(join(dir, 'accounts.json.bak-2000000-'))).toBe(true)
      expect(await readFile(dest!, 'utf8')).toBe(content)

      const digest = fileDigest(dest!)
      expect(digest.size).toBe(Buffer.byteLength(content))
      expect(digest.sha256).toBe(createHash('sha256').update(content).digest('hex'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('two backups taken in the same millisecond never collide (each gets a unique name)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mamoru-backup-'))
    try {
      await writeFile(join(dir, 'accounts.json'), 'one')
      const first = backupAccounts(dir, 10, 5_000_000)!
      await writeFile(join(dir, 'accounts.json'), 'two')
      const second = backupAccounts(dir, 10, 5_000_000)! // same `now`, same millisecond bucket
      expect(first).not.toBe(second)
      expect(await readFile(first, 'utf8')).toBe('one')
      expect(await readFile(second, 'utf8')).toBe('two')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('prunes down to `keep` only after the new backup is written, oldest first, never the newest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mamoru-backup-'))
    try {
      await writeFile(join(dir, 'accounts.json'), '{"accounts":{}}')
      // Pre-seed 10 old (legacy-shaped) backups so the next one pushes the count to 11.
      for (let i = 0; i < 10; i++) await writeFile(join(dir, `accounts.json.bak-${1000 + i}`), 'old')

      const dest = backupAccounts(dir, 10, 2_000_000)!
      const names = (await readdir(dir)).filter((n) => n.startsWith('accounts.json.bak-'))
      expect(names.length).toBe(10)
      expect(names).not.toContain('accounts.json.bak-1000') // the oldest was pruned
      expect(names.some((n) => join(dir, n) === dest)).toBe(true) // the brand new one always survives
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
