// otto/mamoru#259 (spec 010, "Migration (v2-v6 -> V4)"): the move to V4 is ONE owner Safe transaction at the REAL size of a
// production account, not only the synthetic 12-session v2 account of e2e-one-auth.ts phase D.
//
// Target: Brais' Base Safe (v6, design C), forked at the latest block. The V4 stack is deployed on the fork as e2e-one-auth
// does (CREATE2 through the deterministic deployer, ModuleRegistry self-attestation, pinned in the registry in memory).
// The inventory is read with the production path the operator's planMigration uses (sessionCreatedIds from the Safe's
// deployment block, readSessionState, inventoryOf), the admit list from the Safe's real positions (readSafe + the same
// sizing filter), and the transaction is buildMigrateV4's. Executed on the fork as the owner would:
//   the Safe's only owner is the SafeWebAuthnSharedSigner contract (the passkey lives in its storage for this Safe), so the
//   passkey signature is replaced by Safe's own pre-approved-hash path: anvil_impersonateAccount on the owner address,
//   approveHash(safeTxHash) from it, then execTransaction from the relayer with the v=1 "approved hash" signature. The
//   WebAuthn verification gas is added back by hand (PASSKEY_VERIFY_GAS, as the operator's estimate does).
// Optional second part (E2E_MONAD=1): the remote Safe on Monad, step 1 (remove remote sessions, enable V4, move funds).
//
// Run (needs foundry artifacts: `cd contracts/action-policy && ./install.sh && forge build --silent`):
//   PATH=$HOME/.foundry/bin:$PATH bun apps/mamoru-operator/test/migrate-v4-real-size.ts
// Upstreams: BASE_FORK_RPC_URL (default https://base-rpc.publicnode.com: mainnet.base.org answers eth_getLogs too slowly for the
// inventory scan), MONAD_RPC_URL (default https://rpc.monad.xyz). Nothing is broadcast anywhere but the local anvils.
import { mkdtempSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { concat, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, pad, parseAbi, parseEventLogs, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, MigrateV4Input } from '@mamoru/domain'
import { address, baseRegistry, monadRegistry, readCodeHash, type Registry } from '@mamoru/registry'
import { oneAuthV4Deployment, ONE_AUTH_V4_CONTRACTS, V4_DOMAIN_BY_CHAIN, V4_MAX_ADMIT, V4_TX_GAS_TARGET, v4CapUsdOf } from '@mamoru/policy'
import { buildMigrateV4, inventoryOf, readSessionState, sessionCreatedIds, smartSessionV4Abi } from '@mamoru/account/one-auth'
import { multiSendCallOnly } from '@mamoru/account/safe'
import { simulateCalls } from '@mamoru/rpc'
import { assertNoKeyInArgv, sanitizedEnv } from '../../../packages/scenarios/fork/anvil.ts'
import { startForkProxy, type ForkProxy } from '../../../packages/scenarios/proxy/index.ts'
import { Lab } from '../../../packages/scenarios/fixtures/lab.ts'
import { positionUsdc, readSafe } from '../src/chain.ts'
import { MAX_SIZING_POSITIONS, POSITION_DUST_USDC } from '../src/operator.ts'

const REPO = join(import.meta.dir, '../../..')
const OUT = join(REPO, 'contracts/action-policy/out')
const DETERMINISTIC_DEPLOYER: Address = '0x4e59b44847b379578588920cA78FbF26c0B4956C'
const SALT = keccak256(toHex('mamoru.migrate-v4-real-size.v4'))
/** operator.ts PASSKEY_VERIFY_GAS (not exported): what the WebAuthn check costs that an approved-hash signature does not. */
const PASSKEY_VERIFY_GAS = 300_000n

const BRAIS_BASE: Address = '0x99aC3d214D4CE2E761F3108ee592D2A17Ec3c01C'
const BRAIS_MONAD: Address = '0xD72A7cB9773Dc58a9B944f9737996F45dBD1F108'
/** The Base block the Safe was deployed in (binary search on eth_getCode, 2026-11-02); the scan starts a margin before it. */
const BRAIS_BASE_DEPLOY_BLOCK = 52_767_203n
/** C (USD units) the V4 Init carries: Brais' D1 cap is not readable from here and does not change the gas. */
const CAP_USDC = BigInt(process.env.MIGRATE_CAP_USDC ?? '1000000000')

const t0 = Date.now()
const log = (m: string) => console.log(`[migrate-v4-real-size +${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`)
const fails: string[] = []
function check(ok: boolean, step: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? ` (${detail})` : ''}`)
  if (!ok) fails.push(step)
}

if (!process.env.BASE_FORK_RPC_URL) process.env.BASE_FORK_RPC_URL = 'https://base-rpc.publicnode.com'
if (!process.env.MONAD_RPC_URL) process.env.MONAD_RPC_URL = 'https://rpc.monad.xyz'
const anvilBin = Bun.which('anvil') ?? join(homedir(), '.foundry/bin/anvil')
const dir = mkdtempSync(join(tmpdir(), 'mamoru-migrate-real-size-'))
type Fork = { lab: Lab; proxy: ForkProxy; anvil: ReturnType<typeof Bun.spawn> }
async function startFork(envVar: string, chainId: number, name: string, reg: Registry): Promise<Fork> {
  const proxy = startForkProxy(envVar)
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const p = probe.port as number
  probe.stop(true)
  const argv = ['--fork-url', proxy.url, '--no-rate-limit', '--timeout', '120000', '--fork-retry-backoff', '2000', '--retries', '10', '--chain-id', String(chainId), '--host', '127.0.0.1', '--port', String(p), '--no-request-size-limit', '--gas-limit', '60000000']
  assertNoKeyInArgv(argv, [envVar])
  const anvil = Bun.spawn([anvilBin, ...argv], { stdout: Bun.file(join(dir, `anvil-${name}.log`)), stderr: Bun.file(join(dir, `anvil-${name}.log`)), env: sanitizedEnv() })
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
}

const artifact = (file: string, name = file): Hex => JSON.parse(readFileSync(join(OUT, `${file}.sol`, `${name}.json`), 'utf8')).bytecode.object as Hex
const create2 = (initCode: Hex): Address => getAddress(`0x${keccak256(concat(['0xff', DETERMINISTIC_DEPLOYER, SALT, keccak256(initCode)])).slice(26)}`)

/** The V4 stack on `lab`, as e2e-one-auth deploys it (CREATE2 through the deterministic deployer + ModuleRegistry self-attestation). */
async function deployStack(lab: Lab, deployer: Address, admin: Address, guardian: Address): Promise<Record<(typeof ONE_AUTH_V4_CONTRACTS)[number], Address>> {
  const gasInit = concat([artifact('MamoruGasPolicyV2'), encodeAbiParameters([{ type: 'address' }], [guardian])])
  const regInit = concat([artifact('MamoruRegistry'), encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [admin, guardian, 48n * 3600n])])
  const gasPolicy = create2(gasInit)
  const registry = create2(regInit)
  const v4Init = concat([artifact('MamoruActionPolicyV4'), encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'address' }], [registry, gasPolicy, guardian])])
  const checkInit = artifact('MamoruMigrationCheck')
  const out = { MamoruGasPolicyV2: gasPolicy, MamoruRegistry: registry, MamoruActionPolicyV4: create2(v4Init), MamoruMigrationCheck: create2(checkInit) }
  for (const init of [gasInit, regInit, v4Init, checkInit]) {
    const r = await lab.sendAs(deployer, DETERMINISTIC_DEPLOYER, concat([SALT, init]))
    if (!r.ok) throw new Error(`deterministic deploy failed on ${lab.chainId}`)
  }
  const mr = address('ModuleRegistry', lab.registry)
  const uid = (await lab.client.readContract({ address: mr, abi: parseAbi(['struct ModuleRecord { bytes32 resolverUID; address sender; bytes metadata; }', 'function findModule(address) view returns (ModuleRecord)']), functionName: 'findModule', args: [address('TimeFramePolicy', lab.registry)] })).resolverUID
  for (const m of [out.MamoruActionPolicyV4, out.MamoruGasPolicyV2]) {
    const r = await lab.sendAs(deployer, mr, encodeFunctionData({ abi: parseAbi(['function registerModule(bytes32 resolverUID, address moduleAddress, bytes metadata, bytes resolverContext)']), functionName: 'registerModule', args: [uid, m, '0x', '0x'] }))
    if (!r.ok) throw new Error(`ModuleRegistry.registerModule of ${m} failed on ${lab.chainId}`)
  }
  return out
}

/** What the pin PR does: the four names move from `undeployed` to `entries`, with the code hash read on the fork. */
async function pin(lab: Lab, registry: Registry, stack: Record<string, Address>): Promise<void> {
  const entries = registry.entries as unknown as { name: string }[]
  for (const [name, a] of Object.entries(stack)) {
    const i = registry.undeployed.indexOf(name)
    if (i >= 0) registry.undeployed.splice(i, 1)
    entries.push({ name, kind: 'smart-sessions-policy', role: 'migrate-v4-real-size pin', address: a, codeHash: await readCodeHash(lab.client, a) } as never)
  }
}

const safeAbi = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function approveHash(bytes32 hashToApprove)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)',
  'event ExecutionSuccess(bytes32 txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 txHash, uint256 payment)',
])
const storageAccessibleAbi = parseAbi(['function simulateAndRevert(address targetContract, bytes calldataPayload)'])

type Migration = { label: string; safeTx: ReturnType<typeof buildMigrateV4>['safeTx']; safeTxHash: Hex; calls: ReturnType<typeof buildMigrateV4>['calls']; permissionId: Hex; before: Hex[]; input: MigrateV4Input }

/** The operator's pre-sign estimate (operator.ts ownerTxGasLimit): simulateAndRevert in the Safe's context, 9/8 + PASSKEY_VERIFY_GAS. */
async function estimateLikeOperator(lab: Lab, safe: Address, calls: Migration['calls'], block: bigint, relayer: Address): Promise<{ sim: bigint; limit: bigint } | null> {
  const ms = multiSendCallOnly(calls.map((c) => ({ to: c.to, value: c.value ?? 0n, data: c.data })), lab.registry)
  const data = encodeFunctionData({ abi: storageAccessibleAbi, functionName: 'simulateAndRevert', args: [ms.to, ms.data] })
  const [res] = await simulateCalls(lab.client, [{ from: relayer, to: safe, data }], block)
  if (!res || res.returnData.length < 2 + 64 * 2 || BigInt(res.returnData.slice(0, 66)) !== 1n) return null
  return { sim: res.gasUsed, limit: (res.gasUsed * 9n) / 8n + PASSKEY_VERIFY_GAS }
}

/** Owner approval of the hash and the execTransaction from the relayer: ONE Safe transaction. Returns the receipt. */
async function runAsOwner(lab: Lab, safe: Address, m: Migration, relayerKey: Hex) {
  const owners = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' })
  const threshold = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' })
  if (owners.length !== 1 || threshold !== 1n) throw new Error(`the owner faking assumes one owner with threshold 1 (got ${owners.length} owners, threshold ${threshold})`)
  const owner = owners[0]!
  const nonceBefore = await lab.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  if (nonceBefore.toString() !== m.safeTx.nonce) throw new Error(`Safe nonce moved: ${nonceBefore} vs ${m.safeTx.nonce}`)
  // The owner's approval is not a Safe transaction: it is a call of the owner to approveHash (the owner here is the shared
  // signer contract, impersonated). The migration itself is one execTransaction.
  await lab.setBalance(owner, 10n ** 19n)
  const ap = await lab.sendAs(owner, safe, encodeFunctionData({ abi: safeAbi, functionName: 'approveHash', args: [m.safeTxHash] }))
  if (!ap.ok) throw new Error('approveHash from the impersonated owner failed')
  const signatures = concat([pad(owner, { size: 32 }), pad('0x00', { size: 32 }), '0x01'])
  const data = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [m.safeTx.to, 0n, m.safeTx.data, m.safeTx.operation, 0n, 0n, 0n, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', signatures] })
  const relayer = privateKeyToAccount(relayerKey)
  const r = await lab.send(relayer, safe, data, 0n, 40_000_000n)
  return { r, nonceBefore }
}

const stops: (() => void | Promise<void>)[] = []
let exitCode = 1
try {
  const B = await startFork('BASE_FORK_RPC_URL', 8453, 'base', baseRegistry)
  stops.push(async () => {
    B.anvil.kill()
    await B.anvil.exited
    B.proxy.stop()
  })
  const base = B.lab
  const head = await base.client.getBlockNumber()
  log(`Base fork at ${head}`)

  // --- the V4 stack, as T7 deploys it ---------------------------------------------------------------------------------------
  const deployer = privateKeyToAccount(generatePrivateKey()).address
  const admin = privateKeyToAccount(generatePrivateKey()).address
  const guardian = privateKeyToAccount(generatePrivateKey()).address
  for (const a of [deployer, admin, guardian]) await base.setBalance(a, 10n ** 21n)
  const stack = await deployStack(base, deployer, admin, guardian)
  await pin(base, baseRegistry, stack)
  const d = oneAuthV4Deployment(baseRegistry)!
  check(!!d && d.policy === stack.MamoruActionPolicyV4, 'the V4 stack is deployed on the fork and pinned in the Base registry (in memory)', d?.policy)
  const relayerKey = generatePrivateKey()
  const relayer = privateKeyToAccount(relayerKey).address
  await base.setBalance(relayer, 10n ** 19n)

  // --- the real inventory, by the operator's path (planMigration -> inventoryNow) ---------------------------------------------
  const safe = BRAIS_BASE
  check(((await base.client.getCode({ address: safe, blockNumber: BRAIS_BASE_DEPLOY_BLOCK })) ?? '0x') !== '0x' && ((await base.client.getCode({ address: safe, blockNumber: BRAIS_BASE_DEPLOY_BLOCK - 1n })) ?? '0x') === '0x', 'the Safe deploy block is the first with code', String(BRAIS_BASE_DEPLOY_BLOCK))
  const first = BRAIS_BASE_DEPLOY_BLOCK - 50n // inventoryFirst's margin on Base
  const page = BigInt(process.env.MIGRATE_LOG_PAGE ?? '50000')
  const events = await sessionCreatedIds(base.client, baseRegistry, safe, first, head, page, (to, ids) => log(`SessionCreated scan to ${to}: ${ids.length} ids`))
  const now = await readSessionState(base.client, baseRegistry, safe, [], head)
  const inv = inventoryOf({ events, enabled: now.enabled, stored: events }) // stored: the operator's D1 records are not readable here; every event id stands for one
  console.log(`ENABLED permission ids on ${safe}: ${now.enabled.length}`)
  for (const id of now.enabled) console.log(`  ${id}`)
  console.log(`SessionCreated ids read: ${events.length}; to revoke: ${inv.ok ? inv.revoke.length : 'n/a'}`)
  check(inv.ok, 'the inventory reads back clean (every enabled id has a SessionCreated event)', inv.ok ? `${inv.remove.length} to remove, ${inv.revoke.length} to revoke` : inv.detail)
  if (!inv.ok) throw new Error(`inventory: ${inv.detail}`)

  // --- the input, as planMigration builds it ---------------------------------------------------------------------------------
  const r = await readSafe(base.client, safe, baseRegistry)
  const sized = r.positions
    .filter((p) => positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, baseRegistry) >= POSITION_DUST_USDC)
    .map((p) => ({ p, v: positionUsdc(p, r.prices[p.pool]!.sqrtPriceX96, baseRegistry) }))
    .sort((a, b) => (a.v === b.v ? 0 : a.v > b.v ? -1 : 1))
    .slice(0, MAX_SIZING_POSITIONS)
    .map((x) => x.p)
  const admit = sized.map((p) => p.tokenId).slice(0, V4_MAX_ADMIT)
  console.log(`positions in registry pools: ${r.positions.length} (NFTs held ${r.positionCount ?? '?'}); admitted above dust: ${admit.length}`)
  const { nonces } = await readSessionState(base.client, baseRegistry, safe, inv.revoke, r.block)
  const safeNonce = await base.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  const sessionKey = privateKeyToAccount(generatePrivateKey()).address // the account's session key is the operator's secret; any address gives the same size
  const input: MigrateV4Input = { chainId: 8453, safe, safeNonce: safeNonce.toString(), step: 0, capUsdc: v4CapUsdOf(CAP_USDC).toString(), sessionKey, generation: '1', admit: admit.map(String), oldPermissionIds: inv.revoke, removeIds: inv.remove, noncesBefore: nonces.map(String), home: '0x0000000000000000000000000000000000000000', homeDomain: 0 }
  const tx = buildMigrateV4(input, baseRegistry)
  const m: Migration = { label: 'Base home', ...tx, before: now.enabled, input }
  console.log(`Safe tx: ${m.calls.length} multisend calls, data ${(m.safeTx.data.length - 2) / 2} bytes, operation ${m.safeTx.operation}, safeTxHash ${m.safeTxHash}`)

  // --- estimate (operator's pre-sign figure) vs actual -----------------------------------------------------------------------
  let est: Awaited<ReturnType<typeof estimateLikeOperator>> = null
  try {
    est = await estimateLikeOperator(base, safe, m.calls, await base.client.getBlockNumber(), relayer)
  } catch (e) {
    log(`estimate unavailable: ${(e as Error).message.split('\n')[0]}`)
  }

  const { r: res, nonceBefore } = await runAsOwner(base, safe, m, relayerKey)
  const rc = res.receipt
  const logs = parseEventLogs({ abi: safeAbi, strict: false, logs: rc.logs.filter((l) => l.address.toLowerCase() === safe.toLowerCase()) })
  const okEv = logs.filter((l) => l.eventName === 'ExecutionSuccess').length
  const failEv = logs.filter((l) => l.eventName === 'ExecutionFailure').length
  const nonceAfter = await base.client.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' })
  const adjusted = rc.gasUsed + PASSKEY_VERIFY_GAS
  console.log(`gasUsed actual (approved-hash signature): ${rc.gasUsed}`)
  console.log(`operator estimate: ${est ? `simulateAndRevert ${est.sim} -> ${est.limit} (x9/8 + ${PASSKEY_VERIFY_GAS})` : 'unavailable on this fork'}`)
  console.log(`actual + PASSKEY_VERIFY_GAS = ${adjusted}; V4_TX_GAS_TARGET ${V4_TX_GAS_TARGET}; 14.5M = 14500000; headroom ${V4_TX_GAS_TARGET - adjusted}`)
  if (est) console.log(`estimate / (actual + passkey) = ${(Number(est.limit) / Number(adjusted)).toFixed(3)}`)

  // --- checks ----------------------------------------------------------------------------------------------------------------
  check(res.ok && okEv === 1 && failEv === 0 && nonceAfter === nonceBefore + 1n, 'exactly one Safe transaction: one execTransaction, one ExecutionSuccess, Safe nonce +1', `${res.hash} nonce ${nonceBefore} -> ${nonceAfter}, ok=${res.ok} success=${okEv} failure=${failEv}`)
  const after = await base.client.readContract({ address: address('SmartSession', baseRegistry), abi: smartSessionV4Abi, functionName: 'getPermissionIDs', args: [safe] })
  check(after.length === 1 && after[0]!.toLowerCase() === m.permissionId.toLowerCase(), 'only the V4 session is enabled afterwards (getPermissionIDs length 1)', `${m.before.length} -> ${after.length}`)
  let moved = 0
  for (let i = 0; i < inv.revoke.length; i++) {
    const n = await base.client.readContract({ address: address('SmartSession', baseRegistry), abi: smartSessionV4Abi, functionName: 'getNonce', args: [inv.revoke[i]!, safe] })
    if (n !== nonces[i]! && n > nonces[i]!) moved++
  }
  check(moved === inv.revoke.length, "every old id's ENABLE nonce moved", `${moved}/${inv.revoke.length}`)
  check(adjusted < V4_TX_GAS_TARGET, `actual + PASSKEY_VERIFY_GAS < V4_TX_GAS_TARGET (${V4_TX_GAS_TARGET})`, `${adjusted}`)
  check(adjusted < 14_500_000n, 'actual + PASSKEY_VERIFY_GAS < 14_500_000', `${adjusted}`)

  // --- optional: the remote Safe on Monad -------------------------------------------------------------------------------------
  if (process.env.E2E_MONAD === '1') {
    log(`Monad part requested for ${BRAIS_MONAD} (domain ${V4_DOMAIN_BY_CHAIN[143]}): not implemented. Measured 2026-11-02: that Safe has nonce 0 and ONE enabled session, and the public Monad RPC caps eth_getLogs at 100 blocks (about 2,000 pages a day at 0.4 s blocks), so a real inventory scan costs more than the migration it measures; buildMigrateV4 step 1 itself exists (operator planRemoteMigration).`)
    void monadRegistry
  } else {
    console.log(`Monad part: skipped (set E2E_MONAD=1; remote ${BRAIS_MONAD})`)
  }

  exitCode = fails.length ? 1 : 0
  console.log(`\nMIGRATE-V4 REAL SIZE ${fails.length ? `FAIL: ${fails.join('; ')}` : 'PASS'}. Logs ${dir}`)
} catch (e) {
  console.error(e instanceof Error ? (e.stack ?? e.message) : e)
  console.error(`logs ${dir}`)
} finally {
  for (const s of stops) await Promise.resolve(s()).catch(() => {})
}
process.exit(exitCode)
