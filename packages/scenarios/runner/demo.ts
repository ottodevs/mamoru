import type { ScenarioResult } from '../report/index.ts'

export const DEMO_SCENARIOS = ['M01', 'M02', 'M03', 'M04'] as const

const TITLES: Record<(typeof DEMO_SCENARIOS)[number], string> = {
  M01: 'Observe an empty account',
  M02: 'Deposit and first allocation',
  M03: 'Swap through the session',
  M04: 'Harvest fees to USDC',
}

export type DemoHeader = { runId: string; forkBlock: number; chainId: number; reportPath: string }

/** Readable summary of the T003 scenarios: one block per scenario, its steps, then the invariants it held. */
export function formatDemo(header: DemoHeader, results: ScenarioResult[]): string {
  const lines = [`Mamoru engine lab · Base block ${header.forkBlock} forked on anvil, chain id ${header.chainId} · lab bundler on loopback`, '']
  for (const r of results) {
    const title = TITLES[r.id as keyof typeof TITLES] ?? r.id
    lines.push(`${r.id}  ${title}  ${r.status.toUpperCase()}  (${(r.durationMs / 1000).toFixed(1)} s)`)
    for (const s of r.steps) lines.push(`  ${s.ok ? '✓' : '✗'} ${s.step}${s.detail ? `: ${s.detail}` : ''}`)
    if (r.error) lines.push(`  ✗ ${r.error.split('\n')[0]}`)
    const inv = Object.entries(r.invariants)
    const held = inv.filter(([, v]) => v.ok).map(([k]) => k)
    const broken = inv.filter(([, v]) => !v.ok).map(([k, v]) => `${k} (${v.detail ?? 'broken'})`)
    if (held.length) lines.push(`  invariants held: ${held.join(', ')}`)
    if (broken.length) lines.push(`  invariants broken: ${broken.join(', ')}`)
    lines.push('')
  }
  const passed = results.filter((r) => r.status === 'pass').length
  lines.push(`${passed}/${results.length} pass · run ${header.runId}`, `report: ${header.reportPath}`)
  return lines.join('\n')
}
