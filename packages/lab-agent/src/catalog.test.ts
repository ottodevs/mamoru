import { describe, expect, test } from 'bun:test'
import { buildCatalogPrompt } from './catalog.ts'

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

  test('catalogIds carries the window ids and both base policy ids (the untraceable-digit allowlist)', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    expect(catalog.catalogIds).toEqual(['fix-full', 'fix-nobtc', 'conservador-live-v2', 'conservador-lab-guards-v1'])
  })

  test('names both bases with their policy id and the override knobs with bounds', () => {
    const catalog = buildCatalogPrompt(FIXTURE_DIR)
    expect(catalog.systemPrompt).toContain('conservador-live-v2')
    expect(catalog.systemPrompt).toContain('conservador-lab-guards-v1')
    expect(catalog.systemPrompt).toContain('widthTicks')
    expect(catalog.systemPrompt).toContain('500..8000')
    expect(catalog.systemPrompt).toContain('100..10000')
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
