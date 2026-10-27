import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { metricsSignature, verifySettingsResponse } from '@mamoru/operator-auth'
import { canonicalSettingsJson, DEFAULT_CAP_USDC, DEFAULT_ENGINE_SETTINGS, OPS_FLAGS, parseEngineSettings, validateAccountCaps, validateEngineSettings, type EngineSettings, type OpsFlagName } from '@mamoru/policy'

/**
 * Spec 006 (otto/mamoru#147): the operator's side of engine settings. Pulls the active versions from the app Worker
 * (signed request, signed response), validates every version against the code bounds, refuses a response older than
 * what it already applied, keeps the last good set on disk, and resolves the settings of each account.
 */

export const ENGINE_SETTINGS_PATH = '/api/internal/engine-settings'
export const SETTINGS_POLL_MS = 60_000
/** Without a successful pull for this long the settings in force are reported stale and an [alert] line is logged. */
export const SETTINGS_STALE_MS = 15 * 60_000
/**
 * Emergency path that needs neither the Worker nor a restart: a valid settings object in this file (stateDir, 0600,
 * written by hand on lady) wins over D1 and the last-known-good for every account, re-read on every poll; deleting
 * the file hands control back to D1. Logged at every change and reported as source 'local'. See spec 006.
 */
export const LOCAL_OVERRIDE_FILE = 'engine-settings.local.json'

export type SettingsVersion = { id: number; env: 'prod' | 'beta'; accountKeys: string[] | null; template: string; settings: EngineSettings; hash: string; createdAt: string }
/** `accountCaps` (otto/mamoru#26): lowercase account key to whole USDC, over the environment's cap. */
/**
 * `ownerSafes` (otto/mamoru#212): lowercase account key to the other Safe addresses its owner holds in its environment,
 * only for an owner with more than one address (normally none). Optional: older Workers do not serve it.
 */
type Payload = { versions: SettingsVersion[]; betaAccounts: string[]; flags: Record<OpsFlagName, boolean>; accountCaps: Record<string, number>; ownerSafes?: Record<string, string[]>; servedAt: string }

export type ResolvedSettings = {
  settings: EngineSettings
  /** The D1 version id, or null for the code defaults. */
  versionId: number | null
  source: 'd1' | 'last-known-good' | 'default' | 'local'
  /** Knobs forced by the emergency env override (MAMORU_DEPTH / MAMORU_CAP_USDC). */
  override: string[]
  /**
   * otto/mamoru#26: this account's own cap from D1 (whole USDC), over the canary and environment cap; null without one,
   * and always null under the local emergency file or MAMORU_CAP_USDC (those win). Optional for older callers.
   */
  accountCapUsdc?: number | null
  /** The D1 version is this environment's canary (otto/mamoru#26: where the cap came from, for /metrics). */
  canary?: boolean
}

/** Emergency override from env: wins over D1 for the knobs it names, and is reported so it cannot stay on unseen. */
export type SettingsOverride = { depth?: EngineSettings['depth']; capUsdc?: number }

export type SettingsStatus = {
  /** No successful pull for SETTINGS_STALE_MS (with a URL configured). */
  stale: boolean
  url: string | null
  source: 'd1' | 'last-known-good' | 'default' | 'local'
  lastPullAt: string | null
  lastError: string | null
  versions: { id: number; env: string; canary: boolean; template: string; hash: string }[]
  override: string[]
  /** otto/mamoru#129: runtime flags from the latest applied pull. No successful pull yet: every flag off. */
  flags: Record<OpsFlagName, boolean>
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * otto/mamoru#129: the `flags` field of the payload. Absent or explicitly null (an app Worker that has not
 * deployed the ops-flags read yet, or has nothing to say): every flag reads as off, not a refused pull. Present
 * but not a plain object: refused outright, that shape is confidently wrong rather than merely incomplete. A
 * present object with an entry that is not a boolean, or a name this operator does not know: that one entry
 * reads as off, the rest of the pull still applies.
 */
function parseOpsFlags(raw: unknown): Record<OpsFlagName, boolean> {
  const out = Object.fromEntries(Object.keys(OPS_FLAGS).map((f) => [f, false])) as Record<OpsFlagName, boolean>
  if (raw === undefined || raw === null) return out
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('flags must be an object')
  const o = raw as Record<string, unknown>
  for (const k of Object.keys(out)) if (typeof o[k] === 'boolean') out[k as OpsFlagName] = o[k] as boolean
  return out
}

/**
 * otto/mamoru#26: the `accountCaps` field. Absent or null (an app Worker that does not serve it yet): no override.
 * Present: every entry must be valid (validateAccountCaps), else the whole pull is refused, as for a bad version.
 */
function parseAccountCaps(raw: unknown): Record<string, number> {
  if (raw === undefined || raw === null) return {}
  const errors = validateAccountCaps(raw)
  if (errors.length) throw new Error(`bad accountCaps: ${errors.join('; ')}`)
  return { ...(raw as Record<string, number>) }
}

/** otto/mamoru#212: the `ownerSafes` field. Absent or null: none. Present: every entry must be addresses, else the pull is refused. */
function parseOwnerSafes(raw: unknown): Record<string, string[]> {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ownerSafes must be an object')
  const out: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(v) || !v.every((a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a))) throw new Error(`bad ownerSafes for ${k.slice(0, 8)}`)
    out[k.toLowerCase()] = (v as string[]).map((a) => a.toLowerCase())
  }
  return out
}

/** One line for the log: 8-character keys and caps, sorted, or `none`. */
export function describeAccountCaps(m: Record<string, number>): string {
  const keys = Object.keys(m).sort()
  return keys.length ? keys.map((k) => `${k.slice(0, 8)}=${m[k]}`).join(', ') : 'none'
}

/** Every check a pulled body must pass before anything of it runs. Throws with the reason. */
export function checkPayload(raw: unknown, applied: Payload | null, opts: { allocation?: string } = {}): Payload {
  if (!raw || typeof raw !== 'object') throw new Error('body is not an object')
  const p = raw as Payload
  if (!Array.isArray(p.versions) || !Array.isArray(p.betaAccounts) || !p.betaAccounts.every((k) => typeof k === 'string')) throw new Error('body has the wrong shape')
  const flags = parseOpsFlags((raw as { flags?: unknown }).flags)
  const accountCaps = parseAccountCaps((raw as { accountCaps?: unknown }).accountCaps)
  const ownerSafes = parseOwnerSafes((raw as { ownerSafes?: unknown }).ownerSafes)
  const versions: SettingsVersion[] = []
  for (const v of p.versions) {
    if (!v || !Number.isSafeInteger(v.id) || v.id < 1 || (v.env !== 'prod' && v.env !== 'beta')) throw new Error('a version has the wrong shape')
    if (v.accountKeys !== null && !(Array.isArray(v.accountKeys) && v.accountKeys.every((k) => typeof k === 'string'))) throw new Error(`version ${v.id}: bad account list`)
    // Code bounds are the authority: one version out of bounds and the whole pull is refused.
    const settings = parseEngineSettings(v.settings)
    // As the boot check on MAMORU_CAP_USDC: a cap above the default needs depth sizing, and depth sizing only applies
    // under a target-weights policy. Under any other operator policy such a version is refused (last-known-good stays).
    if ((settings.capUsdc ?? 0) > DEFAULT_CAP_USDC && opts.allocation !== undefined && opts.allocation !== 'target-weights') throw new Error(`version ${v.id}: a cap above ${DEFAULT_CAP_USDC} needs a target-weights policy, the operator runs ${opts.allocation}`)
    // The hash /ops stored must be the hash of exactly these settings (sha256 of the canonical JSON).
    if (v.hash !== createHash('sha256').update(canonicalSettingsJson(settings)).digest('hex')) throw new Error(`version ${v.id}: hash does not match its settings`)
    versions.push({ ...v, accountKeys: v.accountKeys === null ? null : v.accountKeys.map((k) => k.toLowerCase()), settings })
  }
  // Monotonic per environment: a replayed or stale body cannot take an environment back to an older version.
  // A rollback on /ops is a new, higher version, so this never blocks one.
  for (const env of ['prod', 'beta'] as const) {
    const was = Math.max(0, ...(applied?.versions ?? []).filter((v) => v.env === env).map((v) => v.id))
    const now = Math.max(0, ...versions.filter((v) => v.env === env).map((v) => v.id))
    if (now < was) throw new Error(`stale: ${env} would go from version ${was} back to ${now}`)
  }
  // A body served before the one applied is a replay: refused even when its versions are the same (the beta list
  // may have changed in between).
  const servedAt = typeof p.servedAt === 'string' ? p.servedAt : ''
  if (!Number.isFinite(Date.parse(servedAt))) throw new Error('body has no valid servedAt')
  if (applied?.servedAt && Date.parse(servedAt) < Date.parse(applied.servedAt)) throw new Error(`stale: served at ${servedAt}, before the applied ${applied.servedAt}`)
  return { versions, betaAccounts: p.betaAccounts.map((k) => k.toLowerCase()), flags, accountCaps, ownerSafes, servedAt }
}

/**
 * Settings of one account. Per environment one canary at most is live: the newest one, if it is newer than the newest
 * environment-wide version. An account it names runs it; every other account runs the environment-wide version (or
 * the code defaults). Writing a new canary therefore retires the previous one for every account.
 */
export function resolveFor(p: Payload | null, accountKey: string): { settings: EngineSettings; versionId: number | null; canary: boolean } {
  if (!p) return { settings: DEFAULT_ENGINE_SETTINGS, versionId: null, canary: false }
  const key = accountKey.toLowerCase()
  const env = p.betaAccounts.includes(key) ? 'beta' : 'prod'
  const ofEnv = p.versions.filter((v) => v.env === env).sort((a, b) => b.id - a.id)
  const wide = ofEnv.find((x) => x.accountKeys === null)
  const canary = ofEnv.find((x) => x.accountKeys !== null && (!wide || x.id > wide.id))
  const v = canary?.accountKeys?.includes(key) ? canary : wide
  return v ? { settings: v.settings, versionId: v.id, canary: v !== wide } : { settings: DEFAULT_ENGINE_SETTINGS, versionId: null, canary: false }
}

export class EngineSettingsSource {
  private payload: Payload | null = null
  private source: 'd1' | 'last-known-good' | 'default' | 'local' = 'default'
  private lastPullAt: string | null = null
  private lastError: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** The applied set is not on disk yet (a write failed): written again on the next pull. */
  private dirty = false
  /** Why the last per-account resolution fell back to the defaults; kept apart from pull errors. */
  private resolveError: string | null = null
  /** The local emergency file, when present and valid. */
  private local: EngineSettings | null = null
  private localError: string | null = null
  private readonly startedAt: number
  private staleAlerted = false
  private readonly file: string

  constructor(
    private readonly o: { url: string | null; secret: string; stateDir: string; /** The operator policy allocation, for the cap rule. */ allocation?: string; fetch?: Fetch; now?: () => number; override?: SettingsOverride; onChange?: () => void },
  ) {
    this.file = join(o.stateDir, 'engine-settings.json')
    this.startedAt = this.now()
    this.loadLastKnownGood()
    this.readLocal()
  }

  private now(): number {
    return (this.o.now ?? Date.now)()
  }

  private loadLastKnownGood(): void {
    if (!existsSync(this.file)) return
    try {
      this.payload = checkPayload(JSON.parse(readFileSync(this.file, 'utf8')), null, { ...(this.o.allocation ? { allocation: this.o.allocation } : {}) })
      this.source = 'last-known-good'
      if (Object.keys(this.payload.accountCaps).length) console.log(`[settings] account caps: ${describeAccountCaps(this.payload.accountCaps)} (last-known-good)`)
    } catch (e) {
      this.lastError = `last-known-good unreadable: ${(e as Error).message}`
    }
  }

  private saveLastKnownGood(p: Payload): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(p), { mode: 0o600 })
    renameSync(tmp, this.file)
  }

  /** Reads the local emergency file. A file that is not valid settings is ignored and reported, never half-applied. */
  readLocal(): boolean {
    const file = join(this.o.stateDir, LOCAL_OVERRIDE_FILE)
    let next: EngineSettings | null = null
    this.localError = null
    if (existsSync(file)) {
      try {
        next = parseEngineSettings(JSON.parse(readFileSync(file, 'utf8')))
      } catch (e) {
        this.localError = `${LOCAL_OVERRIDE_FILE} ignored: ${(e as Error).message}`
      }
    }
    const changed = canonical(next) !== canonical(this.local)
    this.local = next
    if (changed) console.log(next ? `[alert] engine settings: local emergency file ${LOCAL_OVERRIDE_FILE} in force for every account, over D1` : `[settings] local emergency file gone: D1 / last-known-good in force again`)
    return changed
  }

  private checkStale(): void {
    if (!this.o.url) return
    const since = this.lastPullAt ? Date.parse(this.lastPullAt) : this.startedAt
    const stale = this.now() - since >= SETTINGS_STALE_MS
    if (stale && !this.staleAlerted) console.log(`[alert] engine settings: no successful pull since ${this.lastPullAt ?? 'boot'}; running ${this.source}. For an urgent change without the Worker, write ${LOCAL_OVERRIDE_FILE} in the state dir.`)
    this.staleAlerted = stale
  }

  /** One pull. Never throws: a failure keeps what runs and is reported in `status()`. Returns whether anything changed. */
  async pull(): Promise<boolean> {
    const localChanged = this.readLocal()
    if (localChanged) this.o.onChange?.()
    if (!this.o.url) return localChanged
    const at = this.now()
    try {
      const sig = await metricsSignature(this.o.secret, 'GET', ENGINE_SETTINGS_PATH, Math.floor(at / 60_000))
      const res = await (this.o.fetch ?? ((i, init) => fetch(i, init)))(new URL(ENGINE_SETTINGS_PATH, this.o.url).toString(), { headers: { 'x-mamoru-sig': sig }, signal: AbortSignal.timeout(15_000) })
      if (res.status === 404) throw new Error('settings endpoint not set up (404)')
      if (!res.ok) throw new Error(`settings endpoint answered ${res.status}`)
      const body = await res.text()
      // Checked against the clock after the reply arrived: a pull that crossed a minute boundary still verifies.
      if (!(await verifySettingsResponse(this.o.secret, body, res.headers.get('x-mamoru-sig'), this.now()))) throw new Error('response signature does not verify')
      const next = checkPayload(JSON.parse(body), this.payload, { ...(this.o.allocation ? { allocation: this.o.allocation } : {}) })
      // otto/mamoru#129: flags are part of this diff too, so a /ops flip with no engine-settings change still fires
      // onChange (boot.ts's syncYieldLedger) and is written to the last-known-good file.
      // otto/mamoru#26: account caps too, compared on full keys (the log line's 8-character keys could collide).
      const capsChanged = canonicalCaps(next.accountCaps) !== canonicalCaps(this.payload?.accountCaps ?? {})
      const changed = capsChanged || JSON.stringify(next.versions.map((v) => [v.id, canonicalSettingsJson(v.settings), v.accountKeys])) + next.betaAccounts.join() + JSON.stringify(next.flags) !==
        JSON.stringify((this.payload?.versions ?? []).map((v) => [v.id, canonicalSettingsJson(v.settings), v.accountKeys])) + (this.payload?.betaAccounts ?? []).join() + JSON.stringify(this.payload?.flags ?? {})
      this.payload = next
      this.source = 'd1'
      this.lastPullAt = new Date(at).toISOString()
      this.lastError = null
      this.staleAlerted = false
      if (changed || this.dirty) {
        // Applied in memory first, then written: a failed write is reported and retried on the next pull, and the
        // engines still get the new set now.
        try {
          this.saveLastKnownGood(next)
          this.dirty = false
        } catch (e) {
          this.dirty = true
          this.lastError = `applied, but the last-known-good file was not written: ${(e as Error).message}`
        }
      }
      if (changed) {
        if (capsChanged) console.log(`[settings] account caps: ${describeAccountCaps(next.accountCaps)}`)
        console.log(`[settings] applied ${next.versions.map((v) => `v${v.id} ${v.env}${v.accountKeys ? ' canary' : ''} "${v.template}"`).join(', ') || 'none (defaults)'}`)
        this.o.onChange?.()
      }
      return changed || localChanged
    } catch (e) {
      this.lastError = (e as Error).message
      console.log(`[settings] pull refused or failed, keeping ${this.source}: ${this.lastError}`)
      this.checkStale()
      return localChanged
    }
  }

  start(): void {
    if (!this.o.url) return
    this.stopped = false
    const tick = async () => {
      await this.pull()
      if (!this.stopped) this.timer = setTimeout(tick, SETTINGS_POLL_MS)
    }
    this.timer = setTimeout(tick, SETTINGS_POLL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }

  private overrideKeys(): string[] {
    const o = this.o.override ?? {}
    return [...(o.depth !== undefined ? ['depth'] : []), ...(o.capUsdc !== undefined ? ['capUsdc'] : [])]
  }

  /** otto/mamoru#129: the flags of the latest applied pull. Independent of the local emergency override (that file
   * is engine settings only); no successful pull yet: every flag off. */
  flags(): Record<OpsFlagName, boolean> {
    return this.payload?.flags ?? parseOpsFlags(undefined)
  }

  forAccount(accountKey: string): ResolvedSettings {
    if (this.local) return { settings: this.local, versionId: null, source: 'local', override: [], accountCapUsdc: null }
    const r = resolveFor(this.payload, accountKey)
    const o = this.o.override ?? {}
    const merge = (base: EngineSettings): EngineSettings => ({ ...base, ...(o.depth !== undefined ? { depth: o.depth } : {}), ...(o.capUsdc !== undefined ? { capUsdc: o.capUsdc } : {}) })
    let settings = merge(r.settings)
    // The override and a D1 version can combine into something out of bounds (a D1 cap of 1000 with depth forced off):
    // then the code defaults run, with the override on top, and the status says why.
    if (validateEngineSettings(settings).length) {
      // Then the code defaults run, without the override (the defaults are valid by construction; the override on top
      // of them might not be), and the status says why.
      this.resolveError = `settings for ${accountKey.slice(0, 8)} are out of bounds with the env override; running the code defaults`
      return { settings: DEFAULT_ENGINE_SETTINGS, versionId: null, source: 'default', override: [], accountCapUsdc: null }
    }
    this.resolveError = null
    // otto/mamoru#26: the account's own cap replaces the canary or environment cap, unless MAMORU_CAP_USDC forces one.
    // Not merged into `settings`: whether it may run (depth sizing, target-weights) is the operator's capFor rule.
    const own = o.capUsdc === undefined ? this.payload?.accountCaps[accountKey.toLowerCase()] ?? null : null
    return { settings, versionId: r.versionId, source: r.versionId === null ? 'default' : this.source, override: this.overrideKeys(), accountCapUsdc: own, canary: r.canary }
  }

  /** otto/mamoru#212: the other Safe addresses of this account's owner (its cap counts them too); normally none. */
  otherSafes(accountKey: string): string[] {
    return this.payload?.ownerSafes?.[accountKey.toLowerCase()] ?? []
  }

  status(): SettingsStatus {
    return {
      url: this.o.url,
      source: this.local ? 'local' : this.payload ? this.source : 'default',
      stale: !!this.o.url && this.now() - (this.lastPullAt ? Date.parse(this.lastPullAt) : this.startedAt) >= SETTINGS_STALE_MS,
      lastPullAt: this.lastPullAt,
      lastError: this.localError ?? this.lastError ?? this.resolveError,
      versions: (this.payload?.versions ?? []).map((v) => ({ id: v.id, env: v.env, canary: v.accountKeys !== null, template: v.template, hash: v.hash })),
      override: this.overrideKeys(),
      flags: this.flags(),
    }
  }
}

const canonicalCaps = (m: Record<string, number>) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]))
const canonical = (s: EngineSettings | null) => (s ? canonicalSettingsJson(s) : '')
