// A fake two-chain world (home Base 8453, remote Monad 143) behind the ChainClient shape, using the REAL v4Remote so
// the canonical remote address and permission id are the ones the guardian recomputes.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress, pad, type Abi, type Address, type Hex } from 'viem'
import { v4OwnersHash, v4Remote } from '@mamoru/account/one-auth'
import { address, monadRegistry, baseRegistry } from '@mamoru/registry'
import type { Alerter } from '../src/alerts.ts'
import { StateStore } from '../src/state.ts'
import type { ChainClient, WatcherConfig, WatcherDeps } from '../src/watcher.ts'

export const A = (n: number): Address => getAddress(`0x${n.toString(16).padStart(40, '0')}`)
export const ACCOUNT = A(0xa11ce)
export const V4 = A(0x44)
export const GAS_POLICY = A(0x66)
export const HELPER = A(0x77)
export const REGISTRY = A(0x88)
export const SESSION_KEY = A(0x5e55)
export const OWNER = A(0x0b)
export const CAP = 1_000_000_000n
export const DOMAIN = 15
export const HOME = 8453
export const REMOTE_CHAIN = 143

export type World = ReturnType<typeof makeWorld>

export function makeWorld() {
  const owners = [OWNER]
  const ownersHash = v4OwnersHash({ owners, threshold: 1n, x: 0n, y: 0n, verifiers: 0n })
  const exp = v4Remote({ home: ACCOUNT, owners: { owners, threshold: 1n, x: 0n, y: 0n, verifiers: 0n }, domain: DOMAIN, homeDomain: 6, sessionKey: SESSION_KEY, capUsd: CAP, deployment: { policy: V4, gasPolicy: GAS_POLICY }, registry: monadRegistry })
  return {
    exp,
    event: { account: ACCOUNT, domain: DOMAIN, remote: exp.address, ownersHash, sessionKey: SESSION_KEY },
    regLogs: [] as { args: Record<string, unknown> }[],
    queuedLogs: [] as { args: Record<string, unknown> }[],
    execLogs: [] as { args: Record<string, unknown> }[],
    home: { owners: owners as Address[], threshold: 1n, ownersHash, remoteOf: exp.address as Address, ready: false, readyRemote: A(0) as Address },
    remote: {
      code: '0x6080' as Hex | undefined,
      owners: owners as Address[],
      threshold: 1n,
      ssInstalled: true,
      modules: [address('Safe7579', monadRegistry)] as Address[],
      guard: A(0) as Address,
      deployedAt: 3n,
      handler: address('Safe7579', monadRegistry) as Address,
      permEnabled: true,
      permIds: [exp.permissionId] as Hex[],
    },
    reads: [] as string[],
  }
}

function client(w: World, side: 'home' | 'remote'): ChainClient {
  return {
    getBlockNumber: async () => 10n,
    getCode: async ({ blockNumber }) => (blockNumber !== undefined && blockNumber < w.remote.deployedAt ? undefined : w.remote.code),
    getStorageAt: async ({ slot }) => pad(slot.startsWith('0x4a204f62') ? w.remote.guard : w.remote.handler, { size: 32 }),
    getLogs: async ({ event }) => {
      const name = (event as { name: string }).name
      if (name === 'RemoteRegistered') return side === 'home' ? w.regLogs : []
      if (name === 'Queued') return w.queuedLogs
      if (name === 'ExecutionSuccess') return side === 'remote' ? w.execLogs : []
      return []
    },
    readContract: async ({ functionName, args }: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) => {
      w.reads.push(`${side}.${functionName}`)
      const h = w.home
      const r = w.remote
      switch (functionName) {
        case 'HELPER': return HELPER
        case 'ownersHashOf': return h.ownersHash
        case 'remoteOf': return { remote: h.remoteOf, capUsd: CAP, ownersHash: h.ownersHash, sessionKey: SESSION_KEY }
        case 'isReady': return h.ready
        case 'readyOf': return { remote: h.readyRemote, ownersHash: h.ownersHash }
        case 'getOwners': return side === 'home' ? h.owners : r.owners
        case 'getThreshold': return side === 'home' ? h.threshold : r.threshold
        case 'isModuleInstalled': return r.ssInstalled
        case 'getModulesPaginated': return [r.modules, A(1)]
        case 'isPermissionEnabled': return r.permEnabled
        case 'getPermissionIDs': return r.permIds
        default: throw new Error(`unexpected read ${functionName} ${String(args)}`)
      }
    },
  }
}

export function setup(w: World, over: Partial<WatcherConfig> = {}, allow: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-test-'))
  const store = new StateStore(dir)
  const alerts: string[] = []
  const sent: { account: Address; domain: number; remote: Address }[] = []
  const alerter: Alerter = { alert: async (t) => void alerts.push(t) }
  const cfg: WatcherConfig = { homeChainId: HOME, v4: V4, gasPolicy: GAS_POLICY, registryAt: { [HOME]: REGISTRY, [REMOTE_CHAIN]: REGISTRY }, fromBlock: { [HOME]: 1n, [REMOTE_CHAIN]: 1n }, logPage: 4n, maxPagesPerStream: 50, dryRun: false, realertMs: 1000, ...over }
  const deps: WatcherDeps = {
    clients: { [HOME]: client(w, 'home'), [REMOTE_CHAIN]: client(w, 'remote') },
    send: async (a) => { sent.push(a); return '0x01' },
    alerter,
    store,
    allowlist: () => new Set(allow.map((x) => x.toLowerCase())),
    now: () => 1_000,
  }
  return { cfg, deps, alerts, sent, dir, store }
}

export { baseRegistry }
