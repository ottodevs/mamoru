import { afterAll, describe, expect, test } from 'bun:test'
import { decodeFunctionData, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { POLICIES, grantKey, instantiateGrant } from '@mamoru/policy'
import { baseRegistry, address, smartSessionAbi } from '@mamoru/registry'
import { multicall3Abi } from '@mamoru/rpc'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { FakeChain } from '../../rpc/test/fake-chain.ts'
import { Engine, observationFloor, type EngineSession } from './engine.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const policy = POLICIES['conservador-live-v2']!
const sessionKey = privateKeyToAccount(generatePrivateKey())

/** The grants an activation enables: every grant of the policy that is not per position. */
function sessions(): EngineSession[] {
  const caps = new Proxy({}, { get: () => 10n ** 12n }) as Record<string, bigint>
  return policy.session.grants
    .filter((g) => !g.perPosition)
    .map((g, i) => {
      // One salt per grant, as an activation does: the permission id is derived from it.
      const grant = instantiateGrant(policy, grantKey(g), { account: ACCOUNT, sessionKey: sessionKey.address, chainId: 8453, salt: `0x${(i + 1).toString(16).padStart(64, '0')}`, validAfter: 0, validUntil: 2_000_000_000, caps, admittedTokenIds: [] })
      return { name: grantKey(g), grant, permissionId: permissionIdOf(toSmartSession(grant)) }
    })
}

const chain = new FakeChain()
chain.code.set(ACCOUNT.toLowerCase(), '0x6001')
chain.addPosition(ACCOUNT, 11n, 'pool:USDC/cbBTC/500')
chain.addPosition(ACCOUNT, 12n, 'pool:WETH/USDC/3000')
chain.addPosition(ACCOUNT, 13n, 'pool:USDC/USDT/100')
const rpc = chain.serve()
afterAll(() => rpc.stop())

function engine(all: EngineSession[], intents?: () => { paused: boolean; exitRequested: boolean }): Engine {
  return new Engine(
    { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: rpc.url, bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 800n, historyFromBlock: 800n, sessions: all, intents },
    { waitBlock: async () => {} },
  )
}

describe('one live review', () => {
  test('12 sessions and 3 positions: no request for the sessions, they are read in the first batch of the observation', async () => {
    const all = sessions()
    expect(new Set(all.map((s) => s.permissionId)).size).toBe(12)
    const e = engine(all)
    for (const id of [11n, 12n, 13n]) e.allowedTokenIds.push(id)
    expect((await e.review()).kind).toBe('decided')
    chain.head = 1150n
    chain.safe = 1050n
    chain.requests.length = 0
    const r = await e.review()
    expect(r.kind).toBe('decided')
    if (r.kind !== 'decided') throw new Error('unreachable')
    expect(r.op).toBeNull()
    expect(r.observation.positions.map((p) => p.pool)).toEqual(['pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000', 'pool:USDC/USDT/100'])
    // The account code is read at the safe block in this review, which settles that it is deployed.
    expect(chain.byMethod()).toEqual({ eth_chainId: 1, eth_getBlockByNumber: 5, eth_getCode: 1, eth_call: 2, eth_getLogs: 3 })
    // The session checks ride in the observation's first aggregate3, pinned to its block: every permission, once.
    const first = chain.requests.find((x) => x.method === 'eth_call')!
    expect(first.params[1]).toBe('0x47e')
    const inner = (decodeFunctionData({ abi: multicall3Abi, data: first.params[0].data }).args[0] as readonly { target: Address; callData: Hex }[]).filter((c) => c.target.toLowerCase() === address('SmartSession', baseRegistry).toLowerCase())
    expect(inner.length).toBe(12)
    expect(inner.map((c) => decodeFunctionData({ abi: smartSessionAbi, data: c.callData }).args![0])).toEqual(all.map((s) => s.permissionId))
  })

  test('a session removed on chain is revoked in the ledger, the others stay', async () => {
    const all = sessions()
    const e = engine(all)
    const gone = all[3]!
    chain.disabled.add(gone.permissionId.toLowerCase())
    await e.review()
    chain.disabled.clear()
    expect(e.ledger.get(gone.permissionId)?.revoked).toBe(true)
    expect(all.filter((s) => e.ledger.get(s.permissionId)?.revoked).length).toBe(1)
    // A revoked session is not asked for again.
    chain.requests.length = 0
    await e.review()
    const first = chain.requests.find((x) => x.method === 'eth_call')!
    const asked = (decodeFunctionData({ abi: multicall3Abi, data: first.params[0].data }).args[0] as readonly { target: Address }[]).filter((c) => c.target.toLowerCase() === address('SmartSession', baseRegistry).toLowerCase())
    expect(asked.length).toBe(11)
  })

  test('a provider behind the activation block revokes nothing: the review fails and every session stays', async () => {
    const all = sessions()
    const e = engine(all)
    const [head, safe] = [chain.head, chain.safe]
    // Before the activation the chain has none of the grants: every permission reads as not enabled.
    for (const s of all) chain.disabled.add(s.permissionId.toLowerCase())
    chain.head = e.historyFromBlock
    chain.safe = e.historyFromBlock - 10n
    let r: Awaited<ReturnType<Engine['review']>>
    try {
      r = await e.review()
    } finally {
      chain.disabled.clear()
      chain.head = head
      chain.safe = safe
    }
    expect(r).toMatchObject({ kind: 'observation-failed', code: 'OBS_BLOCK_INCONSISTENT' })
    expect(all.filter((s) => e.ledger.get(s.permissionId)?.revoked).length).toBe(0)
  })

  test('the observation block changes hash: the sessions it read as removed are not revoked', async () => {
    const all = sessions()
    const e = engine(all)
    chain.disabled.add(all[2]!.permissionId.toLowerCase())
    // The final read of the observation block answers another hash: the observation is not consistent.
    let blockReads = 0
    const before = chain.onRequest
    chain.onRequest = (r) => {
      if (r.method === 'eth_getBlockByNumber' && typeof r.params[0] === 'string' && r.params[0] !== 'safe' && r.params[0] !== 'latest') blockReads++
    }
    const hashOf = chain.hashOf.bind(chain)
    const head = chain.head
    chain.hashOf = (n: bigint) => (n === head && blockReads >= 1 ? (`0x${'ee'.repeat(32)}` as Hex) : hashOf(n))
    let r: Awaited<ReturnType<Engine['review']>>
    try {
      r = await e.review()
    } finally {
      chain.hashOf = hashOf
      chain.onRequest = before
      chain.disabled.clear()
    }
    expect(r).toMatchObject({ kind: 'observation-failed', code: 'OBS_BLOCK_INCONSISTENT' })
    expect(all.filter((s) => e.ledger.get(s.permissionId)?.revoked).length).toBe(0)
  })

  test('a session read that fails does not revoke anything: the review throws as before', async () => {
    const all = sessions()
    const e = engine(all)
    chain.failRead(address('SmartSession', baseRegistry), 'isPermissionEnabled(bytes32,address)')
    const err = await e.review().catch((x) => x)
    chain.reverting.clear()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ContractFunctionExecutionError')
    expect(all.some((s) => e.ledger.get(s.permissionId)?.revoked)).toBe(false)
  })
})

// A provider behind the engine's last operation shows the account as it was before it: the same step would be decided again.
describe('a review never observes before the last operation', () => {
  const inc = (blockNumber: bigint) => ({ included: { blockNumber, blockHash: '0x01' as Hex, txHash: '0x02' as Hex, success: true, actualGasCost: 0n } })

  test('the floor is the block of the latest operation that reached the chain', () => {
    expect(observationFloor([])).toBe(0n)
    expect(observationFloor([{}, inc(1200n), inc(1100n), {}])).toBe(1200n)
  })

  test('behind the floor the review fails as stale and decides nothing; at the floor it decides', async () => {
    const e = engine(sessions())
    for (const id of [11n, 12n, 13n]) e.allowedTokenIds.push(id)
    chain.head = 1150n
    chain.safe = 1050n
    const ops = (e.journal as unknown as { ops: unknown[] }).ops
    ops.push(inc(1151n))
    const behind = await e.review()
    expect(behind).toMatchObject({ kind: 'observation-failed', code: 'EHG_OBSERVATION_STALE' })
    chain.head = 1151n
    expect((await e.review()).kind).toBe('decided')
  })

  test('a view from before the floor revokes nothing: the grants a renewal just enabled are still there once the chain shows them', async () => {
    // Seen live on 13 Oct: the engine restarted on renewed grants, observed three blocks before the renewal, read
    // every one of them as not enabled and revoked them in its ledger for good.
    const all = sessions()
    const e = engine(all)
    for (const id of [11n, 12n, 13n]) e.allowedTokenIds.push(id)
    chain.head = 1200n
    chain.safe = 1100n
    e.minObservationBlock = 1203n
    for (const s of all) chain.disabled.add(s.permissionId.toLowerCase())
    expect(await e.review()).toMatchObject({ kind: 'observation-failed', code: 'EHG_OBSERVATION_STALE' })
    // The chain reaches the renewal: the grants are enabled, and the engine still has all of them.
    chain.disabled.clear()
    chain.head = 1203n
    const r = await e.review()
    expect(r.kind).toBe('decided')
    if (r.kind !== 'decided') throw new Error('unreachable')
    expect(r.observation.sessions.filter((x) => x.active)).toHaveLength(all.length)
  })

  test('a restored engine (empty journal) takes its floor from whoever restores it', async () => {
    const e = engine(sessions())
    for (const id of [11n, 12n, 13n]) e.allowedTokenIds.push(id)
    chain.head = 1151n
    chain.safe = 1050n
    e.minObservationBlock = 1160n
    expect(await e.review()).toMatchObject({ kind: 'observation-failed', code: 'EHG_OBSERVATION_STALE' })
    chain.head = 1160n
    expect((await e.review()).kind).toBe('decided')
  })
})

describe('the owner pause reaches decide (US6, PAUSE-01)', () => {
  test('the observation carries the intents the engine is given, read at every review', async () => {
    let paused = true
    const e = engine(sessions(), () => ({ paused, exitRequested: false }))
    for (const id of [11n, 12n, 13n]) e.allowedTokenIds.push(id)
    const a = await e.review()
    if (a.kind !== 'decided') throw new Error(`observation failed: ${a.code}`)
    expect(a.observation.intents.paused).toBe(true)
    expect(a.record.decision.reason).toBe('DECIDE_PAUSED')
    expect(a.op).toBeNull()
    paused = false
    const b = await e.review()
    if (b.kind !== 'decided') throw new Error(`observation failed: ${b.code}`)
    expect(b.observation.intents.paused).toBe(false)
    expect(b.record.decision.reason).not.toBe('DECIDE_PAUSED')
  })
})
