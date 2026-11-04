// merge-pr.sh: refuses a pull request that changes operator auth, policy ids, finality or a public route unless its
// body carries an all-green e2e:all table (lib/e2e-rule.ts). MAMORU_E2E_WAIVED="<pr>: <why>" merges that pull request
// anyway; the reason is posted on it first, and a failed post refuses.
// Usage: bun scripts/release/e2e-rule.ts <pr-number> <diff-file>
import { readFileSync } from 'node:fs'
import { allPassed, e2eReasons, e2eTable, waiverFor } from './lib/e2e-rule.ts'

const [pr, diffFile] = process.argv.slice(2)
if (!pr || !diffFile) throw new Error('usage: e2e-rule.ts <pr-number> <diff-file>')
const reasons = e2eReasons(readFileSync(diffFile, 'utf8'))
if (reasons.length === 0) process.exit(0)
const view = Bun.spawnSync(['gh', 'pr', 'view', pr, '-R', 'ottodevs/mamoru', '--json', 'body', '-q', '.body'])
if (view.exitCode !== 0) {
  console.error(`refusing: cannot read the body of PR #${pr} (gh exit ${view.exitCode})`)
  process.exit(1)
}
const table = e2eTable(view.stdout.toString())
if (allPassed(table)) {
  console.log(`e2e rule: PR #${pr} carries the e2e:all table (${table!.passed}/${table!.total} passed)`)
  process.exit(0)
}
const waived = waiverFor(pr, process.env.MAMORU_E2E_WAIVED)
if (waived) {
  const shown = table ? `the e2e:all table shows ${table.passed}/${table.total} passed` : 'no e2e:all table'
  const body = `Merging with ${shown} (e2e rule, otto/mamoru#366), waived: ${waived}`
  const post = Bun.spawnSync(['gh', 'pr', 'comment', pr, '-R', 'ottodevs/mamoru', '--body', body])
  if (post.exitCode !== 0) {
    console.error(`refusing: the waiver could not be posted on PR #${pr} (gh exit ${post.exitCode}); nothing merges without its record`)
    process.exit(1)
  }
  console.log(`e2e rule: waived for PR #${pr}: ${waived}`)
  process.exit(0)
}
console.error(table
  ? `refusing: PR #${pr} changes what the e2e cover and its e2e:all table shows ${table.passed}/${table.total} passed:`
  : `refusing: PR #${pr} changes what the e2e cover and its body has no e2e:all table:`)
for (const r of reasons) console.error(`  ${r}`)
console.error('run `cd apps/mamoru-operator && bun run e2e:all` on the branch and paste the table (down to "N/M passed") in the PR;')
console.error(`a script that already fails on main: MAMORU_E2E_WAIVED="${pr}: <which, and why>" (posted on the PR)`)
process.exit(1)
