import { describe, expect, test } from 'bun:test'
import type { ScenarioTape, TapeFrame } from '@mamoru/domain'
import { bandRuns } from '../../src/web/lab/chart.tsx'
import devTape from '../../src/web/lab/__fixtures__/dev-tape.json'
import { LabBody } from '../../src/web/lab/lab.tsx'
import { currentKey, fmt, fmtDec, harvestMath, keyIndices, loadTapes, nextKey, prevKey, priceDomain, scaleX, scaleY, stepDelay } from '../../src/web/lab/tape.ts'
import { count, render } from './render.ts'

const tape = devTape as ScenarioTape
const frames = tape.frames

function frame(over: Partial<TapeFrame> = {}): TapeFrame {
  return { ...frames[1]!, ...over }
}

describe('lab tape helpers', () => {
  test('keyframe navigation', () => {
    expect(keyIndices(frames)).toEqual([0, 5, 9, 11])
    expect(nextKey(frames, 0)).toBe(5)
    expect(nextKey(frames, 5)).toBe(9)
    expect(nextKey(frames, 11)).toBe(11)
    expect(prevKey(frames, 9)).toBe(5)
    expect(prevKey(frames, 6)).toBe(5)
    expect(prevKey(frames, 0)).toBe(0)
    expect(currentKey(frames, 7)?.title).toBe('Fees below cost')
  })
  test('scaling', () => {
    expect(scaleY(10, [0, 10], 0, 100)).toBe(0)
    expect(scaleY(0, [0, 10], 0, 100)).toBe(100)
    expect(scaleY(5, [5, 5], 0, 100)).toBe(50)
    expect(scaleX(0, 3, 0, 100)).toBe(0)
    expect(scaleX(2, 3, 0, 100)).toBe(100)
    expect(scaleX(0, 1, 0, 100)).toBe(50)
    const [lo, hi] = priceDomain(frames)
    expect(lo).toBeLessThan(2985)
    expect(hi).toBeGreaterThan(3036.4)
  })
  test('harvest sign comes from the numbers', () => {
    const cost = { baseFeeGwei: '0.01', opCost: '0.02', threshold: '0.1', factorBps: 50_000 }
    const pos = frames[1]!.position!
    expect(harvestMath(frame({ cost, position: { ...pos, feesValue: '0.2' } }))?.sign).toBe('>')
    expect(harvestMath(frame({ cost, position: { ...pos, feesValue: '0.05' } }))?.sign).toBe('<')
    expect(harvestMath(frame({ cost: { ...cost, opCost: '0.5', factorBps: 10_000 }, position: { ...pos, feesValue: '0.5' } }))?.sign).toBe('=')
    expect(harvestMath(frame({ cost, position: null }))).toBeNull()
    expect(harvestMath(frame({ cost, position: { ...pos, feesValue: 'n/a' } }))).toBeNull()
    expect(harvestMath(frame({ cost }))?.factor).toBe(5)
  })
  test('formatting and speed', () => {
    expect(fmt(1234.5)).toBe('1,234.50')
    expect(fmt(0.012345)).toBe('0.01235')
    expect(fmtDec('bad')).toBe('—')
    expect(stepDelay(1)).toBe(700)
    expect(stepDelay(4)).toBe(175)
  })
  test('band breaks where no position is held', () => {
    const f = [frame(), frame({ position: null }), frame(), frame()]
    expect(bandRuns(f)).toEqual([[0], [2, 3]])
  })
  test('loadTapes reads glob modules, skips junk, keeps catalog order', () => {
    const shock = { ...tape, id: 'TAPE-POOL-SHOCK', title: 'Shock' }
    const got = loadTapes({ './tapes/b.json': { default: shock }, './tapes/a.json': { default: tape }, './tapes/x.json': { default: { id: 'x' } } })
    expect(got.map((t) => t.id)).toEqual(['TAPE-HARVEST', 'TAPE-POOL-SHOCK'])
    expect(loadTapes({})).toEqual([])
  })
})

describe('lab page', () => {
  test('empty state without tapes', () => {
    const { text } = render(<LabBody tapes={[]} />)
    expect(text).toContain('No recorded scenarios')
  })
  test('first frame paints fork chip, summary, chart and decision', () => {
    const { html, text: raw } = render(<LabBody tapes={[tape]} />)
    const text = raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    expect(text).toContain('Base fork @ 36000000 · not your funds')
    expect(text).toContain('USDC / WETH 0.05%')
    expect(text).toContain('In range')
    expect(text).toContain('DECIDE_ENTER')
    expect(text).toContain('fees 0 < cost 0.021 × 5 = 0.105 USDC')
    expect(text).toContain('Mint position · 0xaaaa…a3e8')
    expect(count(html, 'data-testid="lab-tick"')).toBe(4)
    expect(count(html, 'data-testid="lab-band"')).toBe(1)
    expect(text).toContain('purga · GO')
  })
})
