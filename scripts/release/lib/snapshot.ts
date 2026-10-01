// An immutable deploy snapshot: a detached worktree pinned to one exact SHA, in its own temp
// directory, with its own `bun install --frozen-lockfile`. Deploys build and ship from here, never
// from the live checkout, so a dirty tree, an unreviewed local commit, or a file edited mid-run can
// never reach a Worker. The directory is always removed, even on failure.
import { $ } from 'bun'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export async function withSnapshot<T>(root: string, sha: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'mamoru-release-'))
  try {
    console.log(`-> snapshot ${sha.slice(0, 7)} at ${dir}`)
    await $`git worktree add --detach ${dir} ${sha}`.cwd(root).quiet()
    await $`bun install --frozen-lockfile`.cwd(dir).quiet()
    return await fn(dir)
  } finally {
    console.log(`-> cleaning up snapshot ${dir}`)
    await $`git worktree remove --force ${dir}`.cwd(root).quiet().nothrow()
    await rm(dir, { recursive: true, force: true }).catch(() => {})
    await $`git worktree prune`.cwd(root).quiet().nothrow()
  }
}
