#!/usr/bin/env bun
// `bun run promote [sha]` — fast-forward main to a specific, verified SHA (only ff, never force),
// then deploy:prod. Defaults to origin/beta's current tip; pass a SHA explicitly to pin against a
// race where origin/beta moves between inspection and promotion. Requires a clean local tree with
// local main already matching origin/main (no local drift) before touching anything, and pushes
// exactly the verified SHA, never whatever the local `main` branch happens to hold.
import { $ } from 'bun'
import { currentBranch, currentSha, fetchRefs, isAncestor, isClean, revParse } from './lib/git.ts'

const root = new URL('../../', import.meta.url).pathname
const requestedSha = process.argv[2]

console.log('== promote: fast-forward main to a verified SHA ==')

if (!(await isClean(root))) {
  console.error('refusing: working tree is not clean.')
  process.exit(1)
}

const branch = await currentBranch(root)
if (branch !== 'main') {
  console.error(`refusing: checkout 'main' before promoting (currently on '${branch}').`)
  process.exit(1)
}

await fetchRefs(root, 'main')

const localMain = await currentSha(root)
const originMain = await revParse(root, 'origin/main')
if (localMain !== originMain) {
  console.error(`refusing: local main (${localMain.slice(0, 7)}) != origin/main (${originMain.slice(0, 7)}). Local main holds commits origin/main does not (or is behind it). Pull or reset first.`)
  process.exit(1)
}

// Fetched separately from `main`: a nonexistent `beta` must not be a crash, and must not stop the
// main-side checks above from running (and reporting first) when both are wrong.
let originBeta: string
try {
  await fetchRefs(root, 'beta')
  originBeta = await revParse(root, 'origin/beta')
} catch {
  console.error('refusing: origin/beta does not exist.')
  process.exit(1)
}

let targetSha: string
try {
  // Resolved through git so an abbreviated sha, if given, normalizes to the same full sha as
  // originBeta before the strict comparison below.
  targetSha = requestedSha ? await revParse(root, requestedSha) : originBeta
} catch {
  console.error(`refusing: '${requestedSha}' does not resolve to a commit.`)
  process.exit(1)
}
if (targetSha !== originBeta) {
  console.error(`refusing: requested SHA ${targetSha.slice(0, 7)} does not match origin/beta's current tip ${originBeta.slice(0, 7)}.`)
  console.error('origin/beta moved. Re-run promote with no argument (or with the confirmed new tip).')
  process.exit(1)
}

if (targetSha === originMain) {
  console.log('origin/main already matches the target SHA, nothing to fast-forward.')
} else {
  if (!(await isAncestor(root, originMain, targetSha))) {
    console.error(`refusing: origin/main is not an ancestor of ${targetSha.slice(0, 7)}, this is not a fast-forward. Rebase or merge beta onto main first.`)
    process.exit(1)
  }
  console.log(`-> pushing ${targetSha.slice(0, 7)} to origin main (fast-forward only, never --force)`)
  // A plain (non +prefixed) refspec push is fast-forward-only by git itself; this is a second,
  // server-enforced guard on top of the isAncestor check above.
  await $`git push origin ${targetSha}:refs/heads/main`.cwd(root)
  try {
    await $`git fetch origin main`.cwd(root).quiet()
    await $`git merge --ff-only origin/main`.cwd(root).quiet()
  } catch {
    console.error('warning: could not fast-forward the local main checkout to match (non-fatal, origin/main is already correct).')
  }
}

console.log('-> deploy:prod')
await $`bun scripts/release/deploy-prod.ts`.cwd(root)
