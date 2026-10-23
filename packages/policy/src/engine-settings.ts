import { FALL_FREEZE_DEFAULTS } from './policies.ts'
import type { LazyRerange, PolicyVersion } from './types.ts'

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
  /**
   * otto/mamoru#172: how the engine re-ranges a position. Absent or `eager`: today's trigger (out of range or within 10%
   * of an edge, then the policy cooldown). `lazy`: the Lab rule `range.lazy` of spec 004 (#101 experiment 4): past
   * the edge by `edgeBufferTicks`, out of range for `minDwellSeconds`, and only when the fees of a new range over
   * `horizonSeconds` beat its gas, swap and LVR (weighted by `lvrWeightBps`); no near-edge trigger. Optional so
   * every version written before it keeps its canonical JSON and hash. In `eager` the four numbers may be kept (a
   * form switching back and forth); they are checked against the bounds and ignored.
   */
  rerange?: RerangeSetting
  /** Move to Base for USDC found on Ethereum (#133). Absent = off, so versions stored before it keep their hash. */
  bridgeOut?: { enabled: boolean }
  /**
   * otto/mamoru#195: the smallest entry is also `gasMultiple` times the gas of its swap and mint at the current fee,
   * never under the policy's own minimum (0.10 USDC). Absent = only the policy minimum, so older versions keep their hash.
   */
  minEntry?: { gasMultiple: number }
}

export type RerangeSetting = ({ mode: 'eager' } & Partial<LazyRerange>) | ({ mode: 'lazy' } & LazyRerange)

/** The cap the operator ran with before settings existed; above it, depth sizing must be on. */
export const DEFAULT_CAP_USDC = 100

export const ENGINE_SETTINGS_BOUNDS = {
  impactBps: { min: 1, max: 500 },
  shareBps: { min: 1, max: 5000 },
  stablesImpactBps: { min: 1, max: 500 },
  capUsdc: { min: 1, max: 1_000_000 },
  fallBps: { min: 100, max: 3000 },
  volBps: { min: 1000, max: 50_000 },
  // #172. The Lab grid (spec 004 results/rebalance-policy-2026-10-16.md) ran buffers 0-400 ticks, dwell 0-2 h, H 6-24 h,
  // LVR weight 1. The bounds leave room around it, never past half a 2000-tick range, a day of waiting or a week of H.
  edgeBufferTicks: { min: 0, max: 1000 },
  minDwellSeconds: { min: 0, max: 86_400 },
  horizonSeconds: { min: 3_600, max: 604_800 },
  lvrWeightBps: { min: 0, max: 20_000 },
  // #195: 1x is break-even on gas alone; past 50x a 2-cent entry gas would hold back a dollar.
  gasMultiple: { min: 1, max: 50 },
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
  // #172: the TRAIN/TEST candidate `lazy-h24h-b100-d30` of spec 004 (results/variants/test-candidates.json).
  'conservador-live-v2 + lazy-h24h-b100-d30': {
    ...DEFAULT_ENGINE_SETTINGS,
    rerange: { mode: 'lazy', edgeBufferTicks: 100, minDwellSeconds: 1800, horizonSeconds: 86_400, lvrWeightBps: 10_000 },
  },
}

const LAZY_KEYS = ['edgeBufferTicks', 'minDwellSeconds', 'horizonSeconds', 'lvrWeightBps'] as const

/**
 * The `range.lazy` these settings ask for, or null for the eager trigger. Always fail closed (`requireCostEstimate`):
 * live, a missing fee or volatility history holds the position instead of skipping the cost test (GPT-6 review of #172).
 */
export function lazyOf(s: EngineSettings): LazyRerange | null {
  const r = s.rerange
  if (!r || r.mode !== 'lazy') return null
  return { edgeBufferTicks: r.edgeBufferTicks, minDwellSeconds: r.minDwellSeconds, horizonSeconds: r.horizonSeconds, lvrWeightBps: r.lvrWeightBps, requireCostEstimate: true }
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
  for (const k of Object.keys(o)) if (!['depth', 'capUsdc', 'guard', 'rerange', 'bridgeOut', 'minEntry'].includes(k)) errors.push(`unknown setting ${k}`)
  if (o.bridgeOut !== undefined) {
    const b = o.bridgeOut as Record<string, unknown> | null
    if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some((k) => k !== 'enabled') || typeof b.enabled !== 'boolean') errors.push('bridgeOut must be { enabled: true | false }')
  }
  const B = ENGINE_SETTINGS_BOUNDS
  if (o.minEntry !== undefined) {
    const m = o.minEntry as Record<string, unknown> | null
    if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some((k) => k !== 'gasMultiple')) errors.push('minEntry must be { gasMultiple }')
    else inRange(errors, 'minEntry.gasMultiple', m.gasMultiple, B.gasMultiple)
  }
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
  if (o.rerange !== undefined) {
    if (!o.rerange || typeof o.rerange !== 'object' || Array.isArray(o.rerange)) errors.push('rerange must be an object')
    else {
      const r = o.rerange as Record<string, unknown>
      for (const k of Object.keys(r)) if (!['mode', ...LAZY_KEYS].includes(k)) errors.push(`unknown rerange setting ${k}`)
      if (r.mode !== 'eager' && r.mode !== 'lazy') errors.push("rerange.mode must be 'eager' or 'lazy'")
      // Lazy needs every number; eager may carry them, and then they must still be in bounds.
      for (const k of LAZY_KEYS) if (r.mode === 'lazy' || r[k] !== undefined) inRange(errors, `rerange.${k}`, r[k], B[k])
    }
  }
  return errors
}

/** An account key as the app stores it (a UUID today): letters, digits, `-` and `_`, at most 128 characters. */
const ACCOUNT_KEY = /^[0-9A-Za-z_-]{1,128}$/

/**
 * otto/mamoru#26 (UI: otto/mamoru-astro#25): one row of `account_cap_overrides`. `capUsdc` is whole USDC within the
 * same bounds as the environment cap, or null to remove the override (the account is back on its environment's cap).
 * The /ops writer, the app Worker and the operator all check with this. Whether a cap above the default may run is
 * decided at the operator (depth sizing applied, target-weights policy), as for the environment cap.
 */
export function validateAccountCapOverride(o: { accountKey: unknown; capUsdc: unknown }): string[] {
  const errors: string[] = []
  if (typeof o.accountKey !== 'string' || !ACCOUNT_KEY.test(o.accountKey)) errors.push('accountKey must be 1 to 128 letters, digits, - or _')
  if (o.capUsdc !== null) inRange(errors, 'capUsdc', o.capUsdc, ENGINE_SETTINGS_BOUNDS.capUsdc)
  return errors
}

/**
 * The `accountCaps` map of the engine-settings payload: lowercase account key to whole USDC, removals already left
 * out. Every reason it is not valid, empty when it is.
 */
export function validateAccountCaps(m: unknown): string[] {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['accountCaps must be an object']
  const errors: string[] = []
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (k !== k.toLowerCase()) errors.push(`accountCaps key ${k.slice(0, 8)} must be lowercase`)
    if (v === null) errors.push(`accountCaps.${k.slice(0, 8)} must be a number`)
    else errors.push(...validateAccountCapOverride({ accountKey: k, capUsdc: v }).map((e) => `accountCaps.${k.slice(0, 8)}: ${e}`))
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
  // #195: a lower multiple lets through entries whose gas is a larger share of what they place.
  if (from.minEntry && (!to.minEntry || to.minEntry.gasMultiple < from.minEntry.gasMultiple)) out.push('smaller entries go through, where gas is a larger share of what they place')
  if (!from.bridgeOut?.enabled && to.bridgeOut?.enabled) out.push('owners can move USDC from Ethereum to Base, and the relayer pays the Ethereum gas')
  if (from.depth && to.depth) {
    if (to.depth.impactBps > from.depth.impactBps) out.push('entries may move the pool price more')
    if (to.depth.shareBps > from.depth.shareBps) out.push('entries may take a bigger share of a pool')
    // Without its own value the stables pool uses the general impact limit, so compare what each side really allows.
    if ((to.depth.stablesImpactBps ?? to.depth.impactBps) > (from.depth.stablesImpactBps ?? from.depth.impactBps)) out.push('stables entries may move the pool price more')
  }
  // #172: lazy re-ranges spend less gas but leave a position out of range (all in one token, earning nothing) for
  // longer, or for good when the cost test keeps saying no; the Lab measured worst max drawdown +0.4 pp. That is the
  // direction that needs a second look. Back to eager is today's trigger, measured and live since September: not risky.
  const lf = lazyOf(from)
  const lt = lazyOf(to)
  if (!lf && lt) out.push('re-ranges become lazy: an out-of-range position waits for the buffer, the dwell and the cost test, and may stay out of range')
  if (lf && lt) {
    if (lt.edgeBufferTicks > lf.edgeBufferTicks) out.push('a position must be further out of range before it is re-ranged')
    if (lt.minDwellSeconds > lf.minDwellSeconds) out.push('a position waits longer out of range before it is re-ranged')
    // Fees and LVR both scale with the horizon and gas does not: a shorter horizon passes the cost test less often.
    if (lt.horizonSeconds < lf.horizonSeconds) out.push('the cost test counts fewer hours of fees, so it lets fewer re-ranges through')
    if (lt.lvrWeightBps > lf.lvrWeightBps) out.push('the cost test weighs LVR more, so it lets fewer re-ranges through')
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
 * policies only, as #127), the fall guard on the buckets the policy has, and the lazy re-range (#172) as
 * `range.lazy`. A new object: the PolicyVersion that grants and `policyHash` are built from is never touched, and
 * `session` and `buckets` stay the same references (`Engine.retune` checks them).
 */
export function withEngineSettings(p: PolicyVersion, s: EngineSettings): PolicyVersion {
  let out = p
  // Off means off, even if a base policy ever carried its own depth, guards or lazy re-range.
  if (!s.depth && out.depth) out = { ...out, depth: undefined }
  if (!s.guard.enabled && out.guards) out = { ...out, guards: undefined }
  const lazy = lazyOf(s)
  if (!lazy && out.range.lazy) {
    const { lazy: _drop, ...range } = out.range
    out = { ...out, range }
  }
  // Lazy replaces the near-edge trigger: `rerangeOf` reads `range.lazy` and never looks at the edge then.
  if (lazy) out = { ...out, range: { ...out.range, lazy } }
  // #195: off means only the policy minimum, even if a base policy ever carried a multiple.
  if (s.minEntry) out = { ...out, minEntryGasMultiple: s.minEntry.gasMultiple }
  else if (out.minEntryGasMultiple !== undefined) out = { ...out, minEntryGasMultiple: undefined }
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
