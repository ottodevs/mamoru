// Spec 004 (#101) LC-T6, against real Base state on an anvil fork: for the three live pools, does the pool's own
// oracle answer the full 24.5 h window `marketOf` needs, or does `observeGuardHistory` fall back to the rolling
// series — and does that series survive a simulated restart. Prints the on-chain/fallback split and the request
// count of the extra Multicall3 batch (the CU cost LC-T6 adds). Never touches the live operator.
// Upstream: RPC_URL or BASE_RPC_URL from the environment only; a public Base RPC when neither is set.
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, custom, type PublicClient } from 'viem'
import { baseRegistry, entry } from '@mamoru/registry'
import { MULTICALL3, observeGuardHistory, type PoolGuardTarget } from '@mamoru/rpc'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { GuardHistoryStore } from '../src/guard-history-state.ts'

if (!process.env.RPC_URL) process.env.RPC_URL = process.env.BASE_RPC_URL ?? 'https://mainnet.base.org'
const WINDOW_SECONDS = 1_800
const LIVE_POOLS = ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'] as const
const log = (m: string) => console.log(`[guard-history] ${m}`)

const proxy = startForkProxy('RPC_URL')
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = probe.port as number
probe.stop(true)
const argv = ['--fork-url', proxy.url, '--chain-id', '8453', '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', '1', '--no-request-size-limit']
assertNoKeyInArgv(argv, ['RPC_URL', 'BASE_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-guard-history-e2e-'))
const anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`

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
  const block = await setup.getBlock({ blockTag: 'latest' })
  const targets: PoolGuardTarget[] = LIVE_POOLS.map((name) => ({ name, address: entry(name, baseRegistry).address }))

  const first = counting()
  const r1 = await retry('first guard-history observation', () => observeGuardHistory(first.client, MULTICALL3, targets, block.number, Number(block.timestamp), WINDOW_SECONDS, new Map()))
  log(`fork of Base at block ${block.number} (${new Date(Number(block.timestamp) * 1000).toISOString()})`)
  log(`request count of the one Multicall3 batch: ${first.total()} ${JSON.stringify(first.counts)}`)
  for (const name of LIVE_POOLS) {
    const p = r1.pools[name]
    log(`${name}: onChain=${r1.onChain.has(name)} twap24hAgoTick=${p?.twap24hAgoTick ?? 'null'} realizedVol24hBps=${p?.realizedVol24hBps ?? 'null'} seriesPoints=${r1.series.get(name)?.points.length ?? 0}`)
  }
  if (first.total() !== 1) throw new Error(`the guard-history batch made ${first.total()} requests, expected exactly 1 (one Multicall3 aggregate3 call)`)
  log('ok  one Multicall3 request covers every live pool')

  const stable = 'pool:USDC/USDT/100'
  if (!r1.onChain.has(stable)) throw new Error(`${stable} was expected to answer its own 24.5 h on-chain history (it did on 2026-10-16: oldest observation ~27 days old)`)
  if (r1.pools[stable]?.twap24hAgoTick == null || r1.pools[stable]?.realizedVol24hBps == null) throw new Error(`${stable} answered on-chain but marketOf still abstained`)
  log(`ok  ${stable} resolves from its own oracle, no fallback needed`)

  for (const name of ['pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'] as const) {
    if (r1.onChain.has(name)) log(`note: ${name} now answers its own 24.5 h on-chain history (cardinality/age grew past the earlier LC-T6 measurement) — not a failure, the fallback is simply unused this run`)
    else if (r1.pools[name]?.twap24hAgoTick !== null) throw new Error(`${name} fell back but a cold (one-point) series should still abstain`)
    else log(`ok  ${name} falls back and a cold series correctly abstains (RISK_DATA_INSUFFICIENT upstream, fail safe)`)
  }

  // Restart persistence: the series this review produced survives a store round-trip (a fresh store over the same dir, as a restarted operator would construct).
  const stateDir = mkdtempSync(join(tmpdir(), 'mamoru-guard-history-state-'))
  try {
    const before = new GuardHistoryStore(stateDir)
    before.update(r1.series)
    before.flush()
    const after = new GuardHistoryStore(stateDir)
    for (const name of LIVE_POOLS) {
      const want = r1.series.get(name)?.points ?? []
      const got = after.snapshot().get(name)?.points ?? []
      if (JSON.stringify(want.map((p) => [p.time, p.tickCumulative.toString()])) !== JSON.stringify(got.map((p) => [p.time, p.tickCumulative.toString()]))) {
        throw new Error(`${name}: series did not round-trip through GuardHistoryStore`)
      }
    }
    log('ok  the rolling series round-trips through GuardHistoryStore: a restart resumes it instead of starting cold')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
} catch (e) {
  failed = true
  console.error(`[guard-history] FAILED: ${(e as Error).message}`)
} finally {
  anvil.kill()
  await anvil.exited
  proxy.stop()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
