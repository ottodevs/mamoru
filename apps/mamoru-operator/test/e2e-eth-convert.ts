// E2E of the ETH conversion (otto/mamoru#211) on an anvil fork of Ethereum that keeps chain id 1: ETH at the
// counterfactual address (the c9d4179b case: 0.05537835 ETH, no code), the owner signs the swap, the relayer deploys
// and sends it, the USDC lands in the same account, and Move to Base then takes it. Real BridgeOut, Relayer, Uniswap
// and Chainlink on the fork; Across's quote is live and its fill status is stubbed.
//
// Run: PATH=$HOME/.foundry/bin:$PATH bun apps/mamoru-operator/test/e2e-eth-convert.ts
// Upstream RPC: L1_RPC_URL, or QUICKNODE_ETH_MAINNET_HTTP from ~/.config/quicknode/endpoints.env (never printed).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, http, toHex, type Hex } from 'viem'
import type { AccountContext, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, baseRegistry, erc20Abi } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { anvilBinary, assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { BridgeOut, L1_USDC, type Fetch } from '../src/bridge-out.ts'
import { HttpError } from '../src/operator.ts'
import { Relayer } from '../src/relayer.ts'

/** anvil's first dev account, funded on every fork. */
const DEV_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const ETH = 55_378_350_000_000_000n

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failures++
}
const code = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e) => (e instanceof HttpError ? e.code : `unexpected: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`),
  )

if (!process.env.L1_RPC_URL) {
  const file = join(homedir(), '.config/quicknode/endpoints.env')
  const line = existsSync(file) ? readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('QUICKNODE_ETH_MAINNET_HTTP=')) : undefined
  if (!line) throw new Error('set L1_RPC_URL')
  process.env.L1_RPC_URL = line.slice(line.indexOf('=') + 1).replace(/^["']|["']$/g, '').trim()
}
const proxy = startForkProxy('L1_RPC_URL')
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
const port = portProbe.port as number
portProbe.stop(true)
const argv = ['--fork-url', proxy.url, '--chain-id', '1', '--host', '127.0.0.1', '--port', String(port), '--no-request-size-limit']
assertNoKeyInArgv(argv, ['L1_RPC_URL'])
const dir = mkdtempSync(join(tmpdir(), 'mamoru-e2e-convert-'))
const anvil = Bun.spawn([anvilBinary(), ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`
try {
  const lab = new Lab(anvilUrl, 1)
  for (let i = 0; ; i++) {
    try {
      await lab.client.getBlockNumber()
      break
    } catch {
      if (i > 300) throw new Error('anvil did not start')
      await Bun.sleep(100)
    }
  }
  const l1 = createPublicClient({ transport: http(anvilUrl) })
  check((await l1.getChainId()) === 1, 'fork keeps chain id 1')

  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner', baseRegistry)]
  const saltNonce = BigInt(Date.now())
  const ctx: AccountContext = {
    accountKey: `e2e-${saltNonce}`,
    chainId: 8453,
    address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
    owners,
    saltNonce: saltNonce.toString(),
    passkey: { credentialId: 'e2e', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
  }
  const safe = ctx.address
  const usdcAt = (a: `0x${string}`) => l1.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })

  let statusAnswer = { status: 'pending' } as { status: string; fillTx?: string }
  const fetcher: Fetch = (url, init) => (url.includes('/deposit/status') ? Promise.resolve(Response.json(statusAnswer)) : fetch(url, init))
  const relayer = new Relayer(DEV_KEY, l1, anvilUrl, 1)
  const on = () => true
  const make = (now: () => number = Date.now) => new BridgeOut(l1, relayer, dir, fetcher, now, undefined, on)
  const bo = make()

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
  function browserSign(t: OwnerTxToSign, by: SoftwarePasskey = passkey): OwnerSignature {
    const a = by.assert(t.safeTxHash)
    const s = randomBytes(1)[0]! & 1 ? P256_N - a.s : a.s
    return {
      prepareId: t.prepareId,
      authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'),
      clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'),
      signature: Buffer.from(der(a.r, s)).toString('base64url'),
    }
  }

  const off = new BridgeOut(l1, relayer, dir, fetcher)
  check((await code(off.prepareConvert(ctx))) === 'BRIDGE_OFF', 'flag off on /ops: BRIDGE_OFF')
  check((await code(bo.prepareConvert(ctx))) === 'CONVERT_NOTHING', 'no ETH on Ethereum: CONVERT_NOTHING')

  await lab.setBalance(safe, ETH)
  check(((await l1.getCode({ address: safe })) ?? '0x') === '0x', 'account not deployed on Ethereum')

  const nonce0 = await l1.getTransactionCount({ address: relayer.address })
  const p0 = await bo.prepareConvert(ctx)
  check(p0.chainId === 1 && p0.safe === safe && p0.summary.length === 3 && p0.convert.ethWei === ETH.toString(), `prepare: ${p0.summary.join(' | ')}`)
  check(BigInt(p0.convert.minUsdc) < BigInt(p0.convert.quotedUsdc) && BigInt(p0.convert.minUsdc) * 10_000n >= BigInt(p0.convert.quotedUsdc) * 9_950n - 10_000n, `min ${p0.convert.minUsdc} is the quote ${p0.convert.quotedUsdc} less 0.5%`)
  check((await code(bo.submitConvert(ctx, browserSign(p0, new SoftwarePasskey(PASSKEY_SCALARS.a2))))) === 'BAD_SIGNATURE', 'another passkey: BAD_SIGNATURE')
  check((await code(bo.submitConvert(ctx, browserSign(p0)))) === 'PREPARE_NOT_FOUND', 'single use, even after a refused signature')
  check((await l1.getTransactionCount({ address: relayer.address })) === nonce0, 'relayer sent nothing for the refused signature')

  // A move's prepare is not a conversion's, and the reverse.
  const pm = await bo.prepareConvert(ctx)
  check((await code(bo.submit(ctx, browserSign(pm)))) === 'PREPARE_NOT_FOUND', "a conversion's approval is refused by Move to Base")

  // The balance changed between prepare and signature: refused, nothing sent.
  const ps = await bo.prepareConvert(ctx)
  await lab.setBalance(safe, ETH + 1n)
  check((await code(bo.submitConvert(ctx, browserSign(ps)))) === 'BRIDGE_STALE', 'ETH changed after prepare: BRIDGE_STALE')
  await lab.setBalance(safe, ETH)

  // The happy path.
  const p1 = await bo.prepareConvert(ctx)
  const done = await bo.submitConvert(ctx, browserSign(p1))
  const c = done.convert!
  const got = await usdcAt(safe)
  check(c.state === 'done' && !!c.deployTx && !!c.l1Tx, `convert: ${c.state}, deployed and sent`)
  check(BigInt(c.usdcOut ?? 0) === got && got >= BigInt(p1.convert.minUsdc), `USDC in the account: ${got} (min ${p1.convert.minUsdc})`)
  check((await l1.getBalance({ address: safe })) === 0n, 'no ETH left in the account')
  check((await bo.status(ctx)).convert?.state === 'done', 'status shows the conversion done')
  check((await code(bo.prepareConvert(ctx))) === 'CONVERT_NOTHING', 'nothing left to convert')

  // A lost outcome is read back from the chain after a restart.
  const file = join(dir, 'bridge-out.json')
  const j = JSON.parse(readFileSync(file, 'utf8'))
  j.converts[ctx.accountKey] = { ...j.converts[ctx.accountKey], state: 'unconfirmed', usdcOut: undefined, at: new Date(Date.now() - 60_000).toISOString() }
  writeFileSync(file, JSON.stringify(j))
  const rs = await make().status(ctx)
  check(rs.convert?.state === 'done' && rs.convert.usdcOut === got.toString(), 'unconfirmed resolved from the receipt after a restart')

  // No transaction hash, past the wait, nonce spent: the Safe's ExecutionSuccess for the signed safeTxHash proves it
  // ran, and the amount comes from that receipt, even with ETH sent to the account again since.
  const j2 = JSON.parse(readFileSync(file, 'utf8'))
  j2.converts[ctx.accountKey] = { ...j2.converts[ctx.accountKey], state: 'unconfirmed', usdcOut: undefined, l1Tx: undefined, at: new Date(Date.now() - 16 * 60_000).toISOString() }
  writeFileSync(file, JSON.stringify(j2))
  await lab.setBalance(safe, ETH)
  const found = await make().status(ctx)
  check(found.convert?.state === 'done' && found.convert.usdcOut === got.toString() && !!found.convert.l1Tx, 'unconfirmed without a hash: found by the Safe event, done with its amount')
  // Another safeTxHash took that nonce (none of ours in the events): this one can never run.
  const j4 = JSON.parse(readFileSync(file, 'utf8'))
  j4.converts[ctx.accountKey] = { ...j4.converts[ctx.accountKey], state: 'unconfirmed', usdcOut: undefined, l1Tx: undefined, safeTxHash: `0x${'77'.repeat(32)}`, at: new Date(Date.now() - 16 * 60_000).toISOString() }
  writeFileSync(file, JSON.stringify(j4))
  const stuck = make()
  check((await stuck.status(ctx)).convert?.state === 'failed', 'nonce taken by another transaction: failed, not stuck')
  await lab.setBalance(safe, 0n)
  // A conversion under way blocks a Move to Base whose approval was prepared before it.
  const pre = await stuck.prepare(ctx)
  const j3 = JSON.parse(readFileSync(file, 'utf8'))
  j3.converts[ctx.accountKey] = { ...j3.converts[ctx.accountKey], state: 'unconfirmed', at: new Date().toISOString() }
  ;(stuck as unknown as { journal: typeof j3 }).journal.converts = j3.converts
  check((await code(stuck.submit(ctx, browserSign(pre)))) === 'BRIDGE_IN_PROGRESS', 'move approved before a conversion, submitted while it is unconfirmed: refused')

  // Then Move to Base takes the USDC (Across, live quote).
  const reborn = make()
  const pmv = await reborn.prepare(ctx)
  check(pmv.summary[0]!.startsWith(`Move ${(Number(got) / 1e6).toFixed(2).replace(/0$/, '')}`) || pmv.summary[0]!.includes('USDC from Ethereum'), `move: ${pmv.summary[0]}`)
  const moved = await reborn.submit(ctx, browserSign(pmv))
  check(moved.route?.state === 'deposited' && (await usdcAt(safe)) === 0n, 'Move to Base: deposited, account emptied on Ethereum')
} finally {
  anvil.kill()
  proxy.stop()
}
console.log(failures === 0 ? 'all passed' : `${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
