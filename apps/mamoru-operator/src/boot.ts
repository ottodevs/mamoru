import { GuardReadsState } from './guard-reads-state.ts'
import { join } from 'node:path'
import { $ } from 'bun'
import { TransactionReceiptNotFoundError, createPublicClient, getAddress, http, isAddress, type Hex, type PublicClient } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { BASE_CHAIN_ID, chainOf, chainWritesOptIn, isChainId, type Address } from '@mamoru/domain'
import { address as registryAddress, baseRegistry, entry, isDeployed, messageTransmitterV2Abi, monadRegistry, registryFor, type Registry } from '@mamoru/registry'
import { LIVE_CAP_USDC } from '@mamoru/account/live'
import { assertPolicyChain, conservadorLabV4, conservadorLabV5, conservadorLabV6, conservadorLiveV4, conservadorLiveV5, conservadorLiveV6, labWmonUsdcMonadV5, liveWmonUsdcMonadV5, MONAD_GAS_CAPS, MONAD_LAB_POLICIES, MONAD_LIVE_POLICIES, POLICIES, withActionPolicy, withTestOverrides, V4_GAS_CAPS, V4_POOLS, V4_POOLS_MONAD, type PolicyVersion } from '@mamoru/policy'
import { rpcBudget } from './budget.ts'
import { startLiveBundler } from './bundler.ts'
import { RpcMetrics } from './metrics.ts'
import { livePool, writeRefusal } from './chain.ts'
import { writeRegistry } from './chain-writes.ts'
import { Operator, type OperatorConfig } from './operator.ts'
import { Relayer } from './relayer.ts'
import { BRIDGE_MONAD_CHAIN_ID, MonadBridge } from './bridge-monad.ts'
import { CCTP_DOMAIN_MONAD, MESSAGE_TRANSMITTER_V2 } from './cctp.ts'
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
/** otto/mamoru#214: `conservadorLiveV6`/`conservadorLabV6` (Base + Monad growth, bridge-out behind MamoruPauseGate) — never in `POLICIES` either. */
const V6_POLICIES_BY_ID: Record<string, PolicyVersion> = { [conservadorLiveV6.policyId]: conservadorLiveV6, [conservadorLabV6.policyId]: conservadorLabV6 }

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
export function resolveNamedPolicy(policyId: string, env: Record<string, string | undefined>, opts: { chainWrites?: boolean } = {}): PolicyVersion | undefined {
  const named = POLICIES[policyId] ?? MONAD_LAB_POLICIES[policyId]
  if (named) return named
  // otto/mamoru#61: a Monad mainnet policy resolves only for an operator opted into writing to Monad (chainWrites).
  if (opts.chainWrites && MONAD_LIVE_POLICIES[policyId]) return MONAD_LIVE_POLICIES[policyId]
  // otto/mamoru#214: the Monad sleeve's v5 policy resolves only wired to the two Monad contracts, and throws without them.
  // The live one also needs the chain-writes opt-in (as v1 above); the lab twin is the fork's.
  const monadV5 = MONAD_V5_BY_ID[policyId]
  if (monadV5 && (monadV5.chain !== 'monad' || opts.chainWrites)) return deployedMonadV5(monadV5, env)
  if (env.MAMORU_ONCHAIN_POLICY_V4 !== '1') return undefined
  const v5 = V5_POLICIES_BY_ID[policyId]
  if (v5) return env.MAMORU_ACTION_POLICY_V2_ADDRESS ? deployedV5(v5, env) : undefined
  // otto/mamoru#214: v6 also needs MamoruPauseGate; without it (or V2) it is not offered. Boot refuses it as the default (assertBootPolicies).
  const v6 = V6_POLICIES_BY_ID[policyId]
  if (v6) return env.MAMORU_ACTION_POLICY_V2_ADDRESS && env.MAMORU_PAUSE_GATE_ADDRESS ? deployedV6(v6, env) : undefined
  const v4 = V4_POLICIES_BY_ID[policyId]
  if (!v4) return undefined
  return deployedV4(v4, env)
}

/** otto/mamoru#214: the Monad sleeve's v5 policies by id. Not in MONAD_LIVE_POLICIES / MONAD_LAB_POLICIES: those resolve without addresses. */
const MONAD_V5_BY_ID: Record<string, PolicyVersion> = { [liveWmonUsdcMonadV5.policyId]: liveWmonUsdcMonadV5, [labWmonUsdcMonadV5.policyId]: labWmonUsdcMonadV5 }

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
function deployedV5(v5: PolicyVersion, env: Record<string, string | undefined>, on: { pools: typeof V4_POOLS | typeof V4_POOLS_MONAD; gasCaps: typeof V4_GAS_CAPS } = { pools: V4_POOLS, gasCaps: V4_GAS_CAPS }): PolicyVersion {
  const v2 = env.MAMORU_ACTION_POLICY_V2_ADDRESS
  if (!v2) throw new Error('MAMORU_ACTION_POLICY_V2_ADDRESS is not set')
  const gas = env.MAMORU_GAS_POLICY_ADDRESS
  if (!gas) throw new Error('MAMORU_ACTION_POLICY_V2_ADDRESS is set but MAMORU_GAS_POLICY_ADDRESS is not')
  for (const [name, a] of [['MAMORU_ACTION_POLICY_V2_ADDRESS', v2], ['MAMORU_GAS_POLICY_ADDRESS', gas]] as const) {
    if (!isAddress(a, { strict: false }) || /^0x0{40}$/i.test(a)) throw new Error(`${name} is not a contract address`)
  }
  if (v2.toLowerCase() === gas.toLowerCase()) throw new Error('MAMORU_ACTION_POLICY_V2_ADDRESS and MAMORU_GAS_POLICY_ADDRESS are the same')
  if (env.MAMORU_ACTION_POLICY_ADDRESS && v2.toLowerCase() === env.MAMORU_ACTION_POLICY_ADDRESS.toLowerCase()) throw new Error('MAMORU_ACTION_POLICY_V2_ADDRESS is the V1 address (MAMORU_ACTION_POLICY_ADDRESS)')
  return withActionPolicy(v5, getAddress(v2), Object.values(on.pools), { gasPolicy: { address: getAddress(gas), caps: on.gasCaps }, contractVersion: 2 })
}

/**
 * otto/mamoru#214: the v6 policy: v5's wiring (MamoruActionPolicyV2, MamoruGasPolicy, contractVersion 2) plus
 * `MAMORU_PAUSE_GATE_ADDRESS`, the MamoruPauseGate its bridge-out grant is encoded with. Required: unset, malformed, zero
 * or equal to the V2, V1 or gas policy address throws, so v6 is never built without a gate that stops a bridge while the
 * guardian has the account paused.
 */
function deployedV6(v6: PolicyVersion, env: Record<string, string | undefined>): PolicyVersion {
  const gate = env.MAMORU_PAUSE_GATE_ADDRESS
  if (!gate) throw new Error('MAMORU_PAUSE_GATE_ADDRESS is not set')
  if (!isAddress(gate, { strict: false }) || /^0x0{40}$/i.test(gate)) throw new Error('MAMORU_PAUSE_GATE_ADDRESS is not a contract address')
  const base = deployedV5(v6, env)
  const ap = base.actionPolicy!
  for (const [name, other] of [['MAMORU_ACTION_POLICY_V2_ADDRESS', ap.address], ['MAMORU_GAS_POLICY_ADDRESS', ap.gasPolicy?.address], ['MAMORU_ACTION_POLICY_ADDRESS', env.MAMORU_ACTION_POLICY_ADDRESS]] as const) {
    if (other && gate.toLowerCase() === other.toLowerCase()) throw new Error(`MAMORU_PAUSE_GATE_ADDRESS and ${name} are the same`)
  }
  return { ...base, actionPolicy: { ...ap, pauseGate: getAddress(gate) } }
}

/**
 * otto/mamoru#214: the Monad sleeve's v5 policy wired to MamoruActionPolicyV2 and MamoruGasPolicy on Monad (the same two
 * env names as Base's v5: an operator reads one chain, so they mean that chain's contracts), with Monad's pool and gas
 * caps (a Base cap would be 10,000x under Monad's gas price). Unset, malformed or equal: throws, never a policy without them.
 */
function deployedMonadV5(p: PolicyVersion, env: Record<string, string | undefined>): PolicyVersion {
  return deployedV5(p, env, { pools: V4_POOLS_MONAD, gasCaps: MONAD_GAS_CAPS })
}

/**
 * otto/mamoru#151: the v5 policy (MamoruActionPolicyV2) the renew row may move this operator's v2/v3/v4 accounts to,
 * or undefined when the v4 opt-in is off or `MAMORU_ACTION_POLICY_V2_ADDRESS` is unset (V2 undeployed: nothing of v5
 * exists). Whether an account is offered the move is the D1 flag `onchain_action_policy_v5`, read on every view.
 */
export function resolveV5Policy(chain: PolicyVersion['chain'], env: Record<string, string | undefined>): PolicyVersion | undefined {
  // otto/mamoru#214: a Monad operator has no Base policy to migrate accounts to; its V2 address is Monad's (deployedMonadV5).
  if (chain === 'monad') return undefined
  if (env.MAMORU_ONCHAIN_POLICY_V4 !== '1' || !env.MAMORU_ACTION_POLICY_V2_ADDRESS) return undefined
  return deployedV5(chain === conservadorLiveV5.chain ? conservadorLiveV5 : conservadorLabV5, env)
}

/**
 * otto/mamoru#214: the v6 policy the renew row may move this operator's v2-v5 accounts to, or undefined when the v4
 * opt-in is off or `MAMORU_ACTION_POLICY_V2_ADDRESS` / `MAMORU_PAUSE_GATE_ADDRESS` is unset (fail closed: v6 is not
 * offered). Whether an account is offered the move is the D1 flag `multichain_v6`, read on every view.
 */
export function resolveV6Policy(chain: PolicyVersion['chain'], env: Record<string, string | undefined>): PolicyVersion | undefined {
  if (chain === 'monad') return undefined
  if (env.MAMORU_ONCHAIN_POLICY_V4 !== '1' || !env.MAMORU_ACTION_POLICY_V2_ADDRESS || !env.MAMORU_PAUSE_GATE_ADDRESS) return undefined
  return deployedV6(chain === conservadorLiveV6.chain ? conservadorLiveV6 : conservadorLabV6, env)
}

/**
 * Spec 007 T7 (d): the v4 policy the renew row may move this operator's v2/v3 accounts to (same chain as the
 * operator's own policy), or undefined when the opt-in is off. Read at boot like `resolveNamedPolicy`; whether an
 * account is offered the move is the D1 flag `onchain_action_policy_v4`, read on every view.
 */
export function resolveV4Policy(chain: PolicyVersion['chain'], env: Record<string, string | undefined>): PolicyVersion | undefined {
  if (chain === 'monad') return undefined
  if (env.MAMORU_ONCHAIN_POLICY_V4 !== '1') return undefined
  return deployedV4(chain === conservadorLiveV4.chain ? conservadorLiveV4 : conservadorLabV4, env)
}

/**
 * otto/mamoru#214 (peer review of #137): accounts activated on the Monad v5 sleeve policy need that same policy to be this
 * operator's own after a restart (it is wired from the environment, so no table resolves it). Refused at boot with the
 * accounts named, rather than throwing "unknown policy" on each of them while their Safes hold positions.
 */
export function assertMonadV5Resolvable(accounts: readonly { accountKey: string; policyId?: string }[], policy: PolicyVersion): void {
  const ids = new Set([liveWmonUsdcMonadV5.policyId, labWmonUsdcMonadV5.policyId])
  const stranded = accounts.filter((a) => a.policyId && ids.has(a.policyId) && a.policyId !== policy.policyId)
  if (stranded.length) throw new Error(`${stranded.length} account(s) run ${stranded[0]!.policyId} (${stranded.map((a) => a.accountKey.slice(0, 8)).join(', ')}) but this operator runs ${policy.policyId}: start it on that policy with MAMORU_ACTION_POLICY_V2_ADDRESS and MAMORU_GAS_POLICY_ADDRESS set`)
}

/** Accounts whose stored policy is a v4 one, when this operator was started without the v4 opt-in or its addresses. */
export function assertV4Resolvable(accounts: readonly { accountKey: string; policyId?: string }[], env: Record<string, string | undefined>): void {
  const v6Ids = new Set([conservadorLiveV6.policyId, conservadorLabV6.policyId])
  const onV6 = accounts.filter((a) => a.policyId && v6Ids.has(a.policyId))
  if (onV6.length) {
    let v6: PolicyVersion | undefined
    try {
      v6 = resolveV6Policy(conservadorLiveV6.chain, env) ?? resolveV6Policy(conservadorLabV6.chain, env)
    } catch {
      v6 = undefined
    }
    if (!v6) throw new Error(`${onV6.length} account(s) run conservador-live-v6 (${onV6.map((a) => a.accountKey.slice(0, 8)).join(', ')}): start with MAMORU_ONCHAIN_POLICY_V4=1, MAMORU_ACTION_POLICY_V2_ADDRESS, MAMORU_GAS_POLICY_ADDRESS and MAMORU_PAUSE_GATE_ADDRESS set`)
  }
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
  /**
   * otto/mamoru#215: Monad mainnet RPC (MAMORU_MONAD_RPC_URL) for the bridge leg of v6 accounts, on the Base operator
   * only: their sleeves' value and readiness on Monad, and the CCTP mints there. Unset: no remote value, no bridge.
   */
  monadRpcUrl?: string
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

/**
 * otto/mamoru#63: the registry of the chain the operator reads. On a supported chain (8453, 143) it is that chain's.
 * On any other chain id (a lab fork) it is the forked chain's, named by MAMORU_SOURCE_CHAIN_ID; unset, Base, which
 * is what every fork the operator ran on so far was. A MAMORU_SOURCE_CHAIN_ID that is not a supported chain, or that
 * contradicts the chain the RPC answers, is refused.
 */
export function operatorRegistry(chainId: number, env: Record<string, string | undefined>): Registry {
  const raw = env.MAMORU_SOURCE_CHAIN_ID
  const source = raw === undefined || raw === '' ? undefined : Number(raw)
  if (source !== undefined && !isChainId(source)) throw new Error(`MAMORU_SOURCE_CHAIN_ID=${raw} is not a supported chain`)
  if (isChainId(chainId)) {
    if (source !== undefined && source !== chainId) throw new Error(`MAMORU_SOURCE_CHAIN_ID=${raw} but the RPC is chain ${chainId}`)
    return registryFor(chainId)
  }
  return registryFor(source ?? BASE_CHAIN_ID)
}

/**
 * otto/mamoru#63: every pool the policy allocates to, and the chain's live pool, are entries of `registry`; else
 * POLICY_TARGET_NOT_IN_REGISTRY / CHAIN_UNSUPPORTED at boot, before any account is read. A Base policy on a Monad
 * registry stops here instead of resolving Base names later.
 */
export function assertPolicyOnRegistry(policy: PolicyVersion, registry: Registry): void {
  for (const pool of policy.buckets.flatMap((b) => b.pools)) entry(pool, registry)
  livePool(registry)
}

/**
 * otto/mamoru#63: what only exists on Base is refused on any other chain at boot: the v4/v5 on-chain action policies
 * (deployed on Base only; v5 through its V2 address as well) and bridge-out (moves USDC from Ethereum to Base).
 */
export function assertBaseOnlyFeatures(registry: Registry, env: Record<string, string | undefined>, o: Pick<BootOptions, 'l1RpcUrl' | 'monadRpcUrl'>, chainId?: number): void {
  if (registry.chainId === BASE_CHAIN_ID) return
  if (env.MAMORU_ONCHAIN_POLICY_V4 === '1') throw new Error(`MAMORU_ONCHAIN_POLICY_V4 is Base only; this operator reads ${registry.chain}`)
  // v5 needs the v4 opt-in above; its deployed address alone is refused too, so no env turns it on off Base.
  // otto/mamoru#214: except on a chain the operator is opted into writing to (MAMORU_CHAIN_WRITES): there it is that chain's
  // MamoruActionPolicyV2, read only by the sleeve's own policy (deployedMonadV5).
  // A lab fork (an RPC chain id that is no real chain) cannot carry MAMORU_CHAIN_WRITES, so it may hold the address for the
  // fork twin (lab-wmon-usdc-monad-v5), which never signs on a real chain.
  const onFork = chainId !== undefined && !isChainId(chainId)
  if (env.MAMORU_PAUSE_GATE_ADDRESS) throw new Error(`MAMORU_PAUSE_GATE_ADDRESS is Base only (v6 bridge-out); this operator reads ${registry.chain}`)
  if (env.MAMORU_ACTION_POLICY_V2_ADDRESS && !onFork && !(chainWritesOptIn(env) as readonly number[]).includes(registry.chainId)) throw new Error(`MAMORU_ACTION_POLICY_V2_ADDRESS is Base only; this operator reads ${registry.chain}`)
  if (o.l1RpcUrl) throw new Error(`MAMORU_L1_RPC_URL (bridge-out to Base) is Base only; this operator reads ${registry.chain}`)
  if (o.monadRpcUrl) throw new Error(`MAMORU_MONAD_RPC_URL (the v6 bridge leg to Monad) is Base only; this operator reads ${registry.chain}`)
}

/**
 * otto/mamoru#215: the Monad RPC of the bridge leg must answer chain 143, and CCTP's MessageTransmitterV2 there must be
 * domain 15; anything else refuses the boot. viem errors quote the URL (it may carry a key): only fixed text leaves.
 * Unreachable is its own error (MonadRpcUnreachable): the boot goes on with the bridge leg waiting for Monad (review of #144).
 */
export class MonadRpcUnreachable extends Error {}

/**
 * Review of #144: why the Base operator's relayer key may not send mints on Monad, or null when it may: only a live
 * operator (MAMORU_LIVE=1) on Base, the same switch that lets it write on Base. Refused, the bridge leg gets no relayer
 * (a mint by anyone else is still recorded) and the Relayer itself carries the refusal.
 */
export function monadMintRefusal(o: { chainId: number; live: boolean }): string | null {
  if (o.chainId !== BASE_CHAIN_ID) return `the bridge leg runs on the Base operator only (chain ${o.chainId})`
  if (!o.live) return 'read only (MAMORU_LIVE is not 1): no mint is sent on Monad'
  return null
}

export async function checkMonadRpc(monad: Pick<PublicClient, 'getChainId' | 'readContract'>): Promise<void> {
  let chainId: number
  let domain: number
  try {
    chainId = await monad.getChainId()
    domain = chainId === BRIDGE_MONAD_CHAIN_ID ? await monad.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'localDomain' }) : -1
  } catch {
    throw new MonadRpcUnreachable('MAMORU_MONAD_RPC_URL is not a reachable Monad RPC (unreachable)')
  }
  if (chainId !== BRIDGE_MONAD_CHAIN_ID) throw new Error(`MAMORU_MONAD_RPC_URL is not a Monad Mainnet RPC (chain ${chainId}, want ${BRIDGE_MONAD_CHAIN_ID})`)
  if (domain !== CCTP_DOMAIN_MONAD) throw new Error(`MAMORU_MONAD_RPC_URL: MessageTransmitterV2 answers domain ${domain}, not Monad's ${CCTP_DOMAIN_MONAD}`)
}

/**
 * otto/mamoru#214 (peer review of #137, P1): off Base, the env addresses the policy is wired to must be entries of the
 * pinned registry: an operator never signs a session for a contract the registry does not name. A name that is
 * `undeployed` or absent refuses the boot (fail closed): the sleeve cannot go live before MamoruActionPolicyV2 and
 * MamoruGasPolicy are pinned, and `writeRegistry` has then checked every entry's code hash on chain. Base and policies
 * without an action policy: nothing to check.
 */
export function assertActionPolicyOnRegistry(policy: PolicyVersion, registry: Registry): void {
  const ap = policy.actionPolicy
  if (!ap || registry.chainId === BASE_CHAIN_ID) return
  const pairs: [string, string | undefined][] = [['MamoruActionPolicyV2', ap.address], ['MamoruGasPolicy', ap.gasPolicy?.address]]
  for (const [name, wired] of pairs) {
    if (!wired) continue
    if (!isDeployed(name, registry)) throw new Error(`${name} is ${wired} in the environment but is not pinned in the ${registry.chain} registry (undeployed or absent): refusing to sign sessions for it`)
    if (registryAddress(name, registry).toLowerCase() !== wired.toLowerCase()) throw new Error(`${name} is ${wired} in the environment but ${registryAddress(name, registry)} in the ${registry.chain} registry`)
  }
}

/**
 * otto/mamoru#214: once the registry pins MamoruPauseGate (base.json moves it from `undeployed` to `entries`), the env
 * address v6 is wired to must be that entry: an operator never signs a bridge-out session for a gate the pinned registry
 * does not name. While it is `undeployed` the env address stands alone. No pause gate on the policy: nothing to check.
 */
export function assertPauseGateOnRegistry(policy: PolicyVersion, registry: Registry): void {
  const gate = policy.actionPolicy?.pauseGate
  if (!gate || !isDeployed('MamoruPauseGate', registry)) return
  const pinned = registryAddress('MamoruPauseGate', registry)
  if (pinned.toLowerCase() !== gate.toLowerCase()) throw new Error(`MamoruPauseGate is ${gate} in the environment but ${pinned} in the ${registry.chain} registry`)
}

/**
 * otto/mamoru#214, review of PR #141 (P1 2, P1 3): what boot checks of the process-wide policy and of the v6 renew target.
 * A policy with a bucket on another chain (v6) is never the default: an activation does not check that the owner's
 * sleeve on that chain runs (only the Worker's renewal guard does), so a fresh account would bridge to a sleeve nobody
 * runs. The v6 renew target gets the same registry checks as the default policy, the pause-gate pin included, so a
 * stale `MAMORU_PAUSE_GATE_ADDRESS` refuses the boot even while the default policy is v5.
 */
export function assertBootPolicies(policy: PolicyVersion, v6Policy: PolicyVersion | undefined, registry: Registry): void {
  if (policy.remoteBuckets?.length) throw new Error(`${policy.policyId} has a bucket on another chain: it is a renewal target only, never the default policy (an activation does not check the owner's sleeve)`)
  for (const p of [policy, ...(v6Policy ? [v6Policy] : [])]) {
    assertPolicyOnRegistry(p, registry)
    assertPauseGateOnRegistry(p, registry)
  }
}

/**
 * otto/mamoru#61: whether this operator writes to a chain other than Base. MAMORU_CHAIN_WRITES (default unset: no)
 * names the chain ids it is opted into; it applies only when the RPC answers that very chain id and the registry read
 * is that chain's (never a lab fork id of it). A flag that names another chain than the one the RPC is refuses the boot
 * instead of being ignored, so a stale or wrong value is seen at once. A malformed value refuses the boot too.
 */
export function chainWritesFor(chainId: number, registry: Registry, env: Record<string, string | undefined>): { on: boolean; optIn: readonly number[] } {
  const optIn = chainWritesOptIn(env)
  if (!optIn.length) return { on: false, optIn }
  const on = registry.chainId === chainId && optIn.some((c) => c === chainId)
  if (!on) throw new Error(`MAMORU_CHAIN_WRITES=${env.MAMORU_CHAIN_WRITES} but this operator reads ${registry.chain} (registry chain ${registry.chainId}) on chain ${chainId}`)
  return { on, optIn }
}

/**
 * otto/mamoru#61: what an operator writing off Base must run with: a policy made for that chain (`chain: 'monad'` for
 * Monad mainnet, its names resolving in that chain's registry) and signing on exactly that chain id. Anything else
 * (a Base policy, the fork-only lab policy) is refused at boot.
 */
export function assertWritePolicy(policy: PolicyVersion, registry: Registry, chainId: number): void {
  if (registry.chainId === BASE_CHAIN_ID) return
  if (policy.sourceChainId !== registry.chainId) throw new Error(`${policy.policyId} resolves its names on chain ${policy.sourceChainId ?? BASE_CHAIN_ID}, not ${registry.chain}`)
  assertPolicyChain(policy, chainId)
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
  const readRegistry = operatorRegistry(chainId, process.env)
  assertBaseOnlyFeatures(readRegistry, process.env, o, chainId)
  // otto/mamoru#61: writing off Base is an explicit opt-in (MAMORU_CHAIN_WRITES), and only on a registry verified
  // against the chain itself (writeRegistry). Without it, nothing below changes for any chain.
  // Writes off Base need BOTH the opt-in and MAMORU_LIVE=1 (review of #116, P1-1): the flag alone, without live, leaves
  // the operator read only exactly as without it (no write registry, relayer refusal, no bundler, no Monad policy).
  const flagged = chainWritesFor(chainId, readRegistry, process.env)
  const writes = { ...flagged, on: flagged.on && process.env.MAMORU_LIVE === '1' }
  const registry = writes.on ? await writeRegistry(client, readRegistry) : readRegistry
  // Live (owner transactions and engine loops) needs Base itself: chain id 8453, hence the Base registry; or the chain
  // this operator was opted into writing to (otto/mamoru#61), on its own chain id, MAMORU_LIVE=1 included in writes.on.
  const live = (chainId === BASE_CHAIN_ID && process.env.MAMORU_LIVE === '1') || writes.on
  const named = resolveNamedPolicy(o.policyId ?? 'conservador-live-v2', process.env, { chainWrites: writes.on })
  if (!named) throw new Error(`unknown policy ${o.policyId}`)
  // Test-only (MAMORU_TEST_OVERRIDES=1): the fork E2E may shorten the re-range cooldown.
  const policy = withTestOverrides(named, process.env)
  const v6Policy = resolveV6Policy(policy.chain, process.env)
  assertBootPolicies(policy, v6Policy, registry)
  if (writes.on) {
    assertWritePolicy(policy, registry, chainId)
    assertActionPolicyOnRegistry(policy, registry)
  }
  const store = new StateStore(o.stateDir)
  // Review round 2: an account already moved to the on-chain action policy needs that policy to resolve after a
  // restart (funding, engine, renewals and Stop all read it). Refused at boot, with the accounts named, rather than
  // failing on each of them later while their Safes hold positions.
  assertV4Resolvable(Object.values(store.state.accounts), process.env)
  assertMonadV5Resolvable(Object.values(store.state.accounts), policy)
  // The relayer's own reads (gas estimate, nonce, the wait for a receipt) are counted as the relayer's, like its sends.
  const relayerClient = createPublicClient({ transport: http(via('relayer'), { batch: true, timeout: 60_000 }) })
  const relayerKey = loadOrCreateKey(join(o.stateDir, 'relayer.key'), generatePrivateKey)
  // otto/mamoru#63: off Base the relayer refuses every send and no loopback bundler starts (fail closed), unless this
  // operator was opted into writing to that chain (otto/mamoru#61): then the bundler names its EntryPoint and, on a
  // chain that charges the gas limit, sizes each handleOps from its own estimate.
  const refusal = writeRefusal(registry, writes.on ? { chainId, optIn: writes.optIn } : undefined)
  const relayer = new Relayer(relayerKey, relayerClient, via('relayer'), chainId, refusal)
  // otto/mamoru#215: the bridge leg of v6 accounts (Base operator only, assertBaseOnlyFeatures). The mints on Monad are
  // sent by this same relayer key in its own nonce space there (as on Ethereum for bridge-out): not the Monad
  // operator's relayer, which is another key in another process. Fund its address with MON for the mints.
  let bridgeMonad: MonadBridge | null = null
  if (o.monadRpcUrl) {
    const monad = createPublicClient({ transport: http(o.monadRpcUrl, { batch: true, timeout: 30_000 }) })
    // Review of #144: a wrong chain or domain refuses the boot; Monad unreachable does not stop the Base operator: the
    // leg starts without reading or sending anything on Monad until the same check passes.
    let checked = true
    try {
      await checkMonadRpc(monad)
    } catch (e) {
      if (!(e instanceof MonadRpcUnreachable)) throw e
      checked = false
      console.error('[operator] MAMORU_MONAD_RPC_URL unreachable at boot: the bridge leg waits for it (no Monad read, no mint)')
    }
    // Review of #144: mints are writes; only a live Base operator sends them, and its relayer carries the same refusal.
    const mintRefusal = monadMintRefusal({ chainId, live })
    const monadRelayer = mintRefusal === null ? new Relayer(relayerKey, monad, o.monadRpcUrl, BRIDGE_MONAD_CHAIN_ID, mintRefusal) : null
    bridgeMonad = new MonadBridge(o.stateDir, client, monad, monadRelayer, fetch, Date.now, baseRegistry, monadRegistry, checked ? undefined : () => checkMonadRpc(monad))
    const bm = bridgeMonad
    setInterval(() => void bm.tick(), 60_000)
    void bm.tick()
    console.log(`[operator] bridge leg to Monad on (v6 accounts): ${bm.pendingCount()} burn(s) in flight, ${monadRelayer ? `mints from relayer ${monadRelayer.address} on Monad` : `no mints (${mintRefusal})`}`)
  }
  const bundler = refusal === null ? startLiveBundler(client, relayer, chainId, writes.on ? { registry, gasModel: chainOf(registry.chainId).gasModel } : {}) : null
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
      registry,
      ...(writes.on ? { chainWrites: writes.optIn } : {}),
      live,
      rpcUrl: o.rpcUrl,
      bundlerUrl: bundler?.url ?? '',
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
      ...(v6Policy ? { v6Policy } : {}),
      guardReadsState: new GuardReadsState(o.stateDir),
      ...(bridgeMonad ? { bridgeMonad } : {}),
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
  // The snapshot, yield entries and yield receipts read Base (baseRegistry): started on chain 8453 with the Base registry only.
  if (MULTICALL3 && chainId === BASE_CHAIN_ID && registry.chainId === BASE_CHAIN_ID) {
    const snapshotClient = createPublicClient({ transport: http(via('snapshot'), { batch: true, timeout: 60_000 }) })
    const multicall3 = MULTICALL3
    const budget = rpcBudget(rpcMetrics)
    const read = (): Promise<Snapshot> => readSnapshot(snapshotClient, multicall3, chainId, registry, operator.snapshotTargets())
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
  // Base keeps its boot line byte for byte; any other chain says whose contracts it reads and the relayer's unit.
  if (registry.chainId !== BASE_CHAIN_ID) console.log(`[operator] reads ${registry.chain} contracts (registry chain ${registry.chainId}, block ${registry.block}); relayer balance in ${chainOf(registry.chainId).native.symbol} wei; ${refusal ?? `writes on ${registry.chain} (MAMORU_CHAIN_WRITES=${process.env.MAMORU_CHAIN_WRITES}, live=${live})`}`)
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
      bundler?.stop()
      proxy.stop()
      rpcMetrics.persist()
    },
  }
}
