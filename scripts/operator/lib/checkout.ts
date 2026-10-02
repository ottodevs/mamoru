// The durable deploy target (ops/systemd/README.md) is a set of immutable, per-sha release
// directories plus a `current` symlink the unit's WorkingDirectory points at — never a single
// checkout mutated in place with `git checkout --detach`. Mutating a live directory in place keeps
// whatever local edits were already compatible with the new sha (deleted/renamed files survive a
// checkout that doesn't touch them, an untracked file is never touched by checkout at all), so
// unreviewed code could run without anyone noticing. A fresh `git worktree add --detach` into a
// brand-new directory has no prior state to inherit at all, which is what actually closes that gap
// — the clean-tree checks below are defense in depth on top of that, not the primary fix.
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readlink, rename, rm, stat, symlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname, join, resolve, sep } from 'node:path'
import { $ } from 'bun'
import { currentSha, isClean } from '../../release/lib/git.ts'

/** Clones `remoteUrl` into `repoDir` if it is not already a git checkout. A normal (non-bare)
 * clone: `repoDir` itself is never run, only fetched into and used to host `git worktree add`, but
 * a normal clone keeps `origin/main` resolvable the same way every other release script expects. */
export async function ensureRepo(repoDir: string, remoteUrl: string): Promise<void> {
  if (existsSync(join(repoDir, '.git'))) return
  await $`git clone ${remoteUrl} ${repoDir}`.quiet()
}

/** `releases/<sha>` must not already exist: a release is created once and never reused or mutated. */
export function releaseDir(releasesRoot: string, sha: string): string {
  return join(releasesRoot, sha)
}

/**
 * Resolves any accepted hex sha (abbreviated or full — the CLI already refused anything else) to
 * the full 40-char commit sha, once, right after fetching. Every later step (the ancestor check,
 * the release directory name, the HEAD comparison) must use only this value: `git rev-parse
 * HEAD`/`currentSha` always returns the full 40 chars, so comparing it against an abbreviated input
 * sha would never match — `releases/<abbrev>` and `releases/<full>` would also silently be two
 * different directories for what should be the same release. Throws a clear error if `ref` does not
 * resolve to a real commit object (an unknown/mistyped sha, or `main` moved and this one no longer
 * exists after a shallow history — this repo clones are never shallow).
 */
export async function resolveFullSha(repoDir: string, ref: string): Promise<string> {
  try {
    const out = await $`git rev-parse --verify ${`${ref}^{commit}`}`.cwd(repoDir).quiet().text()
    return out.trim()
  } catch {
    throw new Error(`${ref} does not resolve to a known commit in ${repoDir} (fetch first, or it is simply wrong)`)
  }
}

/** Throws unless `dir` resolves to a path strictly inside `releasesRoot` — a last-ditch guard
 * before any destructive operation (`removeRelease`, and `createRelease`'s own target) so a bad
 * `sha` or a caller bug can never make this module touch anything outside the releases tree. */
function assertInsideReleasesRoot(releasesRoot: string, dir: string): void {
  const root = resolve(releasesRoot) + sep
  const resolved = resolve(dir)
  if (resolved !== resolve(releasesRoot) && !resolved.startsWith(root)) throw new Error(`refusing to operate on ${dir}: it is not inside the releases root ${releasesRoot}`)
}

/**
 * Creates `releases/<sha>` as a fresh `git worktree`, and verifies it is clean and its HEAD is
 * exactly `sha` right after checkout (defense in depth: a fresh worktree should always satisfy
 * both, so this only ever fires on something truly unexpected — a corrupt checkout, an ambiguous
 * abbreviated sha resolving differently than expected, a smudge filter, etc). Does NOT install
 * dependencies — see `integrity.ts#verifyAndInstall`, run uniformly for new and reused releases.
 * Refuses outright if the directory already exists, or is outside `releasesRoot`.
 */
export async function createRelease(repoDir: string, releasesRoot: string, dir: string, sha: string): Promise<void> {
  assertInsideReleasesRoot(releasesRoot, dir)
  if (existsSync(dir)) throw new Error(`${dir} already exists; releases are immutable, refusing to reuse or overwrite it`)
  await $`git worktree add --detach ${dir} ${sha}`.cwd(repoDir).quiet()
  if (!(await isClean(dir))) throw new Error(`${dir} is not clean right after checkout; refusing to use it (this should never happen)`)
  const head = await currentSha(dir)
  if (head !== sha) throw new Error(`${dir} has HEAD ${head} right after checking out ${sha}; refusing to use it (this should never happen)`)
}

/** `git -C <dir> rev-parse HEAD === sha`. Used for both a freshly created release (defense in depth, see `createRelease`) and a reused one (the actual bug this guards: a reused release directory was trusted without checking this). */
export async function verifyReleaseHead(dir: string, sha: string): Promise<boolean> {
  return (await currentSha(dir)) === sha
}

/** Removes a `releases/<sha>` worktree (used when pruning old releases, or recreating one whose HEAD did not match the expected sha). Refuses if `dir` is outside `releasesRoot`. Never the one `current` points at — callers must check that first. */
export async function removeRelease(repoDir: string, releasesRoot: string, dir: string): Promise<void> {
  assertInsideReleasesRoot(releasesRoot, dir)
  await $`git worktree remove --force ${dir}`.cwd(repoDir).quiet().nothrow()
  await rm(dir, { recursive: true, force: true })
  await $`git worktree prune`.cwd(repoDir).quiet().nothrow()
}

/** The release directory `current` points at, or null if it does not exist yet (first-ever deploy) or is not a symlink. */
export async function currentTarget(currentLink: string): Promise<string | null> {
  try {
    const st = await lstat(currentLink)
    if (!st.isSymbolicLink()) return null
    return await readlink(currentLink)
  } catch {
    return null
  }
}

/** Atomically repoints `current` at `dir`: a fresh symlink is created under a temp name and
 * renamed over the old one, so the unit's WorkingDirectory never observes a half-updated link —
 * it is always either the old target or the new one, never missing or partial. Rollback is just
 * calling this again with the previous release's directory. */
export async function repointCurrent(currentLink: string, dir: string): Promise<void> {
  await mkdir(dirname(currentLink), { recursive: true })
  const tmp = `${currentLink}.tmp-${randomBytes(4).toString('hex')}`
  await symlink(dir, tmp)
  await rename(tmp, currentLink)
}

/**
 * Which release directories to remove so at most `keep` remain, oldest (by mtime) first, never the
 * one `currentDir` points at regardless of age or `keep` (mirrors `backup.ts`'s "never prune the
 * active one" rule) and never a `*.tmp-*` leftover of a symlink repoint (nothing should ever leave
 * one behind, since the rename is atomic, but a prune pass is a cheap place to also sweep one up if
 * a process were ever killed between the symlink and the rename).
 */
export async function releasesToPrune(releasesRoot: string, currentDir: string, keep: number): Promise<string[]> {
  if (!existsSync(releasesRoot)) return []
  const entries = await readdir(releasesRoot)
  const candidates = entries.map((e) => join(releasesRoot, e)).filter((d) => d !== currentDir)
  const withTimes = await Promise.all(candidates.map(async (d) => ({ d, mtimeMs: (await stat(d)).mtimeMs })))
  withTimes.sort((a, b) => a.mtimeMs - b.mtimeMs)
  const safeKeepOthers = Math.max(keep - 1, 0) // `current` occupies one slot of `keep` by itself
  const excess = withTimes.length - safeKeepOthers
  return excess > 0 ? withTimes.slice(0, excess).map((x) => x.d) : []
}
