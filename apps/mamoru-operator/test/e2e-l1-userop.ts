// E2E of the L1 userOp path (otto/mamoru#180) on an anvil fork of Ethereum that keeps chain id 1.
//
// USDC sits at a Mamoru account's counterfactual address on Ethereum: no code, no ETH. One ERC-4337 v0.7 userOp,
// signed by the passkey alone, deploys the Safe (initCode, same setup as Base), pays its gas in USDC through Pimlico's
// live SingletonPaymasterV7 (0x7777…834C) and, in the same batch, deposits to the same Safe on Base: Across through
// the real BridgeOut, CCTP V2 depositForBurn built by hand. A dev account bundles it with handleOps (the lab bundler).
//
// The paymaster is the real contract on the fork. Its paymasterData is normally signed by Pimlico's service; here a
// dev key is written into its signers mapping (anvil_setStorageAt), and the fork paymaster below signs the same
// ERC-20-mode layout at the Chainlink ETH/USD price. No API key, nothing sent to a real chain.
//
// Run: nix shell nixpkgs#foundry --command bun apps/mamoru-operator/test/e2e-l1-userop.ts
// Upstream RPC: L1_RPC_URL, or QUICKNODE_ETH_MAINNET_HTTP from ~/.config/quicknode/endpoints.env (never printed).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, createPublicClient, encodeAbiParameters, encodeFunctionData, http, keccak256, numberToHex, parseAbi, parseEventLogs, toHex, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { toPackedUserOperation, type UserOperation } from 'viem/account-abstraction'
import type { AccountContext, Address, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, entryPointV07Abi, erc20Abi } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { browserOwnerSignature, liveAccountFromContext, P256_N } from '@mamoru/account/live'
import { userOpHash } from '@mamoru/account/sessions'
import { ownerUserOp, ownerUserOpSignature, safeOpHash, userOpLogs, type PaymasterFields } from '@mamoru/account/userop'
import { anvilBinary, assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab, devAccount } from '../../../packages/scenarios/fixtures/lab.ts'
import { startLabBundler } from '../../../packages/scenarios/bundler/index.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { ACROSS_SPOKE_POOL, BridgeOut, gasCapUsdc, L1_USDC, USEROP_CALL_GAS, USEROP_PVG_FLOOR, USEROP_VERIFY_GAS_DEPLOY, userOpCalls, type Fetch } from '../src/bridge-out.ts'
import { burnMatches, cctpCalls, FINALITY_STANDARD, TOKEN_MESSENGER_V2 } from '../src/cctp.ts'
import { HttpError } from '../src/operator.ts'
import { checkPimlicoErc20, L1Bundler, MAX_CONSTANT_FEE, PIMLICO_ERC20_PAYMASTER_V07, RpcRefused, type Erc20Paymaster, type GasPrice } from '../src/paymaster.ts'

const L1_USDC_HOLDER = '0x28C6c06298d514Db089934071355E5743bf21d60' as const
const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const
const AMOUNT = 150_000_000n
/** A dev key the fork paymaster signs with, written into the real paymaster's signers mapping. */
const PM_SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const TREASURY = '0x000000000000000000000000000000000000beef' as const

let failures = 0
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`)
  if (!ok) failures++
}
const code = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'ok',
    (e) => (e instanceof HttpError ? e.code : `unexpected: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`),
  )
const fmt = (raw: bigint) => (Number(raw) / 1e6).toFixed(4)

const pmAbi = parseAbi([
  'struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }',
  'function signers(address) view returns (bool)',
  'function getHash(uint8 mode, PackedUserOperation userOp) view returns (bytes32)',
])
const chainlinkAbi = parseAbi(['function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)'])

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
const dir = mkdtempSync(join(tmpdir(), 'mamoru-e2e-l1-userop-'))
const anvil = Bun.spawn([anvilBinary(), ...argv], { stdout: Bun.file(join(dir, 'anvil.log')), stderr: Bun.file(join(dir, 'anvil.log')), env: sanitizedEnv() })
const anvilUrl = `http://127.0.0.1:${port}/`
let bundler: ReturnType<typeof startLabBundler> | null = null
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
  // Mainnet fees at the fork block, before the fork mines anything: what a real move would pay now.
  const mainnetFees = await l1.estimateFeesPerGas()
  const forkBlock = await l1.getBlock()
  console.log(`  mainnet at block ${forkBlock.number}: base fee ${forkBlock.baseFeePerGas} wei, maxFeePerGas ${mainnetFees.maxFeePerGas}, priority ${mainnetFees.maxPriorityFeePerGas}`)

  // The real Pimlico paymaster: code, EntryPoint deposit, and a dev signer written into signers[].
  const pm = PIMLICO_ERC20_PAYMASTER_V07
  check(((await l1.getCode({ address: pm })) ?? '0x').length > 2, `Pimlico ERC-20 paymaster v0.7 has code at ${pm}`)
  const pmDeposit = await l1.readContract({ address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'balanceOf', args: [pm] })
  console.log(`  its EntryPoint v0.7 deposit: ${Number(pmDeposit) / 1e18} ETH`)
  let slot = -1
  for (let i = 0; i < 64 && slot < 0; i++) {
    const key = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [PM_SIGNER.address, BigInt(i)]))
    await lab.rpc('anvil_setStorageAt', [pm, key, numberToHex(1, { size: 32 })])
    if (await l1.readContract({ address: pm, abi: pmAbi, functionName: 'signers', args: [PM_SIGNER.address] })) slot = i
    else await lab.rpc('anvil_setStorageAt', [pm, key, numberToHex(0, { size: 32 })])
  }
  check(slot >= 0, `dev signer added to the paymaster's signers (mapping slot ${slot})`)

  const [, answer] = await l1.readContract({ address: CHAINLINK_ETH_USD, abi: chainlinkAbi, functionName: 'latestRoundData' })
  // USDC base units per 1e18 wei: answer has 8 decimals, USDC 6.
  const rate = answer / 100n
  console.log(`  ETH/USD (Chainlink) ${Number(answer) / 1e8}: rate ${rate} USDC units per ETH`)

  /** The same ERC-20-mode paymasterData Pimlico's service returns, signed by the dev signer. */
  type Tamper = { recipient?: Address; rateUp?: bigint }
  class ForkPimlico implements Erc20Paymaster {
    readonly name = 'fork-pimlico'
    tamper: Tamper = {}
    readonly quoted: GasPrice = { paymaster: pm, token: L1_USDC, exchangeRate: rate, postOpGas: 60_000n }
    private config(sig: Hex): Hex {
      const t = this.tamper
      const flags = t.recipient ? 0x02 : 0x00
      return concat([
        numberToHex((1 << 1) | 1, { size: 1 }), // ERC-20 mode, any bundler
        numberToHex(flags, { size: 1 }),
        numberToHex(Math.floor(Date.now() / 1000) + 3600, { size: 6 }),
        numberToHex(0, { size: 6 }),
        L1_USDC,
        numberToHex(this.quoted.postOpGas, { size: 16 }),
        numberToHex(rate + (t.rateUp ?? 0n), { size: 32 }),
        numberToHex(40_000n, { size: 16 }),
        TREASURY,
        ...(t.recipient ? [t.recipient] : []),
        sig,
      ])
    }
    private fields(data: Hex): PaymasterFields {
      return { paymaster: pm, paymasterVerificationGasLimit: 60_000n, paymasterPostOpGasLimit: 70_000n, paymasterData: data }
    }
    async quote() {
      return this.quoted
    }
    async stub(_op: UserOperation<'0.7'>) {
      return this.fields(this.config(`0x${'11'.repeat(65)}`))
    }
    async data(op: UserOperation<'0.7'>) {
      const draft = { ...op, ...this.fields(this.config(`0x${'11'.repeat(65)}`)) }
      const hash = await l1.readContract({ address: pm, abi: pmAbi, functionName: 'getHash', args: [1, toPackedUserOperation(draft)] })
      const sig = await PM_SIGNER.signMessage({ message: { raw: hash } })
      return this.fields(this.config(sig))
    }
    check(f: PaymasterFields, q: GasPrice) {
      checkPimlicoErc20(f, q, L1_USDC)
    }
  }
  const forkPm = new ForkPimlico()

  const executor = devAccount(0)
  bundler = startLabBundler(lab, executor)
  const l1Bundler = new L1Bundler(bundler.url)

  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner')]
  const newAccount = (tag: string): AccountContext => {
    const saltNonce = BigInt(Date.now()) * 1000n + BigInt(randomBytes(1)[0]!)
    return {
      accountKey: `e2e-${tag}-${saltNonce}`,
      chainId: 8453,
      address: counterfactualAddress(accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))),
      owners,
      saltNonce: saltNonce.toString(),
      passkey: { credentialId: 'e2e', x: toHex(passkey.x, { size: 32 }), y: toHex(passkey.y, { size: 32 }) },
    }
  }
  const usdcAt = (a: Address) => l1.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
  const fund = async (to: Address, amount: bigint) => {
    await lab.setBalance(L1_USDC_HOLDER, 10n ** 18n)
    const r = await lab.sendAs(L1_USDC_HOLDER, L1_USDC, encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }))
    if (!r.ok) throw new Error('could not fund the account on the fork')
  }
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
  /** Gas of each phase of the bundle, from anvil's call tracer: deploy, account validation, paymaster, execution, postOp. */
  type Frame = { to?: string; input?: string; gasUsed?: string; calls?: Frame[] }
  const phases = async (tx: Hex) => {
    const t = await lab.rpc<Frame>('debug_traceTransaction', [tx, { tracer: 'callTracer' }])
    const names: Record<string, string> = { '0x570e1a36': 'createSender (deploy)', '0x19822f7c': 'validateUserOp (account)', '0x52b7512c': 'validatePaymasterUserOp', '0x0042dc53': 'innerHandleOp (execution + postOp)' }
    const out: string[] = []
    const walk = (f: Frame, depth: number) => {
      const sel = f.input?.slice(0, 10) ?? ''
      if (names[sel]) out.push(`${names[sel]} ${BigInt(f.gasUsed ?? '0x0')}`)
      if (depth < 3) for (const c of f.calls ?? []) walk(c, depth + 1)
    }
    walk(t, 0)
    console.log(`  phases: ${out.join(', ')}`)
  }
  const opEvent = async (hash: Hex) => {
    const r = await l1Bundler.receipt(hash)
    if (!r) return null
    const tx = await l1.getTransactionReceipt({ hash: r.txHash })
    return { tx, mine: userOpLogs(tx, hash)! }
  }

  let statusAnswer = { status: 'pending' } as { status: string; fillTx?: string }
  const fetcher: Fetch = (url, init) => (url.includes('/deposit/status') ? Promise.resolve(Response.json(statusAnswer)) : fetch(url, init))
  // The relayer must never be used on this path: any call to it fails the test.
  const noRelayer = {
    address: '0x0000000000000000000000000000000000000001' as Address,
    send: async () => {
      throw new Error('relayer used on the userOp path')
    },
  }
  const make = (now: () => number = Date.now) => new BridgeOut(l1, noRelayer, dir, fetcher, now, undefined, () => true, { bundler: l1Bundler, paymaster: forkPm })
  const bo = make()

  // ---- 1. Across through the real BridgeOut: the #117 case -------------------------------------------------------
  const ctx = newAccount('across')
  const safe = ctx.address
  await fund(safe, AMOUNT)
  check(((await l1.getCode({ address: safe })) ?? '0x') === '0x' && (await l1.getBalance({ address: safe })) === 0n, 'account not deployed on Ethereum and holds no ETH')

  const p0 = await bo.prepare(ctx)
  const cap = BigInt(p0.route.gasUsdc ?? '0')
  check(p0.chainId === 1 && cap > 0n && BigInt(p0.route.outputUsdc) + BigInt(p0.route.feeUsdc) === AMOUNT - cap, `prepare: ${p0.summary.join(' | ')}`)
  const sentBefore = bundler.received().length
  check((await code(bo.submit(ctx, browserSign(p0, new SoftwarePasskey(PASSKEY_SCALARS.a2))))) === 'BAD_SIGNATURE', 'another passkey: BAD_SIGNATURE, nothing reaches the bundler')
  check(bundler.received().length === sentBefore, 'bundler received nothing for the refused signature')

  // A paymaster that names a recipient, or charges above its quote, never reaches the owner.
  forkPm.tamper = { recipient: '0x000000000000000000000000000000000000dEaD' }
  check((await code(bo.prepare(ctx))) === 'BRIDGE_GAS_UNAVAILABLE', 'paymaster data with a recipient: refused before signing')
  forkPm.tamper = { rateUp: rate / 10n }
  check((await code(bo.prepare(ctx))) === 'BRIDGE_GAS_UNAVAILABLE', 'paymaster rate 10% above its quote: refused before signing')
  forkPm.tamper = {}

  const p1 = await bo.prepare(ctx)
  const cap1 = BigInt(p1.route.gasUsdc!)
  const poolBefore = await usdcAt(ACROSS_SPOKE_POOL)
  const treasuryBefore = await usdcAt(TREASURY)
  const done = await bo.submit(ctx, browserSign(p1))
  const r = done.route!
  check(r.state === 'deposited' && !!r.userOpHash && !!r.depositId && !r.deployTx, `submit: ${r.state}, deposit id ${r.depositId}, userOp ${r.userOpHash?.slice(0, 18)}…`)
  check(((await l1.getCode({ address: safe })) ?? '0x').length > 2, 'the userOp deployed the account at the same address')
  const ev = (await opEvent(r.userOpHash!))!
  const paid = (await usdcAt(TREASURY)) - treasuryBefore
  const amount1 = BigInt(r.amountUsdc)
  check(ev.mine.success && getAddressEq(ev.mine.paymaster, pm), 'UserOperationEvent: success, paid by the Pimlico paymaster')
  check((await usdcAt(ACROSS_SPOKE_POOL)) - poolBefore === amount1 && amount1 === AMOUNT - cap1, `SpokePool got ${fmt(amount1)} USDC (balance minus the gas cap ${fmt(cap1)})`)
  check(paid > 0n && paid <= cap1 && BigInt(r.gasUsdc ?? '-1') === paid, `gas paid in USDC: ${fmt(paid)} (cap ${fmt(cap1)}), recorded on the route`)
  check((await usdcAt(safe)) === cap1 - paid, `left at the address on Ethereum: ${fmt(cap1 - paid)} USDC (unused gas cap)`)
  const leftAllowance = await l1.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'allowance', args: [safe, pm] })
  check(leftAllowance === cap1 - paid, `paymaster allowance left: ${fmt(leftAllowance)} USDC, bounded by the cap`)
  check((await l1.readContract({ address: L1_USDC, abi: erc20Abi, functionName: 'allowance', args: [safe, ACROSS_SPOKE_POOL] })) === 0n, 'no SpokePool allowance left')
  check((await l1.getBalance({ address: safe })) === 0n, 'the account still holds no ETH')
  const deployGasUsed = ev.mine.actualGasUsed
  const deployTxGas = ev.tx.gasUsed
  const effective = ev.tx.effectiveGasPrice
  console.log(`  deploy+bridge userOp: actualGasUsed ${deployGasUsed} (bundle tx gasUsed ${deployTxGas}), fork gas price ${effective} wei, actualGasCost ${ev.mine.actualGasCost} wei`)
  await phases(ev.tx.transactionHash)
  // ERC-7562 STO-022: during deployment, an unstaked factory may not touch storage associated with the account in
  // other contracts. Which contracts outside the account had storage written by this bundle (the execution phase only
  // writes USDC and the SpokePool):
  const diff = await lab.rpc<{ post: Record<string, { storage?: Record<string, string> }> }>('debug_traceTransaction', [ev.tx.transactionHash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }])
  const named: Record<string, string> = Object.fromEntries((['Safe7579', 'ModuleRegistry', 'SmartSession', 'SafeWebAuthnSharedSigner', 'EntryPointV07'] as const).flatMap((n) => { try { return [[address(n).toLowerCase(), n]] } catch { return [] } }))
  const touched = Object.entries(diff.post).filter(([a, v]) => v.storage && Object.keys(v.storage).length > 0).map(([a, v]) => `${named[a.toLowerCase()] ?? a}(${Object.keys(v.storage!).length})`)
  console.log(`  storage written by the bundle: ${touched.join(', ')}`)

  // Restart with the outcome lost: the userOp hash and the bundler's receipt decide, no log scan.
  const file = join(dir, 'bridge-out.json')
  const j = JSON.parse(readFileSync(file, 'utf8'))
  const realId = j.routes[ctx.accountKey].depositId
  j.routes[ctx.accountKey] = { ...j.routes[ctx.accountKey], state: 'unconfirmed', depositId: undefined, at: new Date(Date.now() - 20 * 60_000).toISOString() }
  writeFileSync(file, JSON.stringify(j))
  const recon = await make().status(ctx)
  check(recon.route?.state === 'deposited' && recon.route.depositId === realId, `unconfirmed resolved by userOpHash after a restart: deposited, id ${recon.route?.depositId}`)
  statusAnswer = { status: 'filled', fillTx: `0x${'ab'.repeat(32)}` }
  const after = await make().status(ctx)
  check(after.route?.state === 'filled', 'status follows Across: filled on Base')

  // Second move on the now deployed account: no initCode, and a balance change after the prepare is refused.
  const bo2 = make()
  await fund(safe, 100_000_000n)
  const p3 = await bo2.prepare(ctx)
  await fund(safe, 1_000_000n)
  check((await code(bo2.submit(ctx, browserSign(p3)))) === 'BRIDGE_STALE', 'balance changed after prepare: BRIDGE_STALE')
  const p4 = await bo2.prepare(ctx)
  const second = await bo2.submit(ctx, browserSign(p4))
  const ev2 = (await opEvent(second.route!.userOpHash!))!
  check(second.route?.state === 'deposited', `second move on the deployed account: deposited, actualGasUsed ${ev2.mine.actualGasUsed}, gas ${fmt(BigInt(second.route?.gasUsdc ?? '0'))} USDC`)
  await phases(ev2.tx.transactionHash)

  // A bundler refusal in validation, with no receipt: failed, nothing moved. A refusal that may follow admission
  // ("already known"): unconfirmed, never failed.
  class Refusing extends L1Bundler {
    constructor(private readonly code: number, private readonly detail: string) {
      super(bundler!.url)
    }
    override async send(): Promise<Hex> {
      throw new RpcRefused('eth_sendUserOperation', this.code, this.detail)
    }
  }
  for (const [rc, detail, want] of [[-32500, 'AA23 reverted', 'BRIDGE_FAILED'], [-32602, 'already known', 'unconfirmed']] as const) {
    const rctx = newAccount(`refused${-rc}`)
    await fund(rctx.address, 100_000_000n)
    const rbo = new BridgeOut(l1, noRelayer, mkdtempSync(join(tmpdir(), 'mamoru-e2e-refused-')), fetcher, Date.now, undefined, () => true, { bundler: new Refusing(rc, detail), paymaster: forkPm })
    const rp = await rbo.prepare(rctx)
    const got = await rbo.submit(rctx, browserSign(rp)).then((v) => v.route?.state ?? 'none', (e) => (e instanceof HttpError ? e.code : 'unexpected'))
    check(got === want && (await usdcAt(rctx.address)) === 100_000_000n, `bundler error ${rc} "${detail}": ${got}, USDC untouched`)
  }

  // ---- 2. CCTP V2 depositForBurn in the same kind of userOp, built by hand ----------------------------------------
  const cctx = newAccount('cctp')
  const csafe = cctx.address
  await fund(csafe, AMOUNT)
  const live = liveAccountFromContext(cctx)
  live.chainId = 1
  const fees = await l1.estimateFeesPerGas()
  const gas = { verificationGasLimit: USEROP_VERIFY_GAS_DEPLOY, callGasLimit: USEROP_CALL_GAS, preVerificationGas: USEROP_PVG_FLOOR, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
  const stubPm = await forkPm.stub({} as UserOperation<'0.7'>)
  const draft = ownerUserOp({ live, deployed: false, nonce: 0n, calls: [{ to: L1_USDC, value: 0n, data: '0x' }], gas, paymaster: stubPm })
  const ccap = gasCapUsdc(draft, forkPm.quoted, MAX_CONSTANT_FEE)
  const burn = { amount: AMOUNT - ccap, maxFee: 0n, minFinality: FINALITY_STANDARD }
  const approvePm = userOpCalls(csafe, { amount: 0n, outputAmount: 0n, exclusiveRelayer: '0x0000000000000000000000000000000000000000', quoteTimestamp: 0, fillDeadline: 0, exclusivityDeadline: 0, fillSec: 0 }, pm, ccap)[0]!
  let cop = ownerUserOp({ live, deployed: false, nonce: 0n, calls: [approvePm, ...cctpCalls(L1_USDC, csafe, burn)], gas, paymaster: stubPm })
  cop = { ...cop, ...(await forkPm.data(cop)) }
  const validUntil = Math.floor(Date.now() / 1000) + 600
  const challenge = safeOpHash(cop, 1, 0, validUntil)
  const safeSig = browserOwnerSignature(browserSign({ safeTxHash: challenge, prepareId: 'cctp' }), challenge)
  cop = { ...cop, signature: ownerUserOpSignature(0, validUntil, safeSig) }
  const chash = userOpHash(cop, 1)
  const messengerBefore = await usdcAt(TOKEN_MESSENGER_V2)
  const supplyBefore = await l1.readContract({ address: L1_USDC, abi: parseAbi(['function totalSupply() view returns (uint256)']), functionName: 'totalSupply' })
  check((await l1Bundler.send(cop)) === chash, 'CCTP userOp accepted by the bundler, same userOp hash')
  const cev = (await opEvent(chash))!
  const supplyAfter = await l1.readContract({ address: L1_USDC, abi: parseAbi(['function totalSupply() view returns (uint256)']), functionName: 'totalSupply' })
  check(cev.mine.success && ((await l1.getCode({ address: csafe })) ?? '0x').length > 2, 'CCTP userOp: success, account deployed')
  check(burnMatches(cev.mine.logs, L1_USDC, csafe, burn), `DepositForBurn: ${fmt(burn.amount)} USDC, mintRecipient = the Safe, domain 6 (Base), open caller, no hook`)
  check(supplyBefore - supplyAfter === burn.amount && (await usdcAt(TOKEN_MESSENGER_V2)) === messengerBefore, 'USDC burned on Ethereum (supply down by the amount)')
  const cpaid = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: cev.mine.logs }).filter((e) => getAddressEq(e.args.to, TREASURY)).reduce((a, e) => a + e.args.value, 0n)
  console.log(`  deploy+CCTP userOp: actualGasUsed ${cev.mine.actualGasUsed}, gas paid ${fmt(cpaid)} USDC at fork price`)

  // ---- 3. What the first move costs at today's mainnet gas --------------------------------------------------------
  // anvil answers 1 gwei for the priority fee; the upstream node's answer is what a bundler would see today.
  const upstream = createPublicClient({ transport: http(proxy.url) })
  const priority = await upstream.estimateMaxPriorityFeePerGas()
  const price = forkBlock.baseFeePerGas! + priority
  console.log(`  mainnet now: base fee ${forkBlock.baseFeePerGas} + priority ${priority} = ${price} wei`)
  const usdcAtPrice = (g: bigint, p: bigint) => (g * p * rate) / 10n ** 18n
  console.log('\n  cost of the first move (deploy + gas in USDC + bridge), Pimlico rate without markup:')
  for (const [label, g] of [['Across', deployGasUsed], ['CCTP', cev.mine.actualGasUsed], ['Across, deployed account', ev2.mine.actualGasUsed]] as const) {
    const parts = [price, 100_000_000n, 1_000_000_000n, 5_000_000_000n].map((p) => `${fmt(usdcAtPrice(g + 60_000n, p))} USDC at ${(Number(p) / 1e9).toFixed(3)} gwei`)
    console.log(`  ${label}: ${g} gas (+60k postOp) -> ${parts.join(', ')}`)
  }
} finally {
  bundler?.stop()
  anvil.kill()
  proxy.stop()
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

function getAddressEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
