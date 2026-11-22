// otto/mamoru#428 (spec 014 step 1): the return home of a REAL production Monad Safe, on anvil forks of Monad (chain 143) and
// Base (chain 8453), before the first account signs it.
//
// Target: Brais' Safes (the pair migrate-v4-real-size.ts uses): on Monad a design-C Safe 1.4.1 whose only owner is the
// SafeWebAuthnSharedSigner, one V3 session enabled and USDC held; on Base his v7 Safe, the home. Nothing is read from D1
// or the operator's state: every input is read on chain.
//
// Monad fork (chain id 143, so the Safe tx hash is the one the passkey would sign there):
//   - the input exactly as planReturnHome builds it (removeIds: every session enabled on the Safe, which is the set Stop
//     revokes; amountUsdc: the whole USDC balance; the Safe nonce), built by buildReturnHome; its hash checked against the
//     Safe's own getTransactionHash;
//   - executed as the owner would: the passkey is replaced by Safe's pre-approved-hash path (the owner is the shared signer
//     contract, impersonated: approveHash, then execTransaction from a relayer with the v=1 signature), with the gas limit
//     the operator's pre-sign estimate gives (simulateAndRevert x 9/8 + PASSKEY_VERIFY_GAS);
//   - asserted: one Safe tx, every session removed, no USDC left, exactly one DepositForBurn of the whole balance to Base
//     (domain 6) with mintRecipient the Base Safe (returnBurnMismatch, the operator's own receipt check, says null), and the
//     MessageSent message decodes as ReturnHome expects (mintIsFor with the Safe as message sender).
// Base fork:
//   - the v8 move: the operator's own prepareRenew (an Operator on the fork, the account's state rebuilt from the chain) on
//     the real v7 Safe, executed the same way with the operator's gas limit; exactly the prepared v8 sessions enabled, V3's
//     generation + 1; its gas reported against V4_TX_GAS_TARGET;
//   - the mint: Circle's attestation of that MessageSent (fresh nonce and finality, as Circle fills them in) signed by a
//     test attester enabled on the fork's MessageTransmitterV2 (impersonated attester manager), served to ReturnHome by a
//     stub Iris; the Monad operator's report of the burn (noteReported, owner: the home) is adopted as burned and minted
//     by ReturnHome.tick to the Base Safe.
//
// Run: PATH=$HOME/.foundry/bin:$PATH bun apps/mamoru-operator/test/return-home-fork.ts (bun run fork:return-home in the operator)
// Once these Safes have really been moved, the run still measures the same path: a Monad Safe without USDC gets 100 USDC
// written into its balance on the fork (RETURN_HOME_FORK_DEAL=1 does it always), one without sessions burns with nothing
// to revoke, and a Base Safe already on v8 is moved again from what it has enabled.
// Upstreams: MONAD_RPC_URL (default https://rpc-mainnet.monadinfra.com), BASE_FORK_RPC_URL (default
// https://base-rpc.publicnode.com). Each anvil and its loopback proxy take a free port the OS gives. Nothing is
// broadcast anywhere but the local anvils.
import { mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { bytesToHex, concat, createWalletClient, encodeFunctionData, getAddress, hexToBytes, http, keccak256, numberToHex, pad, parseAbi, parseEventLogs, toHex, type Hex, type TransactionReceipt } from 'viem'
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts'
import type { AccountContext, Address, ReturnHomeInput } from '@mamoru/domain'
import { address, baseRegistry, erc20Abi, messageTransmitterV2Abi, monadRegistry, safeWebAuthnSharedSignerAbi, smartSessionAbi, tokenMessengerV2Abi, type Registry } from '@mamoru/registry'
import { V4_TX_GAS_TARGET } from '@mamoru/policy'
import { buildReturnHome, RETURN_HOME_DOMAIN, RETURN_HOME_FINALITY, returnReleaseId, TOKEN_MESSENGER_V2 } from '@mamoru/account/return-home'
import { execTransactionData, webAuthnSigner, type SafeTx } from '@mamoru/account/safe'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import { simulateCalls } from '@mamoru/rpc'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy, type ForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { assertV6Gate, resolveNamedPolicy, resolveV6Policy, resolveV7Policy, resolveV8Policy } from '../src/boot.ts'
import type { MonadSender } from '../src/bridge-monad.ts'
import { CCTP_DOMAIN_BASE, CCTP_DOMAIN_MONAD, cctpMessageKey, decodeCctpMessage, MESSAGE_TRANSMITTER_V2, mintIsFor } from '../src/cctp.ts'
import { readSafe } from '../src/chain.ts'
import { Operator, returnBurnMismatch, type OperatorConfig } from '../src/operator.ts'
import { Relayer } from '../src/relayer.ts'
import { ReturnHome } from '../src/return-home.ts'
import { DEFAULT_SPONSOR, SPONSOR_BOUNDS } from '../src/sponsorship.ts'
import { StateStore, type AccountState } from '../src/state.ts'

/** Brais' Safes (migrate-v4-real-size.ts): the Monad remote and its home on Base, the same passkey on both. */
const MONAD_SAFE: Address = '0xD72A7cB9773Dc58a9B944f9737996F45dBD1F108'
const BASE_SAFE: Address = '0x99aC3d214D4CE2E761F3108ee592D2A17Ec3c01C'
/** createProxyWithNonce's saltNonce of BASE_SAFE (tx 0xafb571d3…0e81, Base block 52,767,203): checked below against the address. */
const BASE_SALT_NONCE = 46809589425428679530331588158637142457078508681393392316145456181889366683276n
/**
 * MamoruGasPolicy on Base (the operator's MAMORU_GAS_POLICY_ADDRESS, a public contract): the userOp policy beside the
 * registry's TimeFrame and UsageLimit policies in every session BASE_SAFE's v7 approval enabled (tx 0x55d7e445…a9f3,
 * Base block 54,045,338, where its MamoruActionPolicyV3 generation became 6).
 */
const BASE_GAS_POLICY: Address = '0x9EB9a72c5e7231374eD65f5a1fF3e38a39798866'
/** operator.ts PASSKEY_VERIFY_GAS (not exported): what the WebAuthn check costs that an approved-hash signature does not. */
const PASSKEY_VERIFY_GAS = 300_000n
const ZERO: Address = '0x0000000000000000000000000000000000000000'

const t0 = Date.now()
const log = (m: string) => console.log(`[return-home-fork +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const fails: string[] = []
function check(ok: boolean, step: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` (${detail})` : ''}`)
  if (!ok) fails.push(step)
}

if (!process.env.MONAD_RPC_URL) process.env.MONAD_RPC_URL = 'https://rpc-mainnet.monadinfra.com'
if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://base-rpc.publicnode.com'
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const dir = mkdtempSync(join(tmpdir(), 'mamoru-return-home-fork-'))

type Fork = { lab: Lab; proxy: ForkProxy; anvil: ReturnType<typeof Bun.spawn> }
async function startFork(envVar: string, chainId: number, name: string, reg: Registry): Promise<Fork> {
  const proxy = startForkProxy(envVar)
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const p = probe.port as number
  probe.stop(true)
  const argv = ['--fork-url', proxy.url, '--no-rate-limit', '--timeout', '120000', '--fork-retry-backoff', '2000', '--retries', '10', '--chain-id', String(chainId), '--host', '127.0.0.1', '--port', String(p), '--no-request-size-limit', '--gas-limit', '60000000']
  assertNoKeyInArgv(argv, [envVar])
  let anvil: ReturnType<typeof Bun.spawn> | undefined
  try {
    anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, `anvil-${name}.log`)), stderr: Bun.file(join(dir, `anvil-${name}.log`)), env: sanitizedEnv() })
    const lab = new Lab(`http://127.0.0.1:${p}/`, chainId, reg)
    for (let i = 0; ; i++) {
      try {
        await lab.client.getBlockNumber()
        break
      } catch {
        if (i > 300) throw new Error(`anvil ${name} did not start`)
        await Bun.sleep(200)
      }
    }
    return { lab, proxy, anvil }
  } catch (e) {
    // Nothing left behind when the fork does not come up (an upstream down): the caller never gets it to stop.
    anvil?.kill()
    await anvil?.exited
    proxy.stop()
    throw e
  }
}

const safeAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function VERSION() view returns (string)',
  'function approveHash(bytes32 hashToApprove)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
])
const storageAccessibleAbi = parseAbi(['function simulateAndRevert(address targetContract, bytes calldataPayload)'])
const permissionIdsAbi = parseAbi(['function getPermissionIDs(address account) view returns (bytes32[])'])
const transmitterAdminAbi = parseAbi(['function attesterManager() view returns (address)', 'function enableAttester(address attester)', 'function setSignatureThreshold(uint256 newSignatureThreshold)'])
const npmBalanceAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)'])
const generationAbi = parseAbi(['function generationOf(address account) view returns (uint256)'])

/**
 * The operator's pre-sign estimate (operator.ts ownerTxGasLimit): simulateAndRevert in the Safe's context, 9/8 +
 * PASSKEY_VERIFY_GAS. `tx` is a Safe tx delegatecalling MultiSendCallOnly, as ownerSafeTx gives for several calls.
 */
async function estimateLikeOperator(lab: Lab, safe: Address, tx: SafeTx, relayer: Address): Promise<{ sim: bigint; limit: bigint } | null> {
  if (tx.operation !== 1 || tx.to.toLowerCase() !== address('MultiSendCallOnly_141', lab.registry).toLowerCase()) throw new Error('estimateLikeOperator: not a MultiSendCallOnly batch')
  const data = encodeFunctionData({ abi: storageAccessibleAbi, functionName: 'simulateAndRevert', args: [tx.to, tx.data] })
  const [res] = await simulateCalls(lab.client, [{ from: relayer, to: safe, data }], await lab.client.getBlockNumber())
  if (!res || res.returnData.length < 2 + 64 * 2 || BigInt(res.returnData.slice(0, 66)) !== 1n) return null
  return { sim: res.gasUsed, limit: (res.gasUsed * 9n) / 8n + PASSKEY_VERIFY_GAS }
}

/**
 * ONE owner Safe transaction: the owner (the shared signer contract, impersonated) approves `safeTxHash`, then a relayer
 * sends execTransaction with the v=1 approved-hash signature and `gas`. Throws unless the Safe has one owner, threshold 1.
 */
async function runAsOwner(lab: Lab, safe: Address, tx: SafeTx, safeTxHash: Hex, gas: bigint): Promise<{ receipt: TransactionReceipt; hash: Hex; ok: boolean; nonceBefore: bigint }> {
  const owners = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })
  const threshold = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' })
  if (owners.length !== 1 || threshold !== 1n) throw new Error(`the owner faking assumes one owner with threshold 1 (got ${owners.length} owners, threshold ${threshold})`)
  const owner = owners[0]!
  const nonceBefore = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  if (nonceBefore !== tx.nonce) throw new Error(`Safe nonce moved: ${nonceBefore} vs ${tx.nonce}`)
  await lab.setBalance(owner, 10n ** 19n)
  const ap = await lab.sendAs(owner, safe, encodeFunctionData({ abi: safeAbi, functionName: 'approveHash', args: [safeTxHash] }))
  if (!ap.ok) throw new Error('approveHash from the impersonated owner failed')
  const signatures = concat([pad(owner, { size: 32 }), pad('0x00', { size: 32 }), '0x01'])
  const relayer = privateKeyToAccount(generatePrivateKey())
  await lab.setBalance(relayer.address, 10n ** 20n)
  const r = await lab.send(relayer, safe, execTransactionData(tx, signatures), 0n, gas)
  return { ...r, nonceBefore }
}

function executions(receipt: TransactionReceipt, safe: Address): { ok: number; failed: number } {
  const logs = parseEventLogs({ abi: safeAbi, strict: false, logs: receipt.logs.filter((l) => l.address.toLowerCase() === safe.toLowerCase()) })
  return { ok: logs.filter((l) => l.eventName === 'ExecutionSuccess').length, failed: logs.filter((l) => l.eventName === 'ExecutionFailure').length }
}

/** What Circle's attestation service does to a V2 message before signing: a fresh nonce (bytes 12..44) and the finality executed (bytes 144..148). */
function attestable(m: Hex, nonce: bigint, finality: number): Hex {
  const b = hexToBytes(m)
  b.set(hexToBytes(pad(toHex(nonce))), 12)
  b.set(hexToBytes(numberToHex(finality, { size: 4 })), 144)
  return bytesToHex(b)
}

/** `amount` of `token` written into `who`'s balance on the fork: the first mapping slot (0..20) whose write balanceOf reads back. */
async function dealUsdc(lab: Lab, token: Address, who: Address, amount: bigint): Promise<bigint> {
  for (let slot = 0n; slot <= 20n; slot++) {
    const key = keccak256(concat([pad(who, { size: 32 }), pad(toHex(slot), { size: 32 })]))
    const was = await lab.client.getStorageAt({ address: token, slot: key })
    await lab.rpc('anvil_setStorageAt', [token, key, pad(toHex(amount), { size: 32 })])
    if ((await lab.client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })) === amount) return amount
    await lab.rpc('anvil_setStorageAt', [token, key, was ?? pad('0x00', { size: 32 })])
  }
  throw new Error(`no balance slot of ${token} found in 0..20`)
}

/** A relayer on the fork with ReturnHome's sender interface: hash on disk (onSigned) before the broadcast, as the real one. */
function forkSender(lab: Lab, key: Hex): MonadSender {
  const account = privateKeyToAccount(key)
  const wallet = createWalletClient({ account, chain: lab.chain, transport: http(lab.url, { timeout: 120_000 }) })
  return {
    address: account.address,
    async send(tx, onSent, onSending, onSigned) {
      const block = await lab.client.getBlock()
      const maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + 1_000_000n
      const nonce = await lab.client.getTransactionCount({ address: account.address, blockTag: 'pending' })
      const req = await wallet.prepareTransactionRequest({ to: tx.to, data: tx.data, gas: tx.gas, nonce, maxFeePerGas, maxPriorityFeePerGas: 1_000_000n, type: 'eip1559' })
      const raw = await wallet.signTransaction(req as never)
      const hash = keccak256(raw)
      onSending?.(maxFeePerGas * (tx.gas ?? 0n), { hash, nonce, maxFeePerGas })
      onSigned?.(hash, nonce)
      await lab.client.request({ method: 'eth_sendRawTransaction', params: [raw] })
      onSent?.(hash)
      return { hash, receipt: await lab.client.waitForTransactionReceipt({ hash }) }
    },
  }
}

const stops: (() => void | Promise<void>)[] = []
const stopFork = (f: Fork) => async () => {
  f.anvil.kill()
  await f.anvil.exited
  f.proxy.stop()
}
let exitCode = 1
try {
  // ======================================================================== Monad: step 1, the owner's return home
  const M = await startFork('MONAD_RPC_URL', 143, 'monad', monadRegistry)
  stops.push(stopFork(M))
  const monad = M.lab
  const mHead = await monad.client.getBlockNumber()
  log(`Monad fork at block ${mHead}, chain id ${await monad.client.getChainId()}`)
  const mUsdc = address('USDC', monadRegistry)
  const smartSession = address('SmartSession', monadRegistry)
  const safe = MONAD_SAFE
  const home = BASE_SAFE

  const version = await monad.client.readContract({ address: safe, abi: safeAbi, functionName: 'VERSION' })
  const owners = await monad.client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })
  const signerM = await monad.client.readContract({ address: address('SafeWebAuthnSharedSigner', monadRegistry), abi: safeWebAuthnSharedSignerAbi, functionName: 'getConfiguration', args: [safe] })
  let balance = await monad.balanceOf('USDC', safe)
  // Once this Safe has really gone home it holds no USDC: the burn is then measured on USDC written into it on the fork.
  if (balance === 0n || process.env.RETURN_HOME_FORK_DEAL === '1') {
    balance = await dealUsdc(monad, mUsdc, safe, 100_000_000n)
    log(`${balance} USDC units written into the Monad Safe's balance on the fork`)
  }
  const ids =(await monad.client.readContract({ address: smartSession, abi: permissionIdsAbi, functionName: 'getPermissionIDs', args: [safe] })) as Hex[]
  const nfts = await monad.client.readContract({ address: address('NonfungiblePositionManager', monadRegistry), abi: npmBalanceAbi, functionName: 'balanceOf', args: [safe] })
  const wmon = await monad.balanceOf('WMON', safe)
  console.log(`Monad Safe ${safe}: Safe ${version}, owners ${owners.join(',')}, ${ids.length} session(s) enabled, ${balance} USDC units, ${nfts} position NFT(s), ${wmon} WMON wei`)
  check(version === '1.4.1' && owners.length === 1 && owners[0]!.toLowerCase() === address('SafeWebAuthnSharedSigner', monadRegistry).toLowerCase(), 'the Monad Safe is a design-C Safe 1.4.1 owned by the shared passkey signer alone')
  if (!ids.length) log('the Monad Safe has no session enabled any more: the run checks a burn with nothing to revoke')
  check(balance > 0n, 'the Monad Safe holds USDC for step 1 to send home', `${ids.length} session(s), ${balance} USDC units`)

  // The input planReturnHome builds: Stop's set (every session the Safe has enabled), the whole USDC balance, the Safe nonce.
  const safeNonce = await monad.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  const input: ReturnHomeInput = { chainId: 143, safe, safeNonce: safeNonce.toString(), home, amountUsdc: balance.toString(), removeIds: ids }
  const built = buildReturnHome(input, monadRegistry)
  const tx: SafeTx = { to: built.safeTx.to, value: 0n, data: built.safeTx.data, operation: built.safeTx.operation, nonce: safeNonce }
  console.log(`return-home Safe tx: ${built.calls.length} calls (${ids.length} removeSession, approve, depositForBurn), operation ${tx.operation}, data ${(tx.data.length - 2) / 2} bytes, safeTxHash ${built.safeTxHash}`)
  const onChainHash = await monad.client.readContract({ address: safe, abi: safeAbi, functionName: 'getTransactionHash', args: [tx.to, 0n, tx.data, tx.operation, 0n, 0n, 0n, ZERO, ZERO, safeNonce] })
  check(onChainHash.toLowerCase() === built.safeTxHash.toLowerCase(), "buildReturnHome's safeTxHash is the Safe's own getTransactionHash on chain 143 (what the passkey signs)", onChainHash)

  const relayerM = privateKeyToAccount(generatePrivateKey()).address
  await monad.setBalance(relayerM, 10n ** 20n)
  const estM = await estimateLikeOperator(monad, safe, tx, relayerM)
  check(!!estM, "the operator's pre-sign simulation (simulateAndRevert in the Safe) succeeds", estM ? `${estM.sim} -> limit ${estM.limit}` : 'no answer')
  const ex = await runAsOwner(monad, safe, tx, built.safeTxHash, estM?.limit ?? 3_000_000n)
  const rcM = ex.receipt
  const evM = executions(rcM, safe)
  const nonceAfterM = await monad.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  console.log(`burn tx ${ex.hash} block ${rcM.blockNumber}: gasUsed ${rcM.gasUsed} (approved-hash signature; + PASSKEY_VERIFY_GAS = ${rcM.gasUsed + PASSKEY_VERIFY_GAS}), gas limit given ${estM?.limit}`)
  check(ex.ok && evM.ok === 1 && evM.failed === 0 && nonceAfterM === ex.nonceBefore + 1n, 'exactly one Safe transaction within the operator gas limit: ExecutionSuccess, Safe nonce +1', `status ${rcM.status}, nonce ${ex.nonceBefore} -> ${nonceAfterM}`)
  const idsAfter = (await monad.client.readContract({ address: smartSession, abi: permissionIdsAbi, functionName: 'getPermissionIDs', args: [safe] })) as Hex[]
  let stillEnabled = 0
  for (const id of ids) if (await monad.client.readContract({ address: smartSession, abi: smartSessionAbi, functionName: 'isPermissionEnabled', args: [id, safe] })) stillEnabled++
  check(idsAfter.length === 0 && stillEnabled === 0, 'every session is removed: getPermissionIDs is empty and isPermissionEnabled false for each', `${ids.length} -> ${idsAfter.length}`)
  const left = await monad.balanceOf('USDC', safe)
  check(left === 0n, 'no USDC is left on the Monad Safe', `${balance} -> ${left}`)
  check(returnBurnMismatch(rcM, input, mUsdc) === null, "the operator's receipt check (returnBurnMismatch, recordReturnBurns) takes it as the burn the owner signed", String(returnBurnMismatch(rcM, input, mUsdc)))
  const burns = parseEventLogs({ abi: tokenMessengerV2Abi, eventName: 'DepositForBurn', logs: rcM.logs.filter((l) => l.address.toLowerCase() === TOKEN_MESSENGER_V2.toLowerCase()) })
  const b = burns[0]?.args
  check(
    burns.length === 1 && !!b && b.amount === balance && b.destinationDomain === RETURN_HOME_DOMAIN && b.mintRecipient.toLowerCase() === pad(home, { size: 32 }).toLowerCase() && b.depositor.toLowerCase() === safe.toLowerCase() && b.burnToken.toLowerCase() === mUsdc.toLowerCase() && BigInt(b.destinationCaller) === 0n && b.maxFee === 0n && b.minFinalityThreshold === RETURN_HOME_FINALITY && b.hookData === '0x',
    'one DepositForBurn: the whole balance, destination domain 6 (Base), mintRecipient the Base Safe, depositor the Safe, open caller, maxFee 0, Standard finality, no hook',
    b ? `amount ${b.amount}, domain ${b.destinationDomain}, recipient ${b.mintRecipient}` : 'none',
  )
  const sent = parseEventLogs({ abi: messageTransmitterV2Abi, eventName: 'MessageSent', logs: rcM.logs.filter((l) => l.address.toLowerCase() === MESSAGE_TRANSMITTER_V2.toLowerCase()) })
  check(sent.length === 1, 'one MessageSent from MessageTransmitterV2 on Monad', String(sent.length))
  const message = sent[0]!.args.message
  const msg = decodeCctpMessage(message)
  console.log(`MessageSent: ${(message.length - 2) / 2} bytes, source ${msg.sourceDomain} -> destination ${msg.destinationDomain}, nonce ${msg.nonce}, sender ${msg.messageSender}, recipient ${msg.mintRecipient}, amount ${msg.amount}`)
  check((message.length - 2) / 2 === 148 + 228, 'the message is a header and a BurnMessageV2 body with no hook (376 bytes)')
  check(msg.sourceDomain === CCTP_DOMAIN_MONAD && msg.destinationDomain === CCTP_DOMAIN_BASE && msg.amount === balance && msg.maxFee === 0n, 'MessageSent: Monad (15) to Base (6), the burned amount, no fee')
  check(mintIsFor(msg, mUsdc, home, balance, { source: CCTP_DOMAIN_MONAD, destination: CCTP_DOMAIN_BASE }, safe), "MessageSent decodes as ReturnHome's check of an owner-signed return expects (mintIsFor, message sender the Monad Safe)")
  check(!mintIsFor(msg, mUsdc, home, balance, { source: CCTP_DOMAIN_MONAD, destination: CCTP_DOMAIN_BASE }, getAddress(`0x${'a4'.repeat(20)}`)), 'and not as a V4 release (another message sender): the owner path needs its `sender`')

  // ======================================================================== Base: the v8 move (step 0) and the mint
  const B = await startFork('BASE_FORK_RPC_URL', 8453, 'base', baseRegistry)
  stops.push(stopFork(B))
  const base = B.lab
  log(`Base fork at block ${await base.client.getBlockNumber()}`)

  // --- the v8 move, prepared by the operator itself on the real v7 Safe ------------------------------------------------------
  const signerB = await base.client.readContract({ address: address('SafeWebAuthnSharedSigner', baseRegistry), abi: safeWebAuthnSharedSignerAbi, functionName: 'getConfiguration', args: [BASE_SAFE] })
  check(signerB.x === signerM.x && signerB.y === signerM.y, 'the Base Safe and the Monad Safe carry the same passkey (one owner)')
  const ownersB = [address('SafeWebAuthnSharedSigner', baseRegistry)]
  const derived = counterfactualAddress(accountSetup(ownersB, BASE_SALT_NONCE, webAuthnSigner(signerB.x, signerB.y)))
  check(derived.toLowerCase() === BASE_SAFE.toLowerCase(), 'the account context rebuilt from the chain derives the Base Safe (owners, saltNonce, passkey)', derived)
  const ctx: AccountContext = { accountKey: 'fork-v7', chainId: 8453, address: BASE_SAFE, owners: ownersB, saltNonce: BASE_SALT_NONCE.toString(), passkey: { credentialId: 'fork', x: toHex(signerB.x, { size: 32 }), y: toHex(signerB.y, { size: 32 }) } }
  const env = { MAMORU_ONCHAIN_POLICY_V4: '1', MAMORU_GAS_POLICY_ADDRESS: BASE_GAS_POLICY }
  const v6 = resolveV6Policy('base', env)!
  const v7 = resolveV7Policy('base', env)!
  const v8 = resolveV8Policy('base', env)!
  await assertV6Gate(base.client, v6)
  const before = (await base.client.readContract({ address: address('SmartSession', baseRegistry), abi: permissionIdsAbi, functionName: 'getPermissionIDs', args: [BASE_SAFE] })) as Hex[]
  const read = await readSafe(base.client, BASE_SAFE, baseRegistry)
  console.log(`Base Safe ${BASE_SAFE}: ${before.length} session(s) enabled, ${read.positions.length} position(s) in registry pools, Safe nonce ${await base.client.readContract({ address: BASE_SAFE, abi: safeAbi, functionName: 'nonce' })}`)
  // The account as the operator holds it, rebuilt from the chain: v7, active, its enabled sessions as its grants (names do
  // not matter to a move: it revokes every id and enables all of v8), its open positions as the ones it minted.
  const v7Keys = v7.session.grants.filter((g) => !g.perPosition).map((g) => `${g.name}`)
  const acc = {
    accountKey: ctx.accountKey,
    ctx,
    trusted: true,
    active: true,
    policyId: v7.policyId,
    sessionKey: generatePrivateKey(),
    signedCapUsdc: (10_000n * 10n ** 6n).toString(),
    grants: before.map((id, i) => ({ name: v7Keys[i] ?? `v7-${i}`, permissionId: id, grant: { policyId: v7.policyId, userOp: { validUntil: 2_000_000_000, validAfter: 0, usageLimit: 1 } } })),
    revoked: [],
    managedTokenIds: read.positions.map((p) => p.tokenId.toString()),
    admittedTokenIds: read.positions.map((p) => p.tokenId.toString()),
    depositsAfter: '0',
    historyFromBlock: '0',
    epoch: 1,
    ops: [],
    seq: 0,
  } as unknown as AccountState
  const store = new StateStore(join(dir, 'state-base'))
  store.state.accounts[ctx.accountKey] = acc
  const relayerKeyB = generatePrivateKey()
  const cfg: OperatorConfig = {
    chainId: 8453,
    registry: baseRegistry,
    live: true,
    rpcUrl: base.url,
    bundlerUrl: '',
    policy: resolveNamedPolicy('conservador-live-v2', env)!,
    reviewMs: 60_000,
    waitBlockMs: 1_000,
    maxWaitBlocks: 30,
    v6Policy: v6,
    v7Policy: v7,
    v8Policy: v8,
    opsFlags: () => ({ base_v8: true }),
    opsScopedFlags: () => ({ base_v8: null }),
    sponsor: { ...DEFAULT_SPONSOR, weiPerDay: SPONSOR_BOUNDS.weiPerDay[1], perAccount: SPONSOR_BOUNDS.perAccount[1] },
  }
  const op = new Operator(cfg, base.client, new Relayer(relayerKeyB, base.client, base.url, 8453), store)
  await base.setBalance(privateKeyToAccount(relayerKeyB).address, 10n ** 19n)
  const t = await op.prepareRenew(ctx)
  console.log(`v8 move to sign:\n    ${t.summary.join('\n    ')}`)
  check(t.policyId === v8.policyId && t.move === true, 'the renew row prepares the move to conservador-live-v8', `${t.policyId} move=${t.move}`)
  const prepared = (op as unknown as { prepared: Map<string, { tx: SafeTx; grants?: { permissionId: Hex; grant: { policyId: string } }[] }> }).prepared.get(t.prepareId)!
  check(!prepared.tx.refund, 'Mamoru pays the move (no refund in the Safe tx)')
  const ms = prepared.tx
  const gen = () => base.client.readContract({ address: v8.actionPolicy!.address, abi: generationAbi, functionName: 'generationOf', args: [BASE_SAFE] })
  const genBefore = await gen()
  const relayerB = privateKeyToAccount(relayerKeyB).address
  const estV8 = await estimateLikeOperator(base, BASE_SAFE, ms, relayerB)
  check(!!estV8, "the operator's pre-sign simulation of the move succeeds", estV8 ? `${estV8.sim} -> limit ${estV8.limit}` : 'no answer')
  const exV8 = await runAsOwner(base, BASE_SAFE, ms, t.safeTxHash, estV8?.limit ?? 16_000_000n)
  const evV8 = executions(exV8.receipt, BASE_SAFE)
  const after = (await base.client.readContract({ address: address('SmartSession', baseRegistry), abi: permissionIdsAbi, functionName: 'getPermissionIDs', args: [BASE_SAFE] })) as Hex[]
  const v8Gas = exV8.receipt.gasUsed
  console.log(`v8 move tx ${exV8.hash}: gasUsed ${v8Gas} (approved-hash signature); + PASSKEY_VERIFY_GAS = ${v8Gas + PASSKEY_VERIFY_GAS}; V4_TX_GAS_TARGET ${V4_TX_GAS_TARGET}; sessions ${before.length} -> ${after.length}`)
  check(exV8.ok && evV8.ok === 1 && evV8.failed === 0, 'the v8 move is one Safe transaction that executes on the real v7 Safe', `status ${exV8.receipt.status}`)
  const enabled = (prepared.grants ?? []).map((g) => g.permissionId.toLowerCase()).sort()
  check(!before.some((id) => after.includes(id)), 'every v7 session is revoked', `${before.length} v7 session(s), ${after.length} enabled after`)
  check(enabled.length > 0 && JSON.stringify(after.map((id) => id.toLowerCase()).sort()) === JSON.stringify(enabled) && (prepared.grants ?? []).every((g) => g.grant.policyId === v8.policyId), 'exactly the v8 sessions the operator prepared (and stores for the engine) are enabled', `${enabled.length} prepared, ${after.length} enabled`)
  const genAfter = await gen()
  check(genBefore > 0n && genAfter === genBefore + 1n, 'the Safe ran on MamoruActionPolicyV3 before (v7) and the move enables the next generation there', `${genBefore} -> ${genAfter}`)
  check(v8Gas + PASSKEY_VERIFY_GAS <= V4_TX_GAS_TARGET, `the move plus the passkey check fits V4_TX_GAS_TARGET (${V4_TX_GAS_TARGET})`, `${v8Gas + PASSKEY_VERIFY_GAS}`)

  // --- the mint on Base: the burn reported by the Monad operator, adopted on its attestation, minted -----------------------
  const attesterKey = generatePrivateKey()
  const manager = await base.client.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: transmitterAdminAbi, functionName: 'attesterManager' })
  await base.setBalance(manager, 10n ** 18n)
  check((await base.sendAs(manager, MESSAGE_TRANSMITTER_V2, encodeFunctionData({ abi: transmitterAdminAbi, functionName: 'enableAttester', args: [privateKeyToAccount(attesterKey).address] }))).ok, 'a test attester is enabled on the fork (impersonated attester manager)')
  await base.sendAs(manager, MESSAGE_TRANSMITTER_V2, encodeFunctionData({ abi: transmitterAdminAbi, functionName: 'setSignatureThreshold', args: [1n] }))
  const attested = attestable(message, BigInt(keccak256(concat([ex.hash, '0x01']))), RETURN_HOME_FINALITY)
  check(cctpMessageKey(attested) === cctpMessageKey(message), 'the attested message is the MessageSent one (cctpMessageKey) with Circle\'s nonce and finality filled in')
  const s = await sign({ hash: keccak256(attested), privateKey: attesterKey })
  const attestation = concat([s.r, s.s, numberToHex(s.v ?? (s.yParity === 1 ? 28n : 27n), { size: 1 })])
  const asked: string[] = []
  const iris = async (url: string): Promise<Response> => {
    asked.push(url)
    if (url.includes(`/v2/messages/${CCTP_DOMAIN_MONAD}?transactionHash=${ex.hash}`)) return Response.json({ messages: [{ status: 'complete', message: attested, attestation }] })
    return new Response('{}', { status: 404 })
  }
  let now = Date.now()
  const homeUsdcBefore = await base.balanceOf('USDC', home)
  const rh = new ReturnHome(join(dir, 'state-return'), base.client, forkSender(base, generatePrivateKey()), () => ({ v4: getAddress(`0x${'a4'.repeat(20)}`), usdc: mUsdc }), iris as never, () => now)
  await base.setBalance((rh as unknown as { relayer: MonadSender }).relayer.address, 10n ** 18n)
  // What the Monad operator's exposure answer reports for this account (recordReturnBurns: id from the tx, owner.home).
  const id = returnReleaseId(ex.hash)
  rh.noteReported(safe, [{ id, amount: balance.toString(), block: rcM.blockNumber.toString(), tx: ex.hash, owner: home }], ctx.accountKey, [home])
  await rh.tick(() => null)
  const adopted = rh.returns().find((e) => e.id === id)
  check(adopted?.state === 'burned' && adopted.sender?.toLowerCase() === safe.toLowerCase() && adopted.home.toLowerCase() === home.toLowerCase(), 'ReturnHome adopts the reported owner return as burned once the attested message proves it (sender: the Monad Safe)', `${adopted?.state} sender ${adopted?.sender}`)
  check(rh.inFlight(ctx.accountKey) === balance && rh.busy(ctx.accountKey), 'counted in flight on the account until minted', `${rh.inFlight(ctx.accountKey)}`)
  now += 6 * 60_000
  await rh.tick(() => null)
  const minted = rh.returns().find((e) => e.id === id)
  const homeUsdcAfter = await base.balanceOf('USDC', home)
  const used = await base.client.readContract({ address: MESSAGE_TRANSMITTER_V2, abi: messageTransmitterV2Abi, functionName: 'usedNonces', args: [decodeCctpMessage(attested).nonce] })
  const mintRc = minted?.mintTx ? await base.client.getTransactionReceipt({ hash: minted.mintTx }) : null
  console.log(`mint ${minted?.mintTx} gasUsed ${mintRc?.gasUsed}; home USDC ${homeUsdcBefore} -> ${homeUsdcAfter}; Iris asked ${asked.length}x`)
  check(minted?.state === 'minted' && mintRc?.status === 'success', 'ReturnHome mints it on Base from its relayer (receiveMessage)', `${minted?.state} ${minted?.mintTx}`)
  check(homeUsdcAfter - homeUsdcBefore === balance && used !== 0n, 'the whole amount lands on the Base Safe and the CCTP nonce is used', `+${homeUsdcAfter - homeUsdcBefore}`)
  check(rh.inFlight(ctx.accountKey) === 0n && !rh.busy(ctx.accountKey), "once minted nothing is in flight and the account's bridges no longer wait", `${rh.inFlight(ctx.accountKey)} busy=${rh.busy(ctx.accountKey)}`)
  check(asked.every((u) => u.includes(`/v2/messages/${CCTP_DOMAIN_MONAD}?`)), 'Iris is asked for Monad (source domain 15) burns only')

  exitCode = fails.length ? 1 : 0
  console.log(`\nRETURN-HOME FORK ${fails.length ? `FAIL: ${fails.join('; ')}` : 'PASS'}. Logs ${dir}`)
} catch (e) {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e)
  console.error(`logs ${dir}`)
} finally {
  for (const s of stops.reverse()) await Promise.resolve(s()).catch(() => {})
}
process.exit(exitCode)
