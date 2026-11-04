// merge-pr.sh: refuses a pull request that changes operator auth, policy ids, finality or a public route unless its
// body carries the e2e:all table (lib/e2e-rule.ts). MAMORU_E2E_WAIVED="<reason>" merges anyway and says so on the PR.
// Usage: bun scripts/release/e2e-rule.ts <pr-number> <diff-file>
import { readFileSync } from 'node:fs'
import { e2eReasons, hasE2eTable } from './lib/e2e-rule.ts'

const [pr, diffFile] = process.argv.slice(2)
if (!pr || !diffFile) throw new Error('usage: e2e-rule.ts <pr-number> <diff-file>')
const reasons = e2eReasons(readFileSync(diffFile, 'utf8'))
if (reasons.length === 0) process.exit(0)
const body = Bun.spawnSync(['gh', 'pr', 'view', pr, '-R', 'ottodevs/mamoru', '--json', 'body', '-q', '.body']).stdout.toString()
if (hasE2eTable(body)) {
  console.log(`e2e rule: PR #${pr} carries the e2e:all table`)
  process.exit(0)
}
const waived = process.env.MAMORU_E2E_WAIVED?.trim()
if (waived) {
  console.log(`e2e rule: waived for PR #${pr}: ${waived}`)
  Bun.spawnSync(['gh', 'pr', 'comment', pr, '-R', 'ottodevs/mamoru', '--body', `Merged without the e2e:all table (e2e rule, #366): ${waived}`])
  process.exit(0)
}
console.error(`refusing: PR #${pr} changes what the e2e cover and its body has no e2e:all table:`)
for (const r of reasons) console.error(`  ${r}`)
console.error('run `cd apps/mamoru-operator && bun run e2e:all` on the branch and paste the table (down to "N/M passed") in the PR,')
console.error('or set MAMORU_E2E_WAIVED="<why>" to merge without it (the reason is posted on the PR)')
process.exit(1)
