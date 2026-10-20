import { GuardReadsState } from './guard-reads-state.ts'
import { join } from 'node:path'
import { $ } from 'bun'
import { TransactionReceiptNotFoundError, createPublicClient, getAddress, http, isAddress, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { BASE_CHAIN_ID, type Address } from '@mamoru/domain'
import { LIVE_CAP_USDC } from '@mamoru/account/live'
import { conservadorLabV4, conservadorLabV5, conservadorLiveV4, conservadorLiveV5, POLICIES, withActionPolicy, withTestOverrides, V4_GAS_CAPS, V4_POOLS, type PolicyVersion } from '@mamoru/policy'
import { rpcBudget } from './budget.ts'
import { startLiveBundler } from './bundler.ts'
import { RpcMetrics } from './metrics.ts'
import { Operator, type OperatorConfig } from './operator.ts'
import { Relayer } from './relayer.ts'
import { BridgeOut, ETHEREUM_CHAIN_ID, L1_BUNDLER_TIMEOUT_MS, L1_HANDLE_OPS_GAS, L1_USDC } from './bridge-out.ts'
import { L1Bundler, paymasterFromEnv } from './paymaster.ts'
import { startRpcProxy } from './rpc-proxy.ts'
import { startServer } from './server.ts'
import { readSnapshot, SnapshotLoop, snapshotIntervalMs, type Snapshot } from './snapshot.ts'
import { MULTICALL3 } from '@mamoru/rpc'
import { StateStore, loadOrCreateKey } from './state.ts'
import { EntryStore, withHoldValue } from './yield-entries.ts'
import { withReceipts, type BlockTimeReader, type ReceiptReader, type ReceiptSource, type SafeBlockReader } from './yield-receipts.ts'
import { EngineSettingsSource, type SettingsOverride } from './engine-settings.ts'

/**
 * Wraps a snapshot reader with #129's hold-value baseline, stored in its own file under `stateDir`, and the per-day
 * gas and collected fees of every account's engine ops (yield-receipts.ts), kept on their stored rows.
 */
function withYieldLedger(stateDir: string, read: () => Promise<Snapshot>, receipts: { source: ReceiptSource; readReceipt: ReceiptReader; blockTime: BlockTimeReader; safeBlock: SafeBlockReader }): () => Promise<Snapshot> {
  const entries = new EntryStore(stateDir)
  const tried = new Map<string, number>()
  return async () => withReceipts(withHoldValue(await read(), entries), receipts.source, receipts.readReceipt, receipts.blockTime, receipts.safeBlock, tried)
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
/** otto/mamoru#151: `conservadorLiveV5`/`conservadorLabV5`, the policy version for MamoruActionPolicyV2 — never in `POLICIES` either. */
const V5_POLICIES_BY_ID: Record<string, PolicyVersion> = { [conservadorLiveV5.policyId]: conservadorLiveV5, [conservadorLabV5.policyId]: conservadorLabV5 }

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
  const v5 = V5_POLICIES_BY_ID[policyId]
  if (v5) return env.MAMORU_ACTION_POLICY_V2_ADDRESS ? deployedV5(v5, env) : undefined
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
 * otto/mamoru#151: the v5 policy wired to MamoruActionPolicyV2 (`MAMORU_ACTION_POLICY_V2_ADDRESS`, a new address, not
 * the V1 one) and the same MamoruGasPolicy (`MAMORU_GAS_POLICY_ADDRESS`), marked `contractVersion: 2` (the engine reads
 * the guardian pause). Needs the same opt-in as v4. Malformed, zero, or equal to the V1 or the gas policy address:
 * throws, so a V1 address can never stand in for V2 (V1 refuses increase and the deadline: the engine would stall).
 */
function deployedV5(v5: PolicyVersion, env: Record<string, string | undefined>): PolicyVersion {
  const v2 = env.MAMORU_ACTION_POLICY_V2_ADDRESS
  if (!v2) throw new Error('MAMORU_ACTION_POLICY_V2_ADDRESS is not set')
  const gas = env.MAMORU_GAS_POLICY_ADDRESS
  if (!gas) throw new Error('MAMORU_ACTION_POLICY_V2_ADDRESS is set but MAMORU_GAS_POLICY_ADDRESS is not')
  for (const [name, a] of [['MAMORU_ACTION_POLICY_V2_ADDRESS', v2], ['MAMORU_GAS_POLICY_ADDRESS', gas]] as const) {
    if (!isAddress(a, { strict: false }) || /^0x0{40}$/i.test(a)) throw new Error(`${name} is not a contract address`)
  }
  if (v2.toLowerCase() === gas.toLowerCase()) throw new Error('MAMORU_ACTION_POLICY_V2_ADDRESS and MAMORU_GAS_POLICY_ADDRESS are the same')
  if (env.MAMORU_ACTION_POLICY_ADDRESS && v2.toLowerCase() === env.MAMORU_ACTION_POLICY_ADDRESS.toLowerCase()) throw new Error('MAMORU_ACTION_POLICY_V2_ADDRESS is the V1 address (MAMORU_ACTION_POLICY_ADDRESS)')
  return withActionPolicy(v5, getAddress(v2), Object.values(V4_POOLS), { gasPolicy: { address: getAddress(gas), caps: V4_GAS_CAPS }, contractVersion: 2 })
}

/**
 * otto/mamoru#151: the v5 policy (MamoruActionPolicyV2) the renew row may move this operator's v2/v3/v4 accounts to,
 * or undefined when the v4 opt-in is off or `MAMORU_ACTION_POLICY_V2_ADDRESS` is unset (V2 undeployed: nothing of v5
 * exists). Whether an account is offered the move is the D1 flag `onchain_action_policy_v5`, read on every view.
 */
export function resolveV5Policy(chain: PolicyVersion['chain'], env: Record<string, string | undefined>): PolicyVersion | undefined {
  if (env.MAMORU_ONCHAIN_POLICY_V4 !== '1' || !env.MAMORU_ACTION_POLICY_V2_ADDRESS) return undefined
  return deployedV5(chain === conservadorLiveV5.chain ? conservadorLiveV5 : conservadorLabV5, env)
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
  const v5Ids = new Set([conservadorLiveV5.policyId, conservadorLabV5.policyId])
  const onV5 = accounts.filter((a) => a.policyId && v5Ids.has(a.policyId))
  if (onV5.length) {
    let v5: PolicyVersion | undefined
    try {
      v5 = resolveV5Policy(conservadorLiveV5.chain, env) ?? resolveV5Policy(conservadorLabV5.chain, env)
    } catch {
      v5 = undefined
    }
    if (!v5) throw new Error(`${onV5.length} account(s) run MamoruActionPolicyV2 (${onV5.map((a) => a.accountKey.slice(0, 8)).join(', ')}): start with MAMORU_ONCHAIN_POLICY_V4=1, MAMORU_ACTION_POLICY_V2_ADDRESS and MAMORU_GAS_POLICY_ADDRESS set`)
  }
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
  /** Ethereum Mainnet RPC for bridge-out (#133). Unset: bridge-out off. */
  l1RpcUrl?: string
  /** #180: ERC-20 paymaster on Ethereum (keyed URL, never logged) and its kind (pimlico | candide; else from the host). Set: moves are userOps paid in USDC, bundled by the operator itself. */
  l1PaymasterUrl?: string
  l1Paymaster?: string
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
  const relayerKey = loadOrCreateKey(join(o.stateDir, 'relayer.key'), generatePrivateKey)
  const relayer = new Relayer(relayerKey, relayerClient, via('relayer'), chainId)
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
      ...(resolveV5Policy(policy.chain, process.env) ? { v5Policy: resolveV5Policy(policy.chain, process.env) } : {}),
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
    const receipts = {
      source: { accounts: () => Object.values(store.state.accounts).map((a) => ({ accountKey: a.accountKey, safe: a.ctx.address, ops: a.ops })), save: () => store.save() },
      // Same transport as the read: these calls count against the snapshot's RPC budget, not the engines'.
      readReceipt: async (hash: Hex) => {
        const r = await snapshotClient.getTransactionReceipt({ hash }).catch((e: unknown) => {
          if (e instanceof TransactionReceiptNotFoundError) return null
          throw e
        })
        return r ? { logs: r.logs, blockNumber: r.blockNumber } : null
      },
      blockTime: async (blockNumber: bigint) => (await snapshotClient.getBlock({ blockNumber })).timestamp,
      safeBlock: async () => (await snapshotClient.getBlock({ blockTag: 'safe' })).number,
    }
    snapshot = new SnapshotLoop(withYieldLedger(o.stateDir, read, receipts), snapshotIntervalMs(process.env.MAMORU_SNAPSHOT_MS), () => budget.over())
  }
  let yieldLedgerOn = false
  syncYieldLedger = (): void => {
    if (!snapshot) return
    yieldLedgerOn = syncYieldLedgerFlag(snapshot, settings?.flags().yield_ledger === true, yieldLedgerOn)
  }
  // Moving USDC found on Ethereum to Base (#133): off unless an Ethereum RPC is configured. Same relayer key, its own nonce space on Ethereum.
  // The RPC URL is a credential: env, like BASE_RPC_URL. Whether owners may use it is the /ops flag (engine settings
  // bridgeOut), per account, off by default and without a settings source.
  let bridgeOut: BridgeOut | null = null
  if (o.l1RpcUrl) {
    const l1 = createPublicClient({ transport: http(o.l1RpcUrl, { timeout: 30_000 }) })
    // viem errors quote the request URL, which carries the provider key: only fixed text leaves this block.
    let wei: bigint
    try {
      if ((await l1.getChainId()) !== ETHEREUM_CHAIN_ID) throw new Error('wrong chain')
      wei = await l1.getBalance({ address: relayer.address })
    } catch (e) {
      throw new Error(`MAMORU_L1_RPC_URL is not a reachable Ethereum Mainnet RPC (${e instanceof Error && e.message === 'wrong chain' ? 'wrong chain' : 'unreachable'})`)
    }
    const enabledFor = (accountKey: string) => settings?.forAccount(accountKey).settings.bridgeOut?.enabled === true
    const l1Relayer = new Relayer(relayerKey, l1, o.l1RpcUrl, ETHEREUM_CHAIN_ID)
    // #180: with an ERC-20 paymaster the account pays its own gas in USDC. The operator bundles the userOp itself on a
    // second loopback bundler (no ERC-7562 factory-stake rule, so the Safe deploys in initCode): the relayer fronts
    // handleOps within the bridge-out gas guard and the EntryPoint refunds it from the paymaster's deposit.
    const paymaster = paymasterFromEnv(o.l1Paymaster, o.l1PaymasterUrl, ETHEREUM_CHAIN_ID, L1_USDC)
    let guard: ReturnType<BridgeOut['bundlerGuard']> | null = null
    const l1Bundler = paymaster
      ? startLiveBundler(l1, l1Relayer, ETHEREUM_CHAIN_ID, {
          handleOpsGas: L1_HANDLE_OPS_GAS,
          label: 'l1-bundler',
          guard: {
            before: async (k, g) => {
              if (!guard) throw new Error('not ready')
              await guard.before(k, g)
            },
            sending: (k, w, g) => guard!.sending(k, w, g),
            sent: (k, h, n) => guard?.sent(k, h, n),
            after: (k, c, r) => guard?.after(k, c, r),
            failed: (k, signed) => guard?.failed(k, signed),
          },
        })
      : null
    const aa = paymaster && l1Bundler ? { bundler: new L1Bundler(l1Bundler.url, fetch, L1_BUNDLER_TIMEOUT_MS), paymaster } : null
    // CCTP mints on Base go through the operator's Base client and relayer. The minter and the timer run whatever the
    // paymaster config: after a rollback to the relayer path, burns already made still get minted, and open bundle
    // reservations still settle.
    bridgeOut = new BridgeOut(l1, l1Relayer, o.stateDir, fetch, Date.now, process.env.ACROSS_API_KEY, enabledFor, aa, chainId === BASE_CHAIN_ID ? { client, relayer } : null)
    guard = bridgeOut.bundlerGuard()
    const bo = bridgeOut
    setInterval(() => void bo.tick(), 60_000)
    void bo.tick()
    if (aa) console.log(`[operator] bridge-out uses userOps on Ethereum: gas paid in USDC through the ${paymaster!.name} paymaster, bundled by the operator`)
    if (bo.pendingCctp() > 0) console.log(`[operator] bridge-out: ${bo.pendingCctp()} CCTP move(s) to finish on Base`)
    console.log(`[operator] bridge-out from Ethereum available (on per account from /ops), relayer ${relayer.address} (${wei} wei on Ethereum)`)
  }
  const server = startServer(operator, { secret: o.secret, hostname: o.hostname ?? '127.0.0.1', port: o.port ?? 8787, rpcMetrics, gitSha, bootedAt, snapshot, bridgeOut })
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
