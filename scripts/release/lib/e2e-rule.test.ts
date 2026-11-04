import { describe, expect, it } from 'bun:test'
import { e2eReasons, hasE2eTable } from './e2e-rule.ts'

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
  it('elsewhere, only a changed line about finality, the signature or a policy id', () => {
    // The convert finality change (#285) was a line like this in bridge-out.ts.
    expect(e2eReasons(diff('apps/mamoru-operator/src/bridge-out.ts', "+  const fin = await l1.getBlock({ blockTag: 'finalized' })"))).toEqual([
      'apps/mamoru-operator/src/bridge-out.ts (changes a line with `finalized`)',
    ])
    expect(e2eReasons(diff('apps/mamoru-operator/src/operator.ts', '-  policyId: old,'))).toHaveLength(1)
    expect(e2eReasons(diff('apps/mamoru-operator/src/operator.ts', ' context with finalized', '+const y = 2'))).toEqual([])
  })
  it('tests, docs and the e2e themselves never need it; one reason per file', () => {
    expect(e2eReasons(diff('apps/mamoru-operator/test/e2e-fork.ts', '+x-mamoru-ts'))).toEqual([])
    expect(e2eReasons(diff('apps/mamoru-operator/src/rpc-proxy.test.ts', "+'finalized'"))).toEqual([])
    expect(e2eReasons(diff('docs/process/releasing.md', '+finalized'))).toEqual([])
    expect(e2eReasons(diff('packages/scenarios/driver/engine.ts', '+policyId a', '+policyId b'))).toHaveLength(1)
  })
  it('reads several files from one diff', () => {
    const d = [diff('docs/a.md', '+x'), diff('apps/mamoru-operator/src/server.ts', '+y'), diff('packages/policy/src/policies.ts', '+z')].join('\n')
    expect(e2eReasons(d)).toHaveLength(2)
  })
})

describe('hasE2eTable', () => {
  it('finds the summary line e2e:all prints last, alone on its line', () => {
    expect(hasE2eTable('## Tested\n```\nfork  PASS  41\n\n15/15 passed\n```')).toBe(true)
    expect(hasE2eTable('7/15 passed')).toBe(true)
    expect(hasE2eTable('ran e2e, 15/15 passed yesterday')).toBe(false)
    expect(hasE2eTable('')).toBe(false)
  })
})
