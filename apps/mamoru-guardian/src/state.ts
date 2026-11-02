// otto/mamoru#293: all guardian state in one 0600 JSON file (atomic rewrite). Numbers that may exceed 2^53 are strings.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Address, Hex } from 'viem'

export type Registration = { account: Address; domain: number; remote: Address; ownersHash: Hex; sessionKey: Address }
export type WatchedSafe = { chainId: number; address: Address; next: string }
/** #310: a V4 sibling (Init home == account) on this guardian's chain, and its home domain. */
export type Sibling = {
  account: Address
  domain: number
  /** Unix ms of the last setReady this guardian sent for it (review r1: never re-sent while it may still land). */
  sentAt?: number
  /** Unix ms of the last read-back of a ready sibling (re-checked every realert window; a change is alerted). */
  checkedAt?: number
}
export type State = {
  v: 1
  /** Next block to scan, by stream key (`reg`, `queued:<chainId>`). */
  cursors: Record<string, string>
  /** The latest registration of each (account, domain) that is not ready yet. */
  registrations: Record<string, Registration>
  /** Remote Safes whose ExecutionSuccess logs are scanned, each with its own cursor. */
  safes: Record<string, WatchedSafe>
  /** #310: V4 siblings seen on this chain (PolicySet with home == account); kept, and re-checked whenever not ready. */
  siblings: Record<string, Sibling>
  /** Alert dedup: key -> unix ms of the last delivery. */
  alerted: Record<string, number>
}

export const emptyState = (): State => ({ v: 1, cursors: {}, registrations: {}, safes: {}, siblings: {}, alerted: {} })

export class StateStore {
  state: State
  readonly file: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'state.json')
    if (existsSync(this.file)) {
      if ((statSync(this.file).mode & 0o077) !== 0) throw new Error('guardian state file must be 0600')
      const s = JSON.parse(readFileSync(this.file, 'utf8')) as State
      if (s.v !== 1) throw new Error('guardian state file: unknown version')
      s.siblings ??= {} // a state file from before #310
      this.state = s
    } else {
      this.state = emptyState()
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }

  cursor(key: string): bigint | undefined {
    const c = this.state.cursors[key]
    return c === undefined ? undefined : BigInt(c)
  }
  setCursor(key: string, next: bigint): void {
    this.state.cursors[key] = next.toString()
  }

  /** True when `key` was already delivered (within `ttlMs` when given). */
  seen(key: string, now: number, ttlMs?: number): boolean {
    const at = this.state.alerted[key]
    if (at === undefined) return false
    return ttlMs === undefined ? true : now - at < ttlMs
  }
  markAlerted(key: string, now: number): void {
    this.state.alerted[key] = now
  }
}
