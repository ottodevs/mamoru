// otto/mamoru#293, spec 010 I4 + I7: the guardian watcher. A separate process with its own key and no operator code path.
// Env names: see README.md. Fails closed: no V4 address, no home RPC, a wrong chain id, a key that is not V4's GUARDIAN or
// a missing start block all stop the process before it does anything.
import { createPublicClient, createWalletClient, getAddress, http, type Address, type Hex } from 'viem'
import { mamoruActionPolicyV4Abi } from '@mamoru/account/one-auth'
import { oneAuthV4Deployment, V4_DOMAIN_BY_CHAIN } from '@mamoru/policy'
import { registryFor } from '@mamoru/registry'
import { ConsoleAlerter, MattermostAlerter, TeeAlerter, webhookUrlFromFile, type Alerter } from './alerts.ts'
import { loadGuardianAccount } from './key.ts'
import { StateStore } from './state.ts'
import { readAllowlist, runPass, type ChainClient, type WatcherConfig } from './watcher.ts'

const env = process.env
const need = (n: string): string => {
  const v = env[n]
  if (!v) throw new Error(`${n} is required`)
  return v
}
const addr = (n: string): Address | undefined => (env[n] ? getAddress(env[n]!) : undefined)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
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
    const pc = createPublicClient({ transport: http(url) })
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

  const sinks: Alerter[] = [new ConsoleAlerter()]
  if (env.MAMORU_GUARDIAN_WEBHOOK_FILE) sinks.push(new MattermostAlerter(webhookUrlFromFile(env.MAMORU_GUARDIAN_WEBHOOK_FILE)))
  const alerter = new TeeAlerter(sinks)

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
  console.log(`guardian up: home chain ${homeChainId}, chains [${Object.keys(clients).join(',')}], ${dryRun ? 'DRY-RUN' : 'live'}`)

  const once = process.argv.includes('--once')
  for (;;) {
    const errors = await runPass(cfg, deps)
    for (const e of errors) console.error(`pass error ${e}`)
    if (once) return
    await sleep(interval)
  }
}

main().catch((e) => {
  // Only the name and the short message: viem's full text carries the RPC URL.
  console.error(`guardian stopped: ${(e as { shortMessage?: string }).shortMessage ?? (e as Error).message}`)
  process.exit(1)
})
