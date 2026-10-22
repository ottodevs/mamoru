// bun run scenarios:monad [run | replay [prestate.json.gz] | pin]
//   run     fork Monad at the pinned block (scenarios/monad/manifest.json), run MONAD-01, capture the state it read
//   replay  run MONAD-01 again on a plain anvil loaded with that captured state: no upstream at all
//           (default: the prestate committed for the pinned block, scenarios/monad/MONAD-01.prestate.json.gz)
//   pin     move the pin to the latest finalized Monad block (the public RPC keeps ~21 h of state)
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { toHex, type Hex } from 'viem'
import { artifactsRoot } from '../report/index.ts'
import { REPO_ROOT, repoPath } from '../runner/manifest.ts'
import { MONAD_MANIFEST, MONAD_RPC_ENV, PINNED_PRESTATE, capturePrestate, loadMonadManifest, startFromState, startMonadFork, upstreamHost, type MonadFork } from './harness.ts'
import { fmt, runMonad01, type Check } from './scenario.ts'

const [command = 'run', arg] = process.argv.slice(2)
const t0 = Date.now()
const log = (s: string) => console.log(`[monad +${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`)
let passed = 0
const check: Check = (ok, what) => {
  if (!ok) throw new Error(`MONAD-01 FAILED: ${what}`)
  passed++
  log(`ok  ${what}`)
}

const m = await loadMonadManifest()

if (command === 'pin') {
  const url = process.env[MONAD_RPC_ENV] ?? 'https://rpc.monad.xyz'
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['finalized', false] }) })
  const b = ((await res.json()) as { result: { number: Hex; hash: Hex; timestamp: Hex } }).result
  m.fork = { ...m.fork, block: Number(BigInt(b.number)), blockHash: b.hash, timestamp: Number(BigInt(b.timestamp)), pinnedAt: new Date().toISOString().slice(0, 10) }
  writeFileSync(repoPath(MONAD_MANIFEST), `${JSON.stringify(m, null, 2)}\n`)
  console.log(`pinned Monad block ${m.fork.block} ${m.fork.blockHash} (finalized, from ${upstreamHost()})`)
  process.exit(0)
}
if (command !== 'run' && command !== 'replay') {
  console.error('usage: bun run scenarios:monad [run | replay [prestate.json.gz] | pin]')
  process.exit(2)
}

const runId = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}-${toHex(crypto.getRandomValues(new Uint8Array(3))).slice(2)}`
const dir = join(artifactsRoot(REPO_ROOT), 'MONAD-01', runId)
mkdirSync(dir, { recursive: true })
let fork: MonadFork
if (command === 'replay') {
  const state = arg ?? repoPath(PINNED_PRESTATE)
  fork = await startFromState(m, state, join(dir, 'anvil.log'))
  log(`replay from ${state.replace(`${REPO_ROOT}/`, '')}: plain anvil, chain ${m.fork.chainId}, no upstream`)
} else {
  fork = await startMonadFork(m, join(dir, 'anvil.log'))
  log(`fork of Monad (${upstreamHost()}) at block ${m.fork.block} ${m.fork.blockHash.slice(0, 12)}…, lab chain id ${m.fork.chainId}: block hash, anvil version and eth_simulateV1 checked`)
}
const { lab } = fork
let code = 1
try {
  const r = await runMonad01(lab, m, check, log)
  if (command === 'run') {
    // What the run read at the fork block: a replay needs no upstream.
    const state = await capturePrestate(lab, m)
    const bytes = Bun.gzipSync(Buffer.from(JSON.stringify(state)))
    const path = join(dir, 'prestate.json.gz')
    await Bun.write(path, bytes)
    log(`prestate captured: ${Object.keys(state.accounts).length} accounts, ${path.replace(`${REPO_ROOT}/`, '')} (${bytes.length} bytes) sha256 ${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`)
  }
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ id: m.id, mode: command, fork: m.fork, safe: r.safe, tokenId: r.tokenId.toString(), policies: r.policies, feesUsdc: r.feesUsdc.toString(), harvestedUsdc: r.harvestedUsdc.toString(), exitUsdc: r.exitUsdc.toString(), checks: passed, gaps: m.gaps.map((g) => g.id) }, null, 2))
  console.log(`\nMONAD-01 pass: ${passed} checks, harvested ${fmt(r.harvestedUsdc, 6)} USDC, exit ${fmt(r.exitUsdc, 6)} USDC (${command}, block ${m.fork.block})`)
  console.log(`not emulated by the fork (scenarios/monad/manifest.json gaps): ${m.gaps.map((g) => g.id).join(', ')}`)
  code = 0
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
} finally {
  await fork.stop()
}
process.exit(code)
