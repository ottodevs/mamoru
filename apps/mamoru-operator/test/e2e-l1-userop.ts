// E2E of the L1 userOp path (otto/mamoru#180) on an anvil fork of Ethereum that keeps chain id 1.
//
// USDC sits at a Mamoru account's counterfactual address on Ethereum: no code, no ETH. One ERC-4337 v0.7 userOp,
// signed by the passkey alone, deploys the Safe (initCode, same setup as Base), pays its gas in USDC through Pimlico's
// live SingletonPaymasterV7 (0x7777…834C) and, in the same batch, deposits to the same Safe on Base, through the real
// BridgeOut: Across, and CCTP V2 (the default when it pays more) with the mint on a Base fork. The operator's own
// bundler (startLiveBundler) bundles it: its relayer sends handleOps as beneficiary and the EntryPoint refunds it from
// the paymaster's deposit. Circle's attestation is played by a fork attester on Base.
//
// The paymaster is the real contract on the fork. Its paymasterData is normally signed by Pimlico's service; here a
// dev key is written into its signers mapping (anvil_setStorageAt), and the fork paymaster below signs the same
// ERC-20-mode layout at the Chainlink ETH/USD price. No API key, nothing sent to a real chain.
//
// Run: nix shell nixpkgs#foundry --command bun apps/mamoru-operator/test/e2e-l1-userop.ts
// Upstream RPCs: L1_RPC_URL / BASE_RPC_URL, or QUICKNODE_ETH_MAINNET_HTTP / QUICKNODE_BASE_MAINNET_HTTP from
// ~/.config/quicknode/endpoints.env (never printed).
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, createPublicClient, encodeAbiParameters, encodeFunctionData, http, keccak256, numberToHex, parseAbi, parseEventLogs, sliceHex, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { toPackedUserOperation, type UserOperation } from 'viem/account-abstraction'
import type { AccountContext, Address, OwnerSignature, OwnerTxToSign } from '@mamoru/domain'
import { address, entryPointV07Abi, erc20Abi } from '@mamoru/registry'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { webAuthnSigner } from '@mamoru/account/safe'
import { P256_N } from '@mamoru/account/live'
import { userOpLogs, type PaymasterFields } from '@mamoru/account/userop'
import { anvilBinary, assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { PASSKEY_SCALARS, SoftwarePasskey } from '../../../packages/scenarios/webauthn/index.ts'
import { ACROSS_SPOKE_POOL, BASE_USDC, BridgeOut, L1_BUNDLER_TIMEOUT_MS, L1_HANDLE_OPS_GAS, L1_USDC, type Fetch } from '../src/bridge-out.ts'
import { startLiveBundler, type LiveBundler } from '../src/bundler.ts'
import { burnMatches, FINALITY_STANDARD, MESSAGE_TRANSMITTER_V2, messageTransmitterV2Abi } from '../src/cctp.ts'
import { Relayer } from '../src/relayer.ts'
import { HttpError } from '../src/operator.ts'
import { checkPimlicoErc20, L1Bundler, MAX_CONSTANT_FEE, PIMLICO_ERC20_PAYMASTER_V07, RpcRefused, type Erc20Paymaster, type GasPrice } from '../src/paymaster.ts'

const L1_USDC_HOLDER = '0x28C6c06298d514Db089934071355E5743bf21d60' as const
const CHAINLINK_ETH_USD = '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419' as const
const AMOUNT = 150_000_000n
/** A dev key the fork paymaster signs with, written into the real paymaster's signers mapping. */
const PM_SIGNER = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
/** Fresh random relayer keys. Not anvil's dev accounts: on mainnet those carry EIP-7702 delegations to sweeper
 * contracts that forward any ETH they receive, the EntryPoint's refund included (seen on this fork). */
const L1_RELAYER_KEY: Hex = generatePrivateKey()
const BASE_RELAYER_KEY: Hex = generatePrivateKey()
/** Plays Circle's attester on the Base fork. */
const ATTESTER = privateKeyToAccount(generatePrivateKey())
const attestableAbi = parseAbi(['function attesterManager() view returns (address)', 'function enableAttester(address newAttester)', 'function setSignatureThreshold(uint256 newSignatureThreshold)'])
const supplyAbi = parseAbi(['function totalSupply() view returns (uint256)'])
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

for (const [env, name] of [['L1_RPC_URL', 'QUICKNODE_ETH_MAINNET_HTTP'], ['BASE_RPC_URL', 'QUICKNODE_BASE_MAINNET_HTTP']] as const) {
  if (process.env[env]) continue
  const file = join(homedir(), '.config/quicknode/endpoints.env')
  const line = existsSync(file) ? readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`)) : undefined
  if (!line) throw new Error(`set ${env}`)
  process.env[env] = line.slice(line.indexOf('=') + 1).replace(/^["']|["']$/g, '').trim()
}
const dir = mkdtempSync(join(tmpdir(), 'mamoru-e2e-l1-userop-'))
function fork(env: 'L1_RPC_URL' | 'BASE_RPC_URL', chainId: number) {
  const proxy = startForkProxy(env)
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port as number
  probe.stop(true)
  const argv = ['--fork-url', proxy.url, '--chain-id', String(chainId), '--host', '127.0.0.1', '--port', String(port), '--no-request-size-limit']
  assertNoKeyInArgv(argv, ['L1_RPC_URL', 'BASE_RPC_URL'])
  const log = Bun.file(join(dir, `anvil-${chainId}.log`))
  const anvil = Bun.spawn([anvilBinary(), ...argv], { stdout: log, stderr: log, env: sanitizedEnv() })
  return { proxy, anvil, url: `http://127.0.0.1:${port}/` }
}
async function ready(lab: Lab) {
  for (let i = 0; ; i++) {
    try {
      await lab.client.getBlockNumber()
      return
    } catch {
      if (i > 300) throw new Error('anvil did not start')
      await Bun.sleep(100)
    }
  }
}
const eth = fork('L1_RPC_URL', 1)
const baseFork = fork('BASE_RPC_URL', 8453)
const proxy = eth.proxy
const anvilUrl = eth.url
const bundlers: LiveBundler[] = []
try {
  const lab = new Lab(anvilUrl, 1)
  const baseLab = new Lab(baseFork.url, 8453)
  await ready(lab)
  await ready(baseLab)
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

  // The operator's relayer on Ethereum: a fresh key with 0.05 ETH. It fronts handleOps through the bridge-out guard of
  // whichever BridgeOut is sending.
  const l1Relayer = new Relayer(L1_RELAYER_KEY, l1, anvilUrl, 1)
  await lab.setBalance(l1Relayer.address, 50_000_000_000_000_000n)
  let guard: ReturnType<BridgeOut['bundlerGuard']> | null = null
  const ownBundler = () => {
    const b = startLiveBundler(l1, l1Relayer, 1, {
      handleOpsGas: L1_HANDLE_OPS_GAS,
      label: 'l1-bundler',
      guard: { before: (g) => guard!.before(g), sent: (h) => guard?.sent(h), after: (c, r) => guard?.after(c, r), failed: () => guard?.failed() },
    })
    bundlers.push(b)
    return b
  }
  const bundler = ownBundler()
  const l1Bundler = new L1Bundler(bundler.url, fetch, L1_BUNDLER_TIMEOUT_MS)

  // Base fork: the operator's Base relayer (a dev account) and a fork attester in MessageTransmitterV2.
  const baseClient = createPublicClient({ transport: http(baseFork.url) })
  const baseRelayer = new Relayer(BASE_RELAYER_KEY, baseClient, baseFork.url, 8453)
  await baseLab.setBalance(baseRelayer.address, 10n ** 18n)
  const manager = await baseClient.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: attestableAbi, functionName: 'attesterManager' })
  await baseLab.setBalance(manager, 10n ** 18n)
  const en = await baseLab.sendAs(manager, MESSAGE_TRANSMITTER_V2, encodeFunctionData({ abi: attestableAbi, functionName: 'enableAttester', args: [ATTESTER.address] }))
  const th = await baseLab.sendAs(manager, MESSAGE_TRANSMITTER_V2, encodeFunctionData({ abi: attestableAbi, functionName: 'setSignatureThreshold', args: [1n] }))
  check(en.ok && th.ok, 'Base fork: a dev attester enabled in MessageTransmitterV2, threshold 1')

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
  let attestation: { message: Hex; attestation: Hex } | null = null
  const fetcher: Fetch = (url, init) => {
    if (url.includes('/deposit/status')) return Promise.resolve(Response.json(statusAnswer))
    if (url.includes('/v2/messages/')) return Promise.resolve(attestation ? Response.json({ messages: [{ status: 'complete', ...attestation }] }) : Response.json({ error: 'Message not found' }, { status: 404 }))
    return fetch(url, init)
  }
  /** A BridgeOut on the operator's own bundler; with `minter`, CCTP is offered and minted on the Base fork. */
  const make = (o: { now?: () => number; minter?: boolean; bundlerUrl?: string; stateDir?: string } = {}) => {
    const b = new BridgeOut(l1, l1Relayer, o.stateDir ?? dir, fetcher, o.now ?? Date.now, undefined, () => true, { bundler: o.bundlerUrl ? new L1Bundler(o.bundlerUrl, fetch, L1_BUNDLER_TIMEOUT_MS) : l1Bundler, paymaster: forkPm }, o.minter ? { client: baseClient, relayer: baseRelayer } : null)
    guard = b.bundlerGuard()
    return b
  }
  const bo = make()

  // ---- 1. Across through the real BridgeOut: the #117 case -------------------------------------------------------
  const ctx = newAccount('across')
  const safe = ctx.address
  await fund(safe, AMOUNT)
  check(((await l1.getCode({ address: safe })) ?? '0x') === '0x' && (await l1.getBalance({ address: safe })) === 0n, 'account not deployed on Ethereum and holds no ETH')

  const p0 = await bo.prepare(ctx)
  const cap = BigInt(p0.route.gasUsdc ?? '0')
  check(p0.chainId === 1 && cap > 0n && BigInt(p0.route.outputUsdc) + BigInt(p0.route.feeUsdc) === AMOUNT - cap, `prepare: ${p0.summary.join(' | ')}`)
  const sentBefore = await l1.getTransactionCount({ address: l1Relayer.address })
  check((await code(bo.submit(ctx, browserSign(p0, new SoftwarePasskey(PASSKEY_SCALARS.a2))))) === 'BAD_SIGNATURE', 'another passkey: BAD_SIGNATURE, nothing reaches the bundler')
  check((await l1.getTransactionCount({ address: l1Relayer.address })) === sentBefore, 'the relayer sent nothing for the refused signature')

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
  const relayerBefore = await l1.getBalance({ address: l1Relayer.address })
  const pmDepositBefore = await l1.readContract({ address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'balanceOf', args: [pm] })
  const done = await bo.submit(ctx, browserSign(p1))
  const relayerAfter = await l1.getBalance({ address: l1Relayer.address })
  const pmDepositAfter = await l1.readContract({ address: address('EntryPointV07'), abi: entryPointV07Abi, functionName: 'balanceOf', args: [pm] })
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
  const txCost = deployTxGas * effective
  const net = relayerAfter - relayerBefore
  check(ev.tx.from.toLowerCase() === l1Relayer.address.toLowerCase() && net === ev.mine.actualGasCost - txCost, `operator's relayer bundled it: paid ${txCost} wei, refunded ${ev.mine.actualGasCost} wei by the EntryPoint, net ${net >= 0n ? '+' : ''}${net} wei`)
  check(pmDepositBefore - pmDepositAfter === ev.mine.actualGasCost, `the refund came out of the paymaster's EntryPoint deposit (${pmDepositBefore - pmDepositAfter} wei)`)
  const spent = JSON.parse(readFileSync(join(dir, 'bridge-out.json'), 'utf8')).spent
  check(BigInt(spent.wei) === (txCost > ev.mine.actualGasCost ? txCost - ev.mine.actualGasCost : 0n), `bridge-out budget charged only the unrefunded part: ${spent.wei} wei`)
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
  // A restarted operator: a new bundler that remembers nothing; the bundle hash on the route decides.
  const forgetful = ownBundler()
  check((await new L1Bundler(forgetful.url).receipt(r.userOpHash!)) === null, 'a restarted bundler has no receipt for it')
  const recon = await make({ bundlerUrl: forgetful.url }).status(ctx)
  check(recon.route?.state === 'deposited' && recon.route.depositId === realId, `unconfirmed resolved after a restart from the stored bundle hash: deposited, id ${recon.route?.depositId}`)
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
  for (const [rc, detail, want] of [[-32500, 'AA23 reverted', 'BRIDGE_FAILED'], [-32602, 'already known', 'unconfirmed'], [-32500, 'AA25 invalid account nonce', 'unconfirmed']] as const) {
    const rctx = newAccount(`refused${-rc}`)
    await fund(rctx.address, 100_000_000n)
    const rbo = new BridgeOut(l1, l1Relayer, mkdtempSync(join(tmpdir(), 'mamoru-e2e-refused-')), fetcher, Date.now, undefined, () => true, { bundler: new Refusing(rc, detail), paymaster: forkPm })
    const rp = await rbo.prepare(rctx)
    const got = await rbo.submit(rctx, browserSign(rp)).then((v) => v.route?.state ?? 'none', (e) => (e instanceof HttpError ? e.code : 'unexpected'))
    check(got === want && (await usdcAt(rctx.address)) === 100_000_000n, `bundler error ${rc} "${detail}": ${got}, USDC untouched`)
  }

  // ---- 2. CCTP V2 through BridgeOut: chosen by output, burned on Ethereum, minted on Base by the operator ---------
  const cctx = newAccount('cctp')
  const csafe = cctx.address
  await fund(csafe, AMOUNT)
  let clock = Date.now()
  const cbo = make({ now: () => clock, minter: true, stateDir: mkdtempSync(join(tmpdir(), 'mamoru-e2e-cctp-')) })
  const cp = await cbo.prepare(cctx)
  const across = await fetch(`https://app.across.to/api/suggested-fees?inputToken=${L1_USDC}&outputToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&originChainId=1&destinationChainId=8453&amount=${AMOUNT - BigInt(cp.route.gasUsdc!)}`).then((x) => x.json() as Promise<{ outputAmount: string }>)
  check(cp.route.bridge === 'cctp' && BigInt(cp.route.outputUsdc) >= BigInt(across.outputAmount), `route picked by output: CCTP ${fmt(BigInt(cp.route.outputUsdc))} vs Across ${fmt(BigInt(across.outputAmount))} USDC — ${cp.summary[2]}`)
  const supplyBefore = await l1.readContract({ address: L1_USDC, abi: supplyAbi, functionName: 'totalSupply' })
  const cdone = await cbo.submit(cctx, browserSign(cp))
  const cr = cdone.route!
  const supplyAfter = await l1.readContract({ address: L1_USDC, abi: supplyAbi, functionName: 'totalSupply' })
  check(cr.state === 'deposited' && cr.bridge === 'cctp' && supplyBefore - supplyAfter === BigInt(cr.amountUsdc), `CCTP userOp: deployed + burned ${fmt(BigInt(cr.amountUsdc))} USDC on Ethereum, waiting for Circle`)
  const cev = (await opEvent(cr.userOpHash!))!
  check(burnMatches(cev.mine.logs, L1_USDC, csafe, { amount: BigInt(cr.amountUsdc), maxFee: BigInt(cr.amountUsdc) - BigInt(cr.outputUsdc), minFinality: FINALITY_STANDARD }), 'DepositForBurn: mintRecipient = the Safe, domain 6 (Base), open caller, no hook')
  console.log(`  deploy+CCTP userOp: actualGasUsed ${cev.mine.actualGasUsed}, gas ${fmt(BigInt(cr.gasUsdc ?? '0'))} USDC at fork price`)
  clock += 11_000
  check((await cbo.status(cctx)).route?.state === 'deposited', 'no attestation yet: still deposited, nothing sent on Base')

  // Circle's part, played on the fork: the message the burn emitted, with the nonce and finality Circle fills in,
  // signed by the fork attester.
  const sent = parseEventLogs({ abi: messageTransmitterV2Abi, eventName: 'MessageSent', logs: cev.mine.logs })
  check(sent.length === 1, 'the burn emitted one CCTP message')
  const raw = sent[0]!.args.message
  const message = concat([sliceHex(raw, 0, 12), toHex(randomBytes(32)), sliceHex(raw, 44, 144), numberToHex(2000, { size: 4 }), sliceHex(raw, 148)])
  attestation = { message, attestation: await ATTESTER.sign({ hash: keccak256(message) }) }
  const baseBefore = await baseClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [csafe] })
  clock += 11_000
  await cbo.tick()
  const minted = (await cbo.status(cctx)).route!
  const baseAfter = await baseClient.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [csafe] })
  const mintRc = minted.mintTx ? await baseClient.getTransactionReceipt({ hash: minted.mintTx }) : null
  check(minted.state === 'filled' && minted.fillTx === minted.mintTx && baseAfter - baseBefore === BigInt(cr.outputUsdc), `minted on Base by the operator: +${fmt(baseAfter - baseBefore)} USDC at the same Safe, receiveMessage gas ${mintRc?.gasUsed}`)
  clock += 11_000
  check((await cbo.status(cctx)).route?.state === 'filled', 'status stays filled')

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
  for (const b of bundlers) b.stop()
  for (const f of [eth, baseFork]) {
    f.anvil.kill()
    f.proxy.stop()
  }
}
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)

function getAddressEq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
