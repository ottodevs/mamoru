// Operator GET /metrics pulled into D1 for the /ops console (separate repo), otto/mamoru#129 follow-up. The
// operator has no D1 binding (specs/003-snapshot-loop/spec.md, same reason yield-ledger.ts pulls GET /snapshot
// instead of writing D1 itself), so this Worker pulls GET /metrics through the same signed path and upserts
// operator_metrics_latest (migrations/d1/0013_operator_metrics.sql). Unlike runYieldLedger's /snapshot pull,
// this one is NOT behind the yield_ledger ops flag: /metrics costs the operator nothing beyond its own cached
// relayer balance read, so it is cheap enough to pull every tick regardless of what the flag says.
//
// The operator answers 200 with a signature we verified, but its *body* is still an untrusted network
// response as far as this Worker's type system is concerned — a `JSON.parse` result is `any`/`unknown`, never
// `OperatorMetricsWire`. toStoredMetrics() never spreads or casts it: every field this module stores is read
// out one at a time, type-checked, and anything else (an extra property, a wrong-typed one, a whole section
// that is missing) is dropped or defaulted, never passed through (code-review finding, PR #92).
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

type RpcCountersWire = { requests: number; errors: { rateCapacity: number; invalidParams: number; timeout: number; other: number }; fallbacks: number; getLogsChunks: number; cuEstimate: number }
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

/** The operator's full GET /metrics payload — the parts this module reads. apps/mamoru-operator/src/server.ts buildMetricsPayload is the source of truth for the wire shape. Documentation only: nothing casts a raw response to this type (see toStoredMetrics). */
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
    last48h: { hourStart: string; data: RpcSnapshotWire }[]
    cuEstimateTotal: number
    byComponent: { cumulative: ComponentSnapshotWire; last48h: { hourStart: string; data: ComponentSnapshotWire }[] }
  }
  engines: EngineHealthWire[]
  opsRecent: RecentOpWire[]
}

// ---- allow-list readers: every one below reads a single, type-checked value out of an `unknown` and either
// returns a safe default or drops the value entirely. None of them ever return what they were handed unchecked. ----

function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}
function asStr(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}
function asNum(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}
function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}
function asNullableStr(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}
/** ISO-8601 date-time with an explicit zone (Z or ±hh:mm). Anything else (`10/18/2026 09:20:00`, a bare date) is refused. */
const ISO_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|([+-])(\d{2}):(\d{2}))$/
/**
 * The sole authority for "is this a real timestamp" in this module (reviews r2/r3, PR #92). Every component is
 * checked, because Date.parse rolls impossible dates over (2026-02-30 becomes 2026-03-02) instead of refusing them.
 */
function isIsoString(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const m = ISO_DATE_TIME.exec(v)
  if (!m) return false
  const n = (i: number) => Number(m[i] ?? '0')
  const [y, mo, d, h, mi, sec, oh, om] = [n(1), n(2), n(3), n(4), n(5), n(6), n(8), n(9)]
  if (h > 23 || mi > 59 || sec > 59 || oh > 14 || om > 59) return false
  // setUTCFullYear, not Date.UTC: Date.UTC maps years 0-99 to 1900-1999 (review r4).
  const day = new Date(0)
  day.setUTCFullYear(y, mo - 1, d)
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return false
  return !Number.isNaN(Date.parse(v))
}
/** Canonical UTC (`toISOString`), so stored timestamps compare lexicographically in chronological order. */
function asIso(v: unknown): string | null {
  return isIsoString(v) ? new Date(v).toISOString() : null
}

const RPC_ERROR_CLASSES = ['rateCapacity', 'invalidParams', 'timeout', 'other'] as const

function rpcCounters(v: unknown): RpcCountersWire {
  const o = asObj(v)
  const errorsRaw = asObj(o.errors)
  const errors = { rateCapacity: 0, invalidParams: 0, timeout: 0, other: 0 }
  for (const k of RPC_ERROR_CLASSES) errors[k] = asNum(errorsRaw[k])
  return { requests: asNum(o.requests), errors, fallbacks: asNum(o.fallbacks), getLogsChunks: asNum(o.getLogsChunks), cuEstimate: asNum(o.cuEstimate) }
}
function rpcSnapshot(v: unknown): RpcSnapshotWire {
  const out: RpcSnapshotWire = {}
  for (const [provider, methodsRaw] of Object.entries(asObj(v))) {
    const methods = asObj(methodsRaw)
    const outMethods: Record<string, RpcCountersWire> = {}
    for (const [method, counters] of Object.entries(methods)) outMethods[method] = rpcCounters(counters)
    out[provider] = outMethods
  }
  return out
}
function hourlyRpcBuckets(v: unknown): { hourStart: string; data: RpcSnapshotWire }[] {
  const out: { hourStart: string; data: RpcSnapshotWire }[] = []
  for (const e of asArr(v)) {
    const o = asObj(e)
    const hourStart = asIso(o.hourStart)
    if (hourStart) out.push({ hourStart, data: rpcSnapshot(o.data) })
  }
  return out
}
function componentCounters(v: unknown): ComponentCountersWire {
  const o = asObj(v)
  return { requests: asNum(o.requests), cuEstimate: asNum(o.cuEstimate) }
}
function componentSnapshot(v: unknown): ComponentSnapshotWire {
  const out: ComponentSnapshotWire = {}
  for (const [component, methodsRaw] of Object.entries(asObj(v))) {
    const methods = asObj(methodsRaw)
    const outMethods: Record<string, ComponentCountersWire> = {}
    for (const [method, counters] of Object.entries(methods)) outMethods[method] = componentCounters(counters)
    out[component] = outMethods
  }
  return out
}
function hourlyComponentBuckets(v: unknown): { hourStart: string; data: ComponentSnapshotWire }[] {
  const out: { hourStart: string; data: ComponentSnapshotWire }[] = []
  for (const e of asArr(v)) {
    const o = asObj(e)
    const hourStart = asIso(o.hourStart)
    if (hourStart) out.push({ hourStart, data: componentSnapshot(o.data) })
  }
  return out
}

const SETTINGS_SOURCES = ['d1', 'last-known-good', 'default', 'local'] as const

function settingsStatus(v: unknown): SettingsStatusWire {
  if (v === null || v === undefined) return null
  const o = asObj(v)
  const source = (SETTINGS_SOURCES as readonly string[]).includes(o.source as string) ? (o.source as (typeof SETTINGS_SOURCES)[number]) : ('default' as const)
  return {
    stale: asBool(o.stale),
    url: asNullableStr(o.url),
    source,
    lastPullAt: asNullableStr(o.lastPullAt),
    lastError: asNullableStr(o.lastError),
    versions: asArr(o.versions)
      .map((ver) => {
        const vo = asObj(ver)
        if (typeof vo.id !== 'number' || typeof vo.env !== 'string' || typeof vo.template !== 'string' || typeof vo.hash !== 'string') return null
        return { id: vo.id, env: vo.env, canary: asBool(vo.canary), template: vo.template, hash: vo.hash }
      })
      .filter((x): x is { id: number; env: string; canary: boolean; template: string; hash: string } => x !== null),
    override: asArr(o.override).filter((x): x is string => typeof x === 'string'),
    flags: Object.fromEntries(Object.entries(asObj(o.flags)).filter(([, val]) => typeof val === 'boolean')) as Record<string, boolean>,
  }
}

function engineHealth(v: unknown): EngineHealthWire | null {
  const o = asObj(v)
  if (typeof o.account !== 'string') return null
  return {
    account: o.account,
    lastReviewAt: asNullableStr(o.lastReviewAt),
    lastDecisionCode: asNullableStr(o.lastDecisionCode),
    consecutiveErrors: asNum(o.consecutiveErrors),
    lastErrorClass: asNullableStr(o.lastErrorClass),
    lastErrorAt: asNullableStr(o.lastErrorAt),
    reviewsLastHour: asNum(o.reviewsLastHour),
    errorsLastHour: asNum(o.errorsLastHour),
  }
}

/** Exactly the five fields `opsRecent` carries, rebuilt field by field — never a grant, session key, signature,
 * permissionId, calls or any other StoredOp field, whatever the input object actually has on it. A malformed
 * entry (missing accountKey/kind/state, or an `at` that does not parse as a date) is dropped, not stored. */
function recentOp(v: unknown): RecentOpWire | null {
  const o = asObj(v)
  const at = asIso(o.at)
  if (typeof o.accountKey !== 'string' || typeof o.kind !== 'string' || typeof o.state !== 'string' || !at) return null
  return { accountKey: o.accountKey.slice(0, 8), kind: o.kind, state: o.state, at, code: typeof o.code === 'string' ? o.code : null }
}

/**
 * The allow-list trim from an untrusted parsed response (`unknown`, never cast) down to
 * `StoredOperatorMetrics`. Every field is read out one at a time through the `as*`/`*Wire` readers above;
 * nothing is spread, so an extra or unexpected property anywhere in the input (a leaked grant, a session key,
 * a field this module does not know about) never reaches the stored JSON. A missing or malformed section
 * (an older operator without `opsRecent`, a `settings: null`, a non-array `engines`) becomes its documented
 * empty/default value, never a missing key on the stored object (code-review finding, PR #92).
 */
export function toStoredMetrics(raw: unknown): StoredOperatorMetrics {
  const root = asObj(raw)
  const operatorRaw = asObj(root.operator)
  const relayerRaw = asObj(operatorRaw.relayer)
  const accountsRaw = asObj(operatorRaw.accounts)
  const rpcRaw = asObj(root.rpc)
  const byComponentRaw = asObj(rpcRaw.byComponent)
  return {
    generatedAt: asStr(root.generatedAt),
    operator: {
      gitSha: asStr(operatorRaw.gitSha),
      uptimeSeconds: asNum(operatorRaw.uptimeSeconds),
      relayer: { address: asStr(relayerRaw.address), balanceWei: asStr(relayerRaw.balanceWei) },
      accounts: { known: asNum(accountsRaw.known), active: asNum(accountsRaw.active), armed: asNum(accountsRaw.armed) },
      settings: settingsStatus(operatorRaw.settings),
    },
    rpc: {
      last48h: hourlyRpcBuckets(rpcRaw.last48h),
      cuEstimateTotal: asNum(rpcRaw.cuEstimateTotal),
      byComponent: { cumulative: componentSnapshot(byComponentRaw.cumulative), last48h: hourlyComponentBuckets(byComponentRaw.last48h) },
    },
    // Missing/invalid opsRecent (an older operator that predates #129, or a malformed answer) is [], not a
    // missing field: asArr(undefined) already answers [], same for engines below.
    engines: asArr(root.engines)
      .map(engineHealth)
      .filter((x): x is EngineHealthWire => x !== null),
    opsRecent: asArr(root.opsRecent)
      .map(recentOp)
      .filter((x): x is RecentOpWire => x !== null),
  }
}

/**
 * Pulls the operator's /metrics, signed the same way GET /snapshot is (yield-ledger.ts fetchSnapshot): one
 * HMAC, no account context. Returns the parsed body as `unknown` — never cast to `OperatorMetricsWire`, since
 * a 200 and a valid signature say nothing about the JSON shape the operator actually sent (see toStoredMetrics
 * for where that gets checked). Null, never a thrown error, when the operator is unreachable or answers
 * anything but 200 — the caller's cron tries again next time.
 */
export async function fetchOperatorMetrics(operatorUrl: string, operatorSecret: string, fetcher: OperatorFetch): Promise<unknown> {
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
    return await res.json()
  } catch (e) {
    console.error('operator-metrics: /metrics unreachable', e instanceof Error ? e.message : String(e))
    return null
  }
}

/**
 * Upserts the single row (migrations/d1/0013_operator_metrics.sql). Two refusals, both silent (log only, never
 * throw — a cron write is never allowed to fail the tick):
 *  - `generatedAt` does not parse as a date: nothing is written, whatever row was there stays.
 *  - freshness guard: the SQL `WHERE` on the upsert only applies when the incoming `generated_at` is strictly
 *    newer than the row already there (ISO-8601 strings in this fixed UTC format compare lexicographically the
 *    same as chronologically) — an out-of-order pull, or a stale answer from behind a load balancer, never
 *    overwrites a newer one.
 */
export async function writeOperatorMetrics(db: Db, input: StoredOperatorMetrics, fetchedAt: Date): Promise<void> {
  // Canonical UTC before the freshness guard compares strings: `11:00+02:00` is 09:00Z, never newer than 10:00Z.
  const generatedAt = asIso(input.generatedAt)
  if (!generatedAt) {
    console.error('operator-metrics: refusing to store a non-ISO generatedAt', input.generatedAt)
    return
  }
  const metrics = { ...input, generatedAt }
  await db
    .prepare(
      `INSERT INTO operator_metrics_latest (id, payload_json, generated_at, fetched_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         payload_json = excluded.payload_json, generated_at = excluded.generated_at, fetched_at = excluded.fetched_at
       WHERE excluded.generated_at > operator_metrics_latest.generated_at`,
    )
    .bind(JSON.stringify(metrics), metrics.generatedAt, fetchedAt.toISOString())
    .run()
}

/**
 * One cron tick: pull the operator's /metrics, trim it through the allow-list and store it. No-op, never
 * throws, when the operator answers nothing (unreachable, any status but 200) or answers a `generatedAt` that
 * does not parse as a date — the row from the last successful pull is left as it was either way. Returns
 * whether a write was attempted (not whether the freshness guard above then kept it: that is DB-level and this
 * caller does not need to know).
 */
export async function pullOperatorMetrics(db: Db, operatorUrl: string, operatorSecret: string, fetcher: OperatorFetch, now: Date): Promise<boolean> {
  const raw = await fetchOperatorMetrics(operatorUrl, operatorSecret, fetcher)
  if (!raw) return false
  const stored = toStoredMetrics(raw)
  if (!isIsoString(stored.generatedAt)) {
    console.error('operator-metrics: generatedAt is not a valid ISO date, skipping write', stored.generatedAt)
    return false
  }
  await writeOperatorMetrics(db, stored, now)
  return true
}
