// Agent Lab bench (spec 008, B-01): the shape a bench run is asked for, its bounds, and the policy it maps to.
// otto/mamoru#199, phase 1 ("the bench"). Reads only the dataset manifest; never touches a wallet key, an RPC key
// or D1.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ReasonError } from '@mamoru/domain'
import { POLICIES, type PolicyVersion } from '@mamoru/policy'

export type Base = 'live' | 'guard'
export const BASES: readonly Base[] = ['live', 'guard']

export type BenchSpec = {
  windowId: string
  base: Base
  widthTicks: number
  /** Whole USDC. */
  deposit: number
}

export const WIDTH_TICKS_MIN = 500
export const WIDTH_TICKS_MAX = 8000
export const WIDTH_TICKS_STEP = 500
export const DEPOSIT_MIN_USDC = 100
export const DEPOSIT_MAX_USDC = 10_000

/** The policy a base name resolves to, before any `widthTicks` override. */
export function basePolicyOf(base: Base): PolicyVersion {
  const id = base === 'live' ? 'conservador-live-v2' : 'conservador-lab-guards-v1'
  const p = POLICIES[id]
  if (!p) throw new Error(`policy catalog has no ${id}; the lab bench expects it`)
  return p
}

/**
 * `base`'s policy with `widthTicks` applied to `range.widthTicks` only — `range.widthTicksByPool` (the stables
 * pool's own, narrower width) is untouched. `policyId` gets a `+w<width>` suffix when the width is not the base's
 * default (2000), so a result names the variant it ran.
 */
export function policyOf(spec: Pick<BenchSpec, 'base' | 'widthTicks'>): PolicyVersion {
  const base = basePolicyOf(spec.base)
  if (spec.widthTicks === base.range.widthTicks) return base
  return { ...base, policyId: `${base.policyId}+w${spec.widthTicks}`, range: { ...base.range, widthTicks: spec.widthTicks } }
}

/**
 * es-ES groups thousands with `.` (`4000` -> `4.000`). `Intl`/`toLocaleString('es-ES')` is not reliable for this:
 * Bun's bundled ICU data does not group `es-ES` the same way it groups other locales, observed on this runtime. The
 * bench's widths are a fixed, small integer range (500..8000), so the separator is inserted by hand instead.
 */
function formatTicks(n: number): string {
  return Math.trunc(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** Spanish, written from the spec alone (never from a run): what the bench shows as the strategy's name. */
export function variantLabel(spec: Pick<BenchSpec, 'base' | 'widthTicks'>): string {
  const width = spec.widthTicks
  if (spec.base === 'live') return width === 2000 ? 'Política actual' : `Rango ${formatTicks(width)} ticks`
  return width === 2000 ? 'Con guarda de caídas' : `Con guarda de caídas + ${formatTicks(width)} ticks`
}

/** Identifies a run by its inputs, independent of whether it has been computed yet. */
export function specKey(spec: BenchSpec): string {
  return `${spec.windowId}|${spec.base}|${spec.widthTicks}|${spec.deposit}`
}

/** `specKey`'s inverse. Throws `LAB_SPEC_INVALID` on a key that is not `windowId|base|widthTicks|deposit`. */
export function parseSpecKey(key: string): BenchSpec {
  const parts = key.split('|')
  if (parts.length !== 4) throw new ReasonError('LAB_SPEC_INVALID', `specKey must be windowId|base|widthTicks|deposit, got ${key}`)
  const [windowId, base, widthTicks, deposit] = parts as [string, string, string, string]
  if (base !== 'live' && base !== 'guard') throw new ReasonError('LAB_SPEC_INVALID', `specKey base must be live or guard, got ${base}`)
  return { windowId, base, widthTicks: Number(widthTicks), deposit: Number(deposit) }
}

export type ManifestWindow = {
  id: string
  file: string
  split: 'train' | 'test'
  regime: string
  label: string
  from: string
  to: string
  step: number
  market: unknown
}

type Manifest = { format: string; windows: ManifestWindow[] }

export function defaultDatasetsDir(): string {
  return `${process.env.HOME}/.local/share/mamoru-lab/datasets`
}

function readManifest(datasetsDir: string): Manifest {
  return JSON.parse(readFileSync(join(datasetsDir, 'manifest.json'), 'utf8')) as Manifest
}

/** The manifest's window by id. Throws `LAB_SPEC_INVALID` when no window of the dataset manifest has it. */
export function manifestWindow(windowId: string, datasetsDir: string = defaultDatasetsDir()): ManifestWindow {
  const w = readManifest(datasetsDir).windows.find((x) => x.id === windowId)
  if (!w) throw new ReasonError('LAB_SPEC_INVALID', `unknown window ${windowId}`)
  return w
}

/** TRAIN windows of the manifest, in its order. `seed` (B-03) and the catalog resolve the Lab's window set from this. */
export function trainWindows(datasetsDir: string = defaultDatasetsDir()): ManifestWindow[] {
  return readManifest(datasetsDir).windows.filter((w) => w.split === 'train')
}

/**
 * B-01: bounds and TRAIN-only. `LAB_SPEC_INVALID` for anything out of shape or bounds, including a window id the
 * manifest does not have at all; `LAB_HOLDOUT_DENIED` for a window the manifest has but which is TEST split — the
 * release gate's holdout, which the bench never spends (AL-12a).
 */
export function validateSpec(spec: BenchSpec, datasetsDir: string = defaultDatasetsDir()): void {
  if (spec.base !== 'live' && spec.base !== 'guard') throw new ReasonError('LAB_SPEC_INVALID', `base must be 'live' or 'guard', got ${JSON.stringify(spec.base)}`)
  if (!Number.isInteger(spec.widthTicks) || spec.widthTicks < WIDTH_TICKS_MIN || spec.widthTicks > WIDTH_TICKS_MAX || spec.widthTicks % WIDTH_TICKS_STEP !== 0)
    throw new ReasonError('LAB_SPEC_INVALID', `widthTicks must be ${WIDTH_TICKS_MIN}..${WIDTH_TICKS_MAX} in steps of ${WIDTH_TICKS_STEP}, got ${spec.widthTicks}`)
  if (!Number.isInteger(spec.deposit) || spec.deposit < DEPOSIT_MIN_USDC || spec.deposit > DEPOSIT_MAX_USDC)
    throw new ReasonError('LAB_SPEC_INVALID', `deposit must be a whole USDC amount ${DEPOSIT_MIN_USDC}..${DEPOSIT_MAX_USDC}, got ${spec.deposit}`)
  if (typeof spec.windowId !== 'string' || spec.windowId.length === 0) throw new ReasonError('LAB_SPEC_INVALID', `windowId must be a non-empty string, got ${JSON.stringify(spec.windowId)}`)
  const w = manifestWindow(spec.windowId, datasetsDir)
  if (w.split !== 'train') throw new ReasonError('LAB_HOLDOUT_DENIED', `${spec.windowId} is a TEST window; the Lab never reaches the release gate's holdout`)
}
