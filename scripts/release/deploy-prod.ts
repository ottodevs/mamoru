#!/usr/bin/env bun
// `bun run deploy:prod` — check, require HEAD == origin/main on a clean tree, deploy the mamoru-app
// Worker (default env, app.mamoru.lol), record the release, print the rollback command. Manual only:
// this script never runs on a push, only `promote` or a human calls it.
import { $ } from 'bun'
import { runCheck } from './lib/check.ts'
import { currentBranch, currentSha, fetchRefs, isClean, revParse } from './lib/git.ts'
import { currentVersionId, deploy, rollbackCommand } from './lib/wrangler.ts'
import { smokeTest, printSmoke } from './lib/smoke.ts'
import { appendReleaseLog } from './lib/release-log.ts'

const root = new URL('../../', import.meta.url).pathname
const appDir = `${root}apps/mamoru-app`

console.log('== deploy:prod ==')

const branch = await currentBranch(root)
if (branch !== 'main') {
  console.error(`refusing: HEAD is on '${branch}', deploy:prod requires 'main'. Run 'bun run promote' or checkout main.`)
  process.exit(1)
}

await fetchRefs(root, 'main')
const local = await currentSha(root)
const remote = await revParse(root, 'origin/main')
if (local !== remote) {
  console.error(`refusing: HEAD (${local.slice(0, 7)}) != origin/main (${remote.slice(0, 7)}). Push or pull first.`)
  process.exit(1)
}

if (!(await isClean(root))) {
  console.error('refusing: working tree is not clean.')
  process.exit(1)
}

await runCheck(root)

const before = await currentVersionId(appDir)
console.log(`current live version before deploy: ${before ?? 'unknown (first deploy?)'}`)

console.log('-> wrangler deploy (prod, default env)')
const { output, versionId } = await deploy(appDir)
console.log(output)
const after = versionId ?? 'unknown'

console.log('-> smoke test https://app.mamoru.lol')
const smoke = await smokeTest('https://app.mamoru.lol')
printSmoke(smoke)

const sha = await currentSha(root)
const logPath = await appendReleaseLog(root, {
  env: 'prod',
  sha,
  versionId: after,
  previousVersionId: before ?? 'none',
  smokeOk: smoke.ok,
  at: new Date().toISOString(),
})
console.log(`release logged: ${logPath}`)

const rollback = before ? rollbackCommand(appDir, undefined, before) : null

if (!smoke.ok) {
  console.error('prod smoke test FAILED after deploy.')
  if (rollback) console.error(`rollback to the previous version: ${rollback}`)
  process.exit(1)
}

console.log(`prod deploy OK. version ${after}, sha ${sha.slice(0, 7)}.`)
if (rollback) console.log(`rollback if needed later: ${rollback}`)
