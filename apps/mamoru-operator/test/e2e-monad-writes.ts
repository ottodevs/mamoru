// otto/mamoru#61: the operator WRITING to Monad, end to end, through its own HTTP prepare/submit path. An anvil fork of
// Monad mainnet that keeps chain id 143 (so the operator runs the mainnet configuration: MAMORU_CHAIN_WRITES=143,
// MAMORU_LIVE=1, policy live-wmon-usdc-monad-v1), with TimeFramePolicy and UsageLimitPolicy deployed on the fork the
// way Base deployed them (#62; Monad mainnet does not have them yet). A passkey owner deposits USDC to its
// counterfactual Safe, prepares and signs the activation; the relayer deploys the Safe, tops up its MON gas reserve and
// executes the activation; the engine enters the WMON/USDC pool (enter_swap, enter_mint) through the operator's
// loopback bundler. Then the gas each transaction declared is set against what it used: Monad charges the limit.
//   PATH=$HOME/.foundry/bin:$PATH bun apps/mamoru-operator/test/e2e-monad-writes.ts
// MONAD_RPC_URL overrides the public Monad RPC (the fork's upstream; never in argv).
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeFunctionData, encodeFunctionData, parseEventLogs, toHex, type Hex } from 'viem'
import type { AccountContext, FundingView, OpView, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, entryPointV07Abi, erc20Abi, monadRegistry } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab, devAccount } from '../../../packages/scenarios/fixtures/lab.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { buyUsdc, deployBasePolicies } from '../../../packages/scenarios/monad/harness.ts'
import { bootOperator } from '../src/boot.ts'
import { operatorSignature } from '../src/server.ts'

const DEPOSIT = 50_000_000n // 50 USDC, under the 100 USDC default cap
const POOL = 'pool:WMON/USDC/3000'
const t0 = Date.now()
const log = (m: string) => console.log(`[e2e-monad-writes +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
let checks = 0
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`E2E FAILED: ${what}`)
  checks++
  log(`ok  ${what}`)
}

if (!process.env.MONAD_RPC_URL) process.env.MONAD_RPC_URL = 'https://rpc.monad.xyz'
const proxy = startForkProxy('MONAD_RPC_URL')
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = probe.port as number
probe.stop(true)
// Chain id 143 kept on purpose: this is the mainnet configuration, which the lab chain ids never reach.
const argv = ['--fork-url', proxy.url, '--chain-id', '143', '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', '1', '--block-time', '1', '--no-request-size-limit']
assertNoKeyInArgv(argv, ['MONAD_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-operator-e2e-monad-writes-'))
const anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`
const lab = new Lab(anvilUrl, 143, monadRegistry)
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
let code = 1
try {
  log(`fork of Monad at block ${await lab.client.getBlockNumber()}, chain ${await lab.client.getChainId()}, gas price ${await lab.client.getGasPrice()} wei`)

  // --- #62 on the fork: the two session policies, as Base deployed them ---------------------------------------------
  const policies = await deployBasePolicies(lab, devAccount(3))
  check(policies.length === 2, `TimeFramePolicy and UsageLimitPolicy at their Base address with Base's code: ${policies.map((p) => p.address).join(', ')}`)

  // --- the account, as the Worker describes it, and the deposit to its counterfactual Safe --------------------------
  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner', monadRegistry)]
  const saltNonce = BigInt(Date.now())
  const ctx: AccountContext = {
    accountKey: `e2e-monad-${saltNonce}`,
    chainId: 143,
    address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y, monadRegistry), monadRegistry), monadRegistry),
    owners,
    saltNonce: saltNonce.toString(),
    passkey: { credentialId: 'e2e-monad', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
  }
  const buyer = devAccount(2)
  await buyUsdc({ lab, registry: monadRegistry, pool: POOL }, buyer, DEPOSIT)
  const dep = await lab.send(buyer, address('USDC', monadRegistry), encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [ctx.address, DEPOSIT] }))
  check(dep.ok && (await lab.balanceOf('USDC', ctx.address)) === DEPOSIT, `deposit: ${DEPOSIT} USDC units sent to counterfactual Safe ${ctx.address}`)

  // --- the operator, opted into writing to Monad --------------------------------------------------------------------
  process.env.MAMORU_LIVE = '1'
  process.env.MAMORU_CHAIN_WRITES = '143'
  process.env.MAMORU_HEAD_LAG = '0'
  delete process.env.MAMORU_SOURCE_CHAIN_ID
  const secret = randomBytes(32).toString('hex')
  const op = await bootOperator({ rpcUrl: enginePort.url, secret, stateDir: join(dir, 'state'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100, policyId: 'live-wmon-usdc-monad-v1' })
  stopOperator = op.stop
  check(op.operator.cfg.live && op.operator.cfg.chainId === 143 && op.operator.cfg.registry.chainId === 143, 'operator is live on chain 143 with MAMORU_CHAIN_WRITES=143')
  check(op.operator.cfg.bundlerUrl !== '', 'the loopback bundler runs')
  check(op.operator.cfg.registry.entries.some((e) => e.name === 'TimeFramePolicy') && !monadRegistry.entries.some((e) => e.name === 'TimeFramePolicy'), 'the write registry carries the session policies verified on the chain; monad.json is untouched')
  await lab.setBalance(op.operator.relayer.address, 100n * 10n ** 18n)

  const header = Buffer.from(JSON.stringify(ctx)).toString('base64url')
  async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: T }> {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const ts = Math.floor(Date.now() / 1000).toString()
    const sig = operatorSignature(secret, method, path, header, raw, ts)
    const res = await fetch(op.url + path, { method, headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': sig, 'content-type': 'application/json' }, body: method === 'POST' ? raw : undefined })
    return { status: res.status, json: (await res.json()) as T }
  }
  const base = `/api/accounts/${ctx.accountKey}`
  const funding = async () => (await call<FundingView>('GET', `${base}/funding?fresh=1`)).json
  const ops = async () => (await call<{ ops: OpView[] }>('GET', `${base}/ops`)).json.ops

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

  const f0 = await funding()
  check(!f0.deployed && f0.usdc === DEPOSIT.toString() && !f0.active, `funding before activation: not deployed, ${f0.usdc} USDC, inactive`)
  const assets = (await call<{ assets: { asset: string; available: boolean }[] }>('GET', `${base}/withdraw-assets`)).json.assets
  check(assets.filter((a) => a.available).map((a) => a.asset).join() === 'USDC', `withdraw assets on Monad: USDC only (${assets.map((a) => `${a.asset}=${a.available}`).join(', ')})`)

  // --- activate: the operator's real prepare and submit ------------------------------------------------------------
  const prep = await call<OwnerTxToSign>('POST', `${base}/activate/prepare`, {})
  check(prep.status === 200, `activate/prepare answers 200 (${prep.status} ${JSON.stringify(prep.json).slice(0, 200)})`)
  const summary = prep.json.summary.join(' | ')
  log(`activate to sign: ${summary}`)
  check(prep.json.chainId === 143 && summary.includes('on Monad') && summary.includes('WMON/USDC 0.30%') && !/Base|cbBTC|WETH|ETH\b/.test(summary), 'the summary names Monad, WMON/USDC and nothing of Base')
  const sub = await call<OpView>('POST', `${base}/activate`, browserSign(prep.json))
  check(sub.status === 200, `activate submitted (${sub.status} ${JSON.stringify(sub.json).slice(0, 200)})`)
  const until = Date.now() + 180_000
  let activated: OpView | undefined
  for (;;) {
    activated = (await ops()).find((o) => o.opId === sub.json.opId)
    if (activated && (activated.state === 'confirmed' || activated.state === 'failed')) break
    if (Date.now() > until) throw new Error(`E2E FAILED: activation still ${activated?.state}`)
    await Bun.sleep(1_000)
  }
  check(activated.state === 'confirmed', `owner activation confirmed (${activated.txHash} block ${activated.block}; ${activated.code})`)
  const f1 = await funding()
  check(f1.deployed && f1.active && BigInt(f1.eth) >= BigInt(f1.gasReserveWei), `Safe deployed, engine active, ${f1.eth} MON wei >= reserve ${f1.gasReserveWei}`)

  // --- the engine enters: swap USDC to WMON, then mint in WMON/USDC ------------------------------------------------
  const enterUntil = Date.now() + 300_000
  let enters: OpView[] = []
  for (;;) {
    enters = (await ops()).filter((o) => o.kind === 'enter')
    if (enters.some((o) => o.opId.includes('enter_mint') && o.state === 'confirmed')) break
    if (enters.some((o) => o.state === 'failed')) throw new Error(`E2E FAILED: engine op failed ${JSON.stringify(enters)}`)
    if (Date.now() > enterUntil) throw new Error(`E2E FAILED: engine did not enter: ${JSON.stringify(enters)}; engine ${JSON.stringify(f1.engine)}`)
    await Bun.sleep(2_000)
  }
  const confirmed = enters.filter((o) => o.state === 'confirmed')
  check(confirmed.some((o) => o.opId.includes('enter_swap')) && confirmed.some((o) => o.opId.includes('enter_mint')), `engine entered: ${confirmed.map((o) => `${o.opId} ${o.txHash}`).join(', ')}`)
  const f2 = await funding()
  const pos = f2.positions[0]
  check(f2.positions.length === 1 && pos!.pool === POOL && BigInt(pos!.liquidity) > 0n, `position #${pos?.tokenId} in ${pos?.pool}, in range ${pos?.inRange}, worth ${pos?.valueUsdc} USDC units; idle USDC ${f2.usdc}`)

  // --- gas: what each transaction declared against what it used ----------------------------------------------------
  const ep = address('EntryPointV07', monadRegistry)
  for (const o of confirmed) {
    const tx = await lab.client.getTransaction({ hash: o.txHash as Hex })
    const r = await lab.client.getTransactionReceipt({ hash: o.txHash as Hex })
    const { args } = decodeFunctionData({ abi: entryPointV07Abi, data: tx.input })
    const packed = (args as unknown as [{ accountGasLimits: Hex; preVerificationGas: bigint }[]])[0][0]!
    const vgl = BigInt(`0x${packed.accountGasLimits.slice(2, 34)}`)
    const cgl = BigInt(`0x${packed.accountGasLimits.slice(34)}`)
    const ev = parseEventLogs({ abi: entryPointV07Abi, logs: r.logs, eventName: 'UserOperationEvent' })[0]!
    const declared = vgl + cgl + packed.preVerificationGas
    log(`${o.opId}: handleOps gas limit ${tx.gas}, used ${r.gasUsed} (${((Number(tx.gas) / Number(r.gasUsed) - 1) * 100).toFixed(1)}% over); userOp limits verification ${vgl} + call ${cgl} + pre ${packed.preVerificationGas} = ${declared}, EntryPoint actualGasUsed ${ev.args.actualGasUsed}`)
    // The bundle carries eth_estimateGas + 10%. The estimate is the least gas limit that succeeds, above the gas used by
    // the refunds and the 63/64 reserve of the nested calls: about 1.24x on this fork. Bounded at 1.5x, never the fixed 6M.
    check(tx.to?.toLowerCase() === ep.toLowerCase() && tx.gas <= (r.gasUsed * 3n) / 2n, `${o.opId}: the bundle declared ${tx.gas} for ${r.gasUsed} used (under 1.5x), not the fixed 6M`)
    check(declared < 5_100_000n && cgl < 2_000_000n, `${o.opId}: userOp limits sized from the simulation (${declared} declared, not 5.1M)`)
  }
  const ownerTx = await lab.client.getTransaction({ hash: activated.txHash as Hex })
  const ownerRc = await lab.client.getTransactionReceipt({ hash: activated.txHash as Hex })
  log(`activation exec: gas limit ${ownerTx.gas}, used ${ownerRc.gasUsed}`)
  check(ownerTx.gas <= (ownerRc.gasUsed * 3n) / 2n, `the activation exec declared ${ownerTx.gas} for ${ownerRc.gasUsed} used (estimate + 10%, under 1.5x)`)
  check(enginePort.stats().rejectedLabMethods === 0, `operator made ${enginePort.stats().forwarded} RPC calls, no anvil_/evm_ method`)

  console.log(`\nE2E MONAD WRITES PASS: ${checks} checks. Safe ${ctx.address} activated on chain 143 and positioned in ${POOL} (#${pos!.tokenId}).`)
  code = 0
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
} finally {
  stopOperator()
  enginePort.stop()
  anvil.kill()
  await anvil.exited
  proxy.stop()
}
process.exit(code)
