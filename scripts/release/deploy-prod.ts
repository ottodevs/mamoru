#!/usr/bin/env bun
// `bun run deploy:prod <sha> [--min-soak-hours=N] [--hotfix="<reason>"]` — deploys ONE named commit to the
// mamoru-app Worker (default env, app.mamoru.lol). The sha must be the tip of origin/beta (what is running
// on beta), must be on origin/main (reviewed and merged) and must have soaked: the release log has to show
// beta running it without interruption, smoke test passing, for at least 24 hours (or the hours asked
// for). The sha is a full 40-character commit id: a branch, a tag or a short sha is refused. It is never
// "whatever main is now": commits merged after the beta was cut cannot ride along.
// Builds from an immutable detached-worktree snapshot of that sha, never the live working tree. Logs the
// release and prints the rollback command even if something fails after the deploy itself. Manual only.
import { OP_LOCK, requireLease, underFlock } from './lib/lease.ts'
import { $ } from 'bun'
import { fetchRefs, isAncestor, revParse } from './lib/git.ts'
import { runCheck } from './lib/check.ts'
import { nextTag, parseProdArgs, prodTarget, soakVerdict } from './lib/gate.ts'
import { withSnapshot } from './lib/snapshot.ts'
import { currentVersionId, deploy, describeFailure, rollbackCommand } from './lib/wrangler.ts'
import { smokeTest, printSmoke } from './lib/smoke.ts'
import { appendReleaseLog, readReleaseLog } from './lib/release-log.ts'

const root = new URL('../../', import.meta.url).pathname
const stableAppDir = `${root}apps/mamoru-app`

// Coordinator only: the session named in MAMORU_COORD_AS must hold the live lease (scripts/release/coord.ts).
underFlock(OP_LOCK, { wait: false, busy: 'another coordinator operation (a release or an operator redeploy) is running' })
requireLease(process.env.MAMORU_COORD_AS)
console.log('== deploy:prod ==')

const refuse = (reason: string): never => {
  console.error(`refusing: ${reason}`)
  process.exit(1)
}

// The sha is taken as written: a full 40-character commit id, never resolved from a name by git.
const parsed = parseProdArgs(process.argv.slice(2))
if (!parsed.ok) refuse(parsed.reason)
const { sha, options: soakOptions } = parsed.ok ? parsed : refuse('unreachable')

let beta: string
let main: string
try {
  await fetchRefs(root, 'main', 'beta')
  beta = await revParse(root, 'origin/beta')
  main = await revParse(root, 'origin/main')
} catch {
  refuse('could not read origin/main and origin/beta.')
}

const target = prodTarget({ requested: sha, beta: beta!, betaIsOnMain: beta! === main! || (await isAncestor(root, beta!, main!)) })
if (!target.ok) refuse(target.reason)

const soak = soakVerdict(await readReleaseLog(), sha, new Date(), soakOptions)
if (!soak.ok) refuse(soak.reason)
console.log(`deploying ${sha.slice(0, 7)}: on beta without interruption for ${(Math.floor(soak.hours! * 100) / 100).toFixed(2)} h (asked: ${soakOptions.minHours} h)${soakOptions.hotfix ? `, hotfix: ${soakOptions.hotfix}` : ''}`)
if (main! !== sha) console.log(`note: origin/main is ahead at ${main!.slice(0, 7)}. Those commits are NOT in this release.`)

let output: string
let versionId: string | null
let before: string | null
try {
  ;({ output, versionId, before } = await withSnapshot(root, sha, async (dir) => {
    const appDir = `${dir}/apps/mamoru-app`
    await runCheck(dir)
    // Read inside the snapshot: fails closed (throws, aborts before deploying) on any read error.
    const before = await currentVersionId(appDir, '')
    const result = await deploy(appDir, '')
    return { ...result, before }
  }))
} catch (err) {
  console.error('deploy:prod failed before or during `wrangler deploy`. Check `bunx wrangler deployments list --env ""` to see whether a new version went live.')
  console.error(describeFailure(err))
  process.exit(1)
}

console.log(output)
const after = versionId ?? 'unknown'
console.log(`deployed version: ${after}`)

// The deploy already happened: everything from here must still log + print the rollback command
// on any failure, including an exception (a thrown smoke-test fetch, a log-write error, etc).
let smokeOk = false
try {
  console.log('-> smoke test https://app.mamoru.lol')
  const smoke = await smokeTest('https://app.mamoru.lol')
  printSmoke(smoke)
  smokeOk = smoke.ok
} catch (err) {
  console.error('smoke test threw:', err instanceof Error ? err.message : err)
}

try {
  const logPath = await appendReleaseLog({
    env: 'prod',
    sha,
    versionId: after,
    previousVersionId: before ?? 'none',
    smokeOk,
    at: new Date().toISOString(),
    soakHours: Number(soak.hours!.toFixed(2)),
    ...(soakOptions.hotfix ? { hotfix: soakOptions.hotfix } : {}),
  })
  console.log(`release logged: ${logPath}`)
} catch (err) {
  console.error('failed to write the release log (deploy result above still stands):', err instanceof Error ? err.message : err)
}

const rollback = before ? rollbackCommand(stableAppDir, '', before) : null

if (!smokeOk) {
  console.error('prod smoke test FAILED after deploy.')
  if (rollback) console.error(`rollback to the previous version: ${rollback}`)
  process.exit(1)
}

console.log(`prod deploy OK. version ${after}, sha ${sha.slice(0, 7)}.`)
if (rollback) console.log(`rollback if needed later: ${rollback}`)

// The tag names the release. It is printed, not pushed: the coordinator writes the one line that says what changed.
try {
  await $`git fetch origin --tags`.cwd(root).quiet()
  const tags = (await $`git tag --list ${'app-*'}`.cwd(root).text()).split('\n').filter(Boolean)
  const tag = nextTag(tags, new Date())
  console.log('tag and publish this release:')
  console.log(`  git tag -a ${tag} ${sha} -m "<one line: what changes for a user>" && git push origin ${tag}`)
  console.log(`  gh release create ${tag} -R ottodevs/mamoru --verify-tag --generate-notes`)
} catch {
  console.error('could not read the existing tags; tag the release by hand (docs/process/releasing.md).')
}
