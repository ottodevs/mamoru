import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readlink, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { createRelease, currentTarget, ensureRepo, releaseDir, releasesToPrune, removeRelease, repointCurrent, resolveFullSha, verifyReleaseHead } from './checkout.ts'

let upstream: string
let baseSha: string
let nextSha: string

beforeAll(async () => {
  upstream = await mkdtemp(join(tmpdir(), 'mamoru-checkout-upstream-'))
  await $`git init -q -b main`.cwd(upstream)
  await $`git config user.email test@example.com`.cwd(upstream)
  await $`git config user.name "Operator Deploy Test"`.cwd(upstream)
  await writeFile(join(upstream, 'package.json'), '{"name":"scratch","private":true}\n')
  await writeFile(join(upstream, 'marker.txt'), 'base\n')
  await $`git add -A`.cwd(upstream)
  await $`git commit -q -m base`.cwd(upstream)
  baseSha = (await $`git rev-parse HEAD`.cwd(upstream).text()).trim()

  await writeFile(join(upstream, 'marker.txt'), 'next\n')
  await $`git add -A`.cwd(upstream)
  await $`git commit -q -m next`.cwd(upstream)
  nextSha = (await $`git rev-parse HEAD`.cwd(upstream).text()).trim()
})

const dirs: string[] = []
function scratch(): string {
  // Synchronous enough for test setup: mkdtemp is async elsewhere, but these are plain paths under a shared parent made once per test via beforeEach-less tmp roots.
  const dir = join(tmpdir(), `mamoru-checkout-${Math.random().toString(16).slice(2)}`)
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('ensureRepo', () => {
  test('clones when the directory is not yet a git checkout', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    expect(existsSync(join(repoDir, '.git'))).toBe(true)
    expect(readFileSync(join(repoDir, 'marker.txt'), 'utf8').trim()).toBe('next')
  })

  test('is a no-op when the directory is already a git checkout', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const shaBefore = (await $`git rev-parse HEAD`.cwd(repoDir).text()).trim()
    await ensureRepo(repoDir, upstream) // must not re-clone or throw
    const shaAfter = (await $`git rev-parse HEAD`.cwd(repoDir).text()).trim()
    expect(shaAfter).toBe(shaBefore)
  })
})

describe('createRelease / removeRelease', () => {
  test('checks out the exact sha into a fresh, clean directory (no install — that is integrity.ts, run uniformly for new and reused releases)', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const releasesRoot = scratch()
    const dir = releaseDir(releasesRoot, baseSha)
    await createRelease(repoDir, releasesRoot, dir, baseSha)
    expect((await $`git rev-parse HEAD`.cwd(dir).text()).trim()).toBe(baseSha)
    expect(readFileSync(join(dir, 'marker.txt'), 'utf8').trim()).toBe('base')
    await removeRelease(repoDir, releasesRoot, dir)
    expect(existsSync(dir)).toBe(false)
  })

  test('refuses to reuse or overwrite an existing release directory', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const releasesRoot = scratch()
    const dir = releaseDir(releasesRoot, baseSha)
    await createRelease(repoDir, releasesRoot, dir, baseSha)
    await expect(createRelease(repoDir, releasesRoot, dir, baseSha)).rejects.toThrow(/already exists/)
    await removeRelease(repoDir, releasesRoot, dir)
  })

  test('refuses a release directory outside the releases root', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const releasesRoot = scratch()
    const outside = join(scratch(), 'not-inside-releases-root')
    await expect(createRelease(repoDir, releasesRoot, outside, baseSha)).rejects.toThrow(/not inside the releases root/)
  })

  test('refuses to remove a directory outside the releases root', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const releasesRoot = scratch()
    const outside = scratch()
    await mkdir(outside, { recursive: true })
    await expect(removeRelease(repoDir, releasesRoot, outside)).rejects.toThrow(/not inside the releases root/)
    expect(existsSync(outside)).toBe(true) // never touched
  })

  test('two releases at different shas coexist independently', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const releasesRoot = scratch()
    const dirA = releaseDir(releasesRoot, baseSha)
    const dirB = releaseDir(releasesRoot, nextSha)
    await createRelease(repoDir, releasesRoot, dirA, baseSha)
    await createRelease(repoDir, releasesRoot, dirB, nextSha)
    expect(readFileSync(join(dirA, 'marker.txt'), 'utf8').trim()).toBe('base')
    expect(readFileSync(join(dirB, 'marker.txt'), 'utf8').trim()).toBe('next')
    await removeRelease(repoDir, releasesRoot, dirA)
    await removeRelease(repoDir, releasesRoot, dirB)
  })
})

describe('resolveFullSha', () => {
  test('resolves an abbreviated sha to the full 40-char one', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const abbrev = baseSha.slice(0, 8)
    expect(abbrev.length).toBeLessThan(baseSha.length)
    expect(await resolveFullSha(repoDir, abbrev)).toBe(baseSha)
  })

  test('a full sha resolves to itself', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    expect(await resolveFullSha(repoDir, baseSha)).toBe(baseSha)
  })

  test('throws a clear error for a sha that does not exist', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    await expect(resolveFullSha(repoDir, 'deadbeef')).rejects.toThrow(/does not resolve to a known commit/)
  })
})

describe('verifyReleaseHead', () => {
  test('true when HEAD matches, false otherwise', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const releasesRoot = scratch()
    const dir = releaseDir(releasesRoot, baseSha)
    await createRelease(repoDir, releasesRoot, dir, baseSha)
    expect(await verifyReleaseHead(dir, baseSha)).toBe(true)
    expect(await verifyReleaseHead(dir, nextSha)).toBe(false)
    await removeRelease(repoDir, releasesRoot, dir)
  })

  test('catches a reused release whose HEAD was tampered with (checked out to a different commit by hand)', async () => {
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const releasesRoot = scratch()
    const dir = releaseDir(releasesRoot, baseSha)
    await createRelease(repoDir, releasesRoot, dir, baseSha)
    await $`git checkout --detach ${nextSha}`.cwd(dir).quiet() // simulate drift/tampering after creation
    expect(await verifyReleaseHead(dir, baseSha)).toBe(false)
    await removeRelease(repoDir, releasesRoot, dir)
  })
})

describe('repointCurrent / currentTarget', () => {
  test('null when `current` does not exist yet', async () => {
    const root = scratch()
    expect(await currentTarget(join(root, 'current'))).toBeNull()
  })

  test('repoints atomically and currentTarget reflects it (rollback is just calling it again)', async () => {
    const root = scratch()
    const link = join(root, 'current')
    const releasesRoot = scratch()
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const dirA = releaseDir(releasesRoot, baseSha)
    const dirB = releaseDir(releasesRoot, nextSha)
    await createRelease(repoDir, releasesRoot, dirA, baseSha)
    await createRelease(repoDir, releasesRoot, dirB, nextSha)

    await repointCurrent(link, dirA)
    expect(await currentTarget(link)).toBe(dirA)
    expect(readFileSync(join(link, 'marker.txt'), 'utf8').trim()).toBe('base')

    await repointCurrent(link, dirB)
    expect(await currentTarget(link)).toBe(dirB)
    expect(readFileSync(join(link, 'marker.txt'), 'utf8').trim()).toBe('next')

    // "rollback" is just pointing it back.
    await repointCurrent(link, dirA)
    expect(await currentTarget(link)).toBe(dirA)

    await removeRelease(repoDir, releasesRoot, dirA)
    await removeRelease(repoDir, releasesRoot, dirB)
  })

  test('never leaves a half-updated link (no temp file survives a successful repoint)', async () => {
    const root = scratch()
    const link = join(root, 'current')
    const releasesRoot = scratch()
    const repoDir = scratch()
    await ensureRepo(repoDir, upstream)
    const dir = releaseDir(releasesRoot, baseSha)
    await createRelease(repoDir, releasesRoot, dir, baseSha)
    await repointCurrent(link, dir)
    const st = await lstat(link)
    expect(st.isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(dir)
    await removeRelease(repoDir, releasesRoot, dir)
  })
})

describe('releasesToPrune', () => {
  test('keeps the newest `keep` by mtime, oldest first to prune, and never the current one', async () => {
    const releasesRoot = scratch()
    await mkdir(releasesRoot, { recursive: true })
    const names = ['r0', 'r1', 'r2', 'r3', 'current-one']
    for (const n of names) await mkdir(join(releasesRoot, n))
    // Oldest to newest: r0, r1, r2, current-one, r3 — current-one is NOT the newest by mtime, to prove it is kept regardless of age.
    const order = ['r0', 'r1', 'r2', 'current-one', 'r3']
    for (let i = 0; i < order.length; i++) {
      const t = new Date(Date.now() + i * 1000)
      await utimes(join(releasesRoot, order[i]!), t, t)
    }
    const currentDir = join(releasesRoot, 'current-one')
    const toPrune = await releasesToPrune(releasesRoot, currentDir, 2)
    // keep=2 total, one slot always reserved for `current`: one more (the newest non-current, r3) is kept; r0, r1, r2 are pruned.
    expect(toPrune.sort()).toEqual([join(releasesRoot, 'r0'), join(releasesRoot, 'r1'), join(releasesRoot, 'r2')].sort())
    expect(toPrune).not.toContain(currentDir)
    expect(toPrune).not.toContain(join(releasesRoot, 'r3'))
  })

  test('nothing to prune when at or under the limit', async () => {
    const releasesRoot = scratch()
    await mkdir(releasesRoot, { recursive: true })
    await mkdir(join(releasesRoot, 'a'))
    await mkdir(join(releasesRoot, 'current-one'))
    expect(await releasesToPrune(releasesRoot, join(releasesRoot, 'current-one'), 5)).toEqual([])
  })

  test('empty when the releases root does not exist yet', async () => {
    expect(await releasesToPrune(join(tmpdir(), 'does-not-exist-xyz'), '/nowhere', 5)).toEqual([])
  })
})
