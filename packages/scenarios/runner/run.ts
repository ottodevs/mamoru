import { copyFileSync } from 'node:fs'
import { createPublicClient, http, toHex } from 'viem'
import { ReasonError, isReasonCode } from '@mamoru/domain'
import { assertCodeHashes } from '@mamoru/registry'
import { POLICIES } from '@mamoru/policy'
import { Lab } from '../fixtures/lab.ts'
import { buildBasicWorld, buildSessWorld, checkpointWorld, restoreWorld, type World, type WorldCheckpoint } from '../fixtures/world.ts'
import { anvilBinaryVersion, type AnvilHandle } from '../fork/anvil.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { setRegistryCode } from '../perturb/index.ts'
import { startEnginePort, startForkProxy, type EnginePort } from '../proxy/index.ts'
import { artifactsRoot, ensureDir, sha256File, writeJson, type ScenarioResult, type StepResult } from '../report/index.ts'
import { dumpState } from '../perturb/index.ts'
import { loadCatalog, type Scenario } from './catalog.ts'
import type { RunCtx, ScenarioCtx, StepHandler } from './context.ts'
import { LAB_STEPS, p256Gate } from './lab-steps.ts'
import { loadManifest, REPO_ROOT } from './manifest.ts'
import { SESSION_STEPS } from './session-steps.ts'
import { SnapshotBook } from './snapshots.ts'
import { WALK_STEPS } from './walk-steps.ts'
import { ENGINE_STEPS } from './engine-steps.ts'
import { buildEngineWorld } from './engine-world.ts'
import { startLabBundler, type LabBundler } from '../bundler/index.ts'
import { devAccount } from '../fixtures/lab.ts'

const STEPS: Record<string, StepHandler> = { ...SESSION_STEPS, ...LAB_STEPS, ...WALK_STEPS, ...ENGINE_STEPS }
const WORLD_ORDER = ['none', 'sess', 'engine', 'basic'] as const
/** Anvil development account that submits the lab bundler's handleOps. */
const BUNDLER_EXECUTOR = 4

function newRunId(): string {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')
  return `${t}-${toHex(crypto.getRandomValues(new Uint8Array(3))).slice(2)}`
}

async function chainIdOf(url: string): Promise<number> {
  const c = createPublicClient({ transport: http(url) })
  return Number(BigInt((await c.request({ method: 'eth_chainId' })) as string))
}

type WorldEnv = { world?: World; checkpoint?: WorldCheckpoint; snaps?: SnapshotBook; enginePort?: EnginePort; anvil?: AnvilHandle; lab?: Lab; bundler?: LabBundler; engineBaseBlock?: bigint }

async function startWorld(run: RunCtx, kind: 'sess' | 'basic' | 'engine', policyId: string): Promise<WorldEnv> {
  const { handle } = await startLabFork({ manifest: run.manifest, forkUrl: run.proxyUrl, logPath: `${run.runDir}/anvil-${kind}.log` })
  run.anvils.push(handle)
  run.rpcUrls.add(handle.url)
  const lab = new Lab(handle.url, run.manifest.fork.chainId)
  await assertCodeHashes(lab.client)
  const enginePort = startEnginePort(handle.url)
  run.rpcUrls.add(enginePort.url)
  const engineClient = createPublicClient({ transport: http(enginePort.url) })
  const engineNow = async () => Number((await engineClient.getBlock()).timestamp)
  const policy = POLICIES[policyId]
  if (!policy) throw new Error(`unknown policy ${policyId}`)
  const t = Date.now()
  const build = kind === 'sess' ? buildSessWorld : kind === 'engine' ? buildEngineWorld : buildBasicWorld
  const world = await build(lab, policy, engineNow)
  const snaps = new SnapshotBook(lab, run.runId)
  await snaps.take('S0')
  const stateSha256 = await dumpState(lab, `${run.runDir}/world-${kind}.state.json.gz`)
  await writeJson(`${run.runDir}/world-${kind}.json`, {
    fixtures: world.fixtures,
    accounts: [world.a1, world.a2].filter(Boolean).map((a) => ({ label: a.label, safe: a.safe, managedTokenIds: a.managedTokenIds, ownerTokenIds: a.ownerTokenIds, grants: a.grants.map((g) => ({ name: g.name, permissionId: g.permissionId })) })),
    stateSha256,
    buildMs: Date.now() - t,
  })
  if (kind !== 'engine') return { world, checkpoint: checkpointWorld(world), snaps, enginePort, anvil: handle, lab }
  const bundler = startLabBundler(lab, devAccount(BUNDLER_EXECUTOR))
  run.rpcUrls.add(bundler.url)
  const engineBaseBlock = (await lab.client.getBlock()).number
  return { world, checkpoint: checkpointWorld(world), snaps, enginePort, anvil: handle, lab, bundler, engineBaseBlock }
}

async function runScenario(run: RunCtx, s: Scenario, env: WorldEnv, first: boolean): Promise<ScenarioResult> {
  const t = Date.now()
  const dir = ensureDir(`${artifactsRoot(REPO_ROOT)}/${s.id}/${run.runId}`)
  const ctx: ScenarioCtx = { run, scenario: s, world: env.world, snaps: env.snaps, enginePort: env.enginePort, bundler: env.bundler, engineBaseBlock: env.engineBaseBlock, results: [], codes: new Set(), kt1: [], invariantErrors: [], dir }
  const result: ScenarioResult = { id: s.id, file: s.file.replace(`${REPO_ROOT}/`, ''), requirements: s.requirements, status: 'fail', steps: [], invariants: {}, codes: [], durationMs: 0 }
  let notExecuted = false
  try {
    if (env.snaps && env.lab) {
      if (!first) {
        await env.snaps.restore(env.snaps.get('S0'))
        await env.snaps.take('S0')
        if (env.world && env.checkpoint) restoreWorld(env.world, env.checkpoint)
      }
      for (const p of s.prepare ?? []) {
        const [k, a] = Object.entries(p)[0]!
        if (k === 'set-code') await setRegistryCode(env.lab, a.name as string)
        else if (k !== 'require-p256') throw new Error(`unknown preparation ${k}`)
      }
      try {
        await assertCodeHashes(env.lab.client)
      } catch (e) {
        if (!(e instanceof ReasonError)) throw e
        ctx.codes.add(e.code)
        result.gate = e.code
        if (s.expect.gate === e.code) {
          ctx.results.push({ step: 'registry code hashes checked before the first step', ok: true, detail: `${e.code}: ${e.detail}`, codes: [e.code] })
          ctx.results.push({ step: 'no step ran', ok: true, detail: `${s.steps.length} steps skipped` })
          return finish()
        }
        throw e
      }
      if (s.expect.gate) {
        ctx.results.push({ step: 'registry code hashes checked before the first step', ok: false, detail: `expected ${s.expect.gate}, all hashes matched` })
        return finish()
      }
      if (s.prepare?.some((p) => 'require-p256' in p)) {
        const gate = await p256Gate(env.lab.client)
        ctx.results.push({ step: 'P-256 vector checked before the first step', ok: !gate.code, detail: `${gate.code ?? 'verifies'}: ${gate.check.detail}`, codes: gate.code ? [gate.code] : [] })
        if (gate.code) {
          ctx.codes.add(gate.code)
          result.gate = gate.code
          notExecuted = true
          return finish()
        }
      }
    }
    for (const step of s.steps) {
      const [kind, args] = Object.entries(step)[0]!
      const h = STEPS[kind]
      if (!h) throw new Error(`unknown step ${kind}`)
      const r = await h(ctx, args ?? {})
      ctx.results.push(...(Array.isArray(r) ? r : [r]))
    }
    return finish()
  } catch (e) {
    result.error = String((e as Error).stack ?? e).slice(0, 2000)
    return finish()
  }

  async function finish(): Promise<ScenarioResult> {
    const inv = result.invariants
    const errs = (name: string) => ctx.invariantErrors.filter((x) => x.name === name)
    for (const name of s.invariants) {
      if (name === 'INV-CODES') {
        const bad = [...ctx.codes].filter((c) => !isReasonCode(c) && !['INCLUDED', 'NONE', 'ACCEPT'].includes(c))
        inv[name] = { ok: bad.length === 0, detail: bad.join(', ') || `${ctx.codes.size} codes, all catalogued` }
      } else if (name === 'INV-FORK-CHAIN') {
        const wrong: string[] = []
        for (const url of [env.anvil?.url, env.enginePort?.url, env.bundler?.url].filter(Boolean) as string[]) {
          const id = await chainIdOf(url).catch(() => -1)
          if (id !== run.manifest.fork.chainId) wrong.push(`${url} answered ${id}`)
        }
        inv[name] = { ok: wrong.length === 0, detail: wrong.join('; ') || 'every RPC answered the fork chain id' }
      } else if (name === 'INV-NO-ANVIL-IN-ENGINE') {
        const st = env.enginePort?.stats()
        inv[name] = { ok: true, detail: st ? `engine port forwarded ${st.forwarded} calls, 0 anvil methods; refused ${st.rejectedLabMethods}` : 'no engine in this scenario' }
      } else {
        const e = errs(name)
        inv[name] = { ok: e.length === 0, detail: e.map((x) => x.detail).slice(0, 3).join('; ') || 'held' }
      }
    }
    result.steps = ctx.results
    result.codes = [...ctx.codes].sort()
    result.kt1 = ctx.kt1.length ? ctx.kt1 : undefined
    const expectedCodes = (s.expect.codes as string[] | undefined) ?? []
    const missing = expectedCodes.filter((c) => !ctx.codes.has(c))
    if (missing.length) result.steps.push({ step: 'expected codes observed', ok: false, detail: `missing ${missing.join(', ')}` })
    const allOk = !result.error && result.steps.length > 0 && result.steps.every((x) => x.ok) && Object.values(inv).every((x) => x.ok) && ctx.kt1.length === 0
    result.status = notExecuted && !result.error ? 'not-executed' : allOk ? 'pass' : 'fail'
    result.durationMs = Date.now() - t
    await writeJson(`${dir}/result.json`, result)
    return result
  }
}

export async function runCatalog(opts: { only?: string[] } = {}): Promise<{ runId: string; results: ScenarioResult[]; reportPath: string }> {
  const manifest = await loadManifest()
  const runId = newRunId()
  const runDir = ensureDir(`${artifactsRoot(REPO_ROOT)}/runs/${runId}`)
  copyFileSync(`${REPO_ROOT}/scenarios/manifest.json`, `${runDir}/manifest.json`)
  const scenarios = await loadCatalog(manifest, opts.only)
  const binary = await anvilBinaryVersion()
  const proxy = startForkProxy()
  const run: RunCtx = { runId, manifest, proxyUrl: proxy.url, runDir, anvils: [], rpcUrls: new Set() }
  const results: ScenarioResult[] = []
  const envs: WorldEnv[] = []
  const started = Date.now()
  const onSignal = async () => {
    for (const a of run.anvils) await a.stop().catch(() => {})
    proxy.stop()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  try {
    for (const kind of WORLD_ORDER) {
      const group = scenarios.filter((s) => s.world === kind).sort((a, b) => Number(a.order === 'last') - Number(b.order === 'last'))
      if (group.length === 0) continue
      const env: WorldEnv = kind === 'none' ? {} : await startWorld(run, kind, group[0]!.policy)
      envs.push(env)
      for (const [i, s] of group.entries()) {
        process.stdout.write(`${s.id} … `)
        const r = await runScenario(run, s, env, i === 0)
        results.push(r)
        console.log(`${r.status}${r.status === 'not-executed' ? ` ${r.gate}` : ''}${r.kt1 ? ' KT-1' : ''} (${r.durationMs} ms)${r.status === 'fail' ? ` ${r.error?.split('\n')[0] ?? r.steps.filter((x) => !x.ok).map((x) => `${x.step}: ${x.detail}`).slice(0, 2).join(' | ')}` : ''}`)
      }
      if (env.anvil && kind !== 'basic') await env.anvil.stop()
      env.enginePort?.stop()
      env.bundler?.stop()
    }
  } finally {
    for (const a of run.anvils) await a.stop().catch(() => {})
    proxy.stop()
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }
  const report = {
    runId,
    catalog: manifest.catalog,
    manifestSha256: sha256File(`${runDir}/manifest.json`),
    fork: manifest.fork,
    anvil: { pinned: manifest.anvil, binary },
    alto: manifest.alto,
    workers: manifest.workers,
    pins: manifest.pins,
    policy: 'conservador-lab-v1',
    durationMs: Date.now() - started,
    summary: {
      total: results.length,
      pass: results.filter((r) => r.status === 'pass').length,
      fail: results.filter((r) => r.status === 'fail').length,
      notExecuted: results.filter((r) => r.status === 'not-executed').map((r) => ({ id: r.id, code: r.gate })),
      kt1: results.filter((r) => r.kt1).map((r) => r.id),
    },
    scenarios: results.map((r) => ({ id: r.id, status: r.status, requirements: r.requirements, codes: r.codes, kt1: r.kt1, gate: r.gate, artifacts: `scenarios/.artifacts/${r.id}/${runId}/` })),
  }
  const reportPath = `${runDir}/report.json`
  await writeJson(reportPath, report)
  return { runId, results, reportPath }
}
