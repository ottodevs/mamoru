import { readdirSync } from 'node:fs'
import { FORBIDDEN_LAB_CHAIN_IDS, ReasonError, type Hex } from '@mamoru/domain'
import type { Manifest } from './manifest.ts'
import { repoPath } from './manifest.ts'

export type Step = Record<string, Record<string, unknown>>

export type Scenario = {
  id: string
  requirements: string[]
  titan26?: string
  fork: { source: string; block: number; blockHash: Hex; chainId: number }
  policy: string
  world: 'sess' | 'basic' | 'none'
  order?: 'last'
  fixtures: string[]
  prepare?: Step[]
  steps: Step[]
  expect: Record<string, unknown>
  invariants: string[]
  file: string
}

/**
 * Gates a scenario before its first step (scenarios.md §1, rule 2): the fork
 * block is required, its hash must match the catalog manifest, and the chain
 * id can never be Base or Base Sepolia.
 */
export function gateScenario(raw: unknown, manifest: Manifest, file: string): Scenario {
  const s = raw as Partial<Scenario> & { fork?: Partial<Scenario['fork']> }
  if (!s || typeof s !== 'object' || !s.id) throw new Error(`${file}: not a scenario`)
  const fork = s.fork
  if (!fork || fork.block === undefined || fork.block === null || !Number.isInteger(fork.block)) {
    throw new ReasonError('LAB_BLOCK_REQUIRED', `${s.id}: fork.block`)
  }
  if (typeof fork.chainId !== 'number' || FORBIDDEN_LAB_CHAIN_IDS.includes(fork.chainId)) {
    throw new ReasonError('LAB_CHAIN_ID_FORBIDDEN', `${s.id}: chain id ${fork.chainId}`)
  }
  if (fork.block !== manifest.fork.block || typeof fork.blockHash !== 'string' || fork.blockHash.toLowerCase() !== manifest.fork.blockHash.toLowerCase()) {
    throw new ReasonError('LAB_BLOCK_HASH_MISMATCH', `${s.id}: block ${fork.block}`)
  }
  if (fork.chainId !== manifest.fork.chainId) {
    throw new ReasonError('LAB_CHAIN_ID_FORBIDDEN', `${s.id}: chain id ${fork.chainId} is not the catalog fork chain`)
  }
  for (const k of ['requirements', 'fixtures', 'steps', 'invariants'] as const) {
    if (!Array.isArray(s[k])) throw new Error(`${file}: ${k} must be a list`)
  }
  if (!s.policy || !s.world || !s.expect) throw new Error(`${file}: policy, world and expect are required`)
  return { ...(s as Scenario), file }
}

export async function readScenario(file: string, manifest: Manifest): Promise<Scenario> {
  const text = await Bun.file(file).text()
  return gateScenario(Bun.YAML.parse(text), manifest, file)
}

export async function loadCatalog(manifest: Manifest, only?: string[]): Promise<Scenario[]> {
  const dir = repoPath('scenarios/catalog')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .sort()
  const out: Scenario[] = []
  for (const f of files) {
    const s = await readScenario(`${dir}/${f}`, manifest)
    if (`${s.id}.yaml` !== f) throw new Error(`${f}: id ${s.id} does not match the file name`)
    if (!only || only.includes(s.id)) out.push(s)
  }
  return out
}
