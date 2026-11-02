// E2E of the V4 sibling's set-up (otto/mamoru#309 b) on an anvil fork of Ethereum after T7 (V4 deployed there 2 Nov):
// ETH at the counterfactual address (the c9d4179b case: 0.05537835 ETH, no code), the owner signs ONE Safe tx on
// Ethereum (buildMigrateV4 step 1 on chain 1: trust + self-attest + enableSessions + assertMigrated), the relayer
// deploys the Safe and sends it, and SmartSession lists the V4 session whose Init names the account itself as home.
// Real BridgeOut, Relayer, ModuleRegistry, SmartSession and V4 on the fork; the passkey is a software P-256 key.
//
// Run: PATH=$HOME/.foundry/bin:$PATH bun apps/mamoru-operator/test/e2e-ethereum-sibling.ts
// Upstream RPC: L1_RPC_URL, or QUICKNODE_ETH_MAINNET_HTTP from ~/.config/quicknode/endpoints.env (never printed).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, encodeFunctionData, http, parseAbi, parseAbiItem, toHex, type Hex } from 'viem'
import type { AccountContext, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, baseRegistry, ethereumRegistry } from '@mamoru/registry'
import { buildMigrateV4, mamoruActionPolicyV4Abi, smartSessionV4Abi } from '@mamoru/account/one-auth'
import { oneAuthV4Deployment } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { anvilBinary, assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { BridgeOut, CHAINLINK_ETH_USD, L1_USDC, L1_WETH, type Fetch } from '../src/bridge-out.ts'
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
const dir = mkdtempSync(join(tmpdir(), 'mamoru-e2e-sibling-'))
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

  const fetcher: Fetch = (url, init) => fetch(url, init)
  const relayer = new Relayer(DEV_KEY, l1, anvilUrl, 1)
  const on = () => true
  const CAP = 1_700_000_000n
  const make = (now: () => number = Date.now) => {
    const b = new BridgeOut(l1, relayer, dir, fetcher, now, undefined, on)
    b.siblingCapUsd = () => CAP
    b.siblingInScope = () => true
    return b
  }
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
  function browserSign(t: Pick<OwnerTxToSign, 'safeTxHash' | 'prepareId'>, by: SoftwarePasskey = passkey): OwnerSignature {
    const a = by.assert(t.safeTxHash)
    const s = randomBytes(1)[0]! & 1 ? P256_N - a.s : a.s
    return {
      prepareId: t.prepareId,
      authenticatorData: Buffer.from(a.authenticatorData.slice(2), 'hex').toString('base64url'),
      clientDataJSON: Buffer.from(a.clientDataJSON).toString('base64url'),
      signature: Buffer.from(der(a.r, s)).toString('base64url'),
    }
  }

  const d = oneAuthV4Deployment(ethereumRegistry)!
  check(!!d && ((await l1.getCode({ address: d.policy })) ?? '0x') !== '0x', 'V4 is deployed on this fork (T7)')
  check((await code(new BridgeOut(l1, relayer, dir, fetcher).prepareSibling(ctx))) === 'BRIDGE_OFF', 'flag off on /ops: BRIDGE_OFF')
  check((await code(new BridgeOut(l1, relayer, dir, fetcher, Date.now, undefined, on).prepareSibling(ctx))) === 'SIBLING_NOT_OFFERED', 'outside the one-authorization scope: SIBLING_NOT_OFFERED')
  check((await code(bo.prepareSibling(ctx))) === 'SIBLING_NOTHING', 'nothing on Ethereum: SIBLING_NOTHING')

  await lab.setBalance(safe, ETH)
  check(((await l1.getCode({ address: safe })) ?? '0x') === '0x', 'account not deployed on Ethereum')
  const nonce0 = await l1.getTransactionCount({ address: relayer.address })
  const p0 = await bo.prepareSibling(ctx)
  const rebuilt = buildMigrateV4(JSON.parse(JSON.stringify(p0.built.input)), ethereumRegistry)
  check(p0.chainId === 1 && p0.safe === safe && rebuilt.safeTxHash === p0.safeTxHash, 'prepare: the Worker rebuilds the same Safe tx from the input')
  check(p0.built.input.home === safe && p0.built.input.homeDomain === 6 && p0.built.input.step === 1 && p0.built.input.capUsdc === CAP.toString(), 'a sibling: home is the account itself, Base domain, the C it is given')
  console.log(`  ${p0.summary.join('\n  ')}`)
  const keys = join(dir, 'ethereum-sibling-keys.json')
  check(existsSync(keys) && (Bun.file(keys).size > 0) && ((await import('node:fs')).statSync(keys).mode & 0o777) === 0o600, 'the session key lives in its own 0600 file')
  check((await code(bo.submitSibling(ctx, browserSign(p0, new SoftwarePasskey(PASSKEY_SCALARS.a2))))) === 'BAD_SIGNATURE', 'another passkey: BAD_SIGNATURE')
  check((await l1.getTransactionCount({ address: relayer.address })) === nonce0, 'relayer sent nothing for the refused signature')

  const p1 = await bo.prepareSibling(ctx)
  const done = await bo.submitSibling(ctx, browserSign(p1))
  check(done.state === 'done', `submit: ${done.state}`)
  const pid = rebuilt.permissionId
  const enabled = (await l1.readContract({ address: address('SmartSession', ethereumRegistry), abi: smartSessionV4Abi, functionName: 'isPermissionEnabled', args: [pid, safe] })) as boolean
  const ids = (await l1.readContract({ address: address('SmartSession', ethereumRegistry), abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [safe] })) as Hex[]
  check(enabled && ids.length === 1, 'SmartSession lists exactly the V4 sibling session')
  const cfg = (await l1.readContract({ address: d.policy, abi: mamoruActionPolicyV4Abi, functionName: 'configOf', args: [safe] })) as { set: boolean; home: `0x${string}`; homeDomain: number; capUsd: bigint }
  check(cfg.set && cfg.home.toLowerCase() === safe.toLowerCase() && Number(cfg.homeDomain) === 6 && cfg.capUsd === CAP, "V4's config: the account's own home on Base, at C")
  check(!(await l1.readContract({ address: d.policy, abi: mamoruActionPolicyV4Abi, functionName: 'isReady', args: [safe, 6] })), 'not ready until the guardian reads Base back')
  const key = (JSON.parse(readFileSync(keys, 'utf8')) as Record<string, string>)[ctx.accountKey]!
  check(!readFileSync(join(dir, 'bridge-out.json'), 'utf8').includes(key.slice(2)), 'the key is never in the journal')
  check((await code(bo.prepareSibling(ctx))) === 'SIBLING_IN_PROGRESS', 'set up once: a second prepare is refused')
  await bo.tick()
  check(make().siblingView(ctx.accountKey).state === 'done', 'the journal survives a restart, tick leaves it done')

  // ---- #309 (c): the sibling at work, on its own session key, bounded by V4 ----
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
  const journal = () => JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8')) as { siblings: Record<string, { leg?: { kind: string; state: string; l1Tx?: Hex; amount: string } }>; routes: Record<string, { state: string; bridge?: string; amountUsdc: string; cctp?: { message?: Hex; sender?: string } }> }
  let clock = Number(await lab.timestamp()) * 1000
  const eng = make(() => clock)
  await eng.tick()
  check(!journal().siblings[ctx.accountKey]!.leg, 'before the listings are executed (V4 registry delay): no op signed, nothing sent')

  // The listings T7 queued, executed after the 72 h delay by the admin Safe (as executeListings on 5 Nov).
  const registry = d.registry
  const regAbi = parseAbi(['function ADMIN() view returns (address)', 'function execute(uint8 kind, bytes32 key, bytes params, uint256 n)'])
  const queued = await l1.getLogs({ address: registry, event: parseAbiItem('event Queued(bytes32 indexed id, uint8 indexed kind, bytes32 indexed key, bytes params, uint256 nonce, uint256 eta)'), fromBlock: 26_328_000n, toBlock: 'latest' })
  const [, answer] = await l1.readContract({ address: CHAINLINK_ETH_USD, abi: parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)']), functionName: 'latestRoundData' })
  await lab.warp(3 * 86_400 + 60)
  const admin = await l1.readContract({ address: registry, abi: regAbi, functionName: 'ADMIN' })
  await lab.setBalance(admin, 10n ** 18n)
  let executed = 0
  for (const q of queued) executed += (await lab.sendAs(admin, registry, encodeFunctionData({ abi: regAbi, functionName: 'execute', args: [q.args.kind!, q.args.key!, q.args.params!, q.args.nonce!] }))).ok ? 1 : 0
  check(queued.length > 0 && executed === queued.length, `the ${queued.length} queued listings executed after the delay`)
  // Chainlink stops updating on a fork: its answer from before the warp, fresh (answer, updatedAt = now).
  const word = (v: bigint) => v.toString(16).padStart(64, '0')
  const mock = `0x60016000527f${word(answer)}6020524260405242606052600160805260a06000f3` as Hex
  await (lab as unknown as { rpc: (m: string, p: unknown[]) => Promise<unknown> }).rpc('anvil_setCode', [CHAINLINK_ETH_USD, mock])
  clock = Number(await lab.timestamp()) * 1000

  const eth0 = await l1.getBalance({ address: safe })
  await eng.tick()
  const leg1 = journal().siblings[ctx.accountKey]!.leg
  check(leg1?.kind === 'swap' && leg1.state === 'done', `the engine swapped on its session key: ${leg1?.kind} ${leg1?.state}`)
  const usdc1 = await l1.readContract({ address: L1_USDC, abi: erc20, functionName: 'balanceOf', args: [safe] })
  const weth1 = await l1.readContract({ address: L1_WETH, abi: erc20, functionName: 'balanceOf', args: [safe] })
  const eth1 = await l1.getBalance({ address: safe })
  console.log(`  swap: ${eth0} wei -> ${usdc1} USDC units, ETH left ${eth1}, WETH ${weth1}`)
  check(usdc1 > 50_000_000n && weth1 === 0n && eth1 > 0n && eth1 < 10n ** 16n, 'ETH became USDC under V4; the gas reserve stays as ETH')
  if (leg1?.l1Tx) {
    const rc = await l1.getTransactionReceipt({ hash: leg1.l1Tx })
    console.log(`  swap handleOps gasUsed ${rc.gasUsed}`)
    for (const l of rc.logs) if (l.topics[0] === '0x1c4fada7374c0a9ee8841fc38afe82932dc0f8e69012e927f061a8bae611a201') console.log(`  revert reason: ${l.data.slice(0, 400)}`)
    for (const l of rc.logs) if (l.topics[0] === '0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f') console.log(`  UserOperationEvent data: ${l.data}`)
  }

  clock += 6 * 60_000
  await eng.tick()
  check(journal().siblings[ctx.accountKey]!.leg?.l1Tx === leg1?.l1Tx, 'not ready on Base yet and only the reserve left: no bridge, no second swap')

  const guardian = (await l1.readContract({ address: d.policy, abi: mamoruActionPolicyV4Abi, functionName: 'GUARDIAN' })) as `0x${string}`
  await lab.setBalance(guardian, 10n ** 18n)
  check((await lab.sendAs(guardian, d.policy, encodeFunctionData({ abi: mamoruActionPolicyV4Abi, functionName: 'setReady', args: [safe, 6, safe] }))).ok, 'the guardian marks the sibling ready (it read the Base home back)')
  clock += 6 * 60_000
  await eng.tick()
  const leg2 = journal().siblings[ctx.accountKey]!.leg
  const route = journal().routes[ctx.accountKey]
  const usdc2 = await l1.readContract({ address: L1_USDC, abi: erc20, functionName: 'balanceOf', args: [safe] })
  check(leg2?.kind === 'bridge' && leg2.state === 'done' && usdc2 === 0n, `the engine bridged all the USDC home: ${leg2?.kind} ${leg2?.state}`)
  check(route?.state === 'deposited' && route.bridge === 'cctp' && route.amountUsdc === usdc1.toString() && !!route.cctp?.message && route.cctp.sender?.toLowerCase() === d.policy.toLowerCase(), "the burn is the account's CCTP route, V4 the burner, waiting for its mint on Base")
  if (leg2?.l1Tx) console.log(`  bridge handleOps gasUsed ${(await l1.getTransactionReceipt({ hash: leg2.l1Tx })).gasUsed}`)
  clock += 6 * 60_000
  await eng.tick()
  check(journal().siblings[ctx.accountKey]!.leg?.l1Tx === leg2?.l1Tx, 'while the move to Base is not minted, the engine waits')
} finally {
  anvil.kill()
  proxy.stop()
}
console.log(failures === 0 ? 'all passed' : `${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
