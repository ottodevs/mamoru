// otto/mamoru#293, spec 010 I4 + I7: one pass of the guardian. Logs -> readback checks -> setReady or alert. Clients,
// the setReady sender, the alerter and the state are injected. Nothing here imports the operator, and the only write it
// can make is V4.setReady (never funds).
import { readFileSync } from 'node:fs'
import { getAddress, isAddressEqual, pad, parseAbiItem, slice, type Abi, type Address, type Hex } from 'viem'
import { mamoruActionPolicyV4Abi, mamoruV4HelperAbi, smartSessionV4Abi } from '@mamoru/account/one-auth'
import { V4_CHAIN_BY_DOMAIN, type OneAuthV4Deployment } from '@mamoru/policy'
import { address, registryFor, safe7579Abi, safeAbi, safeWebAuthnSharedSignerAbi } from '@mamoru/registry'
import type { Alerter } from './alerts.ts'
import { checkRemote, type CheckReads, type Side } from './checks.ts'
import type { StateStore } from './state.ts'

/** The slice of a viem PublicClient the guardian uses (a real client is cast to it in main.ts). */
export type ChainClient = {
  getBlockNumber(): Promise<bigint>
  getCode(a: { address: Address }): Promise<Hex | undefined>
  getStorageAt(a: { address: Address; slot: Hex }): Promise<Hex | undefined>
  readContract(a: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>
  getLogs(a: { address: Address; event: unknown; fromBlock: bigint; toBlock: bigint }): Promise<{ args: Record<string, unknown> }[]>
}

export type SetReady = (a: { account: Address; domain: number; remote: Address }) => Promise<Hex>

export type WatcherConfig = {
  homeChainId: number
  v4: Address
  gasPolicy: Address
  /** MamoruRegistry address per watched chain. */
  registryAt: Readonly<Record<number, Address>>
  /** First block to scan per chain when there is no checkpoint. */
  fromBlock: Readonly<Record<number, bigint>>
  logPage: bigint
  maxPagesPerStream: number
  dryRun: boolean
  /** How long a repeated failing check stays quiet. */
  realertMs: number
}

export type WatcherDeps = {
  clients: Readonly<Record<number, ChainClient>>
  send: SetReady
  alerter: Alerter
  store: StateStore
  /** safeTxHashes Mamoru prepared (lower-case). */
  allowlist: () => ReadonlySet<string>
  now: () => number
}

const registeredEvent = parseAbiItem('event RemoteRegistered(address indexed account, uint32 indexed domain, address remote, bytes32 ownersHash, address sessionKey)')
const queuedEvent = parseAbiItem('event Queued(bytes32 indexed id, uint8 indexed kind, bytes32 indexed key, bytes params, uint256 nonce, uint256 eta)')
const executionSuccessEvent = parseAbiItem('event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)')
/** Safe's keccak256("fallback_manager.handler.address"). */
const FALLBACK_SLOT: Hex = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'
const KIND = ['Pool', 'Vault', 'Route']

/** The allowlist file: JSON array of safeTxHashes; absent = empty. A present but malformed file throws (fail closed: no silent muting). */
export function readAllowlist(path: string | undefined): () => ReadonlySet<string> {
  return () => {
    if (!path) return new Set()
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
      throw e
    }
    const j = JSON.parse(raw) as unknown
    if (!Array.isArray(j) || !j.every((x) => typeof x === 'string')) throw new Error('allowlist file: expected a JSON array of strings')
    return new Set(j.map((x) => x.toLowerCase()))
  }
}

const call = async <T>(c: ChainClient, address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => (await c.readContract({ address, abi, functionName, args })) as T

/** Check reads over real (or fake) clients, home and remote. */
export function readsFor(cfg: WatcherConfig, home: ChainClient, remote: ChainClient, remoteChainId: number, helper: Address): CheckReads {
  const homeReg = registryFor(cfg.homeChainId)
  const remoteReg = registryFor(remoteChainId)
  const on = (s: Side) => (s === 'home' ? home : remote)
  const reg = (s: Side) => (s === 'home' ? homeReg : remoteReg)
  return {
    remoteCode: (a) => remote.getCode({ address: a }),
    owners: (s, a) => call(on(s), a, safeAbi, 'getOwners'),
    threshold: (s, a) => call(on(s), a, safeAbi, 'getThreshold'),
    passkey: async (s, a) => {
      const r = await call<{ x: bigint; y: bigint; verifiers: bigint }>(on(s), address('SafeWebAuthnSharedSigner', reg(s)), safeWebAuthnSharedSignerAbi, 'getConfiguration', [a])
      return { x: r.x, y: r.y, verifiers: BigInt(r.verifiers) }
    },
    homeOwnersHash: (a) => call(home, helper, mamoruV4HelperAbi, 'ownersHashOf', [a]),
    smartSessionInstalled: (a) => call(remote, a, safe7579Abi, 'isModuleInstalled', [1n, address('SmartSession', remoteReg), '0x']),
    safe7579Enabled: (a) => call(remote, a, safeAbi, 'isModuleEnabled', [address('Safe7579', remoteReg)]),
    fallbackHandler: async (a) => {
      const w = await remote.getStorageAt({ address: a, slot: FALLBACK_SLOT })
      return getAddress(slice(pad(w ?? '0x', { size: 32 }), 12))
    },
    permissionEnabled: (id, a) => call(remote, address('SmartSession', remoteReg), smartSessionV4Abi, 'isPermissionEnabled', [id, a]),
    permissionIds: (a) => call(remote, address('SmartSession', remoteReg), smartSessionV4Abi, 'getPermissionIDs', [a]),
  }
}

/** Alert once per key (or once per ttl). A failed delivery throws, so the caller does not advance its checkpoint. */
async function alertOnce(d: WatcherDeps, key: string, text: string, ttlMs?: number) {
  const now = d.now()
  if (d.store.seen(key, now, ttlMs)) return
  await d.alerter.alert(text)
  d.store.markAlerted(key, now)
}

/** Scans [cursor, head] of one stream in bounded pages; `onPage` handles each page's logs, then the cursor moves and state is saved. */
async function scan(cfg: WatcherConfig, d: WatcherDeps, key: string, chainId: number, from: bigint, address: Address, event: unknown, onLogs: (logs: { args: Record<string, unknown> }[]) => Promise<void>, setNext: (n: bigint) => void, getNext: () => bigint | undefined) {
  const c = d.clients[chainId]
  if (!c) return
  const head = await c.getBlockNumber()
  let next = getNext() ?? from
  for (let page = 0; page < cfg.maxPagesPerStream && next <= head; page++) {
    const to = next + cfg.logPage - 1n < head ? next + cfg.logPage - 1n : head
    const logs = await c.getLogs({ address, event, fromBlock: next, toBlock: to })
    await onLogs(logs)
    next = to + 1n
    setNext(next)
    d.store.save()
  }
}

const regKey = (account: Address, domain: number) => `${getAddress(account)}:${domain}`

async function scanRegistrations(cfg: WatcherConfig, d: WatcherDeps) {
  const st = d.store.state
  await scan(cfg, d, 'reg', cfg.homeChainId, cfg.fromBlock[cfg.homeChainId]!, cfg.v4, registeredEvent, async (logs) => {
    for (const l of logs) {
      const a = l.args as { account: Address; domain: number; remote: Address; ownersHash: Hex; sessionKey: Address }
      const domain = Number(a.domain)
      const chainId = V4_CHAIN_BY_DOMAIN[domain]
      st.registrations[regKey(a.account, domain)] = { account: getAddress(a.account), domain, remote: getAddress(a.remote), ownersHash: a.ownersHash, sessionKey: getAddress(a.sessionKey) }
      // Every remote ever registered is watched, also after it is superseded: an old remote still holds funds until swept (spec I4).
      if (chainId !== undefined) {
        const sk = `${chainId}:${getAddress(a.remote)}`
        st.safes[sk] ??= { chainId, address: getAddress(a.remote), next: (cfg.fromBlock[chainId] ?? 0n).toString() }
      }
    }
  }, (n) => d.store.setCursor('reg', n), () => d.store.cursor('reg'))
}

async function scanQueued(cfg: WatcherConfig, d: WatcherDeps, chainId: number) {
  const reg = cfg.registryAt[chainId]
  if (!reg) return
  const key = `queued:${chainId}`
  await scan(cfg, d, key, chainId, cfg.fromBlock[chainId]!, reg, queuedEvent, async (logs) => {
    for (const l of logs) {
      const a = l.args as { id: Hex; kind: number; key: Hex; params: Hex; eta: bigint }
      const eta = new Date(Number(a.eta) * 1000).toISOString()
      await alertOnce(d, `queued:${chainId}:${a.id}`, `MamoruRegistry Queued on chain ${chainId}: kind=${KIND[Number(a.kind)] ?? a.kind} key=${a.key} params=${a.params} eta=${eta} id=${a.id}`)
    }
  }, (n) => d.store.setCursor(key, n), () => d.store.cursor(key))
}

async function scanSafe(cfg: WatcherConfig, d: WatcherDeps, k: string) {
  const w = d.store.state.safes[k]!
  const allow = d.allowlist()
  await scan(cfg, d, k, w.chainId, 0n, w.address, executionSuccessEvent, async (logs) => {
    for (const l of logs) {
      const h = String(l.args.txHash).toLowerCase()
      if (allow.has(h)) continue
      await alertOnce(d, `exec:${w.chainId}:${w.address}:${h}`, `Owner transaction on remote Safe ${w.address} (chain ${w.chainId}) that Mamoru did not prepare: safeTxHash=${h}`)
    }
  }, (n) => { w.next = n.toString() }, () => BigInt(w.next))
}

async function processRegistrations(cfg: WatcherConfig, d: WatcherDeps) {
  const home = d.clients[cfg.homeChainId]!
  const st = d.store.state
  const helper = await call<Address>(home, cfg.v4, mamoruActionPolicyV4Abi, 'HELPER')
  for (const [k, reg] of Object.entries(st.registrations)) {
    const where = `account ${reg.account} domain ${reg.domain} remote ${reg.remote}`
    const cur = await call<{ remote: Address; capUsd: bigint }>(home, cfg.v4, mamoruActionPolicyV4Abi, 'remoteOf', [reg.account, reg.domain])
    if (!isAddressEqual(cur.remote, reg.remote)) { delete st.registrations[k]; d.store.save(); continue } // superseded
    if (await call<boolean>(home, cfg.v4, mamoruActionPolicyV4Abi, 'isReady', [reg.account, reg.domain])) { delete st.registrations[k]; d.store.save(); continue }
    const ready = await call<{ remote: Address }>(home, cfg.v4, mamoruActionPolicyV4Abi, 'readyOf', [reg.account, reg.domain])
    if (isAddressEqual(ready.remote, reg.remote)) continue

    const chainId = V4_CHAIN_BY_DOMAIN[reg.domain]
    const remoteClient = chainId === undefined ? undefined : d.clients[chainId]
    if (chainId === undefined || !remoteClient) {
      await alertOnce(d, `check:${k}:${reg.remote}:rpc`, `Remote not marked ready, ${where}: no RPC configured for its chain`, cfg.realertMs)
      continue
    }
    const deployment: Pick<OneAuthV4Deployment, 'policy' | 'gasPolicy'> = { policy: cfg.v4, gasPolicy: cfg.gasPolicy }
    const res = await checkRemote(
      { account: reg.account, domain: reg.domain, homeChainId: cfg.homeChainId, event: { remote: reg.remote, ownersHash: reg.ownersHash, sessionKey: reg.sessionKey }, capUsd: BigInt(cur.capUsd), deployment, homeRegistry: registryFor(cfg.homeChainId), remoteRegistry: registryFor(chainId) },
      readsFor(cfg, home, remoteClient, chainId, helper),
    )
    if (!res.ok) {
      await alertOnce(d, `check:${k}:${reg.remote}:${res.failed}`, `Remote not marked ready, ${where}: ${res.failed}`, cfg.realertMs)
      continue
    }
    if (cfg.dryRun) {
      await alertOnce(d, `dry:${k}:${reg.remote}`, `[dry-run] all checks passed, would setReady: ${where}`, cfg.realertMs)
      continue
    }
    try {
      const tx = await d.send({ account: reg.account, domain: reg.domain, remote: reg.remote })
      await alertOnce(d, `ready:${k}:${reg.remote}`, `setReady sent: ${where} tx=${tx}`)
      delete st.registrations[k]
      d.store.save()
    } catch {
      await alertOnce(d, `sendfail:${k}:${reg.remote}`, `setReady failed to send, will retry: ${where}`, cfg.realertMs)
    }
  }
}

/** One idempotent pass. Each section is isolated: one chain's RPC outage does not stop the others. Returns the section errors (names only). */
export async function runPass(cfg: WatcherConfig, d: WatcherDeps): Promise<string[]> {
  const errors: string[] = []
  const section = async (name: string, f: () => Promise<void>) => {
    try {
      await f()
    } catch (e) {
      errors.push(`${name}: ${(e as { shortMessage?: string; name?: string }).shortMessage ?? (e as Error).name}`)
    }
  }
  await section('registrations', () => scanRegistrations(cfg, d))
  for (const chainId of Object.keys(d.clients).map(Number)) await section(`queued:${chainId}`, () => scanQueued(cfg, d, chainId))
  await section('process', () => processRegistrations(cfg, d))
  for (const k of Object.keys(d.store.state.safes)) await section(`exec:${k}`, () => scanSafe(cfg, d, k))
  d.store.save()
  return errors
}
