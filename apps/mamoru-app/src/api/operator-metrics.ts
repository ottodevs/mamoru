// Operator GET /metrics pulled into D1 for the /ops console (separate repo), otto/mamoru#129 follow-up. The
// operator has no D1 binding (specs/003-snapshot-loop/spec.md, same reason yield-ledger.ts pulls GET /snapshot
// instead of writing D1 itself), so this Worker pulls GET /metrics through the same signed path and upserts
// operator_metrics_latest (migrations/d1/0013_operator_metrics.sql). Unlike runYieldLedger's /snapshot pull,
// this one is NOT behind the yield_ledger ops flag: /metrics costs the operator nothing beyond its own cached
// relayer balance read, so it is cheap enough to pull every tick regardless of what the flag says.
import { metricsSignature } from '@mamoru/operator-auth'
import type { Db } from './env.ts'
import type { OperatorFetch } from './yield-ledger.ts'

export const METRICS_TIMEOUT_MS = 30_000

/** apps/mamoru-operator/src/metrics.ts EngineHealthSnapshot, as GET /metrics `engines` serves it. */
export type EngineHealthWire = {
  account: string
  lastReviewAt: string | null
  lastDecisionCode: string | null
  consecutiveErrors: number
  lastErrorClass: string | null
  lastErrorAt: string | null
  reviewsLastHour: number
  errorsLastHour: number
}

/**
 * GET /metrics `opsRecent` (otto/mamoru#129, apps/mamoru-operator/src/operator.ts Operator.recentOps): exactly
 * these five fields, never a grant, session key, signature, salt or userOp.
 */
export type RecentOpWire = { accountKey: string; kind: string; state: string; at: string; code: string | null }

type RpcCountersWire = { requests: number; errors: Record<string, number>; fallbacks: number; getLogsChunks: number; cuEstimate: number }
type RpcSnapshotWire = Record<string, Record<string, RpcCountersWire>>
type ComponentCountersWire = { requests: number; cuEstimate: number }
type ComponentSnapshotWire = Record<string, Record<string, ComponentCountersWire>>

/** apps/mamoru-operator/src/engine-settings.ts SettingsStatus, as GET /metrics `operator.settings` serves it (or null without MAMORU_SETTINGS_URL). No secret: `url` is the engine-settings source, not an RPC endpoint. */
export type SettingsStatusWire = {
  stale: boolean
  url: string | null
  source: 'd1' | 'last-known-good' | 'default' | 'local'
  lastPullAt: string | null
  lastError: string | null
  versions: { id: number; env: string; canary: boolean; template: string; hash: string }[]
  override: string[]
  flags: Record<string, boolean>
} | null

/** The operator's full GET /metrics payload — the parts this module reads. apps/mamoru-operator/src/server.ts buildMetricsPayload is the source of truth for the wire shape. */
export type OperatorMetricsWire = {
  generatedAt: string
  operator: {
    uptimeSeconds: number
    gitSha: string
    chainId: number
    live: boolean
    policyId: string
    relayer: { address: string; balanceWei: string; balanceCachedAgeMs: number }
    accounts: { known: number; active: number; armed: number }
    settings: SettingsStatusWire
  }
  rpc: {
    cumulative: RpcSnapshotWire
    cuEstimateTotal: number
    last48h: { hourStart: string; data: RpcSnapshotWire }[]
    logRanges: Record<string, Record<string, number>>
    byComponent: { cumulative: ComponentSnapshotWire; last48h: { hourStart: string; data: ComponentSnapshotWire }[] }
    note: string
  }
  engines: EngineHealthWire[]
  opsRecent: RecentOpWire[]
}

/**
 * What `operator_metrics_latest.payload_json` stores (migrations/d1/0013_operator_metrics.sql): the operator's
 * /metrics, further trimmed for the /ops console. Drops `rpc.cumulative` and `rpc.logRanges` (unbounded-ish
 * per-provider detail the console does not read) and `operator.chainId`/`live`/`policyId` and
 * `relayer.balanceCachedAgeMs` (not useful to the console; the operator's /metrics stays the source of truth for
 * live ops). The operator's own /metrics already carries nothing sensitive (see buildMetricsPayload's doc
 * comment) — this is a size/relevance trim, not a second redaction pass. Mirror this type in the console repo.
 */
export type StoredOperatorMetrics = {
  generatedAt: string
  operator: {
    gitSha: string
    uptimeSeconds: number
    relayer: { address: string; balanceWei: string }
    accounts: { known: number; active: number; armed: number }
    settings: SettingsStatusWire
  }
  rpc: {
    last48h: OperatorMetricsWire['rpc']['last48h']
    cuEstimateTotal: number
    byComponent: OperatorMetricsWire['rpc']['byComponent']
  }
  engines: EngineHealthWire[]
  opsRecent: RecentOpWire[]
}

/** The trim buildMetricsPayload's wire shape down to StoredOperatorMetrics (see that type's doc comment for what is dropped and why). */
export function toStoredMetrics(raw: OperatorMetricsWire): StoredOperatorMetrics {
  return {
    generatedAt: raw.generatedAt,
    operator: {
      gitSha: raw.operator.gitSha,
      uptimeSeconds: raw.operator.uptimeSeconds,
      relayer: { address: raw.operator.relayer.address, balanceWei: raw.operator.relayer.balanceWei },
      accounts: raw.operator.accounts,
      settings: raw.operator.settings,
    },
    rpc: { last48h: raw.rpc.last48h, cuEstimateTotal: raw.rpc.cuEstimateTotal, byComponent: raw.rpc.byComponent },
    engines: raw.engines,
    opsRecent: raw.opsRecent,
  }
}

/**
 * Pulls the operator's /metrics, signed the same way GET /snapshot is (yield-ledger.ts fetchSnapshot): one
 * HMAC, no account context. Null, never a thrown error, when the operator is unreachable or answers anything
 * but 200 — the caller's cron tries again next time.
 */
export async function fetchOperatorMetrics(operatorUrl: string, operatorSecret: string, fetcher: OperatorFetch): Promise<OperatorMetricsWire | null> {
  const path = '/metrics'
  const minute = Math.floor(Date.now() / 60_000)
  const sig = await metricsSignature(operatorSecret, 'GET', path, minute)
  try {
    const res = await fetcher(operatorUrl.replace(/\/+$/, '') + path, {
      method: 'GET',
      headers: { 'x-mamoru-sig': sig, accept: 'application/json' },
      signal: AbortSignal.timeout(METRICS_TIMEOUT_MS),
    })
    if (res.status !== 200) return null
    return (await res.json()) as OperatorMetricsWire
  } catch (e) {
    console.error('operator-metrics: /metrics unreachable', e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Upserts the single row (migrations/d1/0013_operator_metrics.sql), overwriting whatever the previous pull wrote. */
export async function writeOperatorMetrics(db: Db, metrics: StoredOperatorMetrics, fetchedAt: Date): Promise<void> {
  await db
    .prepare(
      `INSERT INTO operator_metrics_latest (id, payload_json, generated_at, fetched_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, generated_at = excluded.generated_at, fetched_at = excluded.fetched_at`,
    )
    .bind(JSON.stringify(metrics), metrics.generatedAt, fetchedAt.toISOString())
    .run()
}

/**
 * One cron tick: pull the operator's /metrics and store it. No-op, never throws, when the operator answers
 * nothing (unreachable, or any status but 200) — the row from the last successful pull is left as it was.
 * Returns whether a row was written.
 */
export async function pullOperatorMetrics(db: Db, operatorUrl: string, operatorSecret: string, fetcher: OperatorFetch, now: Date): Promise<boolean> {
  const raw = await fetchOperatorMetrics(operatorUrl, operatorSecret, fetcher)
  if (!raw) return false
  await writeOperatorMetrics(db, toStoredMetrics(raw), now)
  return true
}
