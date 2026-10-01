// The release log must live outside the checkout (a deploy has no working tree to dirty anyway,
// via the immutable snapshot, but the log must also outlive any single checkout) and be overridable.
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendReleaseLog, releaseLogPath } from './release-log.ts'

const ORIGINAL = process.env.MAMORU_RELEASE_LOG

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MAMORU_RELEASE_LOG
  else process.env.MAMORU_RELEASE_LOG = ORIGINAL
})

describe('releaseLogPath', () => {
  it('defaults to a path outside the repo, under the home directory state dir', () => {
    delete process.env.MAMORU_RELEASE_LOG
    const path = releaseLogPath()
    expect(path).toBe(join(homedir(), '.local', 'state', 'mamoru-app', 'releases.jsonl'))
    expect(path.includes('box/src/mamoru')).toBe(false)
  })
  it('is overridable via MAMORU_RELEASE_LOG', () => {
    process.env.MAMORU_RELEASE_LOG = '/tmp/example/releases.jsonl'
    expect(releaseLogPath()).toBe('/tmp/example/releases.jsonl')
  })
})

describe('appendReleaseLog', () => {
  it('creates the file, writes one JSON line, and appends on a second call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mamoru-release-log-test-'))
    const path = join(dir, 'nested', 'releases.jsonl')
    process.env.MAMORU_RELEASE_LOG = path
    try {
      const record = { env: 'prod' as const, sha: 'abc1234', versionId: 'v1', previousVersionId: 'v0', smokeOk: true, at: '2026-01-01T00:00:00.000Z' }
      const written = await appendReleaseLog(record)
      expect(written).toBe(path)
      await appendReleaseLog({ ...record, sha: 'def5678', smokeOk: false })

      const lines = (await readFile(path, 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0] ?? '')).toEqual(record)
      expect(JSON.parse(lines[1] ?? '').smokeOk).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
