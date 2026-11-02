// otto/mamoru#293, spec 010 I4 + I7: one pass of the guardian. Logs -> readback checks -> setReady or alert. Clients,
// the setReady sender, the alerter and the state are injected. Nothing here imports the operator, and the only write it
// can make is V4.setReady (never funds).
import { readFileSync } from 'node:fs'
import { getAddress, isAddressEqual, pad, parseAbiItem, slice, type Abi, type Address, type Hex } from 'viem'
import { mamoruActionPolicyV4Abi, mamoruV4HelperAbi, smartSessionV4Abi } from '@mamoru/account/one-auth'
import { V4_CHAIN_BY_DOMAIN, type OneAuthV4Deployment } from '@mamoru/policy'
import { address, registryFor, safe7579Abi, safeAbi, safeWebAuthnSharedSignerAbi } from '@mamoru/registry'
import type { Alerter } from './alerts.ts'
import { checkRemote, checkSibling, type CheckReads, type Side, type SiblingReads, type V4Config } from './checks.ts'
import type { StateStore } from './state.ts'

/** The slice of a viem PublicClient the guardian uses (a real client is cast to it in main.ts). */
export type ChainClient = {
  getBlockNumber(): Promise<bigint>
  getCode(a: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>
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
const policySetEvent = parseAbiItem('event PolicySet(bytes32 id, address multiplexer, address account)')
const queuedEvent = parseAbiItem('event Queued(bytes32 indexed id, uint8 indexed kind, bytes32 indexed key, bytes params, uint256 nonce, uint256 eta)')
const executionSuccessEvent = parseAbiItem('event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)')
/** Safe's keccak256("fallback_manager.handler.address"). */
const FALLBACK_SLOT: Hex = '0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5'
const KIND = ['Pool', 'Vault', 'Route']
/** Safe's keccak256("guard_manager.guard.address"). */
const GUARD_SLOT: Hex = '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8'
const SENTINEL: Address = '0x0000000000000000000000000000000000000001'
const safe7579ViewsAbi = [
  { type: 'function', name: 'getValidatorsPaginated', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address[]' }, { type: 'address' }] },
  { type: 'function', name: 'getExecutorsPaginated', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address[]' }, { type: 'address' }] },
  { type: 'function', name: 'getActiveHook', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const satisfies Abi

/** A Safe7579 sentinel-linked list read in pages of 10, through the Safe (Safe7579 is its fallback handler). Bounded. */
async function paginated(c: ChainClient, a: Address, fn: 'getValidatorsPaginated' | 'getExecutorsPaginated'): Promise<Address[]> {
  const out: Address[] = []
  let start: Address = SENTINEL
  for (let i = 0; i < 20; i++) {
    const [page, next] = await call<readonly [readonly Address[], Address]>(c, a, safe7579ViewsAbi, fn, [start, 10n])
    out.push(...page)
    if (isAddressEqual(next, SENTINEL) || BigInt(next) === 0n) return out
    start = next
  }
  throw new Error('too many modules')
}

const modulesAbi = [{ type: 'function', name: 'getModulesPaginated', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'address[]' }, { type: 'address' }] }] as const satisfies Abi

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
    modules: async (a) => {
      // Every module, page by page from the sentinel; a page ends at the sentinel (bounded: 20 pages of 10).
      const out: Address[] = []
      let start: Address = SENTINEL
      for (let i = 0; i < 20; i++) {
        const [page, next] = await call<readonly [readonly Address[], Address]>(remote, a, modulesAbi, 'getModulesPaginated', [start, 10n])
        out.push(...page)
        if (isAddressEqual(next, SENTINEL) || BigInt(next) === 0n) return out
        start = next
      }
      throw new Error('too many modules')
    },
    validators7579: (a) => paginated(remote, a, 'getValidatorsPaginated'),
    executors7579: (a) => paginated(remote, a, 'getExecutorsPaginated'),
    hook7579: (a) => call(remote, a, safe7579ViewsAbi, 'getActiveHook'),
    guard: async (a) => {
      const w = await remote.getStorageAt({ address: a, slot: GUARD_SLOT })
      return getAddress(slice(pad(w ?? '0x', { size: 32 }), 12))
    },
    fallbackHandler: async (a) => {
      const w = await remote.getStorageAt({ address: a, slot: FALLBACK_SLOT })
      return getAddress(slice(pad(w ?? '0x', { size: 32 }), 12))
    },
    permissionEnabled: (id, a) => call(remote, address('SmartSession', remoteReg), smartSessionV4Abi, 'isPermissionEnabled', [id, a]),
    permissionIds: (a) => call(remote, address('SmartSession', remoteReg), smartSessionV4Abi, 'getPermissionIDs', [a]),
  }
}

/**
 * Alert once per key (or once per ttl). A failed delivery throws, so the caller does not advance its checkpoint.
 * Review of #202 r5 (Sol 2): only a delivered alert is recorded. A line that only reached the journal (no webhook: dev)
 * returns false and is not recorded, so it is raised again on the next pass and delivered once a webhook is configured.
 * Returns true when the alert is recorded (delivered now or before).
 */
async function alertOnce(d: WatcherDeps, key: string, text: string, ttlMs?: number): Promise<boolean> {
  const now = d.now()
  if (d.store.seen(key, now, ttlMs)) return true
  const { delivered } = await d.alerter.alert(text)
  if (!delivered) return false
  d.store.markAlerted(key, now)
  return true
}

/**
 * Scans [cursor, head] of one stream in bounded pages; `onLogs` handles each page's logs, then the cursor moves and state is
 * saved. `onLogs` returning false holds the cursor at that page (an alert in it was not delivered): the page is read again.
 */
async function scan(cfg: WatcherConfig, d: WatcherDeps, key: string, chainId: number, from: bigint, address: Address, event: unknown, onLogs: (logs: { args: Record<string, unknown> }[]) => Promise<boolean | void>, setNext: (n: bigint) => void, getNext: () => bigint | undefined) {
  const c = d.clients[chainId]
  if (!c) return
  const head = await c.getBlockNumber()
  let next = getNext() ?? from
  for (let page = 0; page < cfg.maxPagesPerStream && next <= head; page++) {
    const to = next + cfg.logPage - 1n < head ? next + cfg.logPage - 1n : head
    const logs = await c.getLogs({ address, event, fromBlock: next, toBlock: to })
    if ((await onLogs(logs)) === false) return
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
        // Review of #202 (P1-10): its cursor starts at the Safe's deploy block, found when it has code ('' = not deployed yet).
        st.safes[sk] ??= { chainId, address: getAddress(a.remote), next: '' }
      }
    }
  }, (n) => d.store.setCursor('reg', n), () => d.store.cursor('reg'))
}

/**
 * #310: every V4 enable on this chain emits PolicySet; an account whose Init names itself as home is a sibling. Its own
 * cursor ('sib') starts at the chain's first block to scan, as the registrations' does (the same V4, the same chain).
 */
async function scanSiblings(cfg: WatcherConfig, d: WatcherDeps) {
  const st = d.store.state
  const home = d.clients[cfg.homeChainId]!
  await scan(cfg, d, 'sib', cfg.homeChainId, cfg.fromBlock[cfg.homeChainId]!, cfg.v4, policySetEvent, async (logs) => {
    for (const l of logs) {
      const account = getAddress(String(l.args.account))
      const c = configOf(await call<unknown>(home, cfg.v4, mamoruActionPolicyV4Abi, 'configOf', [account]))
      if (c.set && isAddressEqual(c.home, account)) st.siblings[regKey(account, c.homeDomain)] ??= { account, domain: c.homeDomain }
    }
  }, (n) => d.store.setCursor('sib', n), () => d.store.cursor('sib'))
}

function configOf(raw: unknown): V4Config {
  const c = raw as { set: boolean; home: Address; homeDomain: number | bigint; generation: bigint }
  return { set: c.set, home: getAddress(c.home), homeDomain: Number(c.homeDomain), generation: BigInt(c.generation) }
}

/** Safe proxy storage slot 0: its singleton. */
const SINGLETON_SLOT: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000'

/** #310: read each sibling's home back and mark it ready (or alert). A ready sibling is re-checked only when it stops being ready. */
async function processSiblings(cfg: WatcherConfig, d: WatcherDeps) {
  const sibChain = d.clients[cfg.homeChainId]!
  const st = d.store.state
  if (Object.keys(st.siblings).length === 0) return
  const helper = await call<Address>(sibChain, cfg.v4, mamoruActionPolicyV4Abi, 'HELPER')
  for (const [k, s] of Object.entries(st.siblings)) {
    if (await call<boolean>(sibChain, cfg.v4, mamoruActionPolicyV4Abi, 'isReady', [s.account, s.domain])) continue
    const where = `sibling ${s.account} on chain ${cfg.homeChainId}, home domain ${s.domain}`
    const homeChainId = V4_CHAIN_BY_DOMAIN[s.domain]
    const homeClient = homeChainId === undefined ? undefined : d.clients[homeChainId]
    if (homeChainId === undefined || !homeClient) {
      await alertOnce(d, `sib:${k}:rpc`, `Sibling not marked ready, ${where}: no RPC configured for its home chain`, cfg.realertMs)
      continue
    }
    const on = (side: 'sibling' | 'home') => (side === 'sibling' ? sibChain : homeClient)
    const reads: SiblingReads = {
      config: async (side, a) => configOf(await call<unknown>(on(side), cfg.v4, mamoruActionPolicyV4Abi, 'configOf', [a])),
      homeCode: (a) => homeClient.getCode({ address: a }),
      homeSingleton: async (a) => getAddress(slice(pad((await homeClient.getStorageAt({ address: a, slot: SINGLETON_SLOT })) ?? '0x', { size: 32 }), 12)),
      ownersHash: (side, a) => call<Hex>(on(side), helper, mamoruV4HelperAbi, 'ownersHashOf', [a]),
    }
    const res = await checkSibling({ account: s.account, homeDomain: s.domain, homeRegistry: registryFor(homeChainId) }, reads)
    if (!res.ok) {
      await alertOnce(d, `sib:${k}:${res.failed}`, `Sibling not marked ready, ${where}: ${res.failed}`, cfg.realertMs)
      continue
    }
    if (cfg.dryRun) {
      await alertOnce(d, `sib:dry:${k}`, `[dry-run] all checks passed, would setReady: ${where}`, cfg.realertMs)
      continue
    }
    try {
      const tx = await d.send({ account: s.account, domain: s.domain, remote: s.account })
      await alertOnce(d, `sib:ready:${k}:${tx}`, `setReady sent: ${where} tx=${tx}`)
    } catch {
      await alertOnce(d, `sib:sendfail:${k}`, `setReady failed to send, will retry: ${where}`, cfg.realertMs)
    }
  }
}

async function scanQueued(cfg: WatcherConfig, d: WatcherDeps, chainId: number) {
  const reg = cfg.registryAt[chainId]
  if (!reg) return
  const key = `queued:${chainId}`
  await scan(cfg, d, key, chainId, cfg.fromBlock[chainId]!, reg, queuedEvent, async (logs) => {
    let recorded = true
    for (const l of logs) {
      const a = l.args as { id: Hex; kind: number; key: Hex; params: Hex; eta: bigint }
      const eta = new Date(Number(a.eta) * 1000).toISOString()
      if (!(await alertOnce(d, `queued:${chainId}:${a.id}`, `MamoruRegistry Queued on chain ${chainId}: kind=${KIND[Number(a.kind)] ?? a.kind} key=${a.key} params=${a.params} eta=${eta} id=${a.id}`))) recorded = false
    }
    return recorded
  }, (n) => d.store.setCursor(key, n), () => d.store.cursor(key))
}

/** The first block with code at `a` (binary search over getCode at a block), or null when it has none at the head. */
export async function deployBlockOf(c: ChainClient, a: Address, head: bigint): Promise<bigint | null> {
  const has = async (b: bigint) => ((await c.getCode({ address: a, blockNumber: b })) ?? '0x') !== '0x'
  if (!(await has(head))) return null
  let lo = 0n
  let hi = head
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    if (await has(mid)) hi = mid
    else lo = mid + 1n
  }
  return lo
}

async function scanSafe(cfg: WatcherConfig, d: WatcherDeps, k: string) {
  const w = d.store.state.safes[k]!
  if (w.next === '') {
    const c = d.clients[w.chainId]
    if (!c) return
    const head = await c.getBlockNumber()
    let at: bigint | null
    try {
      at = await deployBlockOf(c, w.address, head)
    } catch {
      // Review of #202 r2 (Opus 7): an RPC without historical state cannot find the deploy block. The Safe is watched from
      // now (the earliest block this RPC can say anything about), and that gap is paged.
      if (((await c.getCode({ address: w.address })) ?? '0x') === '0x') return
      at = head
      // Not delivered: the start block is not fixed, so the next pass tries (and alerts) again.
      if (!(await alertOnce(d, `deployblock:${k}`, `Remote Safe ${w.address} (chain ${w.chainId}): deploy block unknown (RPC without history); its owner transactions are watched from block ${head} only`))) return
    }
    if (at === null) return // not deployed: no owner transaction can exist yet
    w.next = at.toString()
    d.store.save()
  }
  const allow = d.allowlist()
  await scan(cfg, d, k, w.chainId, 0n, w.address, executionSuccessEvent, async (logs) => {
    let recorded = true
    for (const l of logs) {
      const h = String(l.args.txHash).toLowerCase()
      if (allow.has(h)) continue
      if (!(await alertOnce(d, `exec:${w.chainId}:${w.address}:${h}`, `Owner transaction on remote Safe ${w.address} (chain ${w.chainId}) that Mamoru did not prepare: safeTxHash=${h}`))) recorded = false
    }
    return recorded
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
    // Review of #202 (P1-5): not ready is not ready, whatever readyOf still names (a stale owners hash after a rotation):
    // the remote is read back again and setReady sent again.

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
      const why = `${name}: ${(e as { shortMessage?: string; name?: string }).shortMessage ?? (e as Error).name}`
      errors.push(why)
      // Review of #202 r2 (Opus 7): a failing section is paged (once per realert window), never only logged.
      await alertOnce(d, `section:${name}`, `guardian section failed: ${why}`, cfg.realertMs).catch(() => {})
    }
  }
  await section('registrations', () => scanRegistrations(cfg, d))
  for (const chainId of Object.keys(d.clients).map(Number)) await section(`queued:${chainId}`, () => scanQueued(cfg, d, chainId))
  await section('process', () => processRegistrations(cfg, d))
  await section('siblings', () => scanSiblings(cfg, d))
  await section('process-siblings', () => processSiblings(cfg, d))
  for (const k of Object.keys(d.store.state.safes)) await section(`exec:${k}`, () => scanSafe(cfg, d, k))
  d.store.save()
  return errors
}
