#!/usr/bin/env bun
// `bun run operator:deploy -- <sha>` — deploys a reviewed sha to the durable operator
// (ops/systemd/README.md): creates (or reuses, after verifying its HEAD and recorded manifest) an
// immutable release at releases/<sha>, atomically repoints the `current` symlink the unit's
// WorkingDirectory points at, restarts the unit, and verifies it came back healthy before calling
// it done. Never touches a Cursor worktree, never runs on a push: a human or the coordinator runs
// this by hand, after Codex review on the sha being deployed.
//
// Order of operations: every validation and preparation step (fetch, ancestor check, release
// creation/reuse, integrity, install, backup, repointing `current`) happens BEFORE anything is
// stopped. None of that can fail for an avoidable reason once it has succeeded, so the stop->start
// window right after it is as short, and as unlikely to fail, as this script can make it. If
// starting still fails (the restart command itself errors, or health never comes up, or the
// post-start process check is not what we expect), it automatically rolls back: repoint `current`
// to the previous release and start that again. If the rollback also fails, it prints a loud final
// banner and exits 2 — see `printNoOperatorBanner` below.
//
// The durable unit is named mamoru-operatord.service — deliberately NOT mamoru-operator.service,
// which is the name of the currently-running *transient* unit. Two units cannot share a name while
// both are loaded, and grepping a unit's ExecStart text cannot reliably tell them apart either (the
// transient unit's ExecStart says "bun run operator", not the entrypoint path), so distinguishing by
// name is the simple, robust answer; `systemctl --user show -p Transient -p FragmentPath` is the
// authoritative *runtime* signal this script actually uses (see lib/systemctl.ts, lib/enumerate.ts).
//
// This script restarts the LIVE operator unit. Do not run it casually; `--dry-run` prints the plan
// (including the exact rollback command) and runs every read-only check, but performs no mutation.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { fetchRefs, isAncestor } from '../release/lib/git.ts'
import { backupAccounts } from './lib/backup.ts'
import { createRelease, currentTarget, ensureRepo, releaseDir, releasesToPrune, removeRelease, repointCurrent, resolveFullSha, verifyReleaseHead } from './lib/checkout.ts'
import { decide, enumerateOperator, waitForNoProcesses, type Decision } from './lib/enumerate.ts'
import { waitForHealth } from './lib/health.ts'
import { checkManifestForReuse, verifyAndInstall } from './lib/integrity.ts'
import { journalCursor, journalFollow, tailForErrors } from './lib/journal.ts'
import { acquireLock, LockHeldError } from './lib/lock.ts'
import { enableUnit, restartUnit, stopUnit, unitRegressedSince, unitSnapshot } from './lib/systemctl.ts'
import { verifyRunningFrom } from './lib/verify.ts'

const DEFAULT_ENTRYPOINT = 'apps/mamoru-operator/src/main.ts'
/** A plain hex sha (abbreviated or full) only: never a ref, branch name, or anything else that
 * could contain `/` or `..` and escape the releases root once joined into a path. Resolved to the
 * full 40-char sha once, right after fetching (see `resolveFullSha`); everything after that uses
 * only the resolved value. */
const SHA_RE = /^[0-9a-f]{7,40}$/i

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    'dry-run': { type: 'boolean', default: false },
    'base-dir': { type: 'string', default: join(homedir(), '.local/share/mamoru-operator') },
    unit: { type: 'string', default: 'mamoru-operatord.service' },
    'state-dir': { type: 'string', default: join(homedir(), '.local/state/mamoru-operator') },
    'deploy-state-dir': { type: 'string', default: join(homedir(), '.local/state/mamoru-operator-deploy') },
    'health-url': { type: 'string', default: 'http://127.0.0.1:8787' },
    'journal-seconds': { type: 'string', default: '60' },
    'keep-releases': { type: 'string', default: '5' },
    remote: { type: 'string', default: 'https://github.com/ottodevs/mamoru.git' },
    'migrate-from-transient': { type: 'string' },
    'force-kill': { type: 'boolean', default: false },
    // Advanced/test-only: overrides the pgrep pattern used to find a running operator process.
    // Tests use a throwaway marker so they never see (or could ever be confused by) whatever
    // operator process is actually running on the host this happens to run on.
    entrypoint: { type: 'string', default: DEFAULT_ENTRYPOINT },
  },
  allowPositionals: true,
})
const OPERATOR_ENTRYPOINT = values.entrypoint!

const shaArg = positionals[0]
if (!shaArg) {
  console.error(
    'usage: bun scripts/operator/deploy.ts <sha> [--dry-run] [--base-dir dir] [--unit name] [--state-dir dir] [--deploy-state-dir dir] [--health-url url] [--journal-seconds n] [--keep-releases n] [--remote url] [--migrate-from-transient <unit>] [--force-kill] [--entrypoint <path>]',
  )
  process.exit(1)
}
if (!SHA_RE.test(shaArg)) {
  console.error(`<sha> must be a plain hex git sha (7-40 hex chars), got ${JSON.stringify(shaArg)}. Refusing: anything else could escape the releases root once joined into a path.`)
  process.exit(1)
}
const baseDir = values['base-dir']!
const unit = values.unit!
const stateDir = values['state-dir']!
const deployStateDir = values['deploy-state-dir']!
const healthUrl = values['health-url']!
const journalSeconds = Number(values['journal-seconds'])
const keepReleases = Number(values['keep-releases'])
const remote = values.remote!
const migrateFrom = values['migrate-from-transient'] ?? null
const forceKill = values['force-kill'] === true
const dryRun = values['dry-run'] === true

if (!Number.isFinite(journalSeconds) || journalSeconds <= 0) {
  console.error(`--journal-seconds must be a positive number, got ${values['journal-seconds']}`)
  process.exit(1)
}
if (!Number.isFinite(keepReleases) || keepReleases < 0) {
  console.error(`--keep-releases must be a non-negative number, got ${values['keep-releases']}`)
  process.exit(1)
}
if (unit === migrateFrom) {
  console.error(`--unit and --migrate-from-transient name the same unit (${unit}); they must be different units.`)
  process.exit(1)
}

const repoDir = join(baseDir, 'repo')
const releasesRoot = join(baseDir, 'releases')
const currentLink = join(baseDir, 'current')
const lockFile = join(deployStateDir, 'deploy.lock')

console.log('== mamoru operator deploy ==')
console.log(`base dir:   ${baseDir}`)
console.log(`unit:       ${unit}`)
console.log(`state dir:  ${stateDir} (read-only except accounts.json backups)`)
console.log(`lock file:  ${lockFile}`)

// Exclusive lock for the whole run: a second concurrent deploy must exit non-zero, immediately, without doing anything.
let lock: ReturnType<typeof acquireLock>
try {
  lock = acquireLock(lockFile)
} catch (e) {
  if (e instanceof LockHeldError) {
    console.error(`FAILED: ${e.message}`)
    process.exit(1)
  }
  throw e
}

try {
  await run(shaArg)
} finally {
  lock.release()
}

/** One attempt at making `unit` run from `dir`: enable (idempotent) + restart, wait for health,
 * verify the running process's cwd/sha, and re-enumerate to confirm exactly one operator process
 * exists afterward, owned by `unit` alone. Used for both the primary start and the rollback retry —
 * the only difference between them is which `dir` to start from. */
async function startAndVerify(dir: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await enableUnit(unit)
    await restartUnit(unit)
  } catch (e) {
    return { ok: false, reason: `systemctl enable/restart ${unit} failed: ${(e as Error).message.split('\n')[0]}` }
  }
  const healthy = await waitForHealth(healthUrl, 30_000)
  if (!healthy) return { ok: false, reason: `${unit} did not answer healthy at ${healthUrl}/health within 30s` }

  const running = await verifyRunningFrom(dir, async () => (await unitSnapshot(unit)).mainPid)
  if (!running.ok) {
    return { ok: false, reason: `the running process is not where it should be (expected cwd ${running.expectedDir}, got ${running.actualCwd ?? '(no process)'}, pid ${running.pid ?? 'none'})` }
  }

  // Checkpoint #3 (the review's "and again after"): re-enumerate post-start. Anything other than
  // "exactly the durable unit alone" is a failure, not just a difference worth noting.
  const after = await enumerateOperator(OPERATOR_ENTRYPOINT, process.pid)
  const postDecision = decide(after, unit, null)
  if (postDecision.kind !== 'proceed-restart') {
    const extra = postDecision.kind === 'refuse' ? `: ${postDecision.reason}` : ''
    return { ok: false, reason: `after starting, the operator process state is not the expected single-process state (${postDecision.kind}${extra})` }
  }
  return { ok: true }
}

function printNoOperatorBanner(rollbackCmd: string): void {
  console.error('')
  console.error('################################################################')
  console.error('##                                                            ##')
  console.error('##               NO OPERATOR IS RUNNING                       ##')
  console.error('##                                                            ##')
  console.error('################################################################')
  console.error('')
  console.error(`Both the new deploy and the automatic rollback failed. ${unit} is not running.`)
  console.error("Real funds are under this operator's management: investigate and start it manually.")
  console.error('')
  console.error(`Exact manual command to try first: systemctl --user restart ${unit}`)
  console.error(`Or roll back explicitly:           ${rollbackCmd}`)
  console.error('')
}

async function run(shaArg: string): Promise<void> {
  // Checkpoint #1: enumerate every process and unit running the operator, and decide whether it is
  // safe to proceed, migrate, or refuse, BEFORE doing any network/git/install work. Never guess: an
  // orphan or an unexpected extra process refuses here, fast, without wasting time on a fetch.
  const initial = await enumerateOperator(OPERATOR_ENTRYPOINT, process.pid)
  const initialDecision = decide(initial, unit, migrateFrom)
  if (initialDecision.kind === 'refuse') {
    console.error(`FAILED: ${initialDecision.reason}`)
    process.exit(1)
  }

  await ensureRepo(repoDir, remote)
  await fetchRefs(repoDir, 'main')
  const sha = await resolveFullSha(repoDir, shaArg).catch((e: Error) => {
    console.error(`FAILED: ${e.message}`)
    process.exit(1)
  })
  if (!(await isAncestor(repoDir, sha, 'origin/main'))) {
    console.error(`${sha} is not an ancestor of origin/main (or main moved since you last fetched). Refusing to deploy an unreviewed sha.`)
    process.exit(1)
  }

  const previousDir = await currentTarget(currentLink)
  const previousSha = previousDir ? basename(previousDir) : null
  const dir = releaseDir(releasesRoot, sha)
  const rollback = previousSha
    ? `bun run operator:deploy -- ${previousSha} --base-dir ${baseDir} --unit ${unit} --state-dir ${stateDir} --health-url ${healthUrl}`
    : '(no previous release to roll back to — this looks like the first-ever deploy)'

  console.log(`current:    ${previousSha ? previousSha.slice(0, 7) : '(none yet)'}`)
  console.log(`target:     ${sha.slice(0, 7)}${previousSha === sha ? ' (already current)' : existsSync(dir) ? ' (release already exists on disk, e.g. a rollback)' : ''}`)

  if (dryRun) {
    console.log('-- dry run: nothing was done --')
    console.log(`1. back up ${join(stateDir, 'accounts.json')} (unique name, verified, keep last 10)`)
    console.log(
      existsSync(dir)
        ? `2. reuse the existing release at ${dir}, after verifying its HEAD is exactly ${sha.slice(0, 7)} and its recorded manifest still matches what is on disk (remove + recreate if either does not)`
        : `2. git worktree add --detach ${dir} ${sha.slice(0, 7)}`,
    )
    console.log('3. verify only node_modules is ignored (refuse any .env*/other ignored file) BEFORE installing, then bun install --frozen-lockfile (idempotent, must not change bun.lock), record the lockfile + node_modules manifest')
    console.log(`4. atomically repoint ${currentLink} -> ${dir} (does not affect whatever is currently running)`)
    console.log('5. re-enumerate immediately before touching the running unit; abort here (nothing destructive yet) if the state changed since step 1')
    if (initialDecision.kind === 'migrate') {
      console.log(`6. migrate: stop transient unit ${initialDecision.transientUnit}, wait up to 15s for its process(es) to exit${forceKill ? ', SIGKILL and wait up to 5s more if still present' : ' (refuses if still present: pass --force-kill to allow a SIGKILL)'}`)
    }
    console.log(`7. record the journal cursor, systemctl --user enable ${unit} (idempotent) and restart it`)
    console.log(`8. wait up to 30s for ${healthUrl}/health, verify the running process's cwd/sha, re-enumerate once more (exactly one process, owned by ${unit})`)
    console.log('9. on any failure in step 7-8: automatically repoint back to the previous release and retry step 7-8 once; if that also fails, print the "NO OPERATOR IS RUNNING" banner and exit 2')
    console.log(`10. watch the journal ${journalSeconds}s for review errors or a restart/active-state regression (reported, does not trigger the automatic rollback above)`)
    console.log(`11. prune old releases beyond ${keepReleases} (never the current one)`)
    console.log(`rollback if something is wrong later: ${rollback}`)
    return
  }

  // ---- everything from here through repointCurrent is preparation: nothing destructive yet. ----

  const backup = backupAccounts(stateDir)
  console.log(backup ? `backed up accounts.json -> ${backup}` : 'no accounts.json yet (fresh operator), nothing to back up')

  if (existsSync(dir)) {
    const headOk = await verifyReleaseHead(dir, sha)
    const manifestCheck = headOk ? await checkManifestForReuse(dir, deployStateDir, sha) : { ok: false as const, reason: `HEAD mismatch, expected ${sha.slice(0, 7)}` }
    if (!headOk || !manifestCheck.ok) {
      console.log(`-> existing release at ${dir} cannot be reused as-is (${manifestCheck.ok ? 'HEAD mismatch' : manifestCheck.reason}); removing and recreating`)
      await removeRelease(repoDir, releasesRoot, dir)
      await createRelease(repoDir, releasesRoot, dir, sha)
    } else {
      console.log(`-> reusing existing release at ${dir} (HEAD and recorded manifest both verified)`)
    }
  } else {
    console.log(`-> creating release ${dir}`)
    await createRelease(repoDir, releasesRoot, dir, sha)
  }
  // Always verify, for both the new and the reused path (and whatever branch above ran): a release
  // whose HEAD does not match the approved sha is never trusted, regardless of how it got that way.
  if (!(await verifyReleaseHead(dir, sha))) {
    console.error(`FAILED: release at ${dir} does not have HEAD ${sha} after creation/verification. Refusing to proceed.`)
    process.exit(1)
  }

  console.log('-> verifying cleanliness (before install) and re-running bun install --frozen-lockfile (idempotent, runs on every deploy)')
  const integrity = await verifyAndInstall(dir, deployStateDir, sha)
  if (!integrity.ok) {
    console.error(`FAILED: ${integrity.reason}`)
    process.exit(1)
  }
  console.log(`   lockfile hash ${integrity.lockfileHash ?? '(no lockfile)'}, node_modules manifest ${integrity.nodeModulesHash ?? '(none)'}`)

  console.log(`-> repointing ${currentLink} -> ${dir}`)
  await repointCurrent(currentLink, dir)

  // ---- preparation is done. Everything below this line touches the running unit. ----

  // Checkpoint #2: re-enumerate immediately before the stop/start window, using the same decision
  // function as checkpoint #1. The fetch/install work above can take a while; this catches anything
  // that changed in the meantime. Nothing destructive has happened yet (the repoint above only
  // affects a future start), so aborting here is always safe.
  const before = await enumerateOperator(OPERATOR_ENTRYPOINT, process.pid)
  const decision = decide(before, unit, migrateFrom)
  if (decision.kind === 'refuse') {
    console.error(`FAILED: the operator process state changed since the initial check and is no longer safe to proceed: ${decision.reason}`)
    process.exit(1)
  }
  await maybeMigrate(decision)

  const cursor = await journalCursor(unit)
  console.log(`-> starting ${unit} from ${dir}`)
  const primary = await startAndVerify(dir)
  if (!primary.ok) {
    console.error(`FAILED: ${primary.reason}`)
    // Nothing to roll back to if the "previous" release is the one we just failed to start from
    // (redeploying the sha that was already current) — that would just repeat the same failure.
    await rollbackOrBail(previousDir && previousDir !== dir ? previousDir : null, previousSha, rollback)
    return
  }
  console.log('   start verified: health OK, cwd/sha verified, exactly one operator process')
  // Baseline for the NRestarts/active-state regression check below, taken right after the start we
  // just verified succeeded — not before it, so the comparison is correct regardless of whether
  // `systemctl restart` itself bumps NRestarts on this systemd version: "no further change from
  // here, across the journal-watch window" is the healthy outcome either way.
  const baseline = await unitSnapshot(unit)

  console.log(`-> watching the journal for ${journalSeconds}s for review errors`)
  const tail = await tailForErrors(journalFollow(unit, cursor), journalSeconds)
  if (tail.failed) {
    console.error(`FAILED: ${tail.reason}`)
    for (const h of tail.hits) console.error(`  ${h}`)
    console.error('the unit is up, healthy, and alone, but something is wrong: check it before trusting this deploy. Not automatically rolled back (the unit is running); roll back by hand if needed:')
    console.error(`rollback: ${rollback}`)
    process.exit(1)
  }

  const regression = unitRegressedSince(baseline, await unitSnapshot(unit))
  if (regression) {
    console.error(`FAILED: ${regression}`)
    console.error('Not automatically rolled back (the unit is running); roll back by hand if needed:')
    console.error(`rollback: ${rollback}`)
    process.exit(1)
  }

  const toPrune = await releasesToPrune(releasesRoot, dir, keepReleases)
  for (const stale of toPrune) {
    console.log(`-> pruning old release ${stale}`)
    await removeRelease(repoDir, releasesRoot, stale)
  }

  console.log(`deploy OK. sha ${sha.slice(0, 7)}${previousSha ? ` (was ${previousSha.slice(0, 7)})` : ''}.`)
  console.log(`rollback if needed later: ${rollback}`)
}

/** Performs the actual stop (never in dry-run; the caller already returned by then). */
async function maybeMigrate(decision: Decision): Promise<void> {
  if (decision.kind !== 'migrate') return
  console.log(`-> migrating from transient unit ${decision.transientUnit}`)
  await stopUnit(decision.transientUnit)
  let remaining = await waitForNoProcesses(OPERATOR_ENTRYPOINT, process.pid, 15_000)
  if (remaining.length > 0 && forceKill) {
    console.log(`-> --force-kill: sending SIGKILL to ${remaining.join(', ')}`)
    for (const pid of remaining) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    remaining = await waitForNoProcesses(OPERATOR_ENTRYPOINT, process.pid, 5_000)
  }
  if (remaining.length > 0) {
    console.error(`FAILED: process(es) ${remaining.join(', ')} still present after stopping ${decision.transientUnit}${forceKill ? ' (even after --force-kill)' : ''}.`)
    if (!forceKill) console.error('rerun with --force-kill if you are sure it is safe, or investigate manually.')
    process.exit(1)
  }
  console.log(`   ${decision.transientUnit} stopped and confirmed gone`)
}

/** The new sha failed to start. Automatic rollback: repoint back to the previous release and try
 * once more. If there is no previous release, or the rollback attempt also fails, this is the one
 * place that prints the final banner and exits 2 — every other failure exits 1 (something is wrong,
 * but it was caught before or without taking the operator down). */
async function rollbackOrBail(previousDir: string | null, previousSha: string | null, rollback: string): Promise<never> {
  if (!previousDir) {
    console.error('no previous release to roll back to.')
    printNoOperatorBanner(rollback)
    process.exit(2)
  }
  console.error(`-> automatic rollback: repointing ${currentLink} back to ${previousDir} (sha ${previousSha?.slice(0, 7) ?? 'unknown'}) and starting it`)
  await repointCurrent(currentLink, previousDir)
  const rolledBack = await startAndVerify(previousDir)
  if (!rolledBack.ok) {
    console.error(`FAILED: rollback to the previous release also failed: ${rolledBack.reason}`)
    printNoOperatorBanner(rollback)
    process.exit(2)
  }
  console.error(`rolled back to the previous release (sha ${previousSha?.slice(0, 7) ?? 'unknown'}); it is healthy. The new sha did NOT deploy.`)
  process.exit(1)
}
