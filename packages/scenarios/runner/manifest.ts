import { join, resolve } from 'node:path'
import type { Hex } from '@mamoru/domain'
import type { AnvilPin } from '../fork/anvil.ts'

export const REPO_ROOT = resolve(import.meta.dir, '../../..')

export function repoPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts)
}

export type Manifest = {
  catalog: string
  source: { chain: string; chainId: number }
  fork: { block: number; blockHash: Hex; timestamp: number; chainId: number; secondChainId: number }
  anvil: AnvilPin
  alto: { package: string; version: string; installed: boolean; note: string }
  workers: { compatibilityDate: string; note: string }
  pins: Record<string, string>
  registry: { path: string; codeHashes: Record<string, Hex> }
}

export async function loadManifest(path = repoPath('scenarios/manifest.json')): Promise<Manifest> {
  return (await Bun.file(path).json()) as Manifest
}
