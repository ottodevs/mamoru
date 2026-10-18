#!/usr/bin/env bun
// `bun run deploy:beta [sha]` — deploys the exact commit at origin/beta's current tip to the
// mamoru-app-beta Worker, from an immutable detached-worktree snapshot (never the live working
// tree), so a dirty or unreviewed local branch can never reach beta's shared D1 and live operator.
// The tip must be a commit of origin/main: beta is a pointer the coordinator moves, never a place to
// work. Every run that reaches the deploy step is written to the release log (that record is what
// deploy:prod reads to know how long a sha has soaked) and prints the rollback command.
// Never creates origin/beta; refuses if it does not exist.
import { OP_LOCK, requireLease, underFlock } from './lib/lease.ts'
import { runTypecheckAndTest, buildApp } from './lib/check.ts'
import { betaTarget, parseBetaArgs } from './lib/gate.ts'
import { withSnapshot } from './lib/snapshot.ts'
import { fetchRefs, isAncestor, revParse } from './lib/git.ts'
import { appendReleaseLog } from './lib/release-log.ts'
import { currentVersionId, deploy, describeFailure, rollbackCommand } from './lib/wrangler.ts'
import { smokeTest, printSmoke } from './lib/smoke.ts'

const root = new URL('../../', import.meta.url).pathname
const stableAppDir = `${root}apps/mamoru-app`

// Coordinator only: the session named in MAMORU_COORD_AS must hold the live lease (scripts/release/coord.ts).
underFlock(OP_LOCK, { wait: false, busy: 'another coordinator operation (a release or an operator redeploy) is running' })
requireLease(process.env.MAMORU_COORD_AS)
console.log('== deploy:beta ==')

let sha: string
let main: string
try {
  await fetchRefs(root, 'beta')
  sha = await revParse(root, 'origin/beta')
} catch {
  console.error('refusing: origin/beta does not exist yet. Nothing to deploy. This script never creates it.')
  process.exit(1)
}
try {
  await fetchRefs(root, 'main')
  main = await revParse(root, 'origin/main')
} catch {
  console.error('refusing: could not read origin/main.')
  process.exit(1)
}
// A caller that polled a sha (the watcher) passes it: if origin/beta moved since, refuse, so what
// it records as deployed or failed is the commit that was actually tried.
const parsedArgs = parseBetaArgs(process.argv.slice(2))
if (!parsedArgs.ok) {
  console.error(`refusing: ${parsedArgs.reason}`)
  process.exit(1)
}
const expected = parsedArgs.expected
const target = betaTarget({ beta: sha, betaIsOnMain: sha === main || (await isAncestor(root, sha, main)), ...(expected ? { expected } : {}) })
if (!target.ok) {
  console.error(`refusing: ${target.reason}`)
  process.exit(1)
}
console.log(`deploying origin/beta at ${sha.slice(0, 7)} from a clean snapshot`)

let output: string
let versionId: string | null
let before: string | null
try {
  ;({ output, versionId, before } = await withSnapshot(root, sha, async (dir) => {
  const appDir = `${dir}/apps/mamoru-app`
  await runTypecheckAndTest(dir)
  await buildApp(appDir, { VITE_BETA: '1' })
  // Read inside the snapshot: fails closed (throws, aborts before deploying) on any read error.
  const before = await currentVersionId(appDir, 'beta')
  const result = await deploy(appDir, 'beta')
  return { ...result, before }
  }))
} catch (err) {
  console.error('deploy:beta failed before or during `wrangler deploy`. Check `bunx wrangler deployments list --env beta` to see whether a new version went live.')
  console.error(describeFailure(err))
  process.exit(1)
}
console.log(output)
const after = versionId ?? 'unknown'
console.log(`deployed version: ${after}`)

// The deploy already happened: from here on, log it and print the rollback command whatever fails.
let smokeOk = false
try {
  console.log('-> smoke test https://beta.mamoru.lol')
  const smoke = await smokeTest('https://beta.mamoru.lol', { expectBetaBadge: true })
  printSmoke(smoke)
  smokeOk = smoke.ok
} catch (err) {
  console.error('smoke test threw:', err instanceof Error ? err.message : err)
}

try {
  const logPath = await appendReleaseLog({ env: 'beta', sha, versionId: after, previousVersionId: before ?? 'none', smokeOk, at: new Date().toISOString() })
  console.log(`release logged: ${logPath}`)
} catch (err) {
  console.error('failed to write the release log (deploy result above still stands; without the record deploy:prod will not accept this sha):', err instanceof Error ? err.message : err)
}

const rollback = before ? rollbackCommand(stableAppDir, 'beta', before) : null

if (!smokeOk) {
  console.error('beta smoke test FAILED. This deploy does not count as a soak.')
  if (rollback) console.error(`rollback to the previous version: ${rollback}`)
  process.exit(1)
}
console.log(`beta deploy OK. version ${after}, sha ${sha.slice(0, 7)}. The soak starts now.`)
if (rollback) console.log(`rollback if needed later: ${rollback}`)
console.log(`when it has soaked and Otto gives the GO: bun run deploy:prod ${sha}`)
