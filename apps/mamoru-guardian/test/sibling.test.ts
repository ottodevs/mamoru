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
import { FALLBACK_ACTION_ID } from '../src/checks.ts'
import { A, GAS_POLICY, HELPER, REGISTRY, V4 } from './helpers.ts'

const ETH = 1
const BASE = 8453
const ACCOUNT = A(0x6111)
const HASH: Hex = `0x${'ab'.repeat(32)}`
/** SafeProxy 1.4.1's runtime code, read on Base (its keccak is SAFE_PROXY_CODEHASH). */
const PROXY: Hex = '0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033'
const PID: Hex = `0x${'77'.repeat(32)}`
const SAFE7579 = address('Safe7579', baseRegistry)
const SMART = address('SmartSession', baseRegistry)

function world() {
  return {
    logs: [{ args: { id: `0x${'00'.repeat(32)}`, multiplexer: A(0x55), account: ACCOUNT } }] as { args: Record<string, unknown> }[],
    sibling: { set: true, home: ACCOUNT as Address, homeDomain: 6, ownersHash: HASH as Hex, ready: false, capUsd: 1_000n },
    // review r2 (P0-1): the home's history and its current grants
    approvals: [] as { token: Address; spender: Address }[],
    allowance: {} as Record<string, bigint>,
    approvalForAll: [] as Address[],
    approvedForAll: true,
    signMsgs: 0,
    head: 10n,
    ownerTxs: [] as { to: Address; operation: number }[],
    ownerChangeAt: undefined as bigint | undefined,
    configAtChange: { set: false, generation: 0n },
    homeGeneration: 1n,
    moduleTxs: [] as { operation: number }[],
    nftApprovals: [] as { tokenId: bigint; approved: Address; owned: boolean }[],
    sibCode: PROXY as Hex | undefined,
    home: {
      code: PROXY as Hex | undefined,
      singleton: address('SafeL2_141', baseRegistry) as Address,
      set: true,
      home: A(0) as Address,
      capUsd: 1_000n,
      ownersHash: HASH as Hex,
      modules: [SAFE7579] as Address[],
      guard: A(0) as Address,
      handler: SAFE7579 as Address,
      validators: [SMART] as Address[],
      executors: [] as Address[],
      hook: A(0) as Address,
      pids: [PID] as Hex[],
      session: { actions: [FALLBACK_ACTION_ID] as Hex[], fallbackPolicies: [V4] as Address[], userOpPolicies: [GAS_POLICY] as Address[], erc1271Policies: [] as Address[], validator: address('OwnableValidator', baseRegistry) as Address },
    },
  }
}
type W = ReturnType<typeof world>

function client(w: W, side: 'sibling' | 'home'): ChainClient {
  return {
    getBlockNumber: async () => (side === 'home' ? w.head : 10n),
    getCode: async () => (side === 'home' ? w.home.code : w.sibCode),
    getStorageAt: async ({ slot }) => pad(slot.startsWith('0x4a204f62') ? w.home.guard : slot.startsWith('0x6c9a6c4a') ? w.home.handler : w.home.singleton, { size: 32 }),
    getLogs: async ({ event, address: at }) => {
      const name = (event as { name: string }).name
      if (name === 'PolicySet') return side === 'sibling' ? w.logs : []
      if (side !== 'home') return []
      const npm = address('NonfungiblePositionManager', baseRegistry)
      const one = typeof at === 'string' ? at : undefined
      if (name === 'Approval' && one && one.toLowerCase() === npm.toLowerCase()) return w.nftApprovals.map((x) => ({ address: npm, args: { owner: ACCOUNT, approved: x.approved, tokenId: x.tokenId } }))
      if (name === 'Approval') {
        const allowed = Array.isArray(at) ? at.map((x) => x.toLowerCase()) : undefined
        return w.approvals.filter((x) => !allowed || allowed.includes(x.token.toLowerCase())).map((x) => ({ address: x.token, args: { owner: ACCOUNT, spender: x.spender } }))
      }
      if (name === 'AddedOwner' && w.ownerChangeAt !== undefined) return [{ args: {}, blockNumber: w.ownerChangeAt }]
      if (name === 'ApprovalForAll') return w.approvalForAll.map((o) => ({ address: npm, args: { owner: ACCOUNT, operator: o } }))
      if (name === 'SignMsg') return Array.from({ length: w.signMsgs }, () => ({ args: {} }))
      if (name === 'SafeMultiSigTransaction') return w.ownerTxs.map((t) => ({ args: { to: t.to, operation: t.operation } }))
      if (name === 'SafeModuleTransaction') return w.moduleTxs.map((t) => ({ args: { operation: t.operation } }))
      return []
    },
    readContract: async ({ functionName, args, blockNumber }: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      if (functionName === 'configOf' && side === 'home' && blockNumber !== undefined) return { capUsd: w.home.capUsd, generation: w.configAtChange.generation, homeDomain: 0, set: w.configAtChange.set, home: A(0), initHash: HASH }
      const s = side === 'sibling'
      switch (functionName) {
        case 'HELPER': return HELPER
        case 'configOf': return s ? { capUsd: w.sibling.capUsd, generation: 1n, homeDomain: w.sibling.homeDomain, set: w.sibling.set, home: w.sibling.home, initHash: HASH } : { capUsd: w.home.capUsd, generation: w.homeGeneration, homeDomain: 0, set: w.home.set, home: w.home.home, initHash: HASH }
        case 'allowance': return w.allowance[String(args?.[1]).toLowerCase()] ?? 1n
        case 'isApprovedForAll': return w.approvedForAll
        case 'ownerOf': { const n = w.nftApprovals.find((x) => x.tokenId === args?.[0]); return n?.owned ? ACCOUNT : A(0xdead) }
        case 'getApproved': return w.nftApprovals.find((x) => x.tokenId === args?.[0])?.approved ?? A(0)
        case 'ownersHashOf': return s ? w.sibling.ownersHash : w.home.ownersHash
        case 'isReady': return w.sibling.ready
        case 'getModulesPaginated': return [w.home.modules, A(1)]
        case 'getValidatorsPaginated': return [w.home.validators, A(1)]
        case 'getExecutorsPaginated': return [w.home.executors, A(1)]
        case 'getActiveHook': return w.home.hook
        case 'getPermissionIDs': return w.home.pids
        case 'getEnabledActions': return w.home.session.actions
        case 'getActionPolicies': return w.home.session.fallbackPolicies
        case 'getUserOpPolicies': return w.home.session.userOpPolicies
        case 'getERC1271Policies': return w.home.session.erc1271Policies
        case 'getSessionValidatorAndConfig': return [w.home.session.validator, '0x']
        default: throw new Error(`unexpected read ${functionName}`)
      }
    },
  }
}

function setup(w: W, over: Partial<WatcherConfig> = {}) {
  const store = new StateStore(mkdtempSync(join(tmpdir(), 'guardian-sib-')))
  const alerts: string[] = []
  const sent: { account: Address; domain: number; remote: Address }[] = []
  const cleared: { account: Address; domain: number }[] = []
  const alerter: Alerter = { alert: async (t) => (alerts.push(t), { delivered: true }) }
  const cfg: WatcherConfig = { homeChainId: ETH, v4: V4, gasPolicy: GAS_POLICY, registryAt: { [ETH]: REGISTRY }, fromBlock: { [ETH]: 1n, [BASE]: 1n }, logPage: 4n, maxPagesPerStream: 50, dryRun: false, realertMs: 1000, ...over }
  const deps: WatcherDeps = {
    clients: { [ETH]: client(w, 'sibling'), [BASE]: client(w, 'home') },
    send: async (a) => { sent.push(a); w.sibling.ready = true; return '0x01' },
    clear: async (a) => { cleared.push(a); w.sibling.ready = false; return '0x02' },
    alerter,
    store,
    allowlist: () => new Set(),
    now: () => 1_000,
  }
  return { cfg, deps, alerts, sent, cleared, store }
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

  test('readiness lost (an owner change on the sibling) is read back and sent again, once the resend window passed', async () => {
    const w = world()
    let now = 1_000
    const s = setup(w)
    s.deps.now = () => now
    await runPass(s.cfg, s.deps)
    w.sibling.ready = false
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1) // review r1 (P1-3): not re-sent while the first may still land
    now += 16 * 60_000
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(2)
  })

  test('a send that has not landed yet is not repeated every pass (review r1, P1-3)', async () => {
    const w = world()
    const s = setup(w)
    s.deps.send = async (a) => { s.sent.push(a); return '0x02' } // mined later: isReady stays false for now
    for (let i = 0; i < 4; i++) await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
  })

  test('a sibling whose Init no longer names itself is dropped, not alerted forever (review r1, Argon 1)', async () => {
    const w = world(); w.home.code = '0x' // refused once
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(Object.keys(s.store.state.siblings).length).toBe(1)
    w.sibling.home = A(0) // re-enabled as a home account
    await runPass(s.cfg, s.deps)
    expect(Object.keys(s.store.state.siblings)).toEqual([])
  })

  test('a ready sibling whose home changes is alerted on the periodic re-check', async () => {
    const w = world()
    let now = 1_000
    const s = setup(w)
    s.deps.now = () => now
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
    w.home.modules = [SAFE7579, A(0xbad)]
    now += 2_000 // past realertMs (1000 in setup)
    await runPass(s.cfg, s.deps)
    expect(s.alerts.some((a) => a.includes("Ready sibling's home changed") && a.includes('homeModules'))).toBe(true)
    expect(s.sent.length).toBe(1)
  })

  const refusals: [string, (w: W) => void, string][] = [
    ['home not deployed on Base', (w) => { w.home.code = '0x' }, 'homeCode'],
    ['not a Safe of the pinned singleton', (w) => { w.home.singleton = A(0xbad) }, 'homeSingleton'],
    ['the Base address is not a V4 home', (w) => { w.home.set = false }, 'homeConfig'],
    ['the Base address is itself a remote', (w) => { w.home.home = A(0x1234) }, 'homeConfig'],
    ['the keys differ (rotated on one side)', (w) => { w.home.ownersHash = `0x${'cd'.repeat(32)}` }, 'ownersHash'],
    // review r1 (P1-1): a home someone else deployed and armed, whatever its owners became
    ['an extra Safe module on the home', (w) => { w.home.modules = [SAFE7579, A(0xbad)] }, 'homeModules'],
    ['a transaction guard on the home', (w) => { w.home.guard = A(0xbad) }, 'homeGuard'],
    ['another fallback handler', (w) => { w.home.handler = A(0xbad) }, 'homeFallbackHandler'],
    ['a second 7579 validator', (w) => { w.home.validators = [SMART, A(0xbad)] }, 'homeValidators7579'],
    ['a 7579 executor', (w) => { w.home.executors = [A(0xbad)] }, 'homeExecutors7579'],
    ['a 7579 hook', (w) => { w.home.hook = A(0xbad) }, 'homeHook7579'],
    ['no session at all', (w) => { w.home.pids = [] }, 'homePermissions'],
    ['a session with another action policy', (w) => { w.home.session.fallbackPolicies = [A(0xbad)] }, 'homePermissions'],
    ['a session with a specific action besides the fallback', (w) => { w.home.session.actions = [FALLBACK_ACTION_ID, `0x${'99'.repeat(32)}`] }, 'homePermissions'],
    ['a session without the gas policy', (w) => { w.home.session.userOpPolicies = [] }, 'homePermissions'],
    ['a session that can sign (ERC-1271 policy)', (w) => { w.home.session.erc1271Policies = [A(0xbad)] }, 'homePermissions'],
    ['a session with another validator', (w) => { w.home.session.validator = A(0xbad) }, 'homePermissions'],
    // review r2 (P0-1): authority an old owner left behind, surviving the owner swap
    ['a token allowance to someone else, still live', (w) => { w.approvals = [{ token: address('USDC', baseRegistry), spender: A(0xbad) }] }, 'homeAllowance'],
    ['an operator approved for all positions', (w) => { w.approvalForAll = [A(0xbad)] }, 'homeApprovedForAll'],
    ['a stored signed message', (w) => { w.signMsgs = 1 }, 'homeSignedMessages'],
    // review r3 (P0-A): a spender that forwards arbitrary calls (it is in the registry, it does not pull from msg.sender)
    ['an allowance to Multicall3', (w) => { w.approvals = [{ token: address('USDC', baseRegistry), spender: address('Multicall3', baseRegistry) }] }, 'homeAllowance'],
    ['an allowance to MultiSendCallOnly', (w) => { w.approvals = [{ token: address('USDC', baseRegistry), spender: address('MultiSendCallOnly_141', baseRegistry) }] }, 'homeAllowance'],
    // review r3 (P0-B): storage the owner could rewrite with no event
    ['an owner delegatecall to anything but MultiSendCallOnly', (w) => { w.ownerTxs = [{ to: A(0xbad), operation: 1 }] }, 'homeDelegatecall'],
    ['a module delegatecall', (w) => { w.moduleTxs = [{ operation: 1 }] }, 'homeDelegatecall'],
    // review r3 (P1-2): a single position approved to someone
    ['a position approved to an operator', (w) => { w.nftApprovals = [{ tokenId: 7n, approved: A(0xbad), owned: true }] }, 'homePositionApproval'],
    ["the home's C above the sibling's", (w) => { w.home.capUsd = 10_000n }, 'homeConfig'],
    // review r1 (P1-2): code that is not a SafeProxy, on either side
    ['the home is not a SafeProxy', (w) => { w.home.code = '0x6080' }, 'codeHash'],
    ['the sibling is not a SafeProxy', (w) => { w.sibCode = '0x6080' }, 'codeHash'],
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

describe("the home's history (review r2 of #223, P0-1)", () => {
  test('allowances to pinned contracts (the router) or reset to 0 are fine', async () => {
    const w = world()
    w.approvals = [{ token: address('USDC', baseRegistry), spender: address('SwapRouter02', baseRegistry) }, { token: address('USDC', baseRegistry), spender: A(0xbad) }]
    w.allowance[A(0xbad).toLowerCase()] = 0n
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
  })

  test("Mamoru's own owner txs (MultiSendCallOnly delegatecall, plain calls) and a moved position's old approval pass", async () => {
    const w = world()
    w.ownerTxs = [{ to: address('MultiSendCallOnly_141', baseRegistry), operation: 1 }, { to: A(0x1234), operation: 0 }]
    w.nftApprovals = [{ tokenId: 9n, approved: A(0xbad), owned: false }]
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
  })

  test('a long history is read over several passes: not ready until it reached the head', async () => {
    const w = world(); w.head = 10_010n
    const s = setup(w, { logPage: 100n, maxPagesPerStream: 10 })
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(s.alerts.some((a) => a.includes('homeHistory:'))).toBe(true)
    for (let i = 0; i < 12; i++) await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
  })

  test('a ready sibling whose home gains a foreign allowance is cleared (P1-c), not only alerted', async () => {
    const w = world()
    let now = 1_000
    const s = setup(w)
    s.deps.now = () => now
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
    w.approvals = [{ token: address('USDC', baseRegistry), spender: A(0xbad) }]
    s.store.state.siblings[ACCOUNT]!.hist = undefined // re-read the history from the deploy block
    now += 2_000
    await runPass(s.cfg, s.deps)
    expect(s.cleared).toEqual([{ account: ACCOUNT, domain: 6 }])
    expect(s.alerts.some((a) => a.includes('clearReady sent'))).toBe(true)
  })
})

describe('security review of r3 (#223)', () => {
  test('an Approval forged by any contract (outside the registry) never blocks readiness', async () => {
    const w = world()
    w.approvals = [{ token: A(0xda1), spender: A(0xbad) }]
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
  })

  test('a grant in the unconfirmed tail (the last blocks) is seen before any setReady', async () => {
    const w = world(); w.head = 15n
    w.approvals = [{ token: address('USDC', baseRegistry), spender: A(0xbad) }]
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(s.alerts.some((a) => a.includes('homeAllowance'))).toBe(true)
  })

  test('an older history schema restarts from the deploy block', async () => {
    const w = world()
    const s = setup(w)
    s.store.state.siblings[ACCOUNT] = { account: ACCOUNT, domain: 6, hist: { next: '999', spenders: {}, operators: [], signed: 0 } as never }
    w.approvals = [{ token: address('USDC', baseRegistry), spender: A(0xbad) }]
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(s.alerts.some((a) => a.includes('homeAllowance'))).toBe(true)
  })

  test('an unbroken half hour of failed reads of a ready sibling clears it (fail closed), not a few passes', async () => {
    const w = world()
    let now = 1_000
    const s = setup(w)
    s.deps.now = () => now
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
    const c = s.deps.clients[BASE]! as unknown as { getCode: () => Promise<unknown> }
    c.getCode = async () => { throw new Error('rpc down') }
    for (let i = 0; i < 3; i++) {
      now += 2_000
      await runPass(s.cfg, s.deps)
    }
    expect(s.cleared).toEqual([])
    now += 31 * 60_000
    await runPass(s.cfg, s.deps)
    expect(s.cleared).toEqual([{ account: ACCOUNT, domain: 6 }])
  })
})

describe('review r4 of #223', () => {
  test("V4 in force since before the last owner change, same generation: refused (an old owner's own session key survives a same-generation re-enable)", async () => {
    const w = world(); w.ownerChangeAt = 4n; w.configAtChange = { set: true, generation: 1n }; w.homeGeneration = 1n
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(s.alerts.some((a) => a.includes('homeSessionStale'))).toBe(true)
  })

  test('the current owners signed a new generation after the change: accepted', async () => {
    const w = world(); w.ownerChangeAt = 4n; w.configAtChange = { set: true, generation: 1n }; w.homeGeneration = 2n
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
  })

  test('no V4 config yet at the owner change (the account moved to V4 after it): accepted', async () => {
    const w = world(); w.ownerChangeAt = 4n
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent.length).toBe(1)
  })

  test('an allowance on a registry vault share to a foreign spender is refused', async () => {
    const w = world()
    w.approvals = [{ token: address('vault:gtUSDCp', baseRegistry), spender: A(0xbad) }]
    const s = setup(w)
    await runPass(s.cfg, s.deps)
    expect(s.sent).toEqual([])
    expect(s.alerts.some((a) => a.includes('homeAllowance'))).toBe(true)
  })

  test('a failed clearReady is tried again on the next pass', async () => {
    const w = world()
    let now = 1_000
    const s = setup(w)
    s.deps.now = () => now
    await runPass(s.cfg, s.deps)
    let fails = 1
    s.deps.clear = async (a) => { if (fails-- > 0) throw new Error('wallet down'); s.cleared.push(a); return '0x02' }
    w.signMsgs = 1
    s.store.state.siblings[ACCOUNT]!.hist = undefined
    now += 2_000
    await runPass(s.cfg, s.deps)
    expect(s.cleared).toEqual([])
    now += 2_000
    await runPass(s.cfg, s.deps)
    expect(s.cleared).toEqual([{ account: ACCOUNT, domain: 6 }])
  })
})
