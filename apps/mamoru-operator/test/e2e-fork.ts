// E2E of the live operator on an anvil fork of Base that keeps chain id 8453.
// The upstream RPC comes from the environment only (RPC_URL or BASE_RPC_URL, or ~/.config/mamoru-operator/env)
// and reaches anvil through a loopback proxy; the operator talks to anvil through the engine port, which
// refuses anvil_* methods. Blocks advance by themselves (--block-time 1), so the operator runs unchanged.
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { toHex, type Hex } from 'viem'
import type { AccountContext, FundingView, OpView, OwnerSignature, OwnerTxToSign, TransferPlan } from '@mamoru/domain'
import { address } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { WHALE } from '../../../packages/scenarios/fixtures/world.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { bootOperator } from '../src/boot.ts'

const envFile = join(homedir(), '.config/mamoru-operator/env')
if (!process.env.RPC_URL && existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line)
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '')
  }
}
if (!process.env.RPC_URL && process.env.BASE_RPC_URL) process.env.RPC_URL = process.env.BASE_RPC_URL

const DEPOSIT = 10_000_000n
const TRANSFER = 2_000_000n
const SINK = '0x000000000000000000000000000000000000dEaD' as const
const t0 = Date.now()
const log = (m: string) => console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`E2E FAILED: ${what}`)
  log(`ok  ${what}`)
}

// --- fork -----------------------------------------------------------------
const proxy = startForkProxy('RPC_URL')
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = portProbe.port as number
portProbe.stop(true)
const argv = ['--fork-url', proxy.url, '--chain-id', '8453', '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', '1', '--block-time', '1', '--no-request-size-limit']
assertNoKeyInArgv(argv, ['RPC_URL', 'BASE_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-operator-e2e-'))
const anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`
const lab = new Lab(anvilUrl, 8453)
for (let i = 0; ; i++) {
  try {
    await lab.client.getBlockNumber()
    break
  } catch {
    if (i > 300) throw new Error('anvil did not start')
    await Bun.sleep(200)
  }
}
const enginePort = startEnginePort(anvilUrl)
let stopOperator = () => {}
const cleanup = async () => {
  stopOperator()
  enginePort.stop()
  anvil.kill()
  await anvil.exited
  proxy.stop()
}

try {
  log(`fork of Base at block ${await lab.client.getBlockNumber()}, chain ${await lab.client.getChainId()}`)

  // --- the account, as the Worker would describe it ------------------------
  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner')]
  const saltNonce = BigInt(Date.now())
  const ctx: AccountContext = {
    accountKey: `e2e-${saltNonce}`,
    chainId: 8453,
    address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
    owners,
    saltNonce: saltNonce.toString(),
    passkey: { credentialId: 'e2e', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
  }
  await lab.whaleTransfer('USDC', WHALE, ctx.address, DEPOSIT)
  log(`counterfactual Safe ${ctx.address} funded with ${DEPOSIT} USDC units`)

  // --- operator, live on "8453" ------------------------------------------------
  process.env.MAMORU_LIVE = '1'
  // anvil is one node: no head lag to absorb (live default 3 blocks, see rpc-proxy.ts)
  process.env.MAMORU_HEAD_LAG = '0'
  const secret = randomBytes(32).toString('hex')
  const op = await bootOperator({ rpcUrl: enginePort.url, secret, stateDir: join(dir, 'state'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100 })
  stopOperator = op.stop
  check(op.operator.cfg.live, 'operator is live on chain 8453 with MAMORU_LIVE=1')
  await lab.setBalance(op.operator.relayer.address, 10n ** 18n)

  const header = Buffer.from(JSON.stringify(ctx)).toString('base64url')
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const sig = createHmac('sha256', secret).update(`${method} ${path}\n${header}\n${raw}`).digest('hex')
    const res = await fetch(op.url + path, { method, headers: { 'x-mamoru-account': header, 'x-mamoru-sig': sig, 'content-type': 'application/json' }, body: method === 'POST' ? raw : undefined })
    return { status: res.status, json: (await res.json()) as T }
  }
  const base = `/api/accounts/${ctx.accountKey}`
  const funding = async () => (await call<FundingView>('GET', `${base}/funding`)).json
  const ops = async () => (await call<{ ops: OpView[] }>('GET', `${base}/ops`)).json.ops

  // auth is enforced
  const bad = await fetch(`${op.url}${base}/funding`, { headers: { 'x-mamoru-account': header, 'x-mamoru-sig': '00'.repeat(32) } })
  check(bad.status === 401, 'a wrong HMAC is refused with 401')

  function der(r: bigint, s: bigint): Uint8Array {
    const int = (v: bigint) => {
      let b = Buffer.from(v.toString(16).padStart(64, '0'), 'hex')
      while (b.length > 1 && b[0] === 0 && !(b[1]! & 0x80)) b = b.subarray(1)
      if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b])
      return Buffer.concat([Buffer.from([0x02, b.length]), b])
    }
    const body = Buffer.concat([int(r), int(s)])
    return Buffer.concat([Buffer.from([0x30, body.length]), body])
  }
  /** What navigator.credentials.get returns, posted as OwnerSignature (high s half the time, as browsers do). */
  function browserSign(t: OwnerTxToSign): OwnerSignature {
    const a = passkey.assert(t.safeTxHash)
    const s = randomBytes(1)[0]! & 1 ? P256_N - a.s : a.s
    return {
      prepareId: t.prepareId,
      authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'),
      clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'),
      signature: Buffer.from(der(a.r, s)).toString('base64url'),
    }
  }
  async function waitOp(opId: string, what: string, timeoutMs = 120_000): Promise<OpView> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const o = (await ops()).find((x) => x.opId === opId)
      if (o && (o.state === 'confirmed' || o.state === 'failed')) {
        check(o.state === 'confirmed', `${what} confirmed (${o.txHash} block ${o.block})`)
        return o
      }
      if (Date.now() > until) throw new Error(`E2E FAILED: ${what} still ${o?.state}`)
      await Bun.sleep(1_000)
    }
  }
  async function ownerAction(kind: 'activate' | 'transfer' | 'stop', prepareBody?: unknown): Promise<OpView> {
    const prep = await call<OwnerTxToSign | TransferPlan>('POST', `${base}/${kind}/prepare`, prepareBody)
    if (prep.status !== 200) throw new Error(`E2E FAILED: ${kind}/prepare ${prep.status} ${JSON.stringify(prep.json)}`)
    const tx = 'ownerTx' in prep.json ? prep.json.ownerTx : prep.json
    if ('reduce' in prep.json) log(`transfer plan reduce ${JSON.stringify(prep.json.reduce)}`)
    log(`${kind} to sign: ${tx.summary.join(' | ')}`)
    const res = await call<OpView>('POST', `${base}/${kind}`, browserSign(tx))
    if (res.status !== 200) throw new Error(`E2E FAILED: ${kind} ${res.status} ${JSON.stringify(res.json)}`)
    return waitOp(res.json.opId, `owner ${kind}`)
  }

  const f0 = await funding()
  check(!f0.deployed && f0.usdc === DEPOSIT.toString() && !f0.active, `funding before activation: not deployed, ${f0.usdc} USDC, inactive`)

  // a signature over another tx is refused
  const p0 = await call<OwnerTxToSign>('POST', `${base}/activate/prepare`)
  const wrong = browserSign({ ...p0.json, safeTxHash: `0x${'11'.repeat(32)}` as Hex })
  check((await call('POST', `${base}/activate`, wrong)).status === 400, 'an assertion over another hash is refused with 400')

  // --- activate --------------------------------------------------------------
  const activate = await ownerAction('activate')
  const f1 = await funding()
  check(f1.deployed && f1.active && BigInt(f1.eth) >= BigInt(f1.gasReserveWei), `Safe deployed, engine active, ETH ${f1.eth} >= reserve ${f1.gasReserveWei}`)

  // --- engine enters: swap then mint ------------------------------------------
  const until = Date.now() + 240_000
  let enters: OpView[] = []
  for (;;) {
    enters = (await ops()).filter((o) => o.kind === 'enter')
    if (enters.filter((o) => o.state === 'confirmed').length >= 2) break
    if (enters.some((o) => o.state === 'failed')) throw new Error(`E2E FAILED: engine op failed ${JSON.stringify(enters)}`)
    if (Date.now() > until) throw new Error(`E2E FAILED: engine did not enter: ${JSON.stringify(enters)}`)
    await Bun.sleep(2_000)
  }
  check(enters[0]!.opId.includes('enter_swap') && enters[1]!.opId.includes('enter_mint'), `engine entered: ${enters.map((o) => `${o.opId} ${o.txHash}`).join(', ')}`)
  const f2 = await funding()
  check(f2.positions.length === 1 && BigInt(f2.positions[0]!.liquidity) > 0n, `funding shows position #${f2.positions[0]?.tokenId} inRange=${f2.positions[0]?.inRange} USDC ${f2.positions[0]?.amountUsdc} cbBTC ${f2.positions[0]?.amountCbbtc}; idle USDC ${f2.usdc}`)

  // --- transfer 2 USDC out ----------------------------------------------------
  const sinkBefore = await lab.balanceOf('USDC', SINK)
  const transfer = await ownerAction('transfer', { to: SINK, amountUsdc: TRANSFER.toString() })
  check((await lab.balanceOf('USDC', SINK)) - sinkBefore === TRANSFER, `${TRANSFER} USDC units arrived at ${SINK}`)

  // --- transfer more than the idle USDC: the owner batch reduces the position and swaps cbBTC first ---
  const idle = BigInt((await funding()).usdc)
  const big = idle + 1_000_000n
  const reduceTx = await ownerAction('transfer', { to: SINK, amountUsdc: big.toString() })
  const f25 = await funding()
  check((await lab.balanceOf('USDC', SINK)) - sinkBefore === TRANSFER + big && f25.positions.length === 1, `${big} USDC units (idle ${idle} + 1 USDC) sent after reducing position #${f25.positions[0]?.tokenId} to liquidity ${f25.positions[0]?.liquidity}`)

  const tooMuch = await call<{ code: string; error: string }>('POST', `${base}/transfer/prepare`, { to: SINK, amountUsdc: '100000000' })
  check(tooMuch.status === 409, `a transfer the Safe cannot cover is refused before signing: ${tooMuch.json.code} ${tooMuch.json.error}`)

  // --- stop -------------------------------------------------------------------
  const stop = await ownerAction('stop')
  const f3 = await funding()
  const cbbtcValueCap = 10_000n // dust: < ~$10 at any sane BTC price is not the claim; we assert < 0.0001 BTC
  check(!f3.active && f3.positions.length === 0 && BigInt(f3.cbbtc) < cbbtcValueCap, `after stop: inactive, no positions, cbBTC ${f3.cbbtc} units (dust), USDC ${f3.usdc}, ETH ${f3.eth}`)
  const usdcAfter = BigInt(f3.usdc)
  check(usdcAfter > DEPOSIT - TRANSFER - big - 100_000n, `Safe holds ${usdcAfter} USDC units after round trip (deposit ${DEPOSIT} - transfers ${TRANSFER + big}, costs within 0.1 USDC)`)

  const all = await ops()
  const txs = new Set(all.filter((o) => o.txHash).map((o) => o.txHash))
  const stats = enginePort.stats()
  check(stats.rejectedLabMethods === 0, `operator made ${stats.forwarded} RPC calls, 0 anvil_/evm_ methods`)
  log(`RESULT PASS: ops ${all.map((o) => `${o.kind}:${o.state}`).join(', ')}; ${txs.size} distinct tx hashes (activate ${activate.txHash}, transfer ${transfer.txHash}, reduce+transfer ${reduceTx.txHash}, stop ${stop.txHash})`)
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await cleanup()
}
process.exit(process.exitCode ?? 0)
