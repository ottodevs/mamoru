import type { Manifest } from './manifest.ts'
import type { Scenario } from './catalog.ts'
import type { SnapshotBook } from './snapshots.ts'
import type { World } from '../fixtures/world.ts'
import type { AnvilHandle } from '../fork/anvil.ts'
import type { EnginePort } from '../proxy/index.ts'
import type { LabBundler } from '../bundler/index.ts'
import type { StepResult } from '../report/index.ts'

export type RunCtx = {
  runId: string
  manifest: Manifest
  proxyUrl: string
  runDir: string
  /** Every anvil this run started, for the process-list check. */
  anvils: AnvilHandle[]
  /** Every RPC URL the run used, for INV-FORK-CHAIN. */
  rpcUrls: Set<string>
}

export type ScenarioCtx = {
  run: RunCtx
  scenario: Scenario
  world?: World
  snaps?: SnapshotBook
  enginePort?: EnginePort
  /** Engine world: the loopback bundler and the block the engine was registered at. */
  bundler?: LabBundler
  engineBaseBlock?: bigint
  results: StepResult[]
  codes: Set<string>
  kt1: string[]
  invariantErrors: { name: string; detail: string }[]
  dir: string
}

export type StepHandler = (ctx: ScenarioCtx, args: Record<string, unknown>) => Promise<StepResult | StepResult[]>
