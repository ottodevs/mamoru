// otto/mamoru#172: the engine keeps each position's out-of-range clock and, under `range.lazy`, reads the pools'
// fee growth for the cost test. Against the fake chain: no operation is sent.
import { afterAll, describe, expect, test } from 'bun:test'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { DEFAULT_ENGINE_SETTINGS, ENGINE_SETTINGS_TEMPLATES, grantKey, instantiateGrant, POLICIES, withEngineSettings, type PolicyVersion } from '@mamoru/policy'
import { GUARD_CALLS_PER_POOL, SharedGuardReads } from '@mamoru/rpc'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { FakeChain } from '../../rpc/test/fake-chain.ts'
import { Engine, type EngineSession } from './engine.ts'

const ACCOUNT = '0x00000000000000000000000000000000000000aa' as Address
const V2 = POLICIES['conservador-live-v2']!
const LAZY = withEngineSettings(V2, ENGINE_SETTINGS_TEMPLATES['conservador-live-v2 + lazy-h24h-b100-d30']!)
const sessionKey = privateKeyToAccount(generatePrivateKey())

function sessions(): EngineSession[] {
  const caps = new Proxy({}, { get: () => 10n ** 12n }) as Record<string, bigint>
  return V2.session.grants
    .filter((g) => !g.perPosition)
    .map((g, i) => {
      const grant = instantiateGrant(V2, grantKey(g), { account: ACCOUNT, sessionKey: sessionKey.address, chainId: 8453, salt: `0x${(i + 1).toString(16).padStart(64, '0')}`, validAfter: 0, validUntil: 2_000_000_000, caps, admittedTokenIds: [] })
      return { name: grantKey(g), grant, permissionId: permissionIdOf(toSmartSession(grant)) }
    })
}

const chain = new FakeChain()
chain.code.set(ACCOUNT.toLowerCase(), '0x6001')
// The fake cbBTC pool sits at tick 10: this range is out of range below it, past the 100-tick buffer.
chain.addPosition(ACCOUNT, 11n, 'pool:USDC/cbBTC/500')
Object.assign(chain.positions[0]!, { tickLower: 200, tickUpper: 800 })
const rpc = chain.serve()
afterAll(() => rpc.stop())

function engine(policy: PolicyVersion, shared?: SharedGuardReads): Engine {
  const guardHistory = shared ? { pools: policy.buckets.flatMap((b) => b.pools), shared } : undefined
  const e = new Engine(
    { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: rpc.url, bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 800n, historyFromBlock: 800n, sessions: sessions(), ...(guardHistory ? { guardHistory } : {}) },
    { waitBlock: async () => {} },
  )
  e.allowedTokenIds.push(11n)
  return e
}

describe('engine: lazy re-range history (otto/mamoru#172)', () => {
  test('a lazy engine that just started holds the out-of-range position, keeps its clock, and reads fee growth', async () => {
    const shared = new SharedGuardReads()
    const fees = shared.fees
    const e = engine(LAZY, shared)
    const r1 = await e.review()
    if (r1.kind !== 'decided') throw new Error(`observation failed: ${r1.code}`)
    const t1 = r1.observation.block.timestamp
    expect(r1.observation.positions[0]!.outOfRangeSince).toBe(t1)
    expect(r1.record.decision.positions[0]!.codes).toContain('DECIDE_RANGE_COOLDOWN')
    expect(r1.record.decision.positions[0]!.codes).not.toContain('DECIDE_RANGE_ADJUST')
    expect(r1.op).toBeNull()
    // Cold history: the cost test would abstain, never guess.
    expect(r1.observation.guard?.pools['pool:USDC/cbBTC/500']?.feeGrowth24h).toBeNull()
    expect(fees.get('pool:USDC/cbBTC/500')?.length).toBe(1)
    chain.head += 10n
    const r2 = await e.review()
    if (r2.kind !== 'decided') throw new Error(`observation failed: ${r2.code}`)
    expect(r2.observation.block.timestamp).toBeGreaterThan(t1)
    expect(r2.observation.positions[0]!.outOfRangeSince).toBe(t1)
    expect(r2.op).toBeNull()
  })

  test('N lazy engines reviewing the same pools within a minute: one guard read per pool for all of them', async () => {
    const shared = new SharedGuardReads()
    const engines = Array.from({ length: 5 }, () => engine(LAZY, shared))
    chain.head += 10n
    chain.guardCalls = 0
    for (const e of engines) {
      const r = await e.review()
      if (r.kind !== 'decided') throw new Error(`observation failed: ${r.code}`)
      expect(r.observation.guard?.pools['pool:WETH/USDC/3000']).toBeDefined()
      chain.head += 2n
    }
    expect(shared.counts.batches).toBe(1)
    expect(chain.guardCalls).toBe(3 * GUARD_CALLS_PER_POOL)
    // A minute of blocks later (2 s each), the next review reads again, once.
    chain.head += 30n
    for (const e of engines) await e.review()
    expect(shared.counts.batches).toBe(2)
    expect(chain.guardCalls).toBe(2 * 3 * GUARD_CALLS_PER_POOL)
  })

  test('eager: the observation carries no out-of-range clock and no fee growth, as before', async () => {
    const e = engine(withEngineSettings(V2, DEFAULT_ENGINE_SETTINGS))
    // The eager review would propose the re-range and try to send it; only the observation matters here.
    const obs = await e.observe()
    expect('outOfRangeSince' in obs.positions[0]!).toBe(false)
    expect(obs.guard).toBeUndefined()
  })
})
