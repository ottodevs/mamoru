// Minimal git helpers for the release scripts. Never touches secrets.
import { $ } from 'bun'

export async function currentBranch(root: string): Promise<string> {
  return (await $`git rev-parse --abbrev-ref HEAD`.cwd(root).text()).trim()
}

export async function currentSha(root: string): Promise<string> {
  return (await $`git rev-parse HEAD`.cwd(root).text()).trim()
}

export async function revParse(root: string, ref: string): Promise<string> {
  return (await $`git rev-parse ${ref}`.cwd(root).text()).trim()
}

export async function isClean(root: string): Promise<boolean> {
  const out = await $`git status --porcelain`.cwd(root).text()
  return out.trim().length === 0
}

export async function fetchRefs(root: string, ...refs: string[]): Promise<void> {
  await $`git fetch origin ${refs}`.cwd(root).quiet()
}

/** True if `ancestor` is an ancestor of `descendant` (a fast-forward from ancestor to descendant is possible). */
export async function isAncestor(root: string, ancestor: string, descendant: string): Promise<boolean> {
  const proc = Bun.spawn(['git', 'merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, stdout: 'ignore', stderr: 'ignore' })
  return (await proc.exited) === 0
}
