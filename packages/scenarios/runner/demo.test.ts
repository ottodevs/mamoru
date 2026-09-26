import { describe, expect, test } from 'bun:test'
import type { ScenarioResult } from '../report/index.ts'
import { formatDemo } from './demo.ts'

const header = { runId: 'r1', forkBlock: 51811000, chainId: 31337, reportPath: 'scenarios/.artifacts/runs/r1/report.json' }

function result(over: Partial<ScenarioResult>): ScenarioResult {
  return { id: 'M01', file: 'M01.yaml', requirements: [], status: 'pass', steps: [], invariants: {}, codes: [], durationMs: 1500, ...over }
}

describe('formatDemo', () => {
  test('one block per scenario with steps and held invariants', () => {
    const out = formatDemo(header, [
      result({ steps: [{ step: 'review: decision', ok: true, detail: 'DECIDE_HOLD/DECIDE_NO_CAPITAL' }], invariants: { 'INV-SLOT': { ok: true } } }),
    ])
    expect(out).toContain('M01  Observe an empty account  PASS  (1.5 s)')
    expect(out).toContain('  ✓ review: decision: DECIDE_HOLD/DECIDE_NO_CAPITAL')
    expect(out).toContain('  invariants held: INV-SLOT')
    expect(out).toContain('1/1 pass · run r1')
  })

  test('failed steps, errors and broken invariants are shown, not hidden', () => {
    const out = formatDemo(header, [
      result({
        id: 'M04',
        status: 'fail',
        steps: [{ step: 'Savings Log harvest row', ok: false, detail: 'no row' }],
        invariants: { 'INV-ETH-GAS': { ok: false, detail: 'op-3 moved 5' } },
        error: 'boom\nstack',
      }),
    ])
    expect(out).toContain('M04  Harvest fees to USDC  FAIL')
    expect(out).toContain('  ✗ Savings Log harvest row: no row')
    expect(out).toContain('  ✗ boom')
    expect(out).not.toContain('stack')
    expect(out).toContain('invariants broken: INV-ETH-GAS (op-3 moved 5)')
    expect(out).toContain('0/1 pass')
  })
})
