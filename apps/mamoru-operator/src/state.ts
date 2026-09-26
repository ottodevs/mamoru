import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountContext, Hex, OpView } from '@mamoru/domain'
import type { SessionGrant } from '@mamoru/policy'

/** A grant the owner enabled on chain (enter-swap, enter-mint). */
export type StoredGrant = { name: string; grant: SessionGrant; permissionId: Hex }

export type AccountState = {
  accountKey: string
  ctx: AccountContext
  /** Registry trust calls already ran on this Safe (first activation). */
  trusted: boolean
  active: boolean
  /** Engine session key. Private, 0600 state file only, never logged. */
  sessionKey?: Hex
  grants: StoredGrant[]
  revoked: Hex[]
  managedTokenIds: string[]
  depositsAfter: string
  historyFromBlock: string
  /** Bumped at each activation so engine op ids stay unique across runs. */
  epoch: number
  ops: OpView[]
  seq: number
}

export type OperatorState = { accounts: Record<string, AccountState> }

const BIG = '$big'

function replacer(_k: string, v: unknown): unknown {
  return typeof v === 'bigint' ? { [BIG]: v.toString() } : v
}

function reviver(_k: string, v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>
    if (typeof o[BIG] === 'string' && Object.keys(o).length === 1) return BigInt(o[BIG] as string)
  }
  return v
}

export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
}

/** JSON state in one 0600 file, written atomically (tmp + rename). */
export class StateStore {
  readonly file: string
  state: OperatorState

  constructor(readonly dir: string) {
    ensureDir(dir)
    this.file = join(dir, 'accounts.json')
    this.state = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8'), reviver) as OperatorState) : { accounts: {} }
  }

  save(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state, replacer, 1), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, this.file)
  }
}

/** Reads a 0x private key from `file`, or creates one there (0600). The key is never printed. */
export function loadOrCreateKey(file: string, generate: () => Hex): Hex {
  if (existsSync(file)) {
    const k = readFileSync(file, 'utf8').trim()
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${file} does not hold a 0x private key`)
    return k as Hex
  }
  const k = generate()
  writeFileSync(file, `${k}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return k
}
