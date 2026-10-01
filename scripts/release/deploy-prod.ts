#!/usr/bin/env bun
// `bun run deploy:prod` — deploys the exact commit at origin/main's current tip to the mamoru-app
// Worker (default env, app.mamoru.lol), from an immutable detached-worktree snapshot, never the
// live working tree. Logs the release and prints the rollback command even if something fails
// after the deploy itself (smoke test throws, etc). Manual only: this never runs on a push, only
// `promote` or a human calls it.
import { fetchRefs, revParse } from './lib/git.ts'
import { runCheck } from './lib/check.ts'
import { withSnapshot } from './lib/snapshot.ts'
import { currentVersionId, deploy, rollbackCommand } from './lib/wrangler.ts'
import { smokeTest, printSmoke } from './lib/smoke.ts'
import { appendReleaseLog } from './lib/release-log.ts'

const root = new URL('../../', import.meta.url).pathname
const stableAppDir = `${root}apps/mamoru-app`

console.log('== deploy:prod ==')

await fetchRefs(root, 'main')
const sha = await revParse(root, 'origin/main')
console.log(`deploying origin/main at ${sha.slice(0, 7)} from a clean snapshot`)

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
  console.error('deploy:prod failed before or during the deploy; prod was not touched:', err instanceof Error ? err.message : err)
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
  const logPath = await appendReleaseLog({ env: 'prod', sha, versionId: after, previousVersionId: before ?? 'none', smokeOk, at: new Date().toISOString() })
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
