import { describe, expect, test } from 'bun:test'
import type { FundingView, OtherChainsView, OwnerResponse } from '@mamoru/domain'
import { CACHE_MS, WATCHED_CHAINS, type ChainFetch } from '../../src/api/accounts/other-chains.ts'
import { harness, register, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'

const RPC = 'https://l1.example/rpc-key'
const USDC_L1 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const T0 = new Date('2026-10-07T10:00:00Z')

type Call = { id: number; method: string; params: unknown[] }
type Node = { chainId?: number; block?: number; usdc?: bigint; eth?: bigint; answer?: (call: Call) => unknown; http?: number; calls: Call[]; urls: string[] }

/** An Ethereum node that answers JSON-RPC batches. `answer` overrides one result; returning undefined makes that call an RPC error. */
function node(over: Partial<Node> = {}): Node & { fetch: ChainFetch } {
  const n: Node = { chainId: 1, block: 21_000_000, usdc: 0n, eth: 0n, calls: [], urls: [], ...over }
  const fetch: ChainFetch = async (input, init) => {
    n.urls.push(input)
    if (n.http) return new Response('nope', { status: n.http })
    const batch = JSON.parse(String(init.body)) as Call[]
    n.calls.push(...batch)
    return Response.json(
      batch.map((call) => {
        const result = n.answer
          ? n.answer(call)
          : call.method === 'eth_chainId'
            ? `0x${n.chainId!.toString(16)}`
            : call.method === 'eth_blockNumber'
              ? `0x${n.block!.toString(16)}`
              : call.method === 'eth_call'
                ? `0x${n.usdc!.toString(16).padStart(64, '0')}`
                : `0x${n.eth!.toString(16)}`
        return result === undefined ? { jsonrpc: '2.0', id: call.id, error: { code: -32000, message: 'boom' } } : { jsonrpc: '2.0', id: call.id, result }
      }),
    )
  }
  return Object.assign(n, { fetch })
}

async function onboard(h: ReturnType<typeof harness>, passkey = PASSKEY_A) {
  const res = await register(h, passkey)
  return { cookie: sessionCookie(res), owner: (await res.json()) as OwnerResponse }
}

async function read(h: ReturnType<typeof harness>, cookie: string, key: string) {
  const res = await h.request(`/api/accounts/${key}/other-chains`, { cookie })
  expect(res.status).toBe(200)
  return (await res.json()) as OtherChainsView
}

describe('other chains: USDC sent on Ethereum to the Base address (#117)', () => {
  test('reports the amount on chain id 1, at one block, for the account address only', async () => {
    const n = node({ usdc: 150_000_000n, eth: 7n })
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URL: RPC }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    const v = await read(h, cookie, owner.accountKey)

    expect(v).toEqual({
      address: owner.address,
      accountChainId: 8453,
      chains: [{ chainId: 1, name: 'Ethereum', status: 'observed', block: 21_000_000, usdc: '150000000', eth: '7', observedAt: T0.toISOString() }],
    })
    const call = n.calls.find((c) => c.method === 'eth_call')!
    expect(call.params).toEqual([{ to: USDC_L1, data: `0x70a08231${owner.address.slice(2).toLowerCase().padStart(64, '0')}` }, '0x1406f40'])
    expect(n.calls.find((c) => c.method === 'eth_getBalance')!.params).toEqual([owner.address, '0x1406f40'])
    expect(new Set(n.urls)).toEqual(new Set([RPC]))
  })

  test('the Base balance and the dashboard do not change: the amount on Ethereum is credited nowhere', async () => {
    const n = node({ usdc: 150_000_000n })
    const baseFunding = { usdc: '0', eth: '0', cbbtc: '0', active: false, positions: [] } as unknown as FundingView
    const operatorFetch = async () => Response.json(baseFunding)
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URL: RPC, LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.example', OPERATOR_SECRET: 'operator-secret' }, chainFetch: n.fetch, operatorFetch })
    const { cookie, owner } = await onboard(h)
    const tables = () => h.db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    const snapshot = () => JSON.stringify(tables().filter((t) => !/session|activity|rate|challenge/i.test(t.name)).map((t) => [t.name, h.db.raw.query(`SELECT * FROM ${t.name}`).all()]))
    const before = snapshot()
    const dashBefore = await (await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie })).text()

    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ chainId: 1, usdc: '150000000' })

    const funding = (await (await h.request(`/api/accounts/${owner.accountKey}/funding`, { cookie })).json()) as FundingView
    expect(funding.usdc).toBe('0')
    expect(await (await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie })).text()).toBe(dashBefore)
    expect(snapshot()).toBe(before)
    expect(h.db.raw.query('SELECT chain_id FROM accounts').all()).toEqual([{ chain_id: 8453 }])
  })

  test('a node that is not Ethereum is not observed: a Base balance is never shown as an Ethereum one', async () => {
    for (const chainId of [8453, 10, 143]) {
      const n = node({ chainId, usdc: 99_000_000n })
      const h = harness(() => T0, { env: { ETHEREUM_RPC_URL: RPC }, chainFetch: n.fetch })
      const { cookie, owner } = await onboard(h)
      const v = await read(h, cookie, owner.accountKey)
      expect(v.chains).toEqual([{ chainId: 1, name: 'Ethereum', status: 'not_observed', observedAt: T0.toISOString() }])
      expect(n.calls.some((c) => c.method === 'eth_call')).toBe(false)
    }
  })

  test('a node that changes chain between the two batches is not observed', async () => {
    let asked = 0
    const n = node({ usdc: 5n })
    n.answer = (call) => (call.method === 'eth_chainId' ? (asked++ === 0 ? '0x1' : '0x2105') : call.method === 'eth_blockNumber' ? '0x10' : call.method === 'eth_call' ? `0x${'0'.repeat(63)}5` : '0x0')
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URL: RPC }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
  })

  test('no RPC configured: nothing is fetched and nothing is claimed', async () => {
    const n = node({ usdc: 1n })
    const h = harness(() => T0, { chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    expect((await read(h, cookie, owner.accountKey)).chains).toEqual([{ chainId: 1, name: 'Ethereum', status: 'not_observed', observedAt: T0.toISOString() }])
    expect(n.urls).toEqual([])
  })

  test('failures read as not observed, never as zero', async () => {
    const broken: Partial<Node>[] = [
      { http: 500 },
      { answer: (c) => (c.method === 'eth_chainId' ? '0x1' : c.method === 'eth_blockNumber' ? '0x10' : c.method === 'eth_call' ? undefined : '0x0') },
      { answer: (c) => (c.method === 'eth_chainId' ? '0x1' : c.method === 'eth_blockNumber' ? '0x10' : c.method === 'eth_call' ? '0x' : '0x0') },
      { answer: (c) => (c.method === 'eth_chainId' ? '0x1' : c.method === 'eth_blockNumber' ? '0x10' : c.method === 'eth_call' ? `0x${'0'.repeat(64)}` : 'lots') },
      { answer: (c) => (c.method === 'eth_chainId' ? '0x1' : c.method === 'eth_blockNumber' ? null : '0x0') },
    ]
    for (const b of broken) {
      const h = harness(() => T0, { env: { ETHEREUM_RPC_URL: RPC }, chainFetch: node(b).fetch })
      const { cookie, owner } = await onboard(h)
      const row = (await read(h, cookie, owner.accountKey)).chains[0]!
      expect(row).toEqual({ chainId: 1, name: 'Ethereum', status: 'not_observed', observedAt: T0.toISOString() })
    }
    const thrower: ChainFetch = async () => {
      throw new Error(`connect failed ${RPC}`)
    }
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URL: RPC }, chainFetch: thrower })
    const { cookie, owner } = await onboard(h)
    expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
  })

  test('only the owner reads it; another session and no session get what the dashboard gives them', async () => {
    const n = node({ usdc: 150_000_000n })
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URL: RPC }, chainFetch: n.fetch })
    const a = await onboard(h, PASSKEY_A)
    const b = await onboard(h, PASSKEY_B)
    expect((await h.request(`/api/accounts/${a.owner.accountKey}/other-chains`)).status).toBe(401)
    expect((await h.request(`/api/accounts/${a.owner.accountKey}/other-chains`, { cookie: b.cookie })).status).toBe(404)
    expect((await h.request('/api/accounts/not-a-key/other-chains', { cookie: a.cookie })).status).toBe(404)
    expect(n.calls).toEqual([])
    const vb = await read(h, b.cookie, b.owner.accountKey)
    expect(vb.address).toBe(b.owner.address)
    expect(JSON.stringify(n.calls)).not.toContain(a.owner.address.slice(2).toLowerCase())
  })

  test('one read per account inside the cache window; a failed read is not kept', async () => {
    let now = T0
    const n = node({ usdc: 1_000_000n })
    const h = harness(() => now, { env: { ETHEREUM_RPC_URL: RPC }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    await read(h, cookie, owner.accountKey)
    n.usdc = 2_000_000n
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ usdc: '1000000' })
    expect(n.urls.length).toBe(2)
    now = new Date(T0.getTime() + CACHE_MS)
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ usdc: '2000000' })

    n.http = 502
    now = new Date(now.getTime() + CACHE_MS)
    expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
    n.http = undefined
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ status: 'observed', usdc: '2000000' })
  })

  test('the watch list is Ethereum only and never the chain Mamoru runs on', () => {
    expect(WATCHED_CHAINS).toEqual([{ chainId: 1, name: 'Ethereum', usdc: USDC_L1 }])
    expect(WATCHED_CHAINS.some((w) => w.chainId === 8453)).toBe(false)
  })
})
