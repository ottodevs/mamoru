// otto/mamoru#63: the operator boots against a fork of Monad, reads a Safe and values its position without any Base
// constant. The Safe and its WMON/USDC position come from the Monad lab (packages/scenarios/monad, MONAD-01 up to the
// open position). The operator talks to anvil through the engine port (no anvil_* methods) and reads the Monad
// registry (MAMORU_SOURCE_CHAIN_ID=143 on a lab chain id). Off Base it signs and sends nothing (CHAIN_READ_ONLY).
//   bun apps/mamoru-operator/test/e2e-monad-fork.ts [prestate.json.gz]
// With a prestate it runs offline on a plain anvil (bun run scenarios:monad replay's state); without, it forks Monad
// at the block pinned in scenarios/monad/manifest.json through the public RPC (MONAD_RPC_URL overrides it).
import { createHmac, randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toHex } from 'viem'
import type { AccountContext, FundingView } from '@mamoru/domain'
import { monadRegistry } from '@mamoru/registry'
import { startEnginePort } from '../../../packages/scenarios/proxy/index.ts'
import { loadMonadManifest, startFromState, startMonadFork, upstreamHost } from '../../../packages/scenarios/monad/harness.ts'
import { buildPosition, fmt } from '../../../packages/scenarios/monad/scenario.ts'
import { bootOperator } from '../src/boot.ts'

const t0 = Date.now()
const log = (m: string) => console.log(`[e2e-monad +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
let checks = 0
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`E2E FAILED: ${what}`)
  checks++
  log(`ok  ${what}`)
}

const m = await loadMonadManifest()
const dir = mkdtempSync(join(tmpdir(), 'mamoru-operator-e2e-monad-'))
const statePath = process.argv[2]
const fork = statePath ? await startFromState(m, statePath, join(dir, 'anvil.log')) : await startMonadFork(m, join(dir, 'anvil.log'))
log(statePath ? `plain anvil from ${statePath}, chain ${m.fork.chainId}` : `fork of Monad (${upstreamHost()}) at block ${m.fork.block}, lab chain id ${m.fork.chainId}`)
const enginePort = startEnginePort(fork.anvil.url)
let stopOperator = () => {}
let code = 1
try {
  const quiet = () => {}
  const { w, tokenId } = await buildPosition(fork.lab, m, (ok, what) => check(ok, `lab: ${what}`), quiet)
  const { acct } = w

  // --- the operator, on the Monad registry ------------------------------------------------------------------
  process.env.MAMORU_SOURCE_CHAIN_ID = '143'
  process.env.MAMORU_HEAD_LAG = '0'
  delete process.env.MAMORU_LIVE
  const secret = randomBytes(32).toString('hex')
  const lines: string[] = []
  const origLog = console.log
  console.log = (...a: unknown[]) => {
    lines.push(a.map(String).join(' '))
    origLog(...a)
  }
  const op = await bootOperator({ rpcUrl: enginePort.url, secret, stateDir: join(dir, 'state'), port: 0, policyId: m.policy })
  console.log = origLog
  stopOperator = op.stop
  check(op.operator.cfg.registry === monadRegistry, `operator reads the Monad registry (chain ${op.operator.cfg.registry.chainId}) on lab chain ${op.operator.cfg.chainId}`)
  check(!op.operator.cfg.live, 'operator is not live: Monad has no live path yet')
  check(lines.some((l) => l.includes('reads monad contracts') && l.includes('MON wei')), `boot names the registry and the native unit: ${lines.find((l) => l.includes('reads monad'))}`)

  const ctx: AccountContext = {
    accountKey: `e2e-monad-${acct.saltNonce}`,
    chainId: m.fork.chainId,
    address: acct.safe,
    owners: acct.owners,
    saltNonce: acct.saltNonce.toString(),
    passkey: { credentialId: 'e2e-monad', x: toHex(acct.passkey.x, { size: 32 }), y: toHex(acct.passkey.y, { size: 32 }) },
  }
  const header = Buffer.from(JSON.stringify(ctx)).toString('base64url')
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const sig = createHmac('sha256', secret).update(`${method} ${path}\n${header}\n${raw}`).digest('hex')
    const res = await fetch(op.url + path, { method, headers: { 'x-mamoru-account': header, 'x-mamoru-sig': sig, 'content-type': 'application/json' }, body: method === 'POST' ? raw : undefined })
    return { status: res.status, json: (await res.json()) as T }
  }
  const base = `/api/accounts/${ctx.accountKey}`

  // --- read and value the Safe ------------------------------------------------------------------------------
  const f = await call<FundingView>('GET', `${base}/funding?fresh=1`)
  check(f.status === 200, `GET funding answers 200 (${f.status})`)
  const v = f.json
  check(v.address.toLowerCase() === acct.safe.toLowerCase() && v.deployed, `funding reads Safe ${v.address}, deployed`)
  check(v.positions.length === 1 && v.positions[0]!.tokenId === tokenId.toString(), `one position, #${tokenId}`)
  const p = v.positions[0]!
  check(p.pool === m.pool && p.inRange, `position in ${p.pool}, in range`)
  const amounts = p.amounts ?? []
  check(amounts.length === 2, 'the position carries its two token amounts')
  check(
    amounts.map((a) => a.token).join('/') === 'WMON/USDC' && amounts[0]!.decimals === 18 && amounts[1]!.decimals === 6,
    `amounts in WMON (18) and USDC (6): ${amounts.map((a) => `${fmt(BigInt(a.amount), a.decimals)} ${a.token}`).join(' + ')}`,
  )
  const value = BigInt(p.valueUsdc ?? 0)
  const legs = BigInt(amounts[0]!.valueUsdc ?? 0) + BigInt(amounts[1]!.valueUsdc ?? 0)
  check(value >= legs && value - legs < 10_000n, `position valued at ${fmt(value, 6)} USDC (legs ${fmt(legs, 6)})`)
  // About 960 of the 1,000 USDC deposited went into the position; a few dollars of pool fee and price move either way.
  check(value > 900_000_000n && value < 1_000_000_000n, `position value ${fmt(value, 6)} USDC is in line with the ~960 USDC entered`)
  const idleUsdc = BigInt(v.usdc)
  check(idleUsdc > 0n && v.idle?.[0]?.token === 'USDC', `idle USDC ${fmt(idleUsdc, 6)}`)
  const names = JSON.stringify(v)
  check(!/cbBTC|WETH|USDT|EURC|pool:USDC\//.test(names), 'no Base token or pool name anywhere in the funding view')
  check(v.cbbtc === '0', 'the legacy cbbtc field is 0 on Monad')

  // --- not live: an owner transaction is refused ----------------------------------------------------------------
  const prep = await call<{ code?: string }>('POST', `${base}/activate/prepare`, {})
  check(prep.status === 503 && prep.json.code === 'CHAIN_READ_ONLY', `activate/prepare refused on Monad: ${prep.status} ${prep.json.code}`)
  const sent = (await op.operator.relayer.send({ to: acct.safe, value: 1n }).catch((e: unknown) => e)) as { code?: string }
  check(sent.code === 'CHAIN_UNSUPPORTED', `the relayer refuses to send on Monad: ${sent.code}`)
  check(op.operator.cfg.bundlerUrl === '', 'no loopback bundler was started')
  check(enginePort.stats().rejectedLabMethods === 0, 'the operator never asked anvil for a lab method')

  console.log(`\nE2E MONAD PASS: ${checks} checks. The operator booted on the Monad registry, read Safe ${acct.safe} and valued position #${tokenId} at ${fmt(value, 6)} USDC.`)
  code = 0
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
} finally {
  stopOperator()
  enginePort.stop()
  await fork.stop()
}
process.exit(code)
