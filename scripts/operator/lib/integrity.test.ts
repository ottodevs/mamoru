import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { checkIgnoredFiles, checkManifestForReuse, nodeModulesManifestHash, readReleaseMeta, verifyAndInstall, writeReleaseMeta } from './integrity.ts'

let upstream: string
let sha: string

beforeAll(async () => {
  upstream = await mkdtemp(join(tmpdir(), 'mamoru-integrity-upstream-'))
  await $`git init -q -b main`.cwd(upstream)
  await $`git config user.email test@example.com`.cwd(upstream)
  await $`git config user.name "Integrity Test"`.cwd(upstream)
  await writeFile(join(upstream, 'package.json'), '{"name":"scratch","private":true}\n')
  await writeFile(join(upstream, '.gitignore'), 'node_modules/\n.env\n')
  await $`git add -A`.cwd(upstream)
  await $`git commit -q -m base`.cwd(upstream)
  sha = (await $`git rev-parse HEAD`.cwd(upstream).text()).trim()
})

const dirs: string[] = []
async function freshClone(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-release-'))
  dirs.push(dir)
  await rm(dir, { recursive: true, force: true }) // clone wants to create it itself
  await $`git clone ${upstream} ${dir}`.quiet()
  return dir
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('checkIgnoredFiles', () => {
  test('ok when only node_modules is ignored', async () => {
    const dir = await freshClone()
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules', 'x.js'), '')
    expect(await checkIgnoredFiles(dir)).toEqual({ ok: true, disallowed: [] })
  })

  test('ok with a nested workspace node_modules too', async () => {
    const dir = await freshClone()
    await mkdir(join(dir, 'apps', 'thing', 'node_modules'), { recursive: true })
    await writeFile(join(dir, 'apps', 'thing', 'node_modules', 'x.js'), '')
    const result = await checkIgnoredFiles(dir)
    expect(result.ok).toBe(true)
  })

  test('refuses a .env dropped into the release', async () => {
    const dir = await freshClone()
    await writeFile(join(dir, '.env'), 'OPERATOR_SECRET=whatever\n')
    const result = await checkIgnoredFiles(dir)
    expect(result.ok).toBe(false)
    expect(result.disallowed).toEqual(['.env'])
  })

  test('refuses an arbitrary ignored stray file alongside a legitimate node_modules', async () => {
    const dir = await freshClone()
    await mkdir(join(dir, 'node_modules'))
    await writeFile(join(dir, 'node_modules', 'x.js'), '')
    await writeFile(join(dir, '.env'), 'x\n')
    const result = await checkIgnoredFiles(dir)
    expect(result.ok).toBe(false)
    expect(result.disallowed).toEqual(['.env'])
  })

  test('clean when nothing is ignored at all', async () => {
    const dir = await freshClone()
    expect(await checkIgnoredFiles(dir)).toEqual({ ok: true, disallowed: [] })
  })
})

describe('verifyAndInstall', () => {
  test('succeeds, installs, and records lockfile metadata on a clean release', async () => {
    const dir = await freshClone()
    const deployStateDir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-deploystate-'))
    dirs.push(deployStateDir)
    const result = await verifyAndInstall(dir, deployStateDir, sha)
    expect(result.ok).toBe(true)
    expect(existsSync(join(dir, 'node_modules'))).toBe(true)
    const meta = readReleaseMeta(deployStateDir, sha)
    expect(meta).not.toBeNull()
    expect(meta!.sha).toBe(sha)
  })

  test('is idempotent: running it again on an already-installed release still succeeds', async () => {
    const dir = await freshClone()
    const deployStateDir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-deploystate-'))
    dirs.push(deployStateDir)
    expect((await verifyAndInstall(dir, deployStateDir, sha)).ok).toBe(true)
    expect((await verifyAndInstall(dir, deployStateDir, sha)).ok).toBe(true)
  })

  test('refuses a release with a disallowed ignored file before even trying to install', async () => {
    const dir = await freshClone()
    const deployStateDir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-deploystate-'))
    dirs.push(deployStateDir)
    await writeFile(join(dir, '.env'), 'OPERATOR_SECRET=leak\n')
    const result = await verifyAndInstall(dir, deployStateDir, sha)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/\.env/)
    expect(readReleaseMeta(deployStateDir, sha)).toBeNull() // never recorded as verified
  })
})

describe('writeReleaseMeta / readReleaseMeta', () => {
  test('round-trips and is written outside the release tree (the deploy tool state dir, not the release dir)', async () => {
    const deployStateDir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-deploystate-'))
    dirs.push(deployStateDir)
    writeReleaseMeta(deployStateDir, { sha, lockfileHash: 'abc123', nodeModulesHash: 'def456', verifiedAt: '2026-10-02T00:00:00.000Z' })
    expect(readReleaseMeta(deployStateDir, sha)).toEqual({ sha, lockfileHash: 'abc123', nodeModulesHash: 'def456', verifiedAt: '2026-10-02T00:00:00.000Z' })
  })

  test('null for a sha that has no recorded metadata', async () => {
    const deployStateDir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-deploystate-'))
    dirs.push(deployStateDir)
    expect(readReleaseMeta(deployStateDir, 'deadbeef'.repeat(5))).toBeNull()
  })
})

describe('nodeModulesManifestHash', () => {
  test('null when there is no node_modules yet', async () => {
    const dir = await freshClone()
    expect(await nodeModulesManifestHash(dir)).toBeNull()
  })

  test('stable across repeated calls with no change', async () => {
    const dir = await freshClone()
    await mkdir(join(dir, 'node_modules', 'some-pkg'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'some-pkg', 'index.js'), 'module.exports = 1\n')
    const a = await nodeModulesManifestHash(dir)
    const b = await nodeModulesManifestHash(dir)
    expect(a).not.toBeNull()
    expect(a).toBe(b)
  })

  test('changes when a package is added', async () => {
    const dir = await freshClone()
    await mkdir(join(dir, 'node_modules', 'pkg-a'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'pkg-a', 'index.js'), 'x')
    const before = await nodeModulesManifestHash(dir)
    await mkdir(join(dir, 'node_modules', 'pkg-b'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'pkg-b', 'index.js'), 'y')
    const after = await nodeModulesManifestHash(dir)
    expect(after).not.toBe(before)
  })

  test('changes when an existing package is resized (tampered)', async () => {
    const dir = await freshClone()
    await mkdir(join(dir, 'node_modules', 'pkg-a'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'pkg-a', 'index.js'), 'short')
    const before = await nodeModulesManifestHash(dir)
    await writeFile(join(dir, 'node_modules', 'pkg-a', 'index.js'), 'a much, much longer file than before, deliberately so the size differs enough to be unambiguous')
    const after = await nodeModulesManifestHash(dir)
    expect(after).not.toBe(before)
  })
})

describe('checkManifestForReuse', () => {
  test('ok (nothing to compare against) when there is no recorded meta yet', async () => {
    const dir = await freshClone()
    const deployStateDir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-deploystate-'))
    dirs.push(deployStateDir)
    expect(await checkManifestForReuse(dir, deployStateDir, sha)).toEqual({ ok: true })
  })

  test('ok when the recorded manifest still matches what verifyAndInstall just wrote', async () => {
    const dir = await freshClone()
    const deployStateDir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-deploystate-'))
    dirs.push(deployStateDir)
    await verifyAndInstall(dir, deployStateDir, sha)
    expect(await checkManifestForReuse(dir, deployStateDir, sha)).toEqual({ ok: true })
  })

  test('not ok (never reused blindly) when node_modules was tampered with after the last verified install', async () => {
    const dir = await freshClone()
    const deployStateDir = await mkdtemp(join(tmpdir(), 'mamoru-integrity-deploystate-'))
    dirs.push(deployStateDir)
    await verifyAndInstall(dir, deployStateDir, sha)
    // Simulate tampering: add a file inside node_modules without touching bun.lock at all.
    await mkdir(join(dir, 'node_modules', 'sneaky-extra-package'), { recursive: true })
    await writeFile(join(dir, 'node_modules', 'sneaky-extra-package', 'index.js'), 'malicious')
    const result = await checkManifestForReuse(dir, deployStateDir, sha)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no longer matches/)
  })
})
