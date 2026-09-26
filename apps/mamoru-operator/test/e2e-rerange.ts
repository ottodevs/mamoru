// E2E of the live re-range (lane U9) on an anvil fork of Base that keeps chain id 8453: one passkey activates
// enter + manage-any; the engine enters; the TEST ONLY pushes the pool price out of range with a whale swap on
// anvil; the engine re-ranges by itself (decrease + collect + burn, then a new centred mint). Every token that
// left the Safe went to the pool, and a session userOp that collects to another recipient fails validation.
// Base on the E2E of the live operator.
// The upstream RPC comes from the environment only (RPC_URL or BASE_RPC_URL, or ~/.config/mamoru-operator/env)
// and reaches anvil through a loopback proxy; the operator talks to anvil through the engine port, which
// refuses anvil_* methods. Blocks advance by themselves (--block-time 1), so the operator runs unchanged.
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData, keccak256, pad, parseAbi, parseEventLogs, toHex, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { AccountContext, FundingView, OpView, OwnerSignature, OwnerTxToSign, TransferPlan, WithdrawAsset } from '@mamoru/domain'
import { address, entry, entryPointV07Abi, erc20Abi, nonfungiblePositionManagerAbi, uniswapV3PoolAbi } from '@mamoru/registry'
import { collect } from '@mamoru/uniswap-v3'
import { sqrtRatioAtTick } from '@mamoru/uniswap-v3/quote'
import { draftUserOp, executeCallData, handleOpsData, sessionNonceKey, signSessionUserOp } from '@mamoru/account/sessions'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startEnginePort, startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab, decodeEntryPointError } from '../../../packages/scenarios/fixtures/lab.ts'
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
const ATTACKER = '0x000000000000000000000000000000000000bEEF' as const
const MOVER = '0x0000000000000000000000000000000000C0FFEE' as const
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
  process.env.MAMORU_HEAD_LAG = '0'
  const secret = randomBytes(32).toString('hex')
  const op = await bootOperator({ rpcUrl: enginePort.url, secret, stateDir: join(dir, 'state'), port: 0, reviewMs: 2_000, waitBlockMs: 1_100 })
  stopOperator = op.stop
  check(op.operator.cfg.live && op.operator.cfg.policy.session.grants.some((g) => g.name === 'manage-any'), `operator live with ${op.operator.cfg.policy.policyId} (manage-any)`)
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
  async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null>): Promise<T> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const all = await ops()
      const bad = all.filter((o) => o.state === 'failed')
      if (bad.length) log(`note: failed ops ${bad.map((o) => `${o.opId}:${o.code}`).join(', ')}`)
      const v = await probe()
      if (v !== null) return v
      if (Date.now() > until) throw new Error(`E2E FAILED: ${what}: ${JSON.stringify(all.map((o) => `${o.opId} ${o.state} ${o.code}`))}`)
      await Bun.sleep(2_000)
    }
  }

  // --- activate: one passkey, enter + manage-any -------------------------------
  const prep = await call<OwnerTxToSign>('POST', `${base}/activate/prepare`)
  if (prep.status !== 200) throw new Error(`E2E FAILED: activate/prepare ${prep.status} ${JSON.stringify(prep.json)}`)
  log(`activate to sign: ${prep.json.summary.join(' | ')}`)
  const act = await call<OpView>('POST', `${base}/activate`, browserSign(prep.json))
  const activated = await waitFor('activation', 120_000, async () => {
    const o = (await ops()).find((x) => x.opId === act.json.opId)
    return o?.state === 'confirmed' ? o : null
  })
  const state = (op.operator as unknown as { store: { state: { accounts: Record<string, { sessionKey: Hex; grants: { name: string; permissionId: Hex }[] }> } } }).store.state.accounts[ctx.accountKey]!
  check(
    ['enter-swap', 'enter-mint', 'manage-any', 'convert-any'].every((n) => state.grants.some((g) => g.name === n)),
    `one owner tx (${activated.txHash}) enabled ${state.grants.map((g) => g.name).join(', ')}`,
  )
  const fromBlock = BigInt(activated.block!)
  const safe = ctx.address as Address

  // --- engine enters ----------------------------------------------------------
  const pos1 = await waitFor('engine entry', 240_000, async () => {
    const f = await funding()
    return f.positions.find((p) => BigInt(p.liquidity) > 0n) ?? null
  })
  const id1 = BigInt(pos1.tokenId)
  const npm = address('NonfungiblePositionManager')
  const p1 = await lab.client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [id1] })
  const pool = entry('pool:USDC/cbBTC/500')
  const tick0 = (await lab.client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
  check(p1[5] <= tick0 && tick0 < p1[6], `engine entered: position #${id1} [${p1[5]}, ${p1[6]}) around tick ${tick0}`)

  // --- malicious session userOp: collect to another recipient ---------------------
  const sessionKey = privateKeyToAccount(state.sessionKey)
  const manageAny = state.grants.find((g) => g.name === 'manage-any')!
  const key = sessionNonceKey(7)
  async function validate(recipient: Address): Promise<string> {
    const nonce = await lab.entryPointNonce(safe, key)
    const blk = await lab.client.getBlock()
    const callData = executeCallData([collect({ account: recipient, tokenId: id1 })].map((c) => ({ target: c.to, value: 0n, callData: c.data })))
    const u = draftUserOp(safe, nonce, callData, { verificationGasLimit: 3_000_000n, callGasLimit: 1_000_000n, preVerificationGas: 100_000n, maxFeePerGas: (blk.baseFeePerGas ?? 0n) * 2n + 1_000_000n, maxPriorityFeePerGas: 1_000_000n })
    const signed = await signSessionUserOp(u, 8453, manageAny.permissionId, sessionKey)
    try {
      await lab.client.call({ account: op.operator.relayer.address, to: address('EntryPointV07'), data: handleOpsData([signed], op.operator.relayer.address), gas: 10_000_000n })
      return 'ok'
    } catch (e) {
      const m = /custom error (0x[0-9a-f]{8}):\s*([0-9a-f]+)/i.exec((e as Error).message)
      const d = m ? decodeEntryPointError(`${m[1]}${m[2]}` as Hex) : null
      return d ? `${d.name} ${d.reason ?? ''} ${d.inner ?? ''}`.trim() : `revert ${(e as Error).message.split('\n')[0]}`
    }
  }
  const attackerBefore = [await lab.balanceOf('USDC', ATTACKER), await lab.balanceOf('cbBTC', ATTACKER)]
  const evil = await validate(ATTACKER)
  check(/AA2[34]/.test(evil), `session userOp collect(#${id1}, recipient ${ATTACKER}) rejected in validation: ${evil}`)
  check((await validate(safe)) === 'ok', `control: the same userOp with recipient = Safe validates`)

  // --- TEST ONLY: push the pool price out of range with a whale swap on anvil ----------
  const usdc = address('USDC')
  const slot = keccak256(`0x${pad(MOVER).slice(2)}${pad(toHex(9n)).slice(2)}` as Hex)
  const huge = 10n ** 15n
  await lab.rpc('anvil_setStorageAt', [usdc, slot, pad(toHex(huge))])
  check((await lab.balanceOf('USDC', MOVER)) === huge, `test mover holds ${huge} USDC units (storage write, test only)`)
  await lab.setBalance(MOVER, 10n ** 18n)
  // anvil forwards a receipt query for a not-yet-mined hash upstream; poll locally and tolerate that.
  async function sendAs(from: Address, to: Address, data: Hex): Promise<{ ok: boolean }> {
    await lab.rpc('anvil_impersonateAccount', [from])
    const hash = await lab.rpc<Hex>('eth_sendTransaction', [{ from, to, data, gas: '0x1c9c380' }])
    await lab.rpc('anvil_stopImpersonatingAccount', [from])
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(1_000)
      try {
        const r = await lab.client.getTransactionReceipt({ hash })
        if (r) return { ok: r.status === 'success' }
      } catch {}
    }
    throw new Error(`E2E FAILED: no receipt for ${hash}`)
  }
  const router = address('SwapRouter02')
  await sendAs(MOVER, usdc, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [router, huge] }))
  const target = p1[5] - 400
  const swapAbi = parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)'])
  const sw = await sendAs(MOVER, router, encodeFunctionData({ abi: swapAbi, functionName: 'exactInputSingle', args: [{ tokenIn: usdc, tokenOut: address('cbBTC'), fee: 500, recipient: MOVER, amountIn: huge, amountOutMinimum: 0n, sqrtPriceLimitX96: sqrtRatioAtTick(target) }] }))
  const tick1 = (await lab.client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
  check(sw.ok && tick1 < p1[5], `whale swap moved the pool tick ${tick0} -> ${tick1}, below the range [${p1[5]}, ${p1[6]})`)
  // Let the TWAP (policy window) catch up with the new price so the EHG accepts it.
  await lab.warp(op.operator.cfg.policy.execution.twapWindowSeconds + 60)

  // --- engine re-ranges by itself -----------------------------------------------------
  const rerange = await waitFor('engine re-range', 240_000, async () => (await ops()).find((o) => o.opId.includes('rerange') && o.state === 'confirmed') ?? null)
  const owner = await lab.client.readContract({ address: npm, abi: parseAbi(['function ownerOf(uint256) view returns (address)']), functionName: 'ownerOf', args: [id1] }).catch(() => null)
  check(owner === null, `re-range ${rerange.opId} (${rerange.txHash}) burned position #${id1}`)
  const pos2 = await waitFor('new mint in range', 300_000, async () => {
    const f = await funding()
    return f.positions.find((p) => BigInt(p.tokenId) !== id1 && BigInt(p.liquidity) > 0n && p.inRange) ?? null
  })
  const p2 = await lab.client.readContract({ address: npm, abi: nonfungiblePositionManagerAbi, functionName: 'positions', args: [BigInt(pos2.tokenId)] })
  const tick2 = (await lab.client.readContract({ address: pool.address, abi: uniswapV3PoolAbi, functionName: 'slot0' }))[1]
  check(p2[5] <= tick2 && tick2 < p2[6], `new position #${pos2.tokenId} [${p2[5]}, ${p2[6]}) is in range at tick ${tick2}: USDC ${pos2.amountUsdc} cbBTC ${pos2.amountCbbtc}`)

  // --- funds never left the Safe ---------------------------------------------------------
  const toBlock = await lab.client.getBlockNumber()
  const transferEvt = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])
  const erc20Out = await lab.client.getLogs({ address: [usdc, address('cbBTC')], event: transferEvt[0], args: { from: safe }, fromBlock, toBlock })
  const strays = erc20Out.filter((l) => l.args.to!.toLowerCase() !== pool.address.toLowerCase())
  check(erc20Out.length > 0 && strays.length === 0, `${erc20Out.length} ERC-20 transfers out of the Safe since activation, all to the pool (mint and swap payments); 0 elsewhere`)
  const nftOut = parseEventLogs({ abi: nonfungiblePositionManagerAbi, eventName: 'Transfer', logs: await lab.client.getLogs({ address: npm, fromBlock, toBlock }) }).filter((l) => l.args.from.toLowerCase() === safe.toLowerCase())
  check(nftOut.every((l) => l.args.to === '0x0000000000000000000000000000000000000000'), `${nftOut.length} position NFTs left the Safe, all burned`)
  check((await lab.balanceOf('USDC', ATTACKER)) === attackerBefore[0] && (await lab.balanceOf('cbBTC', ATTACKER)) === attackerBefore[1], 'the attacker address received nothing')
  const stats = enginePort.stats()
  check(stats.rejectedLabMethods === 0, `operator made ${stats.forwarded} RPC calls, 0 anvil_/evm_ methods`)
  const all = await ops()
  log(`RESULT PASS: ops ${all.map((o) => `${o.opId}:${o.state}`).join(', ')}`)
} catch (e) {
  console.error((e as Error).message)
  process.exitCode = 1
} finally {
  await cleanup()
}
process.exit(process.exitCode ?? 0)
