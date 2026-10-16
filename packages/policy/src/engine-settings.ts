import { FALL_FREEZE_DEFAULTS } from './policies.ts'
import type { PolicyVersion } from './types.ts'

/**
 * Spec 006 (otto/mamoru#147): the engine knobs that used to live in the operator's env, as one versioned object.
 * Bounds live here, in code: the writer (/ops) validates against a copy for its form, the operator validates
 * against this file and refuses anything outside it. Settings never change a grant an account already holds. The cap
 * also sizes the session limits of approvals signed after it changes (the owner sees that cap in the summary they
 * sign); depth sizing and the guard only change how much an entry places and which entries pause.
 */
export type EngineSettings = {
  /** Depth sizing (#127), or null for off. */
  depth: { impactBps: number; shareBps: number; stablesImpactBps?: number } | null
  /** Cap per account at Start, whole USDC; null = the code default (LIVE_CAP_USDC). */
  capUsdc: number | null
  /** Fall freeze (#101): no new money into a volatile bucket while its pool falls with high volatility. */
  guard: { enabled: boolean; btc: { fallBps: number; volBps: number }; eth: { fallBps: number; volBps: number } }
}

/** The cap the operator ran with before settings existed; above it, depth sizing must be on. */
export const DEFAULT_CAP_USDC = 100

export const ENGINE_SETTINGS_BOUNDS = {
  impactBps: { min: 1, max: 500 },
  shareBps: { min: 1, max: 5000 },
  stablesImpactBps: { min: 1, max: 500 },
  capUsdc: { min: 1, max: 1_000_000 },
  fallBps: { min: 100, max: 3000 },
  volBps: { min: 1000, max: 50_000 },
} as const

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  depth: null,
  capUsdc: null,
  guard: {
    enabled: false,
    btc: { ...FALL_FREEZE_DEFAULTS['btc-usdc'] },
    eth: { ...FALL_FREEZE_DEFAULTS.risk },
  },
}

/** Seeded templates (spec 006). Names are the keys /ops shows and stores. */
export const ENGINE_SETTINGS_TEMPLATES: Record<string, EngineSettings> = {
  'conservador-live-v2 (today)': DEFAULT_ENGINE_SETTINGS,
  'conservador + depth 30/500/5, cap 1000': {
    ...DEFAULT_ENGINE_SETTINGS,
    depth: { impactBps: 30, shareBps: 500, stablesImpactBps: 5 },
    capUsdc: 1000,
  },
  'lab guards (fall freeze 7%/9%)': {
    ...DEFAULT_ENGINE_SETTINGS,
    guard: { ...DEFAULT_ENGINE_SETTINGS.guard, enabled: true },
  },
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)

function inRange(errors: string[], field: string, v: unknown, b: { min: number; max: number }): void {
  if (!isInt(v) || v < b.min || v > b.max) errors.push(`${field} must be a whole number from ${b.min} to ${b.max}`)
}

/**
 * Every reason the object is not valid settings, empty when it is. Strict: unknown keys are refused, so a typo
 * never silently means "default". `capUsdc` above the default needs depth sizing: without it a large account would
 * be entered as a 100 USDC one, whatever the pool can take.
 */
export function validateEngineSettings(s: unknown): string[] {
  const errors: string[] = []
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['settings must be an object']
  const o = s as Record<string, unknown>
  for (const k of Object.keys(o)) if (!['depth', 'capUsdc', 'guard'].includes(k)) errors.push(`unknown setting ${k}`)
  const B = ENGINE_SETTINGS_BOUNDS
  if (o.depth !== null) {
    if (!o.depth || typeof o.depth !== 'object' || Array.isArray(o.depth)) errors.push('depth must be an object or null')
    else {
      const d = o.depth as Record<string, unknown>
      for (const k of Object.keys(d)) if (!['impactBps', 'shareBps', 'stablesImpactBps'].includes(k)) errors.push(`unknown depth setting ${k}`)
      inRange(errors, 'depth.impactBps', d.impactBps, B.impactBps)
      inRange(errors, 'depth.shareBps', d.shareBps, B.shareBps)
      if (d.stablesImpactBps !== undefined) inRange(errors, 'depth.stablesImpactBps', d.stablesImpactBps, B.stablesImpactBps)
    }
  }
  if (o.capUsdc !== null) {
    inRange(errors, 'capUsdc', o.capUsdc, B.capUsdc)
    if (isInt(o.capUsdc) && o.capUsdc > DEFAULT_CAP_USDC && o.depth === null) errors.push(`capUsdc above ${DEFAULT_CAP_USDC} needs depth sizing`)
  }
  if (!o.guard || typeof o.guard !== 'object' || Array.isArray(o.guard)) errors.push('guard must be an object')
  else {
    const g = o.guard as Record<string, unknown>
    for (const k of Object.keys(g)) if (!['enabled', 'btc', 'eth'].includes(k)) errors.push(`unknown guard setting ${k}`)
    if (typeof g.enabled !== 'boolean') errors.push('guard.enabled must be true or false')
    for (const side of ['btc', 'eth'] as const) {
      const r = g[side] as Record<string, unknown> | undefined
      if (!r || typeof r !== 'object' || Array.isArray(r)) {
        errors.push(`guard.${side} must be an object`)
        continue
      }
      for (const k of Object.keys(r)) if (!['fallBps', 'volBps'].includes(k)) errors.push(`unknown guard.${side} setting ${k}`)
      inRange(errors, `guard.${side}.fallBps`, r.fallBps, B.fallBps)
      inRange(errors, `guard.${side}.volBps`, r.volBps, B.volBps)
    }
  }
  return errors
}

/** The validated value, or throws with every reason. */
export function parseEngineSettings(s: unknown): EngineSettings {
  const errors = validateEngineSettings(s)
  if (errors.length) throw new Error(`invalid engine settings: ${errors.join('; ')}`)
  return s as EngineSettings
}

/**
 * Changes that need a confirm step on /ops (spec 006): more money per account, less protection. Each line says what
 * the change does in plain words, for the confirm screen.
 */
export function riskyChanges(from: EngineSettings, to: EngineSettings): string[] {
  const out: string[] = []
  const cap = (s: EngineSettings) => s.capUsdc ?? DEFAULT_CAP_USDC
  if (cap(to) > cap(from)) out.push(`cap per account rises from ${cap(from)} to ${cap(to)} USDC`)
  if (from.guard.enabled && !to.guard.enabled) out.push('the fall guard turns off')
  if (to.guard.enabled) {
    for (const side of ['btc', 'eth'] as const) {
      if (to.guard[side].fallBps > from.guard[side].fallBps) out.push(`the ${side} guard needs a bigger fall before it pauses entries`)
      if (to.guard[side].volBps > from.guard[side].volBps) out.push(`the ${side} guard needs more volatility before it pauses entries`)
    }
  }
  if (from.depth && !to.depth) out.push('depth sizing turns off')
  if (from.depth && to.depth) {
    if (to.depth.impactBps > from.depth.impactBps) out.push('entries may move the pool price more')
    if (to.depth.shareBps > from.depth.shareBps) out.push('entries may take a bigger share of a pool')
    // Without its own value the stables pool uses the general impact limit, so compare what each side really allows.
    if ((to.depth.stablesImpactBps ?? to.depth.impactBps) > (from.depth.stablesImpactBps ?? from.depth.impactBps)) out.push('stables entries may move the pool price more')
  }
  return out
}

/** Canonical JSON (sorted keys): the same settings always hash the same, on /ops and in the operator. */
export function canonicalSettingsJson(s: EngineSettings): string {
  const sort = (v: unknown): unknown =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sort((v as Record<string, unknown>)[k])])) : v
  return JSON.stringify(sort(s))
}

/** Base units of USDC (6 decimals) for the cap, or null for the code default. */
export function capBaseUnits(s: EngineSettings): bigint | null {
  return s.capUsdc === null ? null : BigInt(s.capUsdc) * 1_000_000n
}

/**
 * The policy the engine decides with under these settings: the account's policy plus depth sizing (target-weights
 * policies only, as #127) and the fall guard on the buckets the policy has. Grants are untouched.
 */
export function withEngineSettings(p: PolicyVersion, s: EngineSettings): PolicyVersion {
  let out = p
  // Off means off, even if a base policy ever carried its own depth or guards.
  if (!s.depth && out.depth) out = { ...out, depth: undefined }
  if (!s.guard.enabled && out.guards) out = { ...out, guards: undefined }
  if (s.depth && p.allocation === 'target-weights') {
    out = {
      ...out,
      depth: {
        maxImpactBps: s.depth.impactBps,
        maxShareBps: s.depth.shareBps,
        ...(s.depth.stablesImpactBps === undefined ? {} : { maxImpactBpsByPool: { 'pool:USDC/USDT/100': s.depth.stablesImpactBps } }),
      },
    }
  }
  if (s.guard.enabled) {
    const ids = new Set(p.buckets.map((b) => b.id))
    const byBucket: NonNullable<PolicyVersion['guards']>['byBucket'] = {}
    if (ids.has('btc-usdc')) byBucket['btc-usdc'] = { fallFreeze: { ...s.guard.btc } }
    if (ids.has('risk')) byBucket.risk = { fallFreeze: { ...s.guard.eth } }
    out = { ...out, guards: { byBucket } }
  }
  return out
}
