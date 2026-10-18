import { OPS_FLAGS, type OpsFlagName } from '@mamoru/policy'
import type { Db } from './env.ts'

/**
 * Runtime flags set from /ops (mamoru-astro), D1-backed (migrations/d1/0012_ops_flags.sql). Append-only: a flag's
 * current value is its newest row; no row ever means off. Replaces the env-var gating the yield ledger used
 * before (otto/mamoru#129): see apps/mamoru-app/src/worker.ts and apps/mamoru-operator/src/boot.ts.
 */

type FlagRow = { flag: string; enabled: number }

const missingTable = (e: unknown) => /no such (table|column)/i.test(e instanceof Error ? e.message : String(e))

/** Every known flag, defaulted off; missing table (migration 0012 not applied yet) answers the same as no rows. */
export async function readOpsFlags(db: Db): Promise<Record<OpsFlagName, boolean>> {
  const out = Object.fromEntries(Object.keys(OPS_FLAGS).map((f) => [f, false])) as Record<OpsFlagName, boolean>
  let rows: FlagRow[]
  try {
    rows = (
      await db
        .prepare(`SELECT flag, enabled FROM ops_flag_changes WHERE id IN (SELECT MAX(id) FROM ops_flag_changes GROUP BY flag)`)
        .all<FlagRow>()
    ).results
  } catch (e) {
    if (missingTable(e)) return out
    throw e
  }
  for (const r of rows) if (r.flag in out) out[r.flag as OpsFlagName] = r.enabled === 1
  return out
}
