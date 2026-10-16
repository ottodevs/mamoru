import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addGuardPoint, emptyGuardSeries, type GuardSeries } from '@mamoru/rpc'
import { GuardHistoryStore } from '../src/guard-history-state.ts'

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-guard-history-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function series(...points: [number, bigint][]): GuardSeries {
  let s = emptyGuardSeries()
  for (const [time, tickCumulative] of points) s = addGuardPoint(s, { time, tickCumulative }, 1_800, 200_000)
  return s
}

describe('GuardHistoryStore', () => {
  test('a fresh state dir starts empty', () => {
    const store = new GuardHistoryStore(tmpDir())
    expect(store.snapshot().size).toBe(0)
  })

  test('restart: update + flush, then a new store over the same dir loads the same series back', () => {
    const dir = tmpDir()
    const a = new GuardHistoryStore(dir)
    const s = new Map([
      ['pool:USDC/cbBTC/500', series([0, 100n], [1_800, 101n], [3_600, 99n])],
      ['pool:WETH/USDC/3000', series([0, -50n])],
    ])
    a.update(s)
    a.flush()
    const b = new GuardHistoryStore(dir)
    expect([...b.snapshot().entries()]).toEqual([...s.entries()])
    // Bigints round-tripped exactly, not through a lossy number cast.
    expect(b.snapshot().get('pool:USDC/cbBTC/500')!.points[1]!.tickCumulative).toBe(101n)
  })

  test('update() throttles the actual write to once a minute; flush() bypasses the throttle', () => {
    const dir = tmpDir()
    const a = new GuardHistoryStore(dir)
    const file = join(dir, 'guard-history.json')
    a.update(new Map([['pool:USDC/USDT/100', series([0, 1n])]]), 0)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'pool:USDC/USDT/100': [{ time: 0, tickCumulative: '1' }] })
    // 30s later: within the throttle window, the file is not rewritten with the new value yet.
    a.update(new Map([['pool:USDC/USDT/100', series([0, 2n])]]), 30_000)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'pool:USDC/USDT/100': [{ time: 0, tickCumulative: '1' }] })
    // flush() bypasses it regardless of elapsed time.
    a.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ 'pool:USDC/USDT/100': [{ time: 0, tickCumulative: '2' }] })
  })

  test('a corrupted or hand-edited file is dropped, not trusted: the store starts empty rather than crash', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'guard-history.json'), '{not json')
    expect(new GuardHistoryStore(dir).snapshot().size).toBe(0)
    writeFileSync(join(dir, 'guard-history.json'), JSON.stringify({ 'pool:USDC/USDT/100': [{ time: 'not a number', tickCumulative: '1' }, { time: 0, tickCumulative: 'not an int' }] }))
    expect(new GuardHistoryStore(dir).snapshot().get('pool:USDC/USDT/100')).toEqual({ points: [] })
    writeFileSync(join(dir, 'guard-history.json'), JSON.stringify([1, 2, 3]))
    expect(new GuardHistoryStore(dir).snapshot().size).toBe(0)
  })
})
