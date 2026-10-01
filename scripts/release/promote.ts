#!/usr/bin/env bun
// `bun run promote` — fast-forward main to the tip of beta (only ff, never force), then deploy:prod.
// Use this once beta has soaked a risky change. Requires a local checkout on `main`.
import { $ } from 'bun'
import { currentBranch, fetchRefs, isAncestor, revParse } from './lib/git.ts'

const root = new URL('../../', import.meta.url).pathname

console.log('== promote: fast-forward main to beta ==')

const branch = await currentBranch(root)
if (branch !== 'main') {
  console.error(`refusing: checkout 'main' before promoting (currently on '${branch}').`)
  process.exit(1)
}

await fetchRefs(root, 'main', 'beta')
const mainSha = await revParse(root, 'origin/main')
const betaSha = await revParse(root, 'origin/beta')

if (mainSha === betaSha) {
  console.log('origin/main already matches origin/beta, nothing to fast-forward.')
} else {
  if (!(await isAncestor(root, mainSha, betaSha))) {
    console.error('refusing: origin/main is not an ancestor of origin/beta, this is not a fast-forward.')
    console.error('Rebase or merge beta onto main first, then re-run promote.')
    process.exit(1)
  }
  console.log(`-> fast-forwarding local main to origin/beta (${betaSha.slice(0, 7)})`)
  await $`git merge --ff-only origin/beta`.cwd(root)
  console.log('-> pushing main (fast-forward only, never --force)')
  await $`git push origin main`.cwd(root)
}

console.log('-> deploy:prod')
await $`bun scripts/release/deploy-prod.ts`.cwd(root)
