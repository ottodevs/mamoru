// Stricter-than-`isClean` checks for an operator release directory. `git status --porcelain` alone
// (scripts/release/lib/git.ts#isClean, used by the shared app release scripts, unchanged here) only
// sees tracked/untracked changes — it does not look at *ignored* files at all, so a tampered or
// partial runtime input (a `.env` someone dropped in, a stray build artifact) sitting in an ignored
// path would never flag a release as dirty and could get silently reused across deploys. This file
// is operator-only: scripts/release's behavior is unchanged.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { $ } from 'bun'
import { isClean } from '../../release/lib/git.ts'

/** `bun install --frozen-lockfile` in `dir`. Idempotent: run again on every deploy, even for a reused release (see `verifyAndInstall`). */
export async function installFrozen(dir: string): Promise<void> {
  await $`bun install --frozen-lockfile`.cwd(dir)
}

export type IgnoredCheck = { ok: boolean; disallowed: string[] }

/** True for `node_modules` or `.../node_modules` (a directory named exactly `node_modules`, trailing slash from porcelain output stripped first) — the one ignored path this operator install is expected to produce. */
function isAllowedIgnored(path: string): boolean {
  const trimmed = path.replace(/\/$/, '')
  return trimmed === 'node_modules' || trimmed.endsWith('/node_modules')
}

/** `git status --porcelain --ignored=matching`: every ignored path, recursed fully (plain
 * `--ignored` collapses an untracked directory that is entirely ignored into one line for its
 * topmost such ancestor — e.g. a monorepo's `apps/foo/node_modules/` would show as `apps/foo/`, not
 * matching the node_modules allowlist below at all — `matching` mode reports the exact ignored path
 * instead). Only a `node_modules` directory anywhere in the tree is allowed; anything else ignored
 * (`.env*`, a stray build artifact, a leftover from a different tool) refuses the release. */
export async function checkIgnoredFiles(dir: string): Promise<IgnoredCheck> {
  const out = await $`git status --porcelain --ignored=matching`.cwd(dir).quiet().text()
  const disallowed: string[] = []
  for (const line of out.split('\n')) {
    if (!line.startsWith('!!')) continue // '!!' = ignored, in porcelain v1; everything else is handled by isClean already
    const path = line.slice(3).trim()
    if (!isAllowedIgnored(path)) disallowed.push(path)
  }
  return { ok: disallowed.length === 0, disallowed }
}

function sha256File(path: string): string | null {
  if (!existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * A coarse but cheap fingerprint of node_modules' actual on-disk contents: every top-level entry's
 * name plus its total size (`du -sb`, not following a symlink — a workspace's own sibling packages
 * are symlinked here and are not the concern of this check; real downloaded third-party dependencies
 * are plain directories, and this does react to one being added, removed, or resized). Deliberately
 * not a content hash of every file — too slow for a large dependency tree — so this is "simplest
 * safe rule" (catches a changed/missing/extra package), not a cryptographic guarantee against
 * someone determined enough to also preserve the exact byte count while tampering.
 */
export async function nodeModulesManifestHash(dir: string): Promise<string | null> {
  const nmDir = join(dir, 'node_modules')
  if (!existsSync(nmDir)) return null
  const names = readdirSync(nmDir).sort()
  const sizes = await Promise.all(
    names.map(async (name) => {
      const out = await $`du -sb ${join(nmDir, name)}`.quiet().nothrow().text()
      return out.split(/\s+/)[0] ?? '0'
    }),
  )
  return createHash('sha256')
    .update(names.map((n, i) => `${n}:${sizes[i]}`).join('\n'))
    .digest('hex')
}

export type ReleaseMeta = { sha: string; lockfileHash: string | null; nodeModulesHash: string | null; verifiedAt: string }

/** `deployStateDir/release-meta/<sha>.json` — metadata lives in the DEPLOY TOOL's own state dir,
 * never inside the release directory itself (a metadata file in the release tree would be an
 * untracked/ignored stray file and trip `checkIgnoredFiles` on the very next deploy). */
export function releaseMetaPath(deployStateDir: string, sha: string): string {
  return join(deployStateDir, 'release-meta', `${sha}.json`)
}

export function writeReleaseMeta(deployStateDir: string, meta: ReleaseMeta): void {
  const path = releaseMetaPath(deployStateDir, meta.sha)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(meta, null, 1), { mode: 0o600 })
  renameSync(tmp, path)
}

export function readReleaseMeta(deployStateDir: string, sha: string): ReleaseMeta | null {
  try {
    return JSON.parse(readFileSync(releaseMetaPath(deployStateDir, sha), 'utf8')) as ReleaseMeta
  } catch {
    return null
  }
}

export type ManifestCheck = { ok: true } | { ok: false; reason: string }

/**
 * Whether a candidate-for-reuse release's CURRENT on-disk manifest (bun.lock hash + the
 * node_modules fingerprint above) still matches what was recorded the last time this exact sha was
 * verified. No recorded meta at all (never verified before, or the deploy tool's own state was
 * cleared) is NOT treated as a mismatch — there is nothing to compare against yet, so the caller
 * proceeds to install and record one. node_modules is never reused blindly: a release is only ever
 * reused when this matches; otherwise the caller must remove and rebuild it, never trust what is on
 * disk just because the directory and a matching git HEAD exist.
 */
export async function checkManifestForReuse(dir: string, deployStateDir: string, sha: string): Promise<ManifestCheck> {
  const recorded = readReleaseMeta(deployStateDir, sha)
  if (!recorded) return { ok: true }
  const lockfileHash = sha256File(join(dir, 'bun.lock'))
  const nodeModulesHash = await nodeModulesManifestHash(dir)
  if (lockfileHash !== recorded.lockfileHash || nodeModulesHash !== recorded.nodeModulesHash) {
    return {
      ok: false,
      reason: `recorded manifest for ${sha} no longer matches what is on disk (lockfile ${recorded.lockfileHash ?? 'none'} -> ${lockfileHash ?? 'none'}, node_modules ${recorded.nodeModulesHash ?? 'none'} -> ${nodeModulesHash ?? 'none'})`,
    }
  }
  return { ok: true }
}

export type VerifyAndInstallResult = { ok: true; lockfileHash: string | null; nodeModulesHash: string | null } | { ok: false; reason: string }

/**
 * Runs on every deploy, for both a freshly created and a reused release — `bun install
 * --frozen-lockfile` is idempotent, so re-running it on a reused release is a cheap, real
 * verification that its installed files still match the lockfile exactly, not an assumption.
 * Order: (1) cleanliness — tracked-file dirtiness (isClean) and any disallowed ignored file
 * (.env*, a stray artifact) — is checked BEFORE bun install ever runs, not after, for both a fresh
 * and a reused release; (2) hash bun.lock before; (3) install; (4) refuse if it left the tree dirty;
 * (5) refuse if bun.lock's hash changed — a frozen-lockfile install is documented to error rather
 * than rewrite the lockfile, so any change here means something is wrong, not a normal outcome.
 * Records the resulting manifest (lockfile hash + node_modules fingerprint) in the deploy tool's own
 * state (`releaseMetaPath`) on success, for `checkManifestForReuse` to verify next time.
 */
export async function verifyAndInstall(dir: string, deployStateDir: string, sha: string): Promise<VerifyAndInstallResult> {
  if (!(await isClean(dir))) return { ok: false, reason: `${dir} is not clean before install` }
  const before = await checkIgnoredFiles(dir)
  if (!before.ok) return { ok: false, reason: `disallowed ignored file(s) in ${dir}: ${before.disallowed.join(', ')}` }

  const lockFile = join(dir, 'bun.lock')
  const hashBefore = sha256File(lockFile)
  await installFrozen(dir)

  if (!(await isClean(dir))) return { ok: false, reason: `${dir} is not clean after bun install --frozen-lockfile` }
  const after = await checkIgnoredFiles(dir)
  if (!after.ok) return { ok: false, reason: `disallowed ignored file(s) in ${dir} after install: ${after.disallowed.join(', ')}` }

  const hashAfter = sha256File(lockFile)
  if (hashBefore !== null && hashAfter !== hashBefore) {
    return { ok: false, reason: `bun.lock changed during a --frozen-lockfile install in ${dir} (${hashBefore} -> ${hashAfter}); this should never happen` }
  }

  const nodeModulesHash = await nodeModulesManifestHash(dir)
  writeReleaseMeta(deployStateDir, { sha, lockfileHash: hashAfter, nodeModulesHash, verifiedAt: new Date().toISOString() })
  return { ok: true, lockfileHash: hashAfter, nodeModulesHash }
}
