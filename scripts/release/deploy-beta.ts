#!/usr/bin/env bun
// `bun run deploy:beta` — deploys the exact commit at origin/beta's current tip to the
// mamoru-app-beta Worker, from an immutable detached-worktree snapshot (never the live working
// tree), so a dirty or unreviewed local branch can never reach beta's shared D1 and live operator.
// Never creates origin/beta; refuses if it does not exist.
import { runTypecheckAndTest, buildApp } from './lib/check.ts'
import { withSnapshot } from './lib/snapshot.ts'
import { fetchRefs, revParse } from './lib/git.ts'
import { currentVersionId, deploy, rollbackCommand } from './lib/wrangler.ts'
import { smokeTest, printSmoke } from './lib/smoke.ts'

const root = new URL('../../', import.meta.url).pathname
const stableAppDir = `${root}apps/mamoru-app`

console.log('== deploy:beta ==')

let sha: string
try {
  await fetchRefs(root, 'beta')
  sha = await revParse(root, 'origin/beta')
} catch {
  console.error('refusing: origin/beta does not exist yet. Nothing to deploy. This script never creates it.')
  process.exit(1)
}
// A caller that polled a sha (the watcher) passes it: if origin/beta moved since, refuse, so what
// it records as deployed or failed is the commit that was actually tried.
const expected = process.argv.slice(2).find((a) => /^[0-9a-f]{40}$/.test(a))
if (expected && expected !== sha) {
  console.error(`refusing: origin/beta is at ${sha}, caller expected ${expected}`)
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
  console.error('deploy:beta failed before or during `wrangler deploy`. Check `bunx wrangler deployments list --env beta` to see whether a new version went live:', err instanceof Error ? err.message : err)
  process.exit(1)
}
console.log(output)
const after = versionId ?? 'unknown'
console.log(`deployed version: ${after}`)

let smokeOk = false
try {
  console.log('-> smoke test https://beta.mamoru.lol')
  const smoke = await smokeTest('https://beta.mamoru.lol', { expectBetaBadge: true })
  printSmoke(smoke)
  smokeOk = smoke.ok
} catch (err) {
  console.error('smoke test threw:', err instanceof Error ? err.message : err)
}

if (!smokeOk) {
  console.error('beta smoke test FAILED.')
  if (before) console.error(`rollback to the previous version: ${rollbackCommand(stableAppDir, 'beta', before)}`)
  process.exit(1)
}
console.log(`beta deploy OK. version ${after}, sha ${sha.slice(0, 7)}.`)
