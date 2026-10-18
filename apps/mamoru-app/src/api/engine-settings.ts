import { Hono } from 'hono'
import { settingsResponseSignature, verifyMetricsSignature } from '@mamoru/operator-auth'
import { validateEngineSettings, type EngineSettings, type OpsFlagName } from '@mamoru/policy'
import type { AppEnv } from './context.ts'
import type { Db } from './env.ts'
import { readOpsFlags } from './ops-flags.ts'

/**
 * Spec 006 (otto/mamoru#147): the operator pulls the active engine settings from here. Read-only: versions are
 * written by /ops (mamoru-astro). The request is signed by the operator (operator-level scheme of
 * @mamoru/operator-auth, method + path + minute); the response body is signed back, so the operator runs only what
 * a holder of OPERATOR_SECRET produced.
 */
export const ENGINE_SETTINGS_PATH = '/api/internal/engine-settings'

export type SettingsVersionView = {
  id: number
  env: 'prod' | 'beta'
  /** null: every account of the environment; else a canary, only these accounts. */
  accountKeys: string[] | null
  template: string
  settings: EngineSettings
  hash: string
  createdAt: string
}

export type EngineSettingsPayload = {
  /** Per environment: the newest environment-wide version, and the newest canary newer than it (one at most). */
  versions: SettingsVersionView[]
  /** Accounts the operator must treat as beta (accounts.env, #130). Every other account is prod. */
  betaAccounts: string[]
  /** otto/mamoru#129: runtime flags set from /ops, D1-backed (readOpsFlags). Older operators that do not parse this
   * field yet simply ignore it; it is additive, never required to make sense of `versions`. */
  flags: Record<OpsFlagName, boolean>
  servedAt: string
}

type VersionRow = { id: number; env: 'prod' | 'beta'; account_keys_json: string | null; template: string; settings_json: string; settings_hash: string; created_at: string }

const missingTable = (e: unknown) => /no such (table|column)/i.test(e instanceof Error ? e.message : String(e))

/** The versions the operator needs, or null when the settings tables do not exist yet (migration 0011 not applied). */
export async function activeVersions(db: Db): Promise<SettingsVersionView[] | null> {
  let rows: VersionRow[]
  try {
    rows = (
      await db
        .prepare(
          `SELECT id, env, account_keys_json, template, settings_json, settings_hash, created_at FROM engine_settings_versions ORDER BY id`,
        )
        .all<VersionRow>()
    ).results
  } catch (e) {
    if (missingTable(e)) return null
    throw e
  }
  const valid: SettingsVersionView[] = []
  for (const r of rows) {
    let settings: unknown
    let accountKeys: unknown = null
    try {
      settings = JSON.parse(r.settings_json)
      accountKeys = r.account_keys_json === null ? null : JSON.parse(r.account_keys_json)
    } catch {
      continue
    }
    // A row the code would refuse is never handed out; the operator validates again regardless.
    if (validateEngineSettings(settings).length) continue
    if (accountKeys !== null && !(Array.isArray(accountKeys) && accountKeys.every((k) => typeof k === 'string'))) continue
    valid.push({ id: r.id, env: r.env, accountKeys: accountKeys as string[] | null, template: r.template, settings: settings as EngineSettings, hash: r.settings_hash, createdAt: r.created_at })
  }
  // Per environment: the newest valid environment-wide version, and the newest canary if it is newer than that. One
  // canary at most is live per environment: writing a new one retires the previous one for every account.
  const out: SettingsVersionView[] = []
  for (const env of ['prod', 'beta'] as const) {
    const rowsOf = valid.filter((v) => v.env === env)
    const wide = rowsOf.filter((v) => v.accountKeys === null).at(-1)
    const canary = rowsOf.filter((v) => v.accountKeys !== null && (!wide || v.id > wide.id)).at(-1)
    if (wide) out.push(wide)
    if (canary) out.push(canary)
  }
  return out.sort((a, b) => a.id - b.id)
}

async function betaAccounts(db: Db): Promise<string[]> {
  try {
    const { results } = await db.prepare(`SELECT account_key FROM accounts WHERE env = 'beta' ORDER BY account_key`).all<{ account_key: string }>()
    return results.map((r) => r.account_key)
  } catch (e) {
    if (missingTable(e)) return []
    throw e
  }
}

export function engineSettingsRoutes(now: () => Date) {
  const app = new Hono<AppEnv>()
  app.get(ENGINE_SETTINGS_PATH, async (c) => {
    const secret = c.env.OPERATOR_SECRET
    if (!secret) return c.json({ error: 'not configured' }, 404)
    const at = now().getTime()
    if (!(await verifyMetricsSignature(secret, 'GET', ENGINE_SETTINGS_PATH, c.req.header('x-mamoru-sig'), at))) return c.json({ error: 'unauthorized' }, 401)
    const versions = await activeVersions(c.env.DB)
    if (versions === null) return c.json({ error: 'engine settings are not set up' }, 404)
    const payload: EngineSettingsPayload = { versions, betaAccounts: await betaAccounts(c.env.DB), flags: await readOpsFlags(c.env.DB), servedAt: new Date(at).toISOString() }
    const body = JSON.stringify(payload)
    const sig = await settingsResponseSignature(secret, body, Math.floor(at / 60_000))
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-mamoru-sig': sig } })
  })
  return app
}
