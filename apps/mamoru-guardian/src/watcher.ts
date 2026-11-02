// otto/mamoru#293, spec 010 I4 + I7: one pass of the guardian. Logs -> readback checks -> setReady or alert. Clients,
// the setReady sender, the alerter and the state are injected. Nothing here imports the operator, and the only write it
// can make is V4.setReady (never funds).
import { readFileSync } from 'node:fs'
import { getAddress, isAddressEqual, keccak256, pad, parseAbiItem, slice, type Abi, type Address, type Hex } from 'viem'
import { mamoruActionPolicyV4Abi, mamoruV4HelperAbi, smartSessionV4Abi } from '@mamoru/account/one-auth'
import { V4_CHAIN_BY_DOMAIN, type OneAuthV4Deployment } from '@mamoru/policy'
import { address, registryFor, safe7579Abi, safeAbi, safeWebAuthnSharedSignerAbi } from '@mamoru/registry'
import type { Alerter } from './alerts.ts'
import { checkRemote, checkSibling, FALLBACK_ACTION_ID, type CheckReads, type CheckResult, type HomeHistory, type Side, type SiblingReads, type V4Config } from './checks.ts'
import type { Sibling, StateStore } from './state.ts'

/** The slice of a viem PublicClient the guardian uses (a real client is cast to it in main.ts). */
export type ChainClient = {
  getBlockNumber(): Promise<bigint>
  getCode(a: { address: Address; blockNumber?: bigint }): Promise<Hex | undefined>
  getStorageAt(a: { address: Address; slot: Hex }): Promise<Hex | undefined>
  readContract(a: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown>
  getLogs(a: { address?: Address | Address[]; event: unknown; args?: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }): Promise<{ args: Record<string, unknown>; address?: Address; blockNumber?: bigint | null }[]>
}

export type SetReady = (a: { account: Address; domain: number; remote: Address }) => Promise<Hex>
/** V4.clearReady (revoke-only). */
export type ClearReady = (a: { account: Address; domain: number }) => Promise<Hex>

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
  /** Review r2 of #223 (P1-c): a ready sibling whose home stops passing the checks is cleared, not only alerted. */
  clear?: ClearReady
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
 * The entry is keyed by account: a later Init of the account replaces its home domain (review r1, Argon 2).
 */
async function scanSiblings(cfg: WatcherConfig, d: WatcherDeps) {
  const st = d.store.state
  const home = d.clients[cfg.homeChainId]!
  await scan(cfg, d, 'sib', cfg.homeChainId, cfg.fromBlock[cfg.homeChainId]!, cfg.v4, policySetEvent, async (logs) => {
    for (const l of logs) {
      const account = getAddress(String(l.args.account))
      const c = configOf(await call<unknown>(home, cfg.v4, mamoruActionPolicyV4Abi, 'configOf', [account]))
      if (c.set && isAddressEqual(c.home, account)) {
        const prev = st.siblings[account]
        if (!prev || prev.domain !== c.homeDomain) st.siblings[account] = { account, domain: c.homeDomain }
      }
    }
  }, (n) => d.store.setCursor('sib', n), () => d.store.cursor('sib'))
}

function configOf(raw: unknown): V4Config {
  const c = raw as { set: boolean; home: Address; homeDomain: number | bigint; generation: bigint; capUsd?: bigint }
  return { set: c.set, home: getAddress(c.home), homeDomain: Number(c.homeDomain), generation: BigInt(c.generation), capUsd: BigInt(c.capUsd ?? 0n) }
}

const approvalEvent = parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)')
const approvalForAllEvent = parseAbiItem('event ApprovalForAll(address indexed owner, address indexed operator, bool approved)')
const signMsgEvent = parseAbiItem('event SignMsg(bytes32 indexed msgHash)')
const nftApprovalEvent = parseAbiItem('event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)')
const safeMultiSigEvent = parseAbiItem('event SafeMultiSigTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures, bytes additionalInfo)')
const safeModuleTxEvent = parseAbiItem('event SafeModuleTransaction(address module, address to, uint256 value, bytes data, uint8 operation)')
const addedOwnerEvent = parseAbiItem('event AddedOwner(address owner)')
const removedOwnerEvent = parseAbiItem('event RemovedOwner(address owner)')
const changedThresholdEvent = parseAbiItem('event ChangedThreshold(uint256 threshold)')
/** Logs are read this many blocks short of the head (review r3 of #223, P2: a reorg never skips a log behind the cursor). */
const HISTORY_CONFIRMATIONS = 10n
const allowanceViewAbi = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isApprovedForAll', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getApproved', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'ownerOf', stateMutability: 'view', inputs: [{ type: 'uint256' }], outputs: [{ type: 'address' }] },
] as const satisfies Abi

/**
 * Review r2 of #223 (P0-1): reads the home's logs from its deploy block on, in bounded pages per pass (the cursor lives
 * on the sibling's state): Approval(owner = home) on every token of the home registry, ApprovalForAll(owner = home) on
 * the position manager, SignMsg on the home. Then the CURRENT allowance of every (token, spender) seen and whether each
 * operator is still approved. `complete` only once the scan reached the head.
 */
/** A call that reverted (the contract said no), as opposed to a transport or provider failure. */
function reverted(e: unknown): boolean {
  for (let x = e as { name?: string; cause?: unknown } | undefined, i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    if (x.name === 'ContractFunctionRevertedError' || x.name === 'CallExecutionError' && /revert/i.test(String((x as { shortMessage?: string }).shortMessage ?? ''))) return true
  }
  return false
}

type Hist = NonNullable<Sibling['hist']>

/** One range of the home's logs folded into `h` (shared by the persisted scan and the unconfirmed tail). */
async function foldLogs(home: ChainClient, s: Sibling, h: Hist, reg: ReturnType<typeof registryFor>, from: bigint, to: bigint, v4: Address): Promise<void> {
  const npm = reg.entries.find((e) => e.name === 'NonfungiblePositionManager')?.address
  const callOnly = address('MultiSendCallOnly_141', reg)
  // Review r4 of #223 (P1-2) + security review: Approval(owner = home) only from the registry's tokens and vault shares
  // (real value, what Mamoru moves): a forged emitter can neither flood this query nor be stored.
  const emitters = reg.entries.filter((e) => e.kind === 'token' || e.kind === 'vault').map((e) => e.address)
  for (const l of await home.getLogs({ address: emitters, event: approvalEvent, args: { owner: s.account }, fromBlock: from, toBlock: to })) {
    if (!l.address || (npm && isAddressEqual(l.address, npm)) || l.args.spender === undefined) continue
    const k = getAddress(l.address)
    h.spenders[k] = [...new Set([...(h.spenders[k] ?? []), getAddress(String(l.args.spender))])]
  }
  if (npm) {
    for (const l of await home.getLogs({ address: npm, event: approvalForAllEvent, args: { owner: s.account }, fromBlock: from, toBlock: to })) h.operators = [...new Set([...h.operators, `${getAddress(npm)}:${getAddress(String(l.args.operator))}`])] as Address[]
    for (const l of await home.getLogs({ address: npm, event: nftApprovalEvent, args: { owner: s.account }, fromBlock: from, toBlock: to })) if (l.args.tokenId !== undefined) h.nftIds = [...new Set([...(h.nftIds ?? []), String(l.args.tokenId)])]
  }
  h.signed += (await home.getLogs({ address: s.account, event: signMsgEvent, fromBlock: from, toBlock: to })).length
  // Review r3 (P0-B): every owner tx and every module tx of the home (SafeL2 events, emitted by the home itself).
  for (const l of await home.getLogs({ address: s.account, event: safeMultiSigEvent, fromBlock: from, toBlock: to })) if (Number(l.args.operation) === 1 && !isAddressEqual(getAddress(String(l.args.to)), callOnly)) h.delegatecalls = (h.delegatecalls ?? 0) + 1
  for (const l of await home.getLogs({ address: s.account, event: safeModuleTxEvent, fromBlock: from, toBlock: to })) if (Number(l.args.operation) === 1) h.delegatecalls = (h.delegatecalls ?? 0) + 1
  // Review r4 (P1): the block of the last owner change (its V4 generation then is compared with the one in force now).
  const max = (a: string | undefined, b: bigint | null | undefined) => (b == null ? a : a === undefined || b > BigInt(a) ? b.toString() : a)
  for (const ev of [addedOwnerEvent, removedOwnerEvent, changedThresholdEvent]) for (const l of await home.getLogs({ address: s.account, event: ev, fromBlock: from, toBlock: to })) h.lastOwnerChange = max(h.lastOwnerChange, l.blockNumber)
  void v4
}

/**
 * Review r2/r3 of #223 and the security review of r3: the home's history from its deploy block on. The cursor (on the
 * sibling's state, schema v2: an older one restarts from the deploy block) stays HISTORY_CONFIRMATIONS behind the head;
 * before any answer the unconfirmed tail up to the head is read too, without moving the cursor, so nothing in the last
 * blocks is ever missed. Only the home registry's tokens (real value, what Mamoru moves) and the position manager count:
 * any contract can emit an Approval naming the home, so an unknown emitter is reported in `note`, never a refusal.
 */
async function homeHistoryOf(cfg: WatcherConfig, d: WatcherDeps, s: Sibling, home: ChainClient, homeChainId: number): Promise<HomeHistory> {
  const reg = registryFor(homeChainId)
  const tip = await home.getBlockNumber()
  const head = tip > HISTORY_CONFIRMATIONS ? tip - HISTORY_CONFIRMATIONS : 0n
  // The emitter set a scan covered (security review of r4): a registry that gains a token or vault restarts the scan.
  const emitters = reg.entries.filter((e) => e.kind === 'token' || e.kind === 'vault').map((e) => e.address.toLowerCase()).sort().join(',')
  if (s.hist && (s.hist.v !== 4 || s.hist.emitters !== emitters || s.hist.delegatecalls === undefined || s.hist.nftIds === undefined || s.hist.operators.some((o) => !String(o).includes(':')))) s.hist = undefined
  const h = (s.hist ??= { v: 4, next: '', spenders: {}, operators: [], signed: 0, delegatecalls: 0, nftIds: [], emitters })
  const empty = (note?: string): HomeHistory => ({ complete: false, ...(note ? { note } : {}), allowances: [], approvedForAll: [], signedMessages: 0, delegatecalls: 0, positionApprovals: [] })
  if (h.next === '') {
    let at: bigint | null
    try {
      at = await deployBlockOf(home, s.account, tip)
    } catch {
      return empty('the home chain RPC has no history: its deploy block cannot be found')
    }
    if (at === null) return empty()
    h.next = at.toString()
  }
  let next = BigInt(h.next)
  for (let page = 0; page < cfg.maxPagesPerStream && next <= head; page++) {
    const to = next + cfg.logPage - 1n < head ? next + cfg.logPage - 1n : head
    await foldLogs(home, s, h, reg, next, to, cfg.v4)
    next = to + 1n
    h.next = next.toString()
    d.store.save()
  }
  if (next <= head) return empty()
  // The unconfirmed tail, read into a copy: counted now, scanned again (persisted) once it is confirmed.
  const view: Hist = { ...h, spenders: { ...h.spenders }, operators: [...h.operators], nftIds: [...(h.nftIds ?? [])] }
  if (next <= tip) await foldLogs(home, s, view, reg, next, tip, cfg.v4)
  const tokens = new Set(reg.entries.filter((e) => e.kind === 'token' || e.kind === 'vault').map((e) => e.address.toLowerCase()))
  const allowances: { token: Address; spender: Address }[] = []
  const ignored: string[] = []
  for (const [token, spenders] of Object.entries(view.spenders)) {
    if (!tokens.has(token.toLowerCase())) {
      ignored.push(token)
      continue
    }
    for (const spender of spenders) {
      // A registry token that cannot be read is counted as live (fail closed); its contract is known, not forged.
      const v = await call<bigint>(home, token as Address, allowanceViewAbi, 'allowance', [s.account, spender]).catch(() => 1n)
      if (v > 0n) allowances.push({ token: token as Address, spender })
    }
  }
  const approvedForAll: Address[] = []
  for (const pair of view.operators) {
    const [contract, op] = String(pair).split(':') as [Address, Address]
    if (await call<boolean>(home, contract, allowanceViewAbi, 'isApprovedForAll', [s.account, op]).catch(() => true)) approvedForAll.push(op)
  }
  const positionApprovals: bigint[] = []
  const npm = reg.entries.find((e) => e.name === 'NonfungiblePositionManager')?.address
  if (npm) {
    for (const id of view.nftIds ?? []) {
      let owner: Address
      try {
        owner = await call<Address>(home, npm, allowanceViewAbi, 'ownerOf', [BigInt(id)])
      } catch (e) {
        if (reverted(e)) continue // burned: no longer anyone's
        positionApprovals.push(BigInt(id)) // a transport failure proves nothing: fail closed
        continue
      }
      if (!isAddressEqual(owner, s.account)) continue // moved away: no longer the home's
      const approved = await call<Address>(home, npm, allowanceViewAbi, 'getApproved', [BigInt(id)]).catch(() => s.account)
      if (BigInt(approved) !== 0n) positionApprovals.push(BigInt(id))
    }
  }
  return { complete: true, ...(ignored.length ? { note: `Approval logs from ${ignored.length} contract(s) outside the registry ignored` } : {}), allowances, approvedForAll, signedMessages: view.signed, delegatecalls: view.delegatecalls ?? 0, positionApprovals, ...(view.lastOwnerChange !== undefined ? { lastOwnerChange: BigInt(view.lastOwnerChange) } : {}) }
}

/** Safe proxy storage slot 0: its singleton. */
const SINGLETON_SLOT: Hex = '0x0000000000000000000000000000000000000000000000000000000000000000'
/** An unbroken run of failed reads of a ready sibling this long clears it (fail closed; security review of #223). */
const SIBLING_TRANSIENT_CLEAR_MS = 30 * 60_000
/** A ready sibling whose history re-scan has not finished in this long is cleared too (fail closed). */
const SIBLING_SCAN_CLEAR_MS = 6 * 3600_000
/** A sent setReady is not sent again within this window: Ethereum's inclusion plus a lagging read RPC. */
const SIBLING_RESEND_MS = 15 * 60_000

const sessionViewsAbi = [
  { type: 'function', name: 'getEnabledActions', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'bytes32[]' }] },
  { type: 'function', name: 'getActionPolicies', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }, { type: 'bytes32' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getUserOpPolicies', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getERC1271Policies', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getSessionValidatorAndConfig', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'bytes32' }], outputs: [{ type: 'address' }, { type: 'bytes' }] },
] as const satisfies Abi

/** The reads of checkSibling over the sibling's chain and its home chain. */
export function siblingReadsFor(cfg: WatcherConfig, sibChain: ChainClient, homeClient: ChainClient, homeChainId: number, helper: Address, history: (a: Address) => Promise<HomeHistory>): SiblingReads {
  const on = (side: 'sibling' | 'home') => (side === 'sibling' ? sibChain : homeClient)
  const homeReg = registryFor(homeChainId)
  const smart = address('SmartSession', homeReg)
  return {
    config: async (side, a) => configOf(await call<unknown>(on(side), cfg.v4, mamoruActionPolicyV4Abi, 'configOf', [a])),
    homeConfigAt: async (a, block) => configOf(await homeClient.readContract({ address: cfg.v4, abi: mamoruActionPolicyV4Abi as Abi, functionName: 'configOf', args: [a], blockNumber: block })),
    codeHash: async (side, a) => {
      const code = await on(side).getCode({ address: a })
      return code && code !== '0x' ? keccak256(code) : undefined
    },
    homeSingleton: async (a) => getAddress(slice(pad((await homeClient.getStorageAt({ address: a, slot: SINGLETON_SLOT })) ?? '0x', { size: 32 }), 12)),
    ownersHash: (side, a) => call<Hex>(on(side), helper, mamoruV4HelperAbi, 'ownersHashOf', [a]),
    modules: async (a) => {
      const out: Address[] = []
      let start: Address = SENTINEL
      for (let i = 0; i < 20; i++) {
        const [page, next] = await call<readonly [readonly Address[], Address]>(homeClient, a, modulesAbi, 'getModulesPaginated', [start, 10n])
        out.push(...page)
        if (isAddressEqual(next, SENTINEL) || BigInt(next) === 0n) return out
        start = next
      }
      throw new Error('too many modules')
    },
    guard: async (a) => getAddress(slice(pad((await homeClient.getStorageAt({ address: a, slot: GUARD_SLOT })) ?? '0x', { size: 32 }), 12)),
    fallbackHandler: async (a) => getAddress(slice(pad((await homeClient.getStorageAt({ address: a, slot: FALLBACK_SLOT })) ?? '0x', { size: 32 }), 12)),
    validators7579: (a) => paginated(homeClient, a, 'getValidatorsPaginated'),
    executors7579: (a) => paginated(homeClient, a, 'getExecutorsPaginated'),
    hook7579: (a) => call(homeClient, a, safe7579ViewsAbi, 'getActiveHook'),
    permissionIds: (a) => call(homeClient, smart, smartSessionV4Abi, 'getPermissionIDs', [a]),
    session: async (a, id) => {
      const [actions, fallbackPolicies, userOpPolicies, erc1271Policies, [validator]] = await Promise.all([
        call<readonly Hex[]>(homeClient, smart, sessionViewsAbi, 'getEnabledActions', [a, id]),
        call<readonly Address[]>(homeClient, smart, sessionViewsAbi, 'getActionPolicies', [a, id, FALLBACK_ACTION_ID]),
        call<readonly Address[]>(homeClient, smart, sessionViewsAbi, 'getUserOpPolicies', [a, id]),
        call<readonly Address[]>(homeClient, smart, sessionViewsAbi, 'getERC1271Policies', [a, id]),
        call<readonly [Address, Hex]>(homeClient, smart, sessionViewsAbi, 'getSessionValidatorAndConfig', [a, id]),
      ])
      return { actions, fallbackPolicies, userOpPolicies, erc1271Policies, validator }
    },
    homeHistory: history,
  }
}

/**
 * #310: read each sibling's home back and mark it ready, or alert. Review r1 of #227:
 * - a sibling whose Init no longer names itself (or names another domain) is dropped, never alerted forever;
 * - a sent setReady is not sent again for SIBLING_RESEND_MS (send waits for a successful receipt; the read may lag);
 * - a ready sibling is read back again once per realert window, and a change is alerted (the guardian's clearReady
 *   stays a manual step);
 * - each sibling is its own section: one that throws does not stop the others.
 */
async function processSiblings(cfg: WatcherConfig, d: WatcherDeps): Promise<string[]> {
  const sibChain = d.clients[cfg.homeChainId]!
  const st = d.store.state
  const errors: string[] = []
  if (Object.keys(st.siblings).length === 0) return errors
  const helper = await call<Address>(sibChain, cfg.v4, mamoruActionPolicyV4Abi, 'HELPER')
  for (const [k, s] of Object.entries(st.siblings)) {
    const where = `sibling ${s.account} on chain ${cfg.homeChainId}, home domain ${s.domain}`
    try {
      const c = configOf(await call<unknown>(sibChain, cfg.v4, mamoruActionPolicyV4Abi, 'configOf', [s.account]))
      if (!c.set || !isAddressEqual(c.home, s.account) || c.homeDomain !== s.domain) {
        delete st.siblings[k]
        d.store.save()
        continue
      }
      const ready = await call<boolean>(sibChain, cfg.v4, mamoruActionPolicyV4Abi, 'isReady', [s.account, s.domain])
      const now = d.now()
      if (ready && s.checkedAt !== undefined && now - s.checkedAt < cfg.realertMs) continue
      if (!ready && s.sentAt !== undefined && now - s.sentAt < SIBLING_RESEND_MS) continue
      const homeChainId = V4_CHAIN_BY_DOMAIN[s.domain]
      const homeClient = homeChainId === undefined ? undefined : d.clients[homeChainId]
      // Review r4 of #223 (GPT-6 P1): no home RPC is a failed read, for a ready sibling too (it is then cleared in time).
      const res: CheckResult = homeChainId === undefined || !homeClient
        ? { ok: false, failed: 'homeRpc: no RPC configured for its home chain: read failed', transient: true }
        : await checkSibling({ account: s.account, homeDomain: s.domain, homeRegistry: registryFor(homeChainId), deployment: { policy: cfg.v4, gasPolicy: cfg.gasPolicy } }, siblingReadsFor(cfg, sibChain, homeClient, homeChainId, helper, () => homeHistoryOf(cfg, d, s, homeClient, homeChainId)))
      if (ready) {
        if (res.ok) {
          s.checkedAt = now
          s.transientSince = undefined
          d.store.save()
          continue
        }
        if (res.transient) {
          // Security review of #223: failed reads clear after SIBLING_TRANSIENT_CLEAR_MS unbroken; a scan in progress (an
          // explicit flag) only after SIBLING_SCAN_CLEAR_MS (it may run over several passes, but never forever).
          s.transientSince ??= now
          const expired = now - s.transientSince >= (res.scanning ? SIBLING_SCAN_CLEAR_MS : SIBLING_TRANSIENT_CLEAR_MS)
          if (!expired) {
            s.checkedAt = undefined // re-read next pass
            d.store.save()
            await alertOnce(d, `sib:recheck:${k}:${res.failed}`, `Ready sibling's re-check incomplete, ${where}: ${res.failed}`, cfg.realertMs)
            continue
          }
        }
        // A definite failure, or reads failing for too long: the guardian clears it (revoke-only, review r2 P1-c). The
        // re-check clock moves only once the clear is sent; a failed clear is tried again next pass (GPT-6 r4 P1).
        if (!cfg.dryRun && d.clear) {
          const tx = await d.clear({ account: s.account, domain: s.domain }).catch(() => null)
          s.checkedAt = tx ? now : undefined
          if (tx) s.transientSince = undefined
          d.store.save()
          await alertOnce(d, `sib:changed:${k}:${res.failed}:${tx ?? 'retry'}`, `Ready sibling's home changed or unreadable, ${where}: ${res.failed}. ${tx ? `clearReady sent tx=${tx}` : 'clearReady FAILED to send: retried next pass'}`, cfg.realertMs)
        } else await alertOnce(d, `sib:changed:${k}:${res.failed}`, `Ready sibling's home changed, ${where}: ${res.failed}. Clear it with V4.clearReady`, cfg.realertMs)
        continue
      }
      if (homeChainId === undefined || !homeClient) {
        await alertOnce(d, `sib:${k}:rpc`, `Sibling not marked ready, ${where}: no RPC configured for its home chain`, cfg.realertMs)
        continue
      }
      if (!res.ok) {
        await alertOnce(d, `sib:${k}:${res.failed}`, `Sibling not marked ready, ${where}: ${res.failed}`, cfg.realertMs)
        continue
      }
      if (cfg.dryRun) {
        await alertOnce(d, `sib:dry:${k}`, `[dry-run] all checks passed, would setReady: ${where}`, cfg.realertMs)
        continue
      }
      // Review r2 of #223 (P2-a): the send is recorded BEFORE it is attempted, so a receipt that times out after the
      // broadcast never leads to a second setReady on the next pass.
      s.sentAt = now
      d.store.save()
      try {
        const tx = await d.send({ account: s.account, domain: s.domain, remote: s.account })
        s.checkedAt = now
        d.store.save()
        await alertOnce(d, `sib:ready:${k}:${tx}`, `setReady sent: ${where} tx=${tx}`)
      } catch {
        await alertOnce(d, `sib:sendfail:${k}`, `setReady failed to send, will retry: ${where}`, cfg.realertMs)
      }
    } catch (e) {
      const why = `sibling ${s.account}: ${(e as { shortMessage?: string; name?: string }).shortMessage ?? (e as Error).name}`
      errors.push(why)
      await alertOnce(d, `sib:error:${k}`, `guardian sibling check failed: ${why}`, cfg.realertMs).catch(() => {})
    }
  }
  return errors
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
  await section('process-siblings', async () => { errors.push(...(await processSiblings(cfg, d))) })
  for (const k of Object.keys(d.store.state.safes)) await section(`exec:${k}`, () => scanSafe(cfg, d, k))
  d.store.save()
  return errors
}
