// Requests per review on real Base state: one observe() through Multicall3 and one with unbatched reads, at the
// same block of an anvil fork, for an account that holds at least 3 Uniswap v3 positions. The two observations
// must be equal; the request counts are printed. Never touches the live operator.
// Upstream: RPC_URL or BASE_RPC_URL from the environment only; a public Base RPC when neither is set.
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, custom, http, parseAbiItem, zeroAddress, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, nonfungiblePositionManagerAbi } from '@mamoru/registry'
import { historyCursor, observe, type ObserveInput } from '@mamoru/rpc'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy } from '../../../packages/scenarios/proxy/index.ts'

if (!process.env.RPC_URL) process.env.RPC_URL = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'
/** Requests of one batched review, steady state (packages/rpc/test/observe-batch.test.ts). */
const MAX_BATCHED = 12
const HISTORY_BLOCKS = 1_500n
const log = (m: string) => console.log(`[rpc-count] ${m}`)

const proxy = startForkProxy('RPC_URL')
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = probe.port as number
probe.stop(true)
// No --block-time: the head stays where it is, so both observations read the same block.
const argv = ['--fork-url', proxy.url, '--chain-id', '8453', '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', '1', '--no-request-size-limit']
assertNoKeyInArgv(argv, ['RPC_URL', 'BASE_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-rpc-count-'))
const anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`

/** A client on the fork that counts every JSON-RPC request it makes. */
function counting(): { client: PublicClient; counts: Record<string, number>; total: () => number } {
  const counts: Record<string, number> = {}
  let id = 0
  const client = createPublicClient({
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          counts[method] = (counts[method] ?? 0) + 1
          const res = await fetch(anvilUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
          const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } }
          if (body.error) throw Object.assign(new Error(body.error.message), body.error)
          return body.result
        },
      },
      { retryCount: 0 },
    ),
  })
  return { client, counts, total: () => Object.values(counts).reduce((a, b) => a + b, 0) }
}

/** Public RPCs drop requests now and then: the fork reads through them lazily. */
async function retry<T>(what: string, fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i + 1 >= tries) throw e
      log(`${what} failed (${(e as Error).message.split('\n')[0]}), retry ${i + 1}`)
      await Bun.sleep(1_500 * (i + 1))
    }
  }
}

/** Owners with 3 to 40 positions: MAMORU_E2E_ACCOUNT, or the busiest minters of the last blocks. */
async function findAccounts(client: PublicClient, head: bigint): Promise<Address[]> {
  if (process.env.MAMORU_E2E_ACCOUNT) return [process.env.MAMORU_E2E_ACCOUNT as Address]
  const npm = address('NonfungiblePositionManager')
  const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)')
  const upstream = createPublicClient({ transport: http(proxy.url, { timeout: 30_000 }) })
  const mints = await upstream.getLogs({ address: npm, event: transfer, args: { from: zeroAddress }, fromBlock: head - 1_999n, toBlock: head })
  const perOwner = new Map<Address, number>()
  for (const m of mints) perOwner.set(m.args.to!, (perOwner.get(m.args.to!) ?? 0) + 1)
  const found: Address[] = []
  for (const [owner] of [...perOwner].sort((a, b) => b[1] - a[1])) {
    const n = await client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'balanceOf', args: [owner] })
    if (n >= 3n && n <= 40n) found.push(owner)
    if (found.length >= 6) break
  }
  if (found.length === 0) throw new Error('no owner with 3 to 40 positions in the last 2000 blocks; set MAMORU_E2E_ACCOUNT')
  return found
}

let failed = false
try {
  const setup = counting().client
  for (let i = 0; ; i++) {
    try {
      await setup.getBlockNumber()
      break
    } catch {
      if (i > 300) throw new Error('anvil did not start')
      await Bun.sleep(200)
    }
  }
  const head = await setup.getBlockNumber()
  const candidates = await retry('finding an account', () => findAccounts(setup, head))
  let account = candidates[0]!
  const input = (multicall3?: null): ObserveInput => ({
    chainId: 8453,
    account,
    nonceKey: 0n,
    depositsAfter: head - HISTORY_BLOCKS,
    sessions: [],
    allowedTokenIds: managed,
    historyFromBlock: head - HISTORY_BLOCKS,
    historyCursor: historyCursor(),
    intents: { paused: false, exitRequested: false },
    slot: null,
    twapWindowSeconds: 1800,
    opGasUnits: 5_100_000n,
    maxPriorityFeePerGas: 1_000_000n,
    savingsAsset: 'USDC',
    ethPricePool: 'pool:WETH/USDC/3000',
    ...(multicall3 === null ? { multicall3 } : {}),
  })
  let managed: bigint[] = []
  // A first pass finds the position ids and warms the fork's cache of upstream state. Prefer an owner with a position in a registry pool.
  let warm = await retry('warm-up observation', () => observe(counting().client, input()))
  for (const candidate of candidates.slice(1)) {
    if (warm.positions.some((p) => p.pool)) break
    const first = account
    account = candidate
    const next = await retry('warm-up observation', () => observe(counting().client, input()))
    if (next.positions.some((p) => p.pool)) warm = next
    else account = first
  }
  managed = warm.positions.slice(0, 3).map((p) => p.tokenId)
  log(`fork of Base at block ${warm.block.number}, account ${account} with ${warm.positions.length} positions (${warm.positions.filter((p) => p.pool).length} in registry pools)`)

  const batched = counting()
  const a = await retry('batched observation', () => observe(batched.client, input()))
  const plain = counting()
  const b = await retry('unbatched observation', () => observe(plain.client, input(null)))

  log(`unbatched: ${plain.total()} requests ${JSON.stringify(plain.counts)}`)
  log(`batched:   ${batched.total()} requests ${JSON.stringify(batched.counts)}`)
  if (a.block.hash !== b.block.hash) throw new Error('the fork moved between the two observations')
  if (!Bun.deepEquals(a, b, true)) throw new Error('batched and unbatched observations differ')
  log('ok  the two observations are equal, field by field')
  // One more eth_call when a position sits in a pool outside the registry (the factory is asked for it).
  const allowed = MAX_BATCHED + (a.positions.some((p) => !p.pool) ? 1 : 0) + (a.positions.length > 8 ? 1 : 0)
  if (batched.total() > allowed) throw new Error(`batched review made ${batched.total()} requests, expected at most ${allowed}`)
  log(`ok  batched review within ${allowed} requests`)
} catch (e) {
  failed = true
  console.error(`[rpc-count] FAILED: ${(e as Error).message}`)
} finally {
  anvil.kill()
  await anvil.exited
  proxy.stop()
}
process.exit(failed ? 1 : 0)
