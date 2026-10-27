import { OPS_FLAGS, type OpsFlagName } from '@mamoru/policy'
import type { Db } from './env.ts'

/**
 * Runtime flags set from /ops (mamoru-astro), D1-backed (migrations/d1/0012_ops_flags.sql). Append-only: a flag's
 * current value is its newest row; no row ever means off. Replaces the env-var gating the yield ledger used
 * before (otto/mamoru#129): see apps/mamoru-app/src/worker.ts and apps/mamoru-operator/src/boot.ts.
 */

type FlagRow = { flag: string; enabled: number; accounts?: string | null }

const missingTable = (e: unknown) => /no such (table|column)/i.test(e instanceof Error ? e.message : String(e))

/** otto/mamoru#217: the flags that honor an account scope. Every other flag ignores the `accounts` column. */
export const SCOPABLE_FLAGS: readonly OpsFlagName[] = ['multichain_v6']

/** Column value meaning "everyone", explicit. NULL means "carry the previous row's scope" (see effectiveScope). */
export const SCOPE_EVERYONE = '*'

/** Scope of an enabled scopable flag: null = everyone, a list = only those accounts (empty = nobody). */
export type FlagScope = string[] | null

export type OpsFlagState = {
  /** Booleans. A scoped flag reads FALSE here, so an operator that predates scopes sees it off (fail closed). */
  flags: Record<OpsFlagName, boolean>
  /** Enabled scopable flags only: null = everyone (explicit), list = only those accounts. Absent = not offered. */
  scopedFlags: Partial<Record<OpsFlagName, FlagScope>>
}

const allOff = (): OpsFlagState => ({ flags: Object.fromEntries(Object.keys(OPS_FLAGS).map((f) => [f, false])) as Record<OpsFlagName, boolean>, scopedFlags: {} })

/**
 * Every known flag, defaulted off; missing table (migration 0012 not applied yet) answers the same as no rows.
 * Missing `accounts` column (XXXX_ops_flag_accounts.sql not applied yet): no scopes, flags read as before, never an error.
 *
 * Scope of a scopable flag (otto/mamoru#217), from its rows in id order: the newest row's `accounts` when set (`*` =
 * everyone, else a list); when NULL it INHERITS the previous non-NULL scope, so an /ops flip (which writes NULL)
 * never silently widens a scoped flag. No scope ever set: everyone.
 */
export async function readOpsFlagState(db: Db): Promise<OpsFlagState> {
  const out = allOff()
  let rows: FlagRow[]
  try {
    rows = (await db.prepare(`SELECT flag, enabled, accounts FROM ops_flag_changes ORDER BY id`).all<FlagRow>()).results
  } catch (e) {
    if (!missingTable(e)) throw e
    try {
      rows = (await db.prepare(`SELECT flag, enabled FROM ops_flag_changes ORDER BY id`).all<FlagRow>()).results
    } catch (e2) {
      if (missingTable(e2)) return out
      throw e2
    }
  }
  const latest = new Map<string, FlagRow>()
  const scope = new Map<string, FlagScope>()
  for (const r of rows) {
    if (!(r.flag in OPS_FLAGS)) continue
    latest.set(r.flag, r)
    if (r.accounts !== null && r.accounts !== undefined) scope.set(r.flag, r.accounts.trim() === SCOPE_EVERYONE ? null : parseScope(r.accounts))
  }
  for (const [flag, r] of latest) {
    const on = r.enabled === 1
    const name = flag as OpsFlagName
    if (!SCOPABLE_FLAGS.includes(name)) {
      out.flags[name] = on
      continue
    }
    if (!on) continue
    const s = scope.get(flag) ?? null
    out.flags[name] = s === null
    out.scopedFlags[name] = s
  }
  return out
}

export async function readOpsFlags(db: Db): Promise<Record<OpsFlagName, boolean>> {
  return (await readOpsFlagState(db)).flags
}

export function parseScope(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const t = raw.trim()
  if (t.startsWith('{')) return []
  let items: unknown[]
  if (t.startsWith('[')) {
    try {
      const j: unknown = JSON.parse(t)
      if (!Array.isArray(j)) return []
      items = j
    } catch {
      return []
    }
    if (!items.every((x) => typeof x === 'string')) return []
  } else items = t.split(',')
  return (items as string[]).map((x) => x.trim().toLowerCase()).filter(Boolean)
}
