import { GuardReadsState } from './guard-reads-state.ts'
import { join } from 'node:path'
import { $ } from 'bun'
import { createPublicClient, getAddress, http, isAddress } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { BASE_CHAIN_ID, type Address } from '@mamoru/domain'
import { LIVE_CAP_USDC } from '@mamoru/account/live'
import { conservadorLabV4, conservadorLiveV4, POLICIES, withActionPolicy, withTestOverrides, V4_GAS_CAPS, V4_POOLS, type PolicyVersion } from '@mamoru/policy'
import { rpcBudget } from './budget.ts'
import { startLiveBundler } from './bundler.ts'
import { RpcMetrics } from './metrics.ts'
import { Operator, type OperatorConfig } from './operator.ts'
import { Relayer } from './relayer.ts'
import { startRpcProxy } from './rpc-proxy.ts'
import { startServer } from './server.ts'
import { readSnapshot, SnapshotLoop, snapshotIntervalMs, type Snapshot } from './snapshot.ts'
import { MULTICALL3 } from '@mamoru/rpc'
import { StateStore, loadOrCreateKey } from './state.ts'
import { EntryStore, withHoldValue } from './yield-entries.ts'
import { EngineSettingsSource, type SettingsOverride } from './engine-settings.ts'

/** Wraps a snapshot reader with #129's hold-value baseline, stored in its own file under `stateDir`. */
function withYieldLedger(stateDir: string, read: () => Promise<Snapshot>): () => Promise<Snapshot> {
  const entries = new EntryStore(stateDir)
  return async () => withHoldValue(await read(), entries)
}

/**
 * otto/mamoru#129: starts or stops `loop` to match the `yield_ledger` ops flag, called after every settings pull
 * (boot.ts's onChange, plus once right after the first pull). A no-op, and silent, when `on` has not changed
 * since the last call: a steady flag must not restart the loop or spam the boot log on every settings poll.
 * Returns the value to pass back in as `wasOn` next time.
 */
export function syncYieldLedgerFlag(loop: Pick<SnapshotLoop, 'start' | 'stop'>, on: boolean, wasOn: boolean, log: (line: string) => void = console.log): boolean {
  if (on === wasOn) return wasOn
  if (on) loop.start()
  else loop.stop()
  log(`[flags] yield_ledger ${on ? 'on' : 'off'}`)
  return on
}

/** `conservadorLiveV4`/`conservadorLabV4`, keyed by their own `policyId` — never in `POLICIES` (policies.ts). */
const V4_POLICIES_BY_ID: Record<string, PolicyVersion> = { [conservadorLiveV4.policyId]: conservadorLiveV4, [conservadorLabV4.policyId]: conservadorLabV4 }

/**
 * Spec 007 (otto/mamoru#151) T7: a v2/v3 `policyId` (the only kind any live account names today) resolves exactly
 * as it always has, straight from `POLICIES` — this function changes nothing for them. A v4 `policyId` resolves
 * only with both an explicit opt-in, `MAMORU_ONCHAIN_POLICY_V4=1` (read here, not from the D1 ops-flags table:
 * this runs before `EngineSettingsSource` exists, at the one point `bootOperator` picks the process-wide policy —
 * see `OPS_FLAGS.onchain_action_policy_v4`'s own doc for the D1-backed flag this mirrors for anything that CAN
 * wait for the settings pull), and a deployed `MamoruActionPolicy` address, `MAMORU_ACTION_POLICY_ADDRESS` — never
 * hardcoded, read here and nowhere else. `budgetsByPool` is deliberately left unset (`withActionPolicy` without
 * `opts.caps`): that budget is sized per account from its own deposit (`computeCaps`), which a per-process,
 * boot-time policy object cannot carry for every account at once — T7's operator activation wires it in per
 * account when it builds each account's engine config, not here. Until then precheck's budget mirror is a no-op
 * (fail safe, same as any pool `actionPolicy.budgetsByPool` does not list) and the deployed contract's own
 * `checkAction` is still the real enforcement. Off, or the address unset: an unrecognized policyId throws exactly
 * the same `unknown policy` error it always has — nothing changes for any account while the flag is off.
 */
export function resolveNamedPolicy(policyId: string, env: Record<string, string | undefined>): PolicyVersion | undefined {
  const named = POLICIES[policyId]
  if (named) return named
  if (env.MAMORU_ONCHAIN_POLICY_V4 !== '1') return undefined
  const v4 = V4_POLICIES_BY_ID[policyId]
  if (!v4) return undefined
  return deployedV4(v4, env)
}

/**
 * Spec 007 T7 (GPT-6 review of #97, P1 2/3): the v4 policy wired to BOTH deployed contracts, MamoruActionPolicy
 * (`MAMORU_ACTION_POLICY_ADDRESS`) and MamoruGasPolicy (`MAMORU_GAS_POLICY_ADDRESS`, with V4_GAS_CAPS). These two
 * addresses are what every v4 grant's guard (`toSmartSession`) binds to. Either one missing or malformed: throws.
 */
function deployedV4(v4: PolicyVersion, env: Record<string, string | undefined>): PolicyVersion {
  const deployed = env.MAMORU_ACTION_POLICY_ADDRESS
  if (!deployed) throw new Error('MAMORU_ONCHAIN_POLICY_V4=1 but MAMORU_ACTION_POLICY_ADDRESS is not set')
  const gas = env.MAMORU_GAS_POLICY_ADDRESS
  if (!gas) throw new Error('MAMORU_ONCHAIN_POLICY_V4=1 but MAMORU_GAS_POLICY_ADDRESS is not set')
  for (const [name, a] of [['MAMORU_ACTION_POLICY_ADDRESS', deployed], ['MAMORU_GAS_POLICY_ADDRESS', gas]] as const) {
    if (!isAddress(a, { strict: false }) || /^0x0{40}$/i.test(a)) throw new Error(`${name} is not a contract address`)
  }
  if (deployed.toLowerCase() === gas.toLowerCase()) throw new Error('MAMORU_ACTION_POLICY_ADDRESS and MAMORU_GAS_POLICY_ADDRESS are the same')
  return withActionPolicy(v4, getAddress(deployed), Object.values(V4_POOLS), { gasPolicy: { address: getAddress(gas), caps: V4_GAS_CAPS } })
}

/**
 * Spec 007 T7 (d): the v4 policy the renew row may move this operator's v2/v3 accounts to (same chain as the
 * operator's own policy), or undefined when the opt-in is off. Read at boot like `resolveNamedPolicy`; whether an
 * account is offered the move is the D1 flag `onchain_action_policy_v4`, read on every view.
 */
export function resolveV4Policy(chain: PolicyVersion['chain'], env: Record<string, string | undefined>): PolicyVersion | undefined {
  if (env.MAMORU_ONCHAIN_POLICY_V4 !== '1') return undefined
  return deployedV4(chain === conservadorLiveV4.chain ? conservadorLiveV4 : conservadorLabV4, env)
}

/** Accounts whose stored policy is a v4 one, when this operator was started without the v4 opt-in or its addresses. */
export function assertV4Resolvable(accounts: readonly { accountKey: string; policyId?: string }[], env: Record<string, string | undefined>): void {
  const v4Ids = new Set([conservadorLiveV4.policyId, conservadorLabV4.policyId])
  const onV4 = accounts.filter((a) => a.policyId && v4Ids.has(a.policyId))
  if (!onV4.length) return
  let resolved: PolicyVersion | undefined
  try {
    resolved = resolveV4Policy(conservadorLiveV4.chain, env) ?? resolveV4Policy(conservadorLabV4.chain, env)
  } catch {
    resolved = undefined
  }
  if (!resolved) {
    throw new Error(`${onV4.length} account(s) run the on-chain action policy (${onV4.map((a) => a.accountKey.slice(0, 8)).join(', ')}): start with MAMORU_ONCHAIN_POLICY_V4=1, MAMORU_ACTION_POLICY_ADDRESS and MAMORU_GAS_POLICY_ADDRESS set`)
  }
}

/** `git rev-parse --short HEAD` at the operator's cwd, read once at boot. 'unknown' outside a git checkout. */
async function gitShaOnce(cwd: string): Promise<string> {
  try {
    return (await $`git rev-parse --short HEAD`.cwd(cwd).quiet().text()).trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

export type BootOptions = {
  rpcUrl: string
  secret: string
  stateDir: string
  hostname?: string
  port?: number
  policyId?: string
  reviewMs?: number
  waitBlockMs?: number
  maxWaitBlocks?: number
  /** MAMORU_CAP_USDC, whole USDC (otto/mamoru#127); absent: LIVE_CAP_USDC. */
  capUsdc?: string
  /** MAMORU_DEPTH = `impactBps,shareBps[,stablesImpactBps]` (otto/mamoru#127); absent: depth sizing off. */
  depth?: string
  /** MAMORU_SETTINGS_URL (spec 006, otto/mamoru#147): the app Worker that serves the engine settings. Unset: no pull, code defaults and the env knobs above. */
  settingsUrl?: string
  /** MAMORU_RPC_TRUSTED (otto/mamoru#140 part2 #5), see parseTrustedRpc. */
  trustedRpc?: string
}

/**
 * Spec 006: with settings pulled from D1, MAMORU_DEPTH and MAMORU_CAP_USDC become an emergency override. They win for
 * the knobs they name, the boot log says so, and /metrics reports it, so they cannot be left on unseen.
 */
export function settingsOverride(c: Pick<OperatorConfig, 'capUsdc' | 'depth'>, o: Pick<BootOptions, 'capUsdc' | 'depth'>): SettingsOverride {
  const out: SettingsOverride = {}
  if (o.capUsdc) out.capUsdc = Number((c.capUsdc ?? 0n) / 1_000_000n)
  // MAMORU_DEPTH=off forces depth sizing off over D1.
  if (o.depth === 'off') out.depth = null
  else if (o.depth && c.depth) {
    const stables = c.depth.maxImpactBpsByPool?.['pool:USDC/USDT/100']
    out.depth = { impactBps: c.depth.maxImpactBps, shareBps: c.depth.maxShareBps, ...(stables === undefined ? {} : { stablesImpactBps: stables }) }
  }
  return out
}

/**
 * otto/mamoru#140 (part2 #5): MAMORU_RPC_TRUSTED, comma-separated RPC URLs of independent providers. Each must be
 * https (http only for a loopback host) and on its own host: two URLs of one provider are one opinion. They are
 * asked directly, not through the loopback proxy, and only to prove an owner signature the off-chain check refused;
 * the label in logs is the host, never the URL (it may carry a key). Unset: none. Set but fewer than two distinct
 * hosts: refused at boot.
 */
export function parseTrustedRpc(v: string | undefined): { label: string; url: string }[] {
  if (v === undefined || v.trim() === '') return []
  const out: { label: string; url: string }[] = []
  for (const raw of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    let u: URL
    try {
      u = new URL(raw)
    } catch {
      throw new Error('MAMORU_RPC_TRUSTED: an entry is not a URL')
    }
    const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`MAMORU_RPC_TRUSTED: ${u.hostname} is not https`)
    if (out.some((o) => o.label === u.hostname)) throw new Error(`MAMORU_RPC_TRUSTED: ${u.hostname} is listed twice`)
    out.push({ label: u.hostname, url: raw })
  }
  if (out.length < 2) throw new Error('MAMORU_RPC_TRUSTED needs at least two providers on distinct hosts')
  return out
}

/** Whole USDC from the env, as base units; refuses anything that is not a positive whole number up to 1e9. */
export function parseCapUsdc(v: string | undefined): bigint | undefined {
  if (v === undefined || v === '') return undefined
  if (!/^[1-9][0-9]{0,8}$/.test(v)) throw new Error(`MAMORU_CAP_USDC must be a whole number of USDC, 1 to 999999999: ${v}`)
  return BigInt(v) * 1_000_000n
}

/** `impactBps,shareBps[,stablesImpactBps]`, integers: impact 1 to 500 bps, share 1 to 5000 bps. */
export function parseDepth(v: string | undefined): OperatorConfig['depth'] {
  if (v === undefined || v === '') return undefined
  const parts = v.split(',').map((x) => x.trim())
  if (parts.length < 2 || parts.length > 3 || !parts.every((x) => /^[0-9]+$/.test(x))) throw new Error(`MAMORU_DEPTH must be impactBps,shareBps[,stablesImpactBps]: ${v}`)
  const [impact, share, stables] = parts.map(Number) as [number, number, number | undefined]
  const okImpact = (n: number) => n >= 1 && n <= 500
  if (!okImpact(impact) || share < 1 || share > 5000 || (stables !== undefined && !okImpact(stables))) throw new Error(`MAMORU_DEPTH out of range: ${v}`)
  return { maxImpactBps: impact, maxShareBps: share, ...(stables === undefined ? {} : { maxImpactBpsByPool: { 'pool:USDC/USDT/100': stables } }) }
}

/**
 * A cap above LIVE_CAP_USDC only with depth sizing on: without it, a large account would be entered as the 100 USDC
 * accounts are, whatever the pool can take. Accounts activated before keep the session limits they signed; only new
 * activations (and, in phase 2, an extend approval) get limits sized from the new cap.
 */
export function capAndDepth(o: Pick<BootOptions, 'capUsdc' | 'depth'>, policy: PolicyVersion): Pick<OperatorConfig, 'capUsdc' | 'depth'> {
  const capUsdc = parseCapUsdc(o.capUsdc)
  const depth = parseDepth(o.depth === 'off' ? undefined : o.depth)
  if (capUsdc !== undefined && capUsdc > LIVE_CAP_USDC && !depth) throw new Error('MAMORU_CAP_USDC above the default cap needs MAMORU_DEPTH')
  // Depth sizing applies to target-weights policies only: under any other, a raised cap would be entered unsized.
  if (capUsdc !== undefined && capUsdc > LIVE_CAP_USDC && policy.allocation !== 'target-weights') throw new Error(`MAMORU_CAP_USDC above the default cap needs a target-weights policy, not ${policy.policyId}`)
  return { ...(capUsdc === undefined ? {} : { capUsdc }), ...(depth ? { depth } : {}) }
}

/** Starts the operator: relayer key, state, loopback bundler, HTTP server, and the engine loops that were active. */
export async function bootOperator(o: BootOptions) {
  const bootedAt = Date.now()
  const gitSha = await gitShaOnce(process.cwd())
  const rpcMetrics = new RpcMetrics(o.stateDir)
  // Every RPC call of the operator, engine and bundler goes through the loopback proxy (getLogs splitting, no keyed URL in errors).
  const proxy = startRpcProxy(o.rpcUrl, { metrics: rpcMetrics })
  // One path per component, for the counters only: the proxy serves them all the same way.
  const via = (component: string) => `${proxy.url}c/${component}`
  o = { ...o, rpcUrl: via('engine') }
  const client = createPublicClient({ transport: http(via('operator'), { batch: true, timeout: 60_000 }) })
  const watchClient = createPublicClient({ transport: http(via('watcher'), { batch: true, timeout: 60_000 }) })
  const chainId = await client.getChainId()
  const live = chainId === BASE_CHAIN_ID && process.env.MAMORU_LIVE === '1'
  const named = resolveNamedPolicy(o.policyId ?? 'conservador-live-v2', process.env)
  if (!named) throw new Error(`unknown policy ${o.policyId}`)
  // Test-only (MAMORU_TEST_OVERRIDES=1): the fork E2E may shorten the re-range cooldown.
  const policy = withTestOverrides(named, process.env)
  const store = new StateStore(o.stateDir)
  // Review round 2: an account already moved to the on-chain action policy needs that policy to resolve after a
  // restart (funding, engine, renewals and Stop all read it). Refused at boot, with the accounts named, rather than
  // failing on each of them later while their Safes hold positions.
  assertV4Resolvable(Object.values(store.state.accounts), process.env)
  // The relayer's own reads (gas estimate, nonce, the wait for a receipt) are counted as the relayer's, like its sends.
  const relayerClient = createPublicClient({ transport: http(via('relayer'), { batch: true, timeout: 60_000 }) })
  const relayer = new Relayer(loadOrCreateKey(join(o.stateDir, 'relayer.key'), generatePrivateKey), relayerClient, via('relayer'), chainId)
  const bundler = startLiveBundler(client, relayer, chainId)
  const knobs = capAndDepth(o, policy)
  let retune = () => {}
  // otto/mamoru#129: reassigned once the snapshot loop exists (it needs `operator`, built below); the settings
  // source is wired to call whatever this holds at the time, on every change it applies, not only the first.
  let syncYieldLedger = (): void => {}
  const settings = o.settingsUrl
    ? new EngineSettingsSource({ url: o.settingsUrl, secret: o.secret, stateDir: o.stateDir, allocation: policy.allocation, override: settingsOverride(knobs, o), onChange: () => { retune(); syncYieldLedger() } })
    : null
  if (settings && settings.status().override.length) console.log(`[settings] EMERGENCY OVERRIDE from env: ${settings.status().override.join(', ')} win over D1 until removed from the env`)
  const operator = new Operator(
    {
      chainId,
      live,
      rpcUrl: o.rpcUrl,
      bundlerUrl: bundler.url,
      policy,
      reviewMs: o.reviewMs ?? 20_000,
      waitBlockMs: o.waitBlockMs ?? 2_100,
      maxWaitBlocks: o.maxWaitBlocks ?? 150,
      rpcBudget: rpcBudget(rpcMetrics),
      watchClient,
      ...knobs,
      trustedClients: parseTrustedRpc(o.trustedRpc).map((t) => ({ label: t.label, client: createPublicClient({ transport: http(t.url, { timeout: 15_000 }) }) })),
      ...(settings ? { settings, opsFlags: () => settings.flags() } : {}),
      ...(resolveV4Policy(policy.chain, process.env) ? { v4Policy: resolveV4Policy(policy.chain, process.env) } : {}),
      guardReadsState: new GuardReadsState(o.stateDir),
    },
    client,
    relayer,
    store,
  )
  // otto/mamoru#136 phase 1 + otto/mamoru#129: one read of every served Safe and its pools, with the yield-ledger
  // hold-value baseline always folded in, served on GET /snapshot. Always built when the chain supports it;
  // started and stopped by the `yield_ledger` ops flag (D1, set from /ops), not MAMORU_SNAPSHOT / MAMORU_YIELD_LEDGER
  // env vars. Without MAMORU_SETTINGS_URL there is no pull, so the flag is never learned and the loop stays off.
  let snapshot: SnapshotLoop | null = null
  // Base only for now: the reader takes pools and token addresses from the Base registry (chain.ts USDC_POOLS).
  if (MULTICALL3 && chainId === BASE_CHAIN_ID) {
    const snapshotClient = createPublicClient({ transport: http(via('snapshot'), { batch: true, timeout: 60_000 }) })
    const multicall3 = MULTICALL3
    const budget = rpcBudget(rpcMetrics)
    const read = (): Promise<Snapshot> => readSnapshot(snapshotClient, multicall3, chainId, operator.snapshotTargets())
    snapshot = new SnapshotLoop(withYieldLedger(o.stateDir, read), snapshotIntervalMs(process.env.MAMORU_SNAPSHOT_MS), () => budget.over())
  }
  let yieldLedgerOn = false
  syncYieldLedger = (): void => {
    if (!snapshot) return
    yieldLedgerOn = syncYieldLedgerFlag(snapshot, settings?.flags().yield_ledger === true, yieldLedgerOn)
  }
  const server = startServer(operator, { secret: o.secret, hostname: o.hostname ?? '127.0.0.1', port: o.port ?? 8787, rpcMetrics, gitSha, bootedAt, snapshot })
  const eth = await client.getBalance({ address: relayer.address })
  console.log(`[operator] chain ${chainId} live=${live} policy ${policy.policyId} relayer ${relayer.address} (${eth} wei) sha ${gitSha} on http://${server.hostname}:${server.port}`)
  retune = () => operator.retuneEngines()
  // The first pull before any engine resumes, so a restart never runs a review or a prepare on stale settings when the
  // endpoint answers (bounded by the pull timeout; on failure the last-known-good or the defaults run, reported).
  await settings?.pull()
  syncYieldLedger()
  operator.resume()
  settings?.start()
  return {
    operator,
    url: `http://${server.hostname}:${server.port}`,
    stop: () => {
      operator.shutdown()
      snapshot?.stop()
      settings?.stop()
      server.stop(true)
      bundler.stop()
      proxy.stop()
      rpcMetrics.persist()
    },
  }
}
