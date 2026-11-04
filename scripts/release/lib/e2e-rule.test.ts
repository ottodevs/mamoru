import { describe, expect, it } from 'bun:test'
import { $ } from 'bun'
import { allPassed, e2eReasons, e2eTable, waiverFor } from './e2e-rule.ts'

const diff = (file: string, ...lines: string[]) =>
  [`diff --git a/${file} b/${file}`, 'index 1..2 100644', `--- a/${file}`, `+++ b/${file}`, '@@ -1,2 +1,2 @@', ...lines].join('\n')

describe('e2eReasons', () => {
  it('any change to operator routes, auth, the signed app client or policy ids needs the table', () => {
    for (const f of [
      'apps/mamoru-operator/src/server.ts',
      'apps/mamoru-operator/src/one-auth.ts',
      'apps/mamoru-app/src/api/accounts/operator.ts',
      'packages/policy/src/policies.ts',
      'packages/policy/src/policies-monad.ts',
      'packages/registry/base.json',
    ])
      expect(e2eReasons(diff(f, '+const x = 1'))).toHaveLength(1)
  })
  it('elsewhere, only a changed line about finality, the signature or a policy id, in any case', () => {
    expect(e2eReasons(diff('apps/mamoru-operator/src/bridge-out.ts', "+  const fin = await l1.getBlock({ blockTag: 'finalized' })"))).toEqual([
      'apps/mamoru-operator/src/bridge-out.ts (changes a line with `blockTag`)',
    ])
    for (const l of ['-  policyId: old,', '+const POLICY_ID = 1', '+  await waitForFinality()', '+  confirmations: 3', "+  blockTag: 'safe'"])
      expect(e2eReasons(diff('apps/mamoru-operator/src/operator.ts', l))).toHaveLength(1)
    expect(e2eReasons(diff('apps/mamoru-operator/src/operator.ts', ' context with finalized', '+const y = 2'))).toEqual([])
  })
  it('tests, docs and the e2e themselves never need it; one reason per file', () => {
    expect(e2eReasons(diff('apps/mamoru-operator/test/e2e-fork.ts', '+x-mamoru-ts'))).toEqual([])
    expect(e2eReasons(diff('apps/mamoru-operator/src/rpc-proxy.test.ts', "+'finalized'"))).toEqual([])
    expect(e2eReasons(diff('packages/policy/src/policies-monad.test.ts', '+x'))).toEqual([])
    expect(e2eReasons(diff('docs/process/releasing.md', '+finalized'))).toEqual([])
    // The SPA's labels (4 Nov: #291 mix.ts reads a policyId, #293 transfer.ts names a finality stage) are not the operator's.
    expect(e2eReasons(diff('apps/mamoru-app/src/web/lib/mix.ts', '+  const id = acc.policyId'))).toEqual([])
    expect(e2eReasons(diff('apps/mamoru-app/src/web/lib/transfer.ts', "+  finality: 'standard'"))).toEqual([])
    // The app's signed operator client is still covered.
    expect(e2eReasons(diff('apps/mamoru-app/src/api/accounts/operator.ts', '+x'))).toHaveLength(1)
    expect(e2eReasons(diff('packages/scenarios/driver/engine.ts', '+policyId a', '+policyId b'))).toHaveLength(1)
  })
  it('reads several files from one diff', () => {
    const d = [diff('docs/a.md', '+x'), diff('apps/mamoru-operator/src/server.ts', '+y'), diff('packages/policy/src/policies.ts', '+z')].join('\n')
    expect(e2eReasons(d)).toHaveLength(2)
  })
  it('a diff it cannot read (noprefix, color) refuses instead of passing as empty', () => {
    expect(() => e2eReasons('diff --git apps/mamoru-operator/src/server.ts apps/mamoru-operator/src/server.ts\n+x')).toThrow('no `diff --git')
    expect(() => e2eReasons('\x1b[1mdiff --git a/x b/x\x1b[m\n+x')).toThrow()
    expect(e2eReasons('')).toEqual([])
  })
  // The four reviewed changes that broke the e2e (postmortem of 4 Nov). Needs their history: CI's shallow checkout
  // does not have it, every full clone does.
  for (const [sha, what] of [
    ['90a4817c', 'auth cutoff #140'],
    ['1471f799', 'v1 policy removal #251'],
    ['9bee0e4e', 'convert finality #285'],
    ['5e340239', 'convert finality #309'],
  ] as const) {
    const has = Bun.spawnSync(['git', 'cat-file', '-e', `${sha}^{commit}`]).exitCode === 0
    it.skipIf(!has)(`would have refused ${what} (${sha})`, async () => {
      const d = await $`git -c core.quotePath=false diff --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/ ${sha}~1 ${sha}`.text()
      expect(e2eReasons(d).length).toBeGreaterThan(0)
    })
  }
})

describe('e2eTable and allPassed', () => {
  it('reads the summary line e2e:all prints last, alone on its line; only all-green passes', () => {
    expect(e2eTable('## Tested\n```\nfork  PASS  41\n\n15/15 passed\n```')).toEqual({ passed: 15, total: 15 })
    expect(allPassed(e2eTable('15/15 passed'))).toBe(true)
    expect(allPassed(e2eTable('7/15 passed'))).toBe(false)
    expect(allPassed(e2eTable('0/0 passed'))).toBe(false)
    expect(e2eTable('ran e2e, 15/15 passed yesterday')).toBeUndefined()
    expect(allPassed(e2eTable(''))).toBe(false)
  })
})

describe('waiverFor', () => {
  it('waives only the pull request it names, with a reason', () => {
    expect(waiverFor('285', '285: monad-writes already fails on main')).toBe('monad-writes already fails on main')
    expect(waiverFor('285', '#285: x')).toBe('x')
    expect(waiverFor('286', '285: x')).toBeUndefined()
    expect(waiverFor('285', 'because')).toBeUndefined()
    expect(waiverFor('285', '285:')).toBeUndefined()
    expect(waiverFor('285', undefined)).toBeUndefined()
  })
})
