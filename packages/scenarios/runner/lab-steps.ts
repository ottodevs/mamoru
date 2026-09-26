import { readdirSync } from 'node:fs'
import { encodeFunctionData, keccak256, stringToHex } from 'viem'
import { ReasonError, type Hex } from '@mamoru/domain'
import { address, erc20Abi, uniswapV3PoolAbi } from '@mamoru/registry'
import { Lab } from '../fixtures/lab.ts'
import { DEPOSIT_USDC, GAS_RESERVE_WEI, ownerExec, type World } from '../fixtures/world.ts'
import { assertNoKeyInArgv } from '../fork/anvil.ts'
import { startLabFork } from '../fork/lab-fork.ts'
import { dumpState, secondFork } from '../perturb/index.ts'
import { processCmdline, secretScan, writeJson, type StepResult } from '../report/index.ts'
import { readScenario } from './catalog.ts'
import type { ScenarioCtx, StepHandler } from './context.ts'
import { loadManifest, repoPath, type Manifest } from './manifest.ts'
import type { SnapshotRef } from './snapshots.ts'
import { diffDigest, digestHash, stateDigest, type Digest } from './state.ts'

async function expectCode(ctx: ScenarioCtx, label: string, expected: string, fn: () => Promise<unknown>): Promise<StepResult> {
  let code = 'NONE'
  let detail = ''
  try {
    await fn()
  } catch (e) {
    if (e instanceof ReasonError) {
      code = e.code
      detail = e.detail ?? ''
    } else detail = String((e as Error).message ?? e).slice(0, 160)
  }
  ctx.codes.add(code)
  return { step: label, ok: code === expected, detail: `${code}${detail ? `: ${detail}` : ''}`, codes: [code] }
}

const loadScenarioStep: StepHandler = async (ctx, args) => {
  const file = repoPath(args.file as string)
  const manifest = args.manifest ? await loadManifest(repoPath(args.manifest as string)) : ctx.run.manifest
  return expectCode(ctx, `runner reads ${args.file}`, args.expect as string, () => readScenario(file, manifest))
}

/** Keyed URL shapes used only to prove they never reach argv. They are not real endpoints. */
const SAMPLE_KEYED_URLS = ['https://base-mainnet.example.invalid/v2/0123456789abcdef0123456789abcdef', 'https://user:pass@rpc.example.invalid/', 'https://rpc.example.invalid/?apikey=0123456789']

const startForkStep: StepHandler = async (ctx, args) => {
  const run = ctx.run
  const manifest: Manifest = args.manifest ? await loadManifest(repoPath(args.manifest as string)) : run.manifest
  const urls =
    args.forkUrl === 'env'
      ? [process.env.RPC_URL ?? '']
      : args.forkUrl === 'keyed-samples'
        ? SAMPLE_KEYED_URLS
        : [run.proxyUrl]
  const out: StepResult[] = []
  for (const [i, forkUrl] of urls.entries()) {
    const label = `start fork${args.chainId ? ` chain ${args.chainId}` : ''}${args.rewriteChainId ? ` answering ${args.rewriteChainId}` : ''}${args.manifest ? ` with ${args.manifest}` : ''}${args.forkBlock === null ? ' without block' : ''}${args.forkUrl ? ` (${args.forkUrl} #${i + 1})` : ''}`
    out.push(
      await expectCode(ctx, label, args.expect as string, async () => {
        const { handle } = await startLabFork({
          manifest,
          forkUrl,
          logPath: `${ctx.dir}/anvil-start-${i}.log`,
          chainId: args.chainId as number | undefined,
          forkBlock: args.forkBlock as number | null | undefined,
          rewriteChainId: args.rewriteChainId as number | undefined,
        })
        run.anvils.push(handle)
        await handle.stop()
      }),
    )
  }
  return out
}

const argvGuardStep: StepHandler = async (ctx, args) => {
  const url = args.url === 'env' ? (process.env.RPC_URL ?? '') : SAMPLE_KEYED_URLS[0]!
  return expectCode(ctx, `argv guard with ${args.url === 'env' ? 'the upstream URL' : 'a keyed URL'}`, args.expect as string, async () => assertNoKeyInArgv(['--fork-url', url]))
}

const processListStep: StepHandler = async (ctx) => {
  const secret = process.env.RPC_URL
  const problems: string[] = []
  let checked = 0
  for (const a of ctx.run.anvils) {
    const cmd = processCmdline(a.pid)
    if (cmd.length === 0) continue
    checked++
    try {
      assertNoKeyInArgv(cmd.slice(1))
    } catch {
      problems.push(`anvil ${a.pid} argv carries a non-loopback URL`)
    }
  }
  for (const pid of readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
    const cmd = processCmdline(Number(pid)).join(' ')
    if (secret && cmd.includes(secret)) problems.push(`process ${pid} carries the upstream URL`)
  }
  if (checked === 0) problems.push('no running anvil of this run to inspect')
  return { step: 'process list shows only loopback fork URLs', ok: problems.length === 0, detail: problems.join('; ') || `${checked} anvil processes inspected` }
}

const secretScanStep: StepHandler = async (ctx) => {
  const { files, findings } = secretScan([repoPath('scenarios/.artifacts')])
  await writeJson(`${ctx.dir}/secret-scan.json`, { files, findings })
  return { step: 'no secret or personal data in artifacts and logs', ok: findings.length === 0 && files > 0, detail: findings.slice(0, 5).join('; ') || `${files} files clean` }
}

function world(ctx: ScenarioCtx): World {
  if (!ctx.world || !ctx.snaps) throw new Error(`${ctx.scenario.id} needs a world`)
  return ctx.world
}

const digests = new Map<string, Digest>()

const snapshotStep: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const name = args.name as string
  await ctx.snaps!.take(name)
  digests.set(name, await stateDigest(w))
  return { step: `snapshot ${name} in run ${ctx.run.runId}`, ok: true }
}

const restoreStep: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const name = args.name as string
  await ctx.snaps!.restore(ctx.snaps!.get(name))
  await ctx.snaps!.take(name)
  const diff = diffDigest(digests.get(name)!, await stateDigest(w))
  return { step: `back to ${name}`, ok: diff.length === 0, detail: diff.length ? diff.slice(0, 4).join('; ') : 'balances, owners and nonces equal to the snapshot' }
}

const restoreForeignStep: StepHandler = async (ctx, args) => {
  const w = world(ctx)
  const name = args.name as string
  const ref = ctx.snaps!.get(name)
  const foreign: SnapshotRef = { ...ref, runId: args.fromRun as string }
  const before = await stateDigest(w)
  const blockBefore = await w.lab.client.getBlockNumber()
  const r = await expectCode(ctx, `run ${foreign.runId} uses snapshot ${name}`, args.expect as string, () => ctx.snaps!.restore(foreign, foreign.runId))
  const diff = diffDigest(before, await stateDigest(w))
  const blockAfter = await w.lab.client.getBlockNumber()
  const untouched = diff.length === 0 && blockAfter === blockBefore
  return [r, { step: 'the runner did not revert', ok: untouched, detail: untouched ? 'state and block unchanged' : diff.join('; ') }]
}

const mutateStateStep: StepHandler = async (ctx) => {
  const w = world(ctx)
  const before = await stateDigest(w)
  const r = await ownerExec(w.lab, w.relayer, w.a1, {
    to: address('USDC'),
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [w.a1.backupOwner.address, 1_000_000n] }),
  })
  await w.lab.setBalance(w.a1.safe, 1n)
  const diff = diffDigest(before, await stateDigest(w))
  return { step: 'change the state (owner transfer, balance write)', ok: r.ok && diff.length > 0, detail: `${diff.length} fields changed` }
}

const fixtureBalancesStep: StepHandler = async (ctx) => {
  const w = world(ctx)
  const usdc = await w.lab.balanceOf('USDC', w.a1.safe)
  const eth = await w.lab.client.getBalance({ address: w.a1.safe })
  const ok = usdc === DEPOSIT_USDC && eth === GAS_RESERVE_WEI
  return { step: 'fixture balances are the declared ones', ok, detail: `USDC ${usdc} (declared ${DEPOSIT_USDC}), ETH ${eth} (declared ${GAS_RESERVE_WEI})` }
}

const enginePortCallStep: StepHandler = async (ctx, args) => {
  const port = ctx.enginePort!
  const w = world(ctx)
  const method = args.method as string
  const before = port.stats()
  const res = await fetch(port.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [w.a1.safe, '0xde0b6b3a7640000'] }),
  })
  const json = (await res.json()) as { error?: { code: number } }
  const after = port.stats()
  const ethAfter = await w.lab.client.getBalance({ address: w.a1.safe })
  const rejected = json.error?.code === -32601 && after.rejectedLabMethods === before.rejectedLabMethods + 1 && ethAfter !== 1_000_000_000_000_000_000n
  return { step: `${method} through the engine port`, ok: rejected, detail: rejected ? 'refused by the proxy, nothing forwarded' : JSON.stringify(json) }
}

async function observation(w: World): Promise<Hex> {
  const d = await stateDigest(w)
  const s = await w.lab.client.readContract({ address: address('pool:USDC/cbBTC/500'), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  d['pool.slot0'] = `${s[0]}|${s[1]}`
  return digestHash(d)
}

const reproStep: StepHandler = async (ctx) => {
  const w = world(ctx)
  const run = ctx.run
  const statePath = `${ctx.dir}/state.json.gz`
  const stateSha256 = await dumpState(w.lab, statePath)
  const obs1 = await observation(w)
  const fork2 = await secondFork(run.manifest, run.proxyUrl, { chainId: run.manifest.fork.chainId, statePath, logPath: `${ctx.dir}/anvil-repro.log` })
  run.anvils.push(fork2)
  run.rpcUrls.add(fork2.url)
  let obs2: Hex
  try {
    obs2 = await observation({ ...w, lab: new Lab(fork2.url, run.manifest.fork.chainId) })
  } finally {
    await fork2.stop()
  }
  const same = obs1 === obs2
  const code = same ? 'LAB_REPRO_OK' : 'NONE'
  ctx.codes.add(code)
  await writeJson(`${ctx.dir}/repro.json`, {
    code,
    stateSha256,
    anvil: run.manifest.anvil,
    block: run.manifest.fork.block,
    blockHash: run.manifest.fork.blockHash,
    fixtures: w.fixtures,
    observationHash: obs1,
    reproducedObservationHash: obs2,
  })
  return { step: 'dump, load in another anvil of the same version, observe again', ok: same, detail: `${code}, state sha256 ${stateSha256.slice(0, 16)}…`, codes: [code] }
}

const noopStep: StepHandler = async () => ({ step: 'scenario body', ok: true })

export const LAB_STEPS: Record<string, StepHandler> = {
  'load-scenario': loadScenarioStep,
  'start-fork': startForkStep,
  'argv-guard': argvGuardStep,
  'process-list': processListStep,
  'secret-scan': secretScanStep,
  snapshot: snapshotStep,
  restore: restoreStep,
  'restore-foreign': restoreForeignStep,
  'mutate-state': mutateStateStep,
  'check-fixture-balances': fixtureBalancesStep,
  'engine-port-call': enginePortCallStep,
  repro: reproStep,
  noop: noopStep,
}