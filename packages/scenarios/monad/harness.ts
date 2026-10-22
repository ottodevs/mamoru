// otto/mamoru#65 (and #62 inside the fork): the Monad lab. An anvil fork of Monad mainnet at a pinned block, checked
// by hash, and the steps of MONAD-01: the two missing session policies deployed the way Base deployed them, an
// account activated with the session policies, a WMON/USDC position entered, harvested and exited by the session key.
// Nothing here talks to a real network except the read-only fork upstream (public Monad RPC through a loopback proxy).
import { concat, decodeErrorResult, encodeFunctionData, getContractAddress, keccak256, parseAbi, parseEventLogs, slice, type Hex } from 'viem'
import type { PrivateKeyAccount } from 'viem/accounts'
import { toPackedUserOperation, type UserOperation } from 'viem/account-abstraction'
import type { Address } from '@mamoru/domain'
import {
  address,
  assertCodeHashes,
  baseRegistry,
  entry,
  entryPointV07Abi,
  erc20Abi,
  moduleRegistryAbi,
  monadRegistry,
  nameOf,
  nonfungiblePositionManagerAbi,
  readCodeHash,
  safeAbi,
  safeProxyFactoryAbi,
  smartSessionErrorsAbi,
  smartSessionValidateAbi,
  swapRouter02Abi,
  uniswapV3PoolAbi,
  type Registry,
  type RegistryEntry,
} from '@mamoru/registry'
import { computeCaps, instantiateGrant, labWmonUsdcMonadV1, type Caps, type GrantName, type PolicyVersion, type SessionGrant } from '@mamoru/policy'
import { OPERATION_CALL, createProxyCall, execTransactionData, multiSendCallOnly, webAuthnSigner, type MultiSendCall, type SafeTx } from '@mamoru/account/safe'
import { accountSetup } from '@mamoru/account/recovery'
import { SMART_SESSION_MODE_USE, activationCall, draftUserOp, handleOpsData, registryTrustCalls, sessionKeySignature, sessionNonceKey, userOpHash } from '@mamoru/account/sessions'
import { uniswapV3 } from '@mamoru/uniswap-v3'
import { Lab, decodeEntryPointError, devAccount, type TxResult } from '../fixtures/lab.ts'
import { accountCallData, type CallLike } from '../fixtures/session-op.ts'
import { anvilBinary, anvilBinaryVersion, assertAnvilVersion, assertNoKeyInArgv, postStartChecks, sanitizedEnv, startAnvil, type AnvilHandle, type AnvilPin } from '../fork/anvil.ts'
import { startForkProxy, type ForkProxy } from '../proxy/index.ts'
import { PASSKEY_SCALARS, SoftwarePasskey, signSafeTxWithPasskey } from '../webauthn/index.ts'
import { loadManifest, repoPath } from '../runner/manifest.ts'
import basePolicies from './base-policies.json' with { type: 'json' }

export const MONAD_MANIFEST = 'scenarios/monad/manifest.json'
/** State MONAD-01 reads at the pinned block, captured by a forked run: the replay needs no upstream. */
export const PINNED_PRESTATE = 'scenarios/monad/MONAD-01.prestate.json.gz'
/** Env var holding the upstream Monad RPC. Unset: the public one, which needs no key. */
export const MONAD_RPC_ENV = 'MONAD_RPC_URL'
const PUBLIC_MONAD_RPC = 'https://rpc.monad.xyz'

export type MonadManifest = {
  id: string
  source: { chain: 'monad'; chainId: 143 }
  fork: { block: number; blockHash: Hex; timestamp: number; chainId: number; pinnedAt: string }
  /** The pool the scenario enters, a USDC pool of monad.json. */
  pool: string
  /** Lab policy (packages/policy policies-monad.ts). */
  policy: string
  /** What the fork does not emulate of Monad mainnet: a pass here says nothing about these. */
  gaps: { id: string; what: string; consequence: string }[]
}

export async function loadMonadManifest(): Promise<MonadManifest> {
  return (await Bun.file(repoPath(MONAD_MANIFEST)).json()) as MonadManifest
}

/** The anvil pin is the catalog's (scenarios/manifest.json): one binary for every lab. */
export async function anvilPin(): Promise<AnvilPin> {
  return (await loadManifest()).anvil
}

/** Host of the upstream, never the URL: a keyed URL would carry its key into a log. */
export function upstreamHost(): string {
  const u = process.env[MONAD_RPC_ENV] ?? PUBLIC_MONAD_RPC
  try {
    return new URL(u).hostname
  } catch {
    return 'unparseable'
  }
}

function ensureUpstream(): void {
  if (!process.env[MONAD_RPC_ENV]) process.env[MONAD_RPC_ENV] = PUBLIC_MONAD_RPC
}

export type MonadFork = { lab: Lab; anvil: AnvilHandle; proxy: ForkProxy | null; stop: () => Promise<void> }

/**
 * LAB-01/LAB-02 for Monad: pinned anvil, loopback proxy to the Monad RPC, a lab chain id (never 143 or 10143), then
 * chain id, block hash of the pinned block, served anvil version and eth_simulateV1 checked before any step.
 */
export async function startMonadFork(m: MonadManifest, logPath: string): Promise<MonadFork> {
  const pin = await anvilPin()
  assertAnvilVersion(pin, await anvilBinaryVersion())
  ensureUpstream()
  const proxy = startForkProxy(MONAD_RPC_ENV)
  let anvil: AnvilHandle
  try {
    anvil = await startAnvil({ forkUrl: proxy.url, forkBlock: m.fork.block, chainId: m.fork.chainId, slotsInAnEpoch: pin.slotsInAnEpoch, logPath })
  } catch (e) {
    proxy.stop()
    throw e
  }
  const stop = async () => {
    await anvil.stop()
    proxy.stop()
  }
  try {
    await postStartChecks(anvil.client, { chainId: m.fork.chainId, block: m.fork.block, blockHash: m.fork.blockHash, anvil: pin })
  } catch (e) {
    await stop()
    throw e
  }
  return { lab: new Lab(anvil.url, m.fork.chainId, monadRegistry), anvil, proxy, stop }
}

/**
 * The state MONAD-01 reads at the fork block: every account field and storage slot its transactions read before any
 * of them wrote it (prestateTracer per transaction, in block order; its diffMode marks what each one wrote, and a
 * value read after one of our own writes is not the fork's), plus the code of every registry entry (LAB-05 reads it
 * outside any transaction). Written as JSON: a replay loads it into a plain anvil and needs no upstream.
 */
export type Prestate = { chainId: number; block: number; blockHash: Hex; timestamp: number; accounts: Record<string, { balance?: Hex; nonce?: number; code?: Hex; storage?: Record<string, Hex> }> }

type TraceAccount = { balance?: Hex; nonce?: number; code?: Hex; storage?: Record<string, Hex> }

export async function capturePrestate(lab: Lab, m: MonadManifest): Promise<Prestate> {
  const accounts: Prestate['accounts'] = {}
  const dirty = new Set<string>()
  const head = await lab.client.getBlockNumber()
  for (let n = BigInt(m.fork.block) + 1n; n <= head; n++) {
    const block = await lab.client.getBlock({ blockNumber: n })
    for (const hash of block.transactions) {
      const pre = await lab.rpc<Record<string, TraceAccount>>('debug_traceTransaction', [hash, { tracer: 'prestateTracer' }])
      for (const [addr, a] of Object.entries(pre)) {
        const k = addr.toLowerCase()
        const have = (accounts[k] ??= {})
        for (const f of ['balance', 'nonce', 'code'] as const) {
          if (a[f] !== undefined && have[f] === undefined && !dirty.has(`${k}:${f}`)) (have as Record<string, unknown>)[f] = a[f]
          // Read with nothing there: the fork had none; a later read after our own write must not fill it in.
          if (a[f] === undefined) dirty.add(`${k}:${f}`)
        }
        for (const [slot, v] of Object.entries(a.storage ?? {})) {
          if (dirty.has(`${k}:${slot}`) || have.storage?.[slot] !== undefined) continue
          ;(have.storage ??= {})[slot] = v
        }
      }
      const diff = await lab.rpc<{ post: Record<string, TraceAccount> }>('debug_traceTransaction', [hash, { tracer: 'prestateTracer', tracerConfig: { diffMode: true } }])
      for (const [addr, a] of Object.entries(diff.post)) {
        const k = addr.toLowerCase()
        for (const f of ['balance', 'nonce', 'code'] as const) if (a[f] !== undefined) dirty.add(`${k}:${f}`)
        for (const slot of Object.keys(a.storage ?? {})) dirty.add(`${k}:${slot}`)
      }
    }
  }
  const at = BigInt(m.fork.block)
  // Reads outside any transaction, at the fork block itself: a token's balanceOf (through a proxy's implementation)
  // and a pool's slot0, as the operator's readSafe makes them for every USDC pool of the registry.
  const reads = monadRegistry.entries.flatMap((e) =>
    e.kind === 'token' ? [{ to: e.address, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [e.address] }) }] : e.kind === 'pool' ? [{ to: e.address, data: encodeFunctionData({ abi: uniswapV3PoolAbi, functionName: 'slot0' }) }] : [],
  )
  for (const r of reads) {
    const pre = await lab.rpc<Record<string, TraceAccount>>('debug_traceCall', [r, `0x${at.toString(16)}`, { tracer: 'prestateTracer' }])
    for (const [addr, a] of Object.entries(pre)) {
      const k = addr.toLowerCase()
      const have = (accounts[k] ??= {})
      if (have.code === undefined && a.code !== undefined && !dirty.has(`${k}:code`)) have.code = a.code
      for (const [slot, v] of Object.entries(a.storage ?? {})) if (!dirty.has(`${k}:${slot}`) && have.storage?.[slot] === undefined) (have.storage ??= {})[slot] = v
    }
  }
  for (const e of monadRegistry.entries) {
    const k = e.address.toLowerCase()
    if (accounts[k]?.code !== undefined) continue
    const code = await lab.client.getCode({ address: e.address, blockNumber: at })
    if (code && code !== '0x') (accounts[k] ??= {}).code = code
  }
  return { chainId: m.fork.chainId, block: m.fork.block, blockHash: m.fork.blockHash, timestamp: m.fork.timestamp, accounts }
}

/**
 * Replay without any upstream: a plain anvil (no --fork-url) with the fork block's timestamp, loaded with a captured
 * prestate (`capturePrestate`). The scenario then runs the same transactions on the same state, offline.
 */
export async function startFromState(m: MonadManifest, statePath: string, logPath: string): Promise<MonadFork> {
  const pin = await anvilPin()
  assertAnvilVersion(pin, await anvilBinaryVersion())
  const raw = Buffer.from(await Bun.file(statePath).arrayBuffer())
  const state = JSON.parse(Buffer.from(statePath.endsWith('.gz') ? Bun.gunzipSync(raw) : raw).toString('utf8')) as Prestate
  if (state.chainId !== m.fork.chainId || state.block !== m.fork.block || state.blockHash !== m.fork.blockHash) {
    throw new Error(`state is of block ${state.block} ${state.blockHash}, the manifest pins ${m.fork.block} ${m.fork.blockHash}`)
  }
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = probe.port as number
  probe.stop(true)
  const argv = ['--chain-id', String(m.fork.chainId), '--timestamp', String(state.timestamp), '--host', '127.0.0.1', '--port', String(port), '--slots-in-an-epoch', String(pin.slotsInAnEpoch), '--no-request-size-limit']
  assertNoKeyInArgv(argv)
  const log = Bun.file(logPath)
  const proc = Bun.spawn([anvilBinary(), ...argv], { stdout: log, stderr: log, env: sanitizedEnv() })
  const url = `http://127.0.0.1:${port}/`
  const lab = new Lab(url, m.fork.chainId, monadRegistry)
  const stop = async () => {
    proc.kill()
    await proc.exited
  }
  try {
    for (let i = 0; ; i++) {
      try {
        await lab.client.getChainId()
        break
      } catch {
        if (proc.exitCode !== null || i > 600) throw new Error('anvil (replay) did not start')
        await Bun.sleep(100)
      }
    }
    for (const [addr, a] of Object.entries(state.accounts)) {
      if (a.code !== undefined) await lab.rpc('anvil_setCode', [addr, a.code])
      if (a.balance !== undefined) await lab.rpc('anvil_setBalance', [addr, a.balance])
      if (a.nonce !== undefined) await lab.rpc('anvil_setNonce', [addr, `0x${a.nonce.toString(16)}`])
      for (const [slot, v] of Object.entries(a.storage ?? {})) await lab.rpc('anvil_setStorageAt', [addr, slot, v])
    }
  } catch (e) {
    await stop()
    throw e
  }
  const anvil: AnvilHandle = { url, port, pid: proc.pid, argv, client: lab.client, stop }
  return { lab, anvil, proxy: null, stop }
}

// ---- #62: the two session policies, deployed as on Base ------------------------------------------------------

export const SESSION_USEROP_POLICIES = ['TimeFramePolicy', 'UsageLimitPolicy'] as const

export type PolicyDeploy = { name: string; address: Address; codeHash: Hex; baseTx: Hex; deployTx: Hex | null; registerTx: Hex | null; runtimeBytes: number }

/**
 * Replays the Base creation calldata of TimeFramePolicy and UsageLimitPolicy against the Arachnid CREATE2 deployer on
 * the fork. Before sending: the CREATE2 address of that calldata is the Base registry's address. After: the runtime
 * code hash is the Base registry's code hash, byte for byte the Base bytecode. Then the ModuleRecord: the Arachnid
 * deploy writes none and ModuleRegistry refuses to attest a module without one (ModuleNotFoundInRegistry, found on
 * this fork), so each policy is registered under the resolverUID Base has for it. Already deployed or registered (a
 * fork past the mainnet deploy): only checked.
 */
export async function deployBasePolicies(lab: Lab, from: PrivateKeyAccount): Promise<PolicyDeploy[]> {
  const deployer = basePolicies.deployer as Address
  if (!(await readCodeHash(lab.client, deployer))) throw new Error('the Arachnid CREATE2 deployer has no code on this fork')
  const out: PolicyDeploy[] = []
  for (const c of basePolicies.contracts) {
    const base = entry(c.name, baseRegistry)
    const input = c.input as Hex
    const salt = slice(input, 0, 32)
    const initCode = slice(input, 32)
    const predicted = getContractAddress({ opcode: 'CREATE2', from: deployer, salt, bytecode: initCode })
    if (predicted.toLowerCase() !== base.address.toLowerCase()) throw new Error(`${c.name}: Base calldata creates ${predicted}, Base registry says ${base.address}`)
    let deployTx: Hex | null = null
    if (!(await readCodeHash(lab.client, base.address))) {
      const r = await lab.send(from, deployer, input, 0n, 3_000_000n)
      if (!r.ok) throw new Error(`${c.name}: CREATE2 deploy reverted (${r.hash})`)
      deployTx = r.hash
    }
    const code = (await lab.client.getCode({ address: base.address })) ?? '0x'
    const codeHash = keccak256(code)
    if (codeHash !== base.codeHash) throw new Error(`${c.name}: runtime code hash ${codeHash} is not Base's ${base.codeHash}`)
    const moduleRegistry = address('ModuleRegistry', lab.registry)
    const resolverUID = basePolicies.moduleRecord.resolverUID as Hex
    let registerTx: Hex | null = null
    const record = await lab.client.readContract({ address: moduleRegistry, abi: moduleRegistryAbi, functionName: 'findModule', args: [base.address] })
    if (BigInt(record.resolverUID) === 0n) {
      const r = await lab.send(from, moduleRegistry, encodeFunctionData({ abi: moduleRegistryAbi, functionName: 'registerModule', args: [resolverUID, base.address, '0x', '0x'] }))
      if (!r.ok) throw new Error(`${c.name}: ModuleRegistry.registerModule reverted (${r.hash})`)
      registerTx = r.hash
    }
    const after = await lab.client.readContract({ address: moduleRegistry, abi: moduleRegistryAbi, functionName: 'findModule', args: [base.address] })
    if (after.resolverUID !== resolverUID) throw new Error(`${c.name}: ModuleRecord resolver ${after.resolverUID} is not Base's ${resolverUID}`)
    out.push({ name: c.name, address: base.address, codeHash, baseTx: c.baseTx as Hex, deployTx, registerTx, runtimeBytes: (code.length - 2) / 2 })
  }
  return out
}

/**
 * The registry of the fork once the policies are deployed: monad.json plus the two entries, each pinned to the code
 * hash just read on the fork (equal to Base's). Lab only: monad.json gets them when they exist on Monad mainnet.
 */
export function forkRegistryWith(deployed: PolicyDeploy[], block: bigint): Registry {
  const extra: RegistryEntry[] = deployed.map((d) => ({ ...entry(d.name, baseRegistry), address: d.address, codeHash: d.codeHash }))
  return { ...monadRegistry, block: Number(block), entries: [...monadRegistry.entries.filter((e) => !extra.some((x) => x.name === e.name)), ...extra] }
}

/**
 * Names the account and session encoders of @mamoru/account resolve. Those encoders still read them from the Base
 * registry: the lab proves each one has the same address on the fork registry, so the calldata they build is
 * Monad's. A name that differs stops the run (fail closed), it is never papered over.
 */
export const ACCOUNT_STACK = [
  'EntryPointV07',
  'SafeL2_141',
  'SafeProxyFactory_141',
  'Safe7579',
  'Safe7579Launchpad',
  'ModuleRegistry',
  'RhinestoneAttester',
  'SmartSession',
  'OwnableValidator',
  'UniActionPolicy',
  'TimeFramePolicy',
  'UsageLimitPolicy',
  'SafeWebAuthnSharedSigner',
  'P256Verifier',
  'MultiSend_141',
  'MultiSendCallOnly_141',
  'Multicall3',
] as const

export function assertAccountStackParity(registry: Registry): void {
  const bad = ACCOUNT_STACK.filter((n) => address(n, registry).toLowerCase() !== address(n, baseRegistry).toLowerCase())
  if (bad.length) throw new Error(`account stack differs from Base on ${registry.chain}: ${bad.join(', ')}`)
}

// ---- the account --------------------------------------------------------------------------------------------

const wmonAbi = parseAbi(['function deposit() payable'])

export type MonadAccount = {
  safe: Address
  owners: Address[]
  saltNonce: bigint
  passkey: SoftwarePasskey
  sessionKey: PrivateKeyAccount
  caps: Caps
  grants: { name: string; grant: SessionGrant; permissionId: Hex }[]
  tokenIds: bigint[]
}

export type MonadWorld = { lab: Lab; registry: Registry; policy: PolicyVersion; relayer: PrivateKeyAccount; trader: PrivateKeyAccount; acct: MonadAccount; pool: string; log: (m: string) => void }

/** A Safe exactly as the app builds one (passkey owner through SafeWebAuthnSharedSigner, SmartSession installed). */
export async function deployAccount(lab: Lab, relayer: PrivateKeyAccount, saltNonce: bigint): Promise<MonadAccount> {
  const passkey = new SoftwarePasskey(PASSKEY_SCALARS.a1)
  const owners = [address('SafeWebAuthnSharedSigner', lab.registry)]
  const setup = accountSetup(owners, saltNonce, webAuthnSigner(passkey.x, passkey.y))
  const call = createProxyCall(setup)
  const r = await lab.send(relayer, call.to, call.data)
  if (!r.ok) throw new Error(`Safe deploy reverted (${r.hash})`)
  const safe = parseEventLogs({ abi: safeProxyFactoryAbi, logs: r.receipt.logs, eventName: 'ProxyCreation' })[0]!.args.proxy
  return { safe, owners, saltNonce, passkey, sessionKey: devAccount(5), caps: {}, grants: [], tokenIds: [] }
}

/** One owner transaction, signed with the passkey for the fork chain id and relayed by `relayer`. */
export async function ownerBatch(lab: Lab, relayer: PrivateKeyAccount, acct: MonadAccount, calls: MultiSendCall[]): Promise<TxResult> {
  const b = calls.length === 1 ? { to: calls[0]!.to, data: calls[0]!.data, operation: OPERATION_CALL as 0 | 1 } : multiSendCallOnly(calls)
  const nonce = await lab.client.readContract({ address: acct.safe, abi: safeAbi, functionName: 'nonce' })
  const tx: SafeTx = { to: b.to, value: 0n, data: b.data, operation: b.operation, nonce }
  const signature = signSafeTxWithPasskey(acct.passkey, acct.safe, lab.chainId, tx)
  return lab.send(relayer, acct.safe, execTransactionData(tx, signature))
}

/**
 * USDC bought on the pool itself by a dev account: MON wrapped to WMON, swapped to USDC. The MON spent is sized from
 * the pool price with 25% headroom for fee and impact.
 */
export async function buyUsdc(w: Pick<MonadWorld, 'lab' | 'registry' | 'pool'>, buyer: PrivateKeyAccount, usdcAtLeast: bigint): Promise<bigint> {
  const { lab, registry } = w
  const v3 = uniswapV3(registry)
  const e = entry(w.pool, registry)
  const { sqrtPriceX96 } = await poolSlot0(lab, w.pool)
  const Q192 = 1n << 192n
  const perUsdc = e.token0 === 'USDC' ? { num: sqrtPriceX96 * sqrtPriceX96, den: Q192 } : { num: Q192, den: sqrtPriceX96 * sqrtPriceX96 }
  const monIn = (usdcAtLeast * perUsdc.num * 125n) / (perUsdc.den * 100n)
  await lab.setBalance(buyer.address, monIn + 10n ** 21n)
  must(await lab.send(buyer, address('WMON', registry), encodeFunctionData({ abi: wmonAbi, functionName: 'deposit' }), monIn), 'wrap MON')
  must(await lab.send(buyer, address('WMON', registry), v3.approve('WMON', 'SwapRouter02', monIn).data), 'approve WMON')
  const fee = entry(w.pool, registry).fee!
  const swap = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('WMON', registry), tokenOut: address('USDC', registry), fee, recipient: buyer.address, amountIn: monIn, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] })
  must(await lab.send(buyer, address('SwapRouter02', registry), swap), 'buy USDC')
  const got = await lab.balanceOf('USDC', buyer.address)
  if (got < usdcAtLeast) throw new Error(`bought ${got} USDC units, wanted ${usdcAtLeast}`)
  return got
}

/** Round trips through the pool by a trader that is not the account: fees accrue to in-range liquidity. */
export async function churn(w: MonadWorld, rounds: number, usdcEach: bigint): Promise<void> {
  const { lab, registry, trader } = w
  const fee = entry(w.pool, registry).fee!
  const router = address('SwapRouter02', registry)
  await buyUsdc(w, trader, usdcEach)
  must(await lab.send(trader, address('USDC', registry), uniswapV3(registry).approve('USDC', 'SwapRouter02', 2n ** 255n).data), 'trader approve USDC')
  must(await lab.send(trader, address('WMON', registry), uniswapV3(registry).approve('WMON', 'SwapRouter02', 2n ** 255n).data), 'trader approve WMON')
  for (let i = 0; i < rounds; i++) {
    const usdc = await lab.balanceOf('USDC', trader.address)
    const amount = usdc < usdcEach ? usdc : usdcEach
    const sell = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('USDC', registry), tokenOut: address('WMON', registry), fee, recipient: trader.address, amountIn: amount, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] })
    must(await lab.send(trader, router, sell), `churn sell ${i}`)
    const wmon = await lab.balanceOf('WMON', trader.address)
    const buy = encodeFunctionData({ abi: swapRouter02Abi, functionName: 'exactInputSingle', args: [{ tokenIn: address('WMON', registry), tokenOut: address('USDC', registry), fee, recipient: trader.address, amountIn: wmon, amountOutMinimum: 1n, sqrtPriceLimitX96: 0n }] })
    must(await lab.send(trader, router, buy), `churn buy ${i}`)
  }
}

export async function poolSlot0(lab: Lab, pool: string): Promise<{ sqrtPriceX96: bigint; tick: number }> {
  const s = await lab.client.readContract({ address: address(pool, lab.registry), abi: uniswapV3PoolAbi, functionName: 'slot0' })
  return { sqrtPriceX96: s[0], tick: s[1] }
}

/** Session caps at the pool price, from the USDC deposit, as the operator sizes them at activation. */
export async function capsAt(w: MonadWorld, depositUsdc: bigint): Promise<Caps> {
  const { sqrtPriceX96 } = await poolSlot0(w.lab, w.pool)
  const e = entry(w.pool, w.registry)
  const other = e.token0 === 'USDC' ? e.token1! : e.token0!
  const Q192 = 1n << 192n
  const price = e.token0 === 'USDC' ? { num: sqrtPriceX96 * sqrtPriceX96, den: Q192 } : { num: Q192, den: sqrtPriceX96 * sqrtPriceX96 }
  return computeCaps(w.policy, depositUsdc, { [other]: price })
}

let saltCounter = 0

/** Grants of the lab policy for this account, enabled by one passkey-signed owner transaction (with the trust calls the first time). */
export async function activate(w: MonadWorld, specs: { name: GrantName; tokenId?: bigint }[], opts: { trust: boolean }): Promise<void> {
  const { lab, acct } = w
  const now = Number(await lab.timestamp())
  const grants = specs.map((s) =>
    instantiateGrant(w.policy, s.name, {
      account: acct.safe,
      sessionKey: acct.sessionKey.address,
      chainId: lab.chainId,
      salt: `0x${(++saltCounter).toString(16).padStart(64, '0')}`,
      validAfter: now - 60,
      validUntil: now + w.policy.session.validitySeconds,
      caps: acct.caps,
      tokenId: s.tokenId,
      admittedTokenIds: acct.tokenIds,
    }),
  )
  const act = activationCall(grants, [])
  const calls: MultiSendCall[] = [...(opts.trust ? registryTrustCalls(acct.safe) : []), { to: act.to, value: 0n, data: act.data }]
  must(await ownerBatch(lab, w.relayer, acct, calls), `activation of ${specs.map((s) => s.name).join(', ')}`)
  grants.forEach((g, i) => acct.grants.push({ name: g.tokenId === undefined ? g.name : `${g.name}:${g.tokenId}`, grant: g, permissionId: act.permissionIds[i]! }))
}

export function grantOf(acct: MonadAccount, name: string) {
  const g = [...acct.grants].reverse().find((x) => x.name === name)
  if (!g) throw new Error(`no grant ${name}`)
  return g
}

export type OpOutcome = { included: boolean; success: boolean; reason?: string; validator?: string; txHash?: Hex; gasUsed?: bigint; actualGasCost?: bigint }

/**
 * A userOp signed by the session key under one grant, sent to EntryPoint.handleOps by the relayer. The chain's
 * verdict is the result: included and executed, or rejected (with the EntryPoint reason and SmartSession's own).
 */
export async function sessionOp(w: MonadWorld, grantName: string, calls: CallLike[]): Promise<OpOutcome> {
  const { lab, acct, registry } = w
  const g = grantOf(acct, grantName)
  const callData = accountCallData(calls)
  const nonce = await lab.entryPointNonce(acct.safe, sessionNonceKey(0, address('SmartSession', registry)))
  const block = await lab.client.getBlock()
  // Gas limits sized for the lab, not tight: Monad charges the limit (gap G1), the fork charges what is used.
  let op = draftUserOp(acct.safe, nonce, callData, { verificationGasLimit: 3_000_000n, callGasLimit: 2_000_000n, preVerificationGas: 100_000n, maxFeePerGas: (block.baseFeePerGas ?? 1n) * 2n + 1_000_000n, maxPriorityFeePerGas: 1_000_000n })
  const hash = userOpHash(op, lab.chainId)
  op = { ...op, signature: concat([SMART_SESSION_MODE_USE, g.permissionId, await sessionKeySignature(acct.sessionKey, hash)]) }
  const data = handleOpsData([op], w.relayer.address)
  const entryPoint = address('EntryPointV07', registry)
  let reason: string | undefined
  let validator: string | undefined
  try {
    await lab.client.call({ account: w.relayer.address, to: entryPoint, data, gas: 15_000_000n })
  } catch (e) {
    const d = revertData(e)
    reason = decodeEntryPointError(d)?.reason ?? 'unknown'
    validator = await smartSessionVerdict(lab, op, registry)
  }
  if (reason) return { included: false, success: false, reason, validator }
  const sent = await lab.send(w.relayer, entryPoint, data)
  const ev = sent.ok ? parseEventLogs({ abi: entryPointV07Abi, logs: sent.receipt.logs, eventName: 'UserOperationEvent' })[0] : undefined
  if (!ev) return { included: false, success: false, reason: 'handleOps reverted', txHash: sent.hash }
  return { included: true, success: ev.args.success, txHash: sent.hash, gasUsed: sent.receipt.gasUsed, actualGasCost: ev.args.actualGasCost }
}

/**
 * SmartSession.validateUserOp called from the account, as Safe7579 does: Safe7579 itself reports only
 * ExecutionFailed(), this names the policy (PolicyViolation) or the time range a rejected op failed on.
 */
async function smartSessionVerdict(lab: Lab, op: UserOperation<'0.7'>, registry: Registry): Promise<string> {
  const data = encodeFunctionData({ abi: smartSessionValidateAbi, functionName: 'validateUserOp', args: [toPackedUserOperation(op), userOpHash(op, lab.chainId)] })
  try {
    const r = await lab.client.call({ account: op.sender, to: address('SmartSession', registry), data, gas: 10_000_000n })
    const v = BigInt(r.data ?? '0x0')
    if (v === 0n) return 'valid'
    if ((v & ((1n << 160n) - 1n)) === 1n) return 'SIG_VALIDATION_FAILED'
    return `time range validUntil ${(v >> 160n) & ((1n << 48n) - 1n)}, validAfter ${v >> 208n}`
  } catch (e) {
    const d = revertData(e)
    if (!d || d === '0x') return 'revert without data'
    try {
      const x = decodeErrorResult({ abi: smartSessionErrorsAbi, data: d })
      if (x.errorName === 'PolicyViolation') return `PolicyViolation(${nameOf(x.args[1] as Address, registry) ?? x.args[1]})`
      return x.errorName
    } catch {
      return `revert ${slice(d, 0, 4)}`
    }
  }
}

function revertData(e: unknown): Hex | undefined {
  let cur: any = e
  for (let i = 0; i < 8 && cur; i++) {
    if (typeof cur.data === 'string' && cur.data.startsWith('0x')) return cur.data as Hex
    if (cur.data && typeof cur.data.data === 'string') return cur.data.data as Hex
    cur = cur.cause
  }
  return undefined
}

export function must(r: TxResult, what: string): void {
  if (!r.ok) throw new Error(`${what} reverted (${r.hash})`)
}

export function mintedTokenId(txHash: Hex, logs: Parameters<typeof parseEventLogs>[0]['logs'], safe: Address, registry: Registry): bigint {
  const t = parseEventLogs({ abi: nonfungiblePositionManagerAbi, logs, eventName: 'Transfer' }).find(
    (l) => l.address.toLowerCase() === address('NonfungiblePositionManager', registry).toLowerCase() && l.args.to.toLowerCase() === safe.toLowerCase(),
  )
  if (!t) throw new Error(`no position minted to the account in ${txHash}`)
  return t.args.tokenId
}

export async function balances(lab: Lab, who: Address): Promise<{ usdc: bigint; wmon: bigint }> {
  return { usdc: await lab.balanceOf('USDC', who), wmon: await lab.balanceOf('WMON', who) }
}

