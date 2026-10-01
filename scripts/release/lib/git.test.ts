// Guards that gate promote/deploy: fast-forward detection, clean-tree detection, sha resolution.
// Built against a disposable scratch repo so no real history is needed.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { $ } from 'bun'
import { currentBranch, currentSha, isAncestor, isClean, revParse } from './git.ts'

let repo: string
let base: string
let ahead: string
let sideways: string

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'mamoru-git-test-'))
  await $`git init -q -b main`.cwd(repo)
  await $`git config user.email test@example.com`.cwd(repo)
  await $`git config user.name "Release Pipeline Test"`.cwd(repo)

  await writeFile(join(repo, 'a.txt'), 'one\n')
  await $`git add a.txt`.cwd(repo)
  await $`git commit -q -m base`.cwd(repo)
  base = (await $`git rev-parse HEAD`.cwd(repo).text()).trim()

  await writeFile(join(repo, 'a.txt'), 'two\n')
  await $`git add a.txt`.cwd(repo)
  await $`git commit -q -m ahead`.cwd(repo)
  ahead = (await $`git rev-parse HEAD`.cwd(repo).text()).trim()

  // A sideways commit that branches off `base`, so it is NOT a fast-forward descendant of `ahead`.
  await $`git checkout -q -b side ${base}`.cwd(repo)
  await writeFile(join(repo, 'b.txt'), 'side\n')
  await $`git add b.txt`.cwd(repo)
  await $`git commit -q -m side`.cwd(repo)
  sideways = (await $`git rev-parse HEAD`.cwd(repo).text()).trim()
  await $`git checkout -q main`.cwd(repo)
})

afterAll(async () => {
  await rm(repo, { recursive: true, force: true })
})

describe('isAncestor (fast-forward check)', () => {
  it('is true when the first sha is a real ancestor of the second', async () => {
    expect(await isAncestor(repo, base, ahead)).toBe(true)
  })
  it('is false for a sideways (non fast-forward) commit', async () => {
    expect(await isAncestor(repo, ahead, sideways)).toBe(false)
  })
  it('is false in the wrong direction', async () => {
    expect(await isAncestor(repo, ahead, base)).toBe(false)
  })
  it('is true for a sha compared to itself', async () => {
    expect(await isAncestor(repo, base, base)).toBe(true)
  })
})

describe('isClean', () => {
  it('is true right after a commit', async () => {
    expect(await isClean(repo)).toBe(true)
  })
  it('is false with an untracked file', async () => {
    await writeFile(join(repo, 'untracked.txt'), 'x\n')
    expect(await isClean(repo)).toBe(false)
    await rm(join(repo, 'untracked.txt'))
  })
})

describe('currentBranch / currentSha / revParse', () => {
  it('reports the checked-out branch and its sha', async () => {
    expect(await currentBranch(repo)).toBe('main')
    expect(await currentSha(repo)).toBe(ahead)
    expect(await revParse(repo, 'main')).toBe(ahead)
  })
})
