import { afterAll, describe, expect, test } from 'bun:test'
import { decodeFunctionData, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address } from '@mamoru/domain'
import { POLICIES, grantKey, instantiateGrant } from '@mamoru/policy'
import { address, smartSessionAbi } from '@mamoru/registry'
import { multicall3Abi } from '@mamoru/rpc'
import { permissionIdOf, toSmartSession } from '@mamoru/account/sessions'
import { FakeChain } from '../../rpc/test/fake-chain.ts'
import { Engine, type EngineSession } from './engine.ts'

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

function engine(all: EngineSession[]): Engine {
  return new Engine(
    { mode: 'live', chainId: 8453, signingChainIds: [8453], rpcUrl: rpc.url, bundlerUrl: 'http://127.0.0.1:9/', policy, account: ACCOUNT, sessionKey, nonceLane: 0, depositsAfter: 800n, historyFromBlock: 800n, sessions: all },
    { waitBlock: async () => {} },
  )
}

describe('one live review', () => {
  test('12 sessions and 3 positions: one request for the sessions, eleven for the observation', async () => {
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
    expect(chain.byMethod()).toEqual({ eth_chainId: 1, eth_getBlockByNumber: 5, eth_getCode: 1, eth_call: 3, eth_getLogs: 2 })
    // The session checks are the first request: every permission in one aggregate3.
    const first = chain.requests.find((x) => x.method === 'eth_call')!
    const inner = decodeFunctionData({ abi: multicall3Abi, data: first.params[0].data }).args[0] as readonly { target: Address; callData: Hex }[]
    expect(inner.length).toBe(12)
    expect(inner.every((c) => c.target.toLowerCase() === address('SmartSession').toLowerCase())).toBe(true)
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
    expect((decodeFunctionData({ abi: multicall3Abi, data: first.params[0].data }).args[0] as unknown[]).length).toBe(11)
  })

  test('a session read that fails does not revoke anything: the review throws as before', async () => {
    const all = sessions()
    const e = engine(all)
    chain.failRead(address('SmartSession'), 'isPermissionEnabled(bytes32,address)')
    const err = await e.review().catch((x) => x)
    chain.reverting.clear()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ContractFunctionExecutionError')
    expect(all.some((s) => e.ledger.get(s.permissionId)?.revoked)).toBe(false)
  })
})
