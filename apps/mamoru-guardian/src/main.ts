// otto/mamoru#293, spec 010 I4 + I7: the guardian watcher. A separate process with its own key and no operator code path.
// Env names: see README.md. Fails closed: no V4 address, no home RPC, a wrong chain id, a key that is not V4's GUARDIAN or
// a missing start block all stop the process before it does anything.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex } from 'viem'
import { mamoruActionPolicyV4Abi } from '@mamoru/account/one-auth'
import { oneAuthV4Deployment, V4_DOMAIN_BY_CHAIN } from '@mamoru/policy'
import { registryFor } from '@mamoru/registry'
import { ConsoleAlerter, MattermostAlerter, TeeAlerter, webhookUrlFromFile, type Alerter } from './alerts.ts'
import { loadGuardianAccount } from './key.ts'
import { StateStore } from './state.ts'
import { readAllowlist, runPass, type ChainClient, type WatcherConfig } from './watcher.ts'

type Env = Record<string, string | undefined>
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The RPC client of one URL; injectable so a startup failure is testable without a network. */
export type MakeClient = (url: string) => ReturnType<typeof createPublicClient>

/**
 * Review of #202 r3 (Sol 2): the alerter exists before anything that can fail, from configuration alone (console, and the
 * webhook when its file is set). A webhook file that cannot be read still leaves the console sink, and says so there.
 */
export function alerterFrom(env: Env): Alerter {
  const sinks: Alerter[] = [new ConsoleAlerter()]
  if (env.MAMORU_GUARDIAN_WEBHOOK_FILE) {
    try {
      sinks.push(new MattermostAlerter(webhookUrlFromFile(env.MAMORU_GUARDIAN_WEBHOOK_FILE)))
    } catch (e) {
      console.error(`guardian alert sink: ${(e as Error).message}`)
    }
  }
  return new TeeAlerter(sinks)
}

/** Only the short message: viem's full text carries the RPC URL. */
export function shortWhy(e: unknown): string {
  return (e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? String(e)
}

/** The stamp file of a startup failure: one per reason (a hash of it), in the state dir. */
function stampOf(env: Env, why: string): string | null {
  const dir = env.MAMORU_GUARDIAN_STATE_DIR
  return dir ? join(dir, `startup-alerted-${createHash('sha256').update(why).digest('hex').slice(0, 16)}`) : null
}

/**
 * Pages a startup failure, at most once per hour per reason across restarts (systemd restarts the unit with backoff and
 * never gives up, so the page is the signal). The stamp is written only once the alert was delivered: a failed delivery
 * leaves no stamp and the next restart pages again. A stamp from the future (clock moved back) counts as expired.
 */
export async function pageStartupFailure(alerter: Alerter, env: Env, why: string, now = Date.now()): Promise<boolean> {
  const stamp = stampOf(env, why)
  try {
    if (stamp && existsSync(stamp)) {
      const age = now - Number(readFileSync(stamp, 'utf8'))
      if (age >= 0 && age < 3_600_000) return false
    }
  } catch {}
  try {
    await alerter.alert(`guardian failed to start (restarting with backoff): ${why}`)
  } catch {
    return false
  }
  try {
    if (stamp) {
      mkdirSync(env.MAMORU_GUARDIAN_STATE_DIR!, { recursive: true, mode: 0o700 })
      writeFileSync(stamp, String(now), { mode: 0o600 })
    }
  } catch {}
  return true
}

/** After a successful start: every startup stamp is cleared, so the next failure pages at once. */
export function clearStartupStamps(env: Env): void {
  const dir = env.MAMORU_GUARDIAN_STATE_DIR
  if (!dir || !existsSync(dir)) return
  for (const f of readdirSync(dir)) if (f.startsWith('startup-alerted-')) rmSync(join(dir, f), { force: true })
}

/** Starts the guardian loop; throws on any startup failure (the caller pages it). `once`: one pass and return. */
export async function run(env: Env, alerter: Alerter, makeClient: MakeClient = (url) => createPublicClient({ transport: http(url) }), once = false): Promise<void> {
  const need = (n: string): string => {
    const v = env[n]
    if (!v) throw new Error(`${n} is required`)
    return v
  }
  const addr = (n: string): Address | undefined => (env[n] ? getAddress(env[n]!) : undefined)
  const dryRun = env.MAMORU_GUARDIAN_DRY_RUN === '1' || process.argv.includes('--dry-run')
  const homeChainId = Number(env.MAMORU_GUARDIAN_HOME_CHAIN_ID ?? 8453)
  if (V4_DOMAIN_BY_CHAIN[homeChainId] === undefined) throw new Error(`home chain ${homeChainId} is not a V4 chain`)

  // Fail closed: the V4 address comes from env or the pinned deployment, nothing else.
  const homeDeployment = oneAuthV4Deployment(registryFor(homeChainId))
  const v4 = addr('MAMORU_GUARDIAN_V4_ADDRESS') ?? homeDeployment?.policy
  const gasPolicy = addr('MAMORU_GUARDIAN_GAS_POLICY_ADDRESS') ?? homeDeployment?.gasPolicy
  if (!v4 || !gasPolicy) throw new Error('no V4 / gas policy address: set MAMORU_GUARDIAN_V4_ADDRESS and MAMORU_GUARDIAN_GAS_POLICY_ADDRESS or pin the deployment in the registry')

  // One client per chain: the home chain's own URL, and one per other V4 chain that has MAMORU_GUARDIAN_RPC_URL_<chainId>.
  const urls: Record<number, string> = { [homeChainId]: need('MAMORU_GUARDIAN_HOME_RPC_URL') }
  for (const id of Object.keys(V4_DOMAIN_BY_CHAIN).map(Number)) if (id !== homeChainId && env[`MAMORU_GUARDIAN_RPC_URL_${id}`]) urls[id] = env[`MAMORU_GUARDIAN_RPC_URL_${id}`]!
  const publicClients: Record<number, ReturnType<typeof createPublicClient>> = {}
  const clients: Record<number, ChainClient> = {}
  const registryAt: Record<number, Address> = {}
  const fromBlock: Record<number, bigint> = {}
  const store = new StateStore(need('MAMORU_GUARDIAN_STATE_DIR'))
  for (const [k, url] of Object.entries(urls)) {
    const id = Number(k)
    const pc = makeClient(url)
    if ((await pc.getChainId()) !== id) throw new Error(`RPC for chain ${id} answers another chain id`)
    publicClients[id] = pc
    clients[id] = pc as unknown as ChainClient
    const reg = addr('MAMORU_GUARDIAN_REGISTRY_ADDRESS') ?? oneAuthV4Deployment(registryFor(id))?.registry
    if (reg) registryAt[id] = reg
    const fb = env[`MAMORU_GUARDIAN_FROM_BLOCK_${id}`]
    if (fb) fromBlock[id] = BigInt(fb)
    else if (store.cursor(id === homeChainId ? 'reg' : `queued:${id}`) === undefined) throw new Error(`MAMORU_GUARDIAN_FROM_BLOCK_${id} is required on first start`)
    else fromBlock[id] = 0n
  }

  const home = publicClients[homeChainId]!
  let send: (a: { account: Address; domain: number; remote: Address }) => Promise<Hex>
  const keyFile = env.MAMORU_GUARDIAN_KEY_FILE
  if (!keyFile && !dryRun) throw new Error('MAMORU_GUARDIAN_KEY_FILE is required (or run with --dry-run)')
  if (keyFile) {
    const account = loadGuardianAccount(keyFile)
    const guardian = (await home.readContract({ address: v4, abi: mamoruActionPolicyV4Abi, functionName: 'GUARDIAN' })) as Address
    if (guardian.toLowerCase() !== account.address.toLowerCase()) throw new Error('the guardian key is not V4.GUARDIAN')
    const wallet = createWalletClient({ account, transport: http(urls[homeChainId]) })
    send = async ({ account: acct, domain, remote }) => {
      const hash = await wallet.writeContract({ chain: null, address: v4, abi: mamoruActionPolicyV4Abi, functionName: 'setReady', args: [acct, domain, remote] })
      const rc = await home.waitForTransactionReceipt({ hash })
      if (rc.status !== 'success') throw new Error('setReady reverted')
      return hash
    }
  } else {
    send = async () => { throw new Error('dry-run: no key') }
  }
  if (dryRun) send = async () => { throw new Error('dry-run: never sends') }


  const cfg: WatcherConfig = {
    homeChainId,
    v4,
    gasPolicy,
    registryAt,
    fromBlock,
    logPage: BigInt(env.MAMORU_GUARDIAN_LOG_PAGE ?? 2000),
    maxPagesPerStream: Number(env.MAMORU_GUARDIAN_MAX_PAGES ?? 50),
    dryRun,
    realertMs: Number(env.MAMORU_GUARDIAN_REALERT_SECONDS ?? 6 * 3600) * 1000,
  }
  const deps = { clients, send, alerter, store, allowlist: readAllowlist(env.MAMORU_GUARDIAN_ALLOWLIST_FILE), now: () => Date.now() }
  const interval = Number(env.MAMORU_GUARDIAN_INTERVAL_SECONDS ?? 30) * 1000
  clearStartupStamps(env)
  console.log(`guardian up: home chain ${homeChainId}, chains [${Object.keys(clients).join(',')}], ${dryRun ? 'DRY-RUN' : 'live'}`)

  for (;;) {
    const errors = await runPass(cfg, deps)
    for (const e of errors) console.error(`pass error ${e}`)
    if (once) return
    await sleep(interval)
  }
}

if (import.meta.main) {
  const env = process.env
  const alerter = alerterFrom(env)
  run(env, alerter, undefined, process.argv.includes('--once')).catch(async (e) => {
    const why = shortWhy(e)
    console.error(`guardian stopped: ${why}`)
    await pageStartupFailure(alerter, env, why)
    process.exit(1)
  })
}
