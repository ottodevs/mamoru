// otto/mamoru#310: the guardian on Ethereum marks a V4 sibling ready only after reading its home back on Base.
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pad, type Abi, type Address, type Hex } from 'viem'
import { address, baseRegistry } from '@mamoru/registry'
import type { Alerter } from '../src/alerts.ts'
import { StateStore } from '../src/state.ts'
import { runPass, type ChainClient, type WatcherConfig, type WatcherDeps } from '../src/watcher.ts'
import { A, GAS_POLICY, HELPER, REGISTRY, V4 } from './helpers.ts'

const ETH = 1
const BASE = 8453
const ACCOUNT = A(0x6111)
const HASH: Hex = `0x${'ab'.repeat(32)}`

function world() {
  return {
    logs: [{ args: { id: `0x${'00'.repeat(32)}`, multiplexer: A(0x55), account: ACCOUNT } }] as { args: Record<string, unknown> }[],
    sibling: { set: true, home: ACCOUNT as Address, homeDomain: 6, ownersHash: HASH as Hex, ready: false },
    home: { code: '0x6080' as Hex | undefined, singleton: address('SafeL2_141', baseRegistry) as Address, set: true, home: A(0) as Address, ownersHash: HASH as Hex },
  }
}
type W = ReturnType<typeof world>

function client(w: W, side: 'sibling' | 'home'): ChainClient {
  return {
    getBlockNumber: async () => 10n,
    getCode: async () => (side === 'home' ? w.home.code : '0x6080'),
    getStorageAt: async () => pad(w.home.singleton, { size: 32 }),
    getLogs: async ({ event }) => ((event as { name: string }).name === 'PolicySet' && side === 'sibling' ? w.logs : []),
    readContract: async ({ functionName }: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }) => {
      const s = side === 'sibling'
      switch (functionName) {
        case 'HELPER': return HELPER
        case 'configOf': return s ? { capUsd: 1n, generation: 1n, homeDomain: w.sibling.homeDomain, set: w.sibling.set, home: w.sibling.home, initHash: HASH } : { capUsd: 1n, generation: 1n, homeDomain: 0, set: w.home.set, home: w.home.home, initHash: HASH }
        case 'ownersHashOf': return s ? w.sibling.ownersHash : w.home.ownersHash
        case 'isReady': return w.sibling.ready
        default: throw new Error(`unexpected read ${functionName}`)
      }
    },
  }
}

function setup(w: W, over: Partial<WatcherConfig> = {}) {
  const store = new StateStore(mkdtempSync(join(tmpdir(), 'guardian-sib-')))
  const alerts: string[] = []
  const sent: { account: Address; domain: number; remote: Address }[] = []
  const alerter: Alerter = { alert: async (t) => (alerts.push(t), { delivered: true }) }
  const cfg: WatcherConfig = { homeChainId: ETH, v4: V4, gasPolicy: GAS_POLICY, registryAt: { [ETH]: REGISTRY }, fromBlock: { [ETH]: 1n, [BASE]: 1n }, logPage: 4n, maxPagesPerStream: 50, dryRun: false, realertMs: 1000, ...over }
  const deps: WatcherDeps = {
    clients: { [ETH]: client(w, 'sibling'), [BASE]: client(w, 'home') },
    send: async (a) => { sent.push(a); w.sibling.ready = true; return '0x01' },
    alerter,
    store,
    allowlist: () => new Set(),
    now: () => 1_000,
  }
  return { cfg, deps, alerts, sent, store }
}

describe('V4 sibling readiness (#310)', () => {
  test('a sibling whose home is the same user Safe on Base: setReady(account, 6, account) once', async () => {
    const w = world()
    const s = setup(w)
    expect(await runPass(s.cfg, s.deps)).toEqual([])
    expect(s.sent).toEqual([{ account: ACCOUNT, domain: 6, remote: ACCOUNT }])
    expect(s.alerts.some((a) => a.includes('setReady sent: sibling'))).toBe(true)
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1) // ready: not sent again
  })

  test('readiness lost (an owner change on the sibling) is read back and sent again', async () => {
    const w = world()
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    w.sibling.ready = false
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(2)
  })

  const refusals: [string, (w: W) => void, string][] = [
    ['home not deployed on Base', (w) => { w.home.code = '0x' }, 'homeCode'],
    ['not a Safe of the pinned singleton', (w) => { w.home.singleton = A(0xbad) }, 'homeSingleton'],
    ['the Base address is not a V4 home', (w) => { w.home.set = false }, 'homeConfig'],
    ['the Base address is itself a remote', (w) => { w.home.home = A(0x1234) }, 'homeConfig'],
    ['the keys differ (rotated on one side)', (w) => { w.home.ownersHash = `0x${'cd'.repeat(32)}` }, 'ownersHash'],
  ]
  for (const [name, mutate, failed] of refusals) {
    test(`refused (${name}): no setReady, one alert naming ${failed}`, async () => {
      const w = world(); mutate(w)
      const s = setup(w)
      await runPass(s.cfg, s.deps)
      expect(s.sent).toEqual([])
      expect(s.alerts.filter((a) => a.includes(`${failed}:`)).length).toBe(1)
      await runPass(s.cfg, s.deps)
      expect(s.alerts.filter((a) => a.includes(`${failed}:`)).length).toBe(1) // deduped
    })
  }

  test('an enable that is not a sibling (a home account) is not tracked', async () => {
    const w = world(); w.sibling.home = A(0)
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(Object.keys(s.store.state.siblings)).toEqual([])
    expect(s.sent).toEqual([])
  })

  test('no RPC for the home chain: alert, never setReady', async () => {
    const w = world()
    const s = setup(w)
    delete (s.deps.clients as Record<number, ChainClient>)[BASE]
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(s.alerts.some((a) => a.includes('no RPC configured for its home chain'))).toBe(true)
  })

  test('dry-run: checks pass, nothing sent', async () => {
    const w = world()
    const s = setup(w, { dryRun: true })
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(s.alerts.some((a) => a.includes('[dry-run] all checks passed, would setReady: sibling'))).toBe(true)
  })
})
