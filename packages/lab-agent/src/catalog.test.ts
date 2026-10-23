import { describe, expect, test } from 'bun:test'
import { buildCatalogPrompt } from './catalog.ts'
import { verify } from './verifier.ts'

const FIX_FULL_DATASET_ID = '0x852bf32acfea20911aaa2572caf1fe3d759b94ff543593b6a9ee49673e29f828' // TRAIN
const FIX_NOBTC_DATASET_ID = '0xec3b3d809e7efe55c3a19ab6fe686103f4713aa5398d104032c59897e34f5af0' // TRAIN
const FIX_TEST_DATASET_ID = '0x6669782d746573742d686f6c646f75742d666978747572652d6f6e6c792d3030' // TEST split, fictional

// Same fixture lab-bench's own tests use (CI has no ~/.local/share/mamoru-lab/datasets — see spec.test.ts there):
// fix-full (TRAIN, all 3 pools), fix-nobtc (TRAIN, no cbBTC data), fix-test (TEST split).
const FIXTURE_DIR = `${import.meta.dir}/../../lab-bench/src/__fixtures__`

describe('buildCatalogPrompt (AL-14)', () => {
  test('lists every TRAIN window and never the TEST one (AL-12a, LAB-AL-16)', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    expect(catalog.windowIds.sort()).toEqual(['fix-full', 'fix-nobtc'])
    expect(catalog.windowIds).not.toContain('fix-test')
    expect(catalog.systemPrompt).toContain('fix-full')
    expect(catalog.systemPrompt).toContain('fix-nobtc')
    expect(catalog.systemPrompt).not.toContain('fix-test')
  })

  test('years carries every calendar year a TRAIN window touches — the fixture windows are all 2026-09', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    expect(catalog.years).toEqual([2026])
  })

  test('catalogIds carries the window ids, the TRAIN dataset ids, and both base policy ids (the untraceable-digit allowlist)', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    expect(catalog.catalogIds).toEqual(['fix-full', 'fix-nobtc', FIX_FULL_DATASET_ID, FIX_NOBTC_DATASET_ID, 'conservador-live-v2', 'conservador-lab-guards-v1'])
    // fix-nobtc's own dataset id is real too (it's still a TRAIN window, just unrunnable for any base) — the
    // point here is just: fix-test's (TEST split) is never in the list.
    expect(catalog.catalogIds).not.toContain(FIX_TEST_DATASET_ID)
  })

  test('review finding: a caveat naming a TRAIN dataset id passes verification; one naming the TEST dataset id fails', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    const ctx = { runStore: new Map(), catalogIds: catalog.catalogIds, catalogYears: catalog.years }

    const trainAnswer = { blocks: [{ type: 'caveat' as const, md: `El dataset ${FIX_FULL_DATASET_ID} ya tiene una corrida citable.` }] }
    expect(verify(trainAnswer, ctx).ok).toBe(true)

    const testAnswer = { blocks: [{ type: 'caveat' as const, md: `${FIX_TEST_DATASET_ID} es la retención del gate de release.` }] }
    const result = verify(testAnswer, ctx)
    expect(result.ok).toBe(false)
    expect(result.errors[0]?.kind).toBe('untraceable-digit')
  })

  test('names both bases with their policy id and the override knobs with bounds', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    expect(catalog.systemPrompt).toContain('conservador-live-v2')
    expect(catalog.systemPrompt).toContain('conservador-lab-guards-v1')
    expect(catalog.systemPrompt).toContain('widthTicks')
    expect(catalog.systemPrompt).toContain('500..8000')
    expect(catalog.systemPrompt).toContain('100..10000')
  })

  test('each window lists which bases and pools can actually run there (B-03 basesForWindow)', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    const fullLine = catalog.systemPrompt.split('\n').find((l) => l.includes('"fix-full"'))!
    expect(fullLine).toContain('bases: live, guard')
    expect(fullLine).toContain('pool:USDC/USDT/100')
    expect(fullLine).toContain('pool:USDC/cbBTC/500')
    expect(fullLine).toContain('pool:WETH/USDC/3000')
  })

  test('a window with no runnable base reads "no runs available" instead of a bare bases list (fix-nobtc)', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    const nobtcLine = catalog.systemPrompt.split('\n').find((l) => l.includes('"fix-nobtc"'))!
    expect(nobtcLine).toContain('no runs available')
    expect(nobtcLine).not.toContain('bases: live')
  })

  test('rules cover the answer contract, no-retry-after-tool-error, and the Monad/future caveat (AL-24, AL-70)', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    expect(catalog.systemPrompt).toContain('submit_answer')
    expect(catalog.systemPrompt.toLowerCase()).toContain('monad')
    expect(catalog.systemPrompt).toMatch(/4 rondas/)
  })

  test('is rebuilt fresh each call (no caching) and carries no list_* tool', () => {
    const a = buildCatalogPrompt(FIXTURE_DIR)
    const b = buildCatalogPrompt(FIXTURE_DIR)
    expect(a.systemPrompt).toBe(b.systemPrompt)
    expect(catalogMentionsListTool(a.systemPrompt)).toBe(false)
  })
})

function catalogMentionsListTool(prompt: string): boolean {
  return /\blist_\w+/.test(prompt)
}
