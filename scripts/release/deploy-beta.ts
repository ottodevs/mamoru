#!/usr/bin/env bun
// `bun run deploy:beta` — check, build with the BETA badge, deploy the mamoru-app-beta Worker
// (env.beta in wrangler.jsonc), smoke test beta.mamoru.lol. Safe to run from any branch; the
// systemd watcher proposed in ops/systemd/ runs this on every push to `beta`.
import { $ } from 'bun'
import { runCheck } from './lib/check.ts'
import { currentVersionId, deploy, rollbackCommand } from './lib/wrangler.ts'
import { smokeTest, printSmoke } from './lib/smoke.ts'

const root = new URL('../../', import.meta.url).pathname
const appDir = `${root}apps/mamoru-app`

console.log('== deploy:beta ==')
await runCheck(root)

console.log('-> build (VITE_BETA=1, shows the BETA badge)')
await $`bun run build`.cwd(appDir).env({ ...process.env, VITE_BETA: '1' })

const before = await currentVersionId(appDir, 'beta')

console.log('-> wrangler deploy --env beta')
const { output, versionId } = await deploy(appDir, 'beta')
console.log(output)
console.log(`deployed version: ${versionId ?? 'unknown'}`)

console.log('-> smoke test https://beta.mamoru.lol')
const smoke = await smokeTest('https://beta.mamoru.lol', { expectBetaBadge: true })
printSmoke(smoke)

if (!smoke.ok) {
  console.error('beta smoke test FAILED.')
  if (before) console.error(`rollback to the previous version: ${rollbackCommand(appDir, 'beta', before)}`)
  process.exit(1)
}
console.log('beta deploy OK.')
