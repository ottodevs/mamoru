// E2E of bridge-out (#133) on an anvil fork of Ethereum that keeps chain id 1, reached through a loopback proxy.
// The real BridgeOut and the real Relayer against the fork; the quote is Across's live one. Across's fill status is
// stubbed: a deposit id made on the fork can collide with a real one on mainnet.
//
// Run: nix shell nixpkgs#foundry --command bun apps/mamoru-operator/test/e2e-bridge-out.ts
// Upstream RPC: L1_RPC_URL, or QUICKNODE_ETH_MAINNET_HTTP from ~/.config/quicknode/endpoints.env (never printed).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, encodeFunctionData, http, toHex, type Hex } from 'viem'
import type { AccountContext, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, erc20Abi } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { anvilBinary, assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { BridgeOut, L1_USDC, ACROSS_SPOKE_POOL, type Fetch } from '../src/bridge-out.ts'
import { HttpError } from '../src/operator.ts'
import { Relayer } from '../src/relayer.ts'

const L1_USDC_HOLDER = '0x28C6c06298d514Db089934071355E5743bf21d60' as const
/** anvil's first dev account, funded on every fork. */
const DEV_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const AMOUNT = 150_000_000n

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
const dir = mkdtempSync(join(tmpdir(), 'mamoru-e2e-bridge-'))
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
  const safe = ctx.address
  const usdcAt = (a: `0x${string}`) => l1.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
  const fundSafe = async (amount: bigint) => {
    await lab.setBalance(L1_USDC_HOLDER, 10n ** 18n)
    const r = await lab.sendAs(L1_USDC_HOLDER, L1_USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [safe, amount] }))
    if (!r.ok) throw new Error('could not fund the account on the fork')
  }

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

  // Off on /ops: nothing prepared, status says so.
  const off = new BridgeOut(l1, relayer, dir, fetcher)
  check((await code(off.prepare(ctx))) === 'BRIDGE_OFF' && (await off.status(ctx)).enabled === false, 'flag off on /ops: BRIDGE_OFF, status enabled=false')

  // Nothing there: nothing offered.
  check((await code(bo.prepare(ctx))) === 'BRIDGE_NOTHING', 'no USDC on Ethereum: prepare refuses (BRIDGE_NOTHING)')

  // The #117 case: USDC at the counterfactual address, no code, no ETH.
  await fundSafe(AMOUNT)
  check(((await l1.getCode({ address: safe })) ?? '0x') === '0x', 'account not deployed on Ethereum')

  // A signature from another passkey costs the relayer nothing.
  const nonce0 = await l1.getTransactionCount({ address: relayer.address })
  const p0 = await bo.prepare(ctx)
  check(p0.chainId === 1 && p0.safe === safe && p0.summary.length === 3, `prepare: ${p0.summary.join(' | ')}`)
  const intruder = new SoftwarePasskey(PASSKEY_SCALARS.a2)
  check((await code(bo.submit(ctx, browserSign(p0, intruder)))) === 'BAD_SIGNATURE', 'another passkey: BAD_SIGNATURE')
  check((await code(bo.submit(ctx, browserSign(p0)))) === 'PREPARE_NOT_FOUND', 'a prepare is single use, even after a refused signature')
  check((await l1.getTransactionCount({ address: relayer.address })) === nonce0, 'relayer sent nothing for the refused signature')

  // Another account cannot use this account's prepare.
  const p1 = await bo.prepare(ctx)
  check((await code(bo.submit({ ...ctx, accountKey: 'someone-else' }, browserSign(p1)))) === 'PREPARE_NOT_FOUND', 'a prepare of another account: PREPARE_NOT_FOUND')

  // The happy path.
  const p2 = await bo.prepare(ctx)
  const poolBefore = await usdcAt(ACROSS_SPOKE_POOL)
  const done = await bo.submit(ctx, browserSign(p2))
  const r = done.route!
  check(r.state === 'deposited' && !!r.deployTx && !!r.l1Tx && !!r.depositId, `submit: ${r.state}, deposit id ${r.depositId}`)
  check(r.amountUsdc === AMOUNT.toString() && BigInt(r.outputUsdc) === BigInt(p2.route.outputUsdc), `amounts: ${r.amountUsdc} in, ${r.outputUsdc} out`)
  check((await usdcAt(safe)) === 0n && (await usdcAt(ACROSS_SPOKE_POOL)) - poolBefore === AMOUNT, 'account emptied on Ethereum, SpokePool got the amount')
  check((await l1.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'allowance', args: [safe, ACROSS_SPOKE_POOL] })) === 0n, 'no allowance left')
  check((await code(bo.prepare(ctx))) === 'BRIDGE_IN_PROGRESS', 'after the move, while it is on its way: no second one')

  // Status follows Across, and the journal survives a restart.
  check((await bo.status(ctx)).route?.state === 'deposited', 'status: deposited while Across has not filled')

  // A move whose outcome was lost (the hash came back, the wait for the receipt did not): the chain decides, not a guess.
  const file = join(dir, 'bridge-out.json')
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const realId = j.routes[ctx.accountKey].depositId
  j.routes[ctx.accountKey] = { ...j.routes[ctx.accountKey], state: 'unconfirmed', depositId: undefined }
  writeFileSync(file, JSON.stringify(j))
  const recon = await make().status(ctx)
  check(recon.route?.state === 'deposited' && recon.route.depositId === realId, `unconfirmed resolved from the receipt: deposited, id ${recon.route?.depositId}`)

  statusAnswer = { status: 'filled', fillTx: `0x${'ab'.repeat(32)}` }
  const reborn = make()
  const after = await reborn.status(ctx)
  check(after.route?.state === 'filled' && after.route.fillTx === `0x${'ab'.repeat(32)}`, 'status after a restart: filled on Base')

  // A second deposit later on the deployed account: no deploy, and a balance change between prepare and submit is refused.
  await fundSafe(20_000_000n)
  const p3 = await reborn.prepare(ctx)
  await fundSafe(1_000_000n)
  check((await code(reborn.submit(ctx, browserSign(p3)))) === 'BRIDGE_STALE', 'balance changed after prepare: BRIDGE_STALE')
  const p4 = await reborn.prepare(ctx)
  const second = await reborn.submit(ctx, browserSign(p4))
  check(second.route?.state === 'deposited' && !second.route.deployTx, 'second move on the deployed account: deposited, no deploy')

  // An approval that ran out is refused.
  await fundSafe(5_000_000n)
  let clock = Date.now()
  const timed = make(() => clock)
  // The second move is still 'deposited': a third waits for it.
  check((await code(timed.prepare(ctx))) === 'BRIDGE_IN_PROGRESS', 'a move under way blocks the next one')
  statusAnswer = { status: 'expired' }
  clock += 11_000
  check((await timed.status(ctx)).route?.state === 'expired', 'Across expired: shown as expired (refund pending), not as on its way')
  statusAnswer = { status: 'refunded' }
  clock += 11_000
  check((await timed.status(ctx)).route?.state === 'refunded', 'Across refunded: shown as back on Ethereum')
  const p5 = await timed.prepare(ctx)
  clock += 121_000
  check((await code(timed.submit(ctx, browserSign(p5)))) === 'PREPARE_EXPIRED', 'expired approval: PREPARE_EXPIRED')
  const p6 = await timed.prepare(ctx)
  check((await timed.submit(ctx, browserSign(p6))).route?.state === 'deposited', 'after a refund the owner can move again: deposited')
  statusAnswer = { status: 'filled' }
  clock += 11_000
  await timed.status(ctx)
  await fundSafe(2_000_000n)
  check((await code(timed.prepare(ctx))) === 'BRIDGE_ACCOUNT_LIMIT', 'three moves started today: the fourth waits for tomorrow')
  const spent = JSON.parse(readFileSync(file, 'utf8')).spent
  check(BigInt(spent.wei) > 0n, `the day's relayer spend is on disk (${spent.day}: ${spent.wei} wei)`)
} finally {
  anvil.kill()
  proxy.stop()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
