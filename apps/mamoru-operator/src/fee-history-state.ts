import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FeeGrowthHistory, FeePoint } from '@mamoru/rpc'
import type { RegistryName } from '@mamoru/registry'

type Persisted = Record<string, { time: number; growth0X128: string; growth1X128: string }[]>

const U = /^\d+$/

/**
 * otto/mamoru#172: the lazy re-range's fee history (`SharedGuardReads.fees`), kept across operator restarts in
 * `stateDir/fee-history.json` (0600, tmp + rename), written by the operator process only, at most once a minute.
 * Without it every restart would leave lazy accounts holding (DECIDE_RANGE_NO_FEE_HISTORY) for 12 h. Malformed
 * entries are dropped, never trusted; points are sorted and deduplicated by time. A gap while the operator was down
 * is harmless: fee growth globals only grow, so the difference to the oldest point of the last 24 h is still right.
 */
export class FeeHistoryState {
  private readonly file: string
  private lastPersistAt = -Infinity

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, 'fee-history.json')
  }

  load(): FeeGrowthHistory {
    const out: FeeGrowthHistory = new Map()
    if (!existsSync(this.file)) return out
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return out
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
    for (const [name, points] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(points)) continue
      const valid: FeePoint[] = []
      for (const p of points as Record<string, unknown>[]) {
        if (!p || typeof p !== 'object' || typeof p.time !== 'number' || !Number.isInteger(p.time) || typeof p.growth0X128 !== 'string' || typeof p.growth1X128 !== 'string' || !U.test(p.growth0X128) || !U.test(p.growth1X128)) continue
        valid.push({ time: p.time, growth0X128: BigInt(p.growth0X128), growth1X128: BigInt(p.growth1X128) })
      }
      valid.sort((a, b) => a.time - b.time)
      out.set(name as RegistryName, valid.filter((p, i) => i === valid.length - 1 || p.time !== valid[i + 1]!.time))
    }
    return out
  }

  /** Persists, throttled to once a minute; `now` is injectable for tests. */
  update(fees: FeeGrowthHistory, now: number = Date.now()): void {
    if (now - this.lastPersistAt < 60_000) return
    this.lastPersistAt = now
    const out: Persisted = Object.create(null) as Persisted
    for (const [name, points] of fees) out[name] = points.map((p) => ({ time: p.time, growth0X128: p.growth0X128.toString(), growth1X128: p.growth1X128.toString() }))
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch (e) {
      console.error(`[fee-history] failed to persist ${this.file}: ${(e as Error)?.message?.split('\n')[0] ?? e}`)
    }
  }
}
