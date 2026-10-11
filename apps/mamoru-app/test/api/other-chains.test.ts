import { describe, expect, test } from 'bun:test'
import { decodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector } from 'viem'
import type { FundingView, OtherChainsView, OwnerResponse } from '@mamoru/domain'
import { CACHE_MS, FAIL_MS, MAX_PROVIDERS, PENDING_MS, providerUrls, ReadGate, RPC_TIMEOUT_MS, WATCHED_CHAINS, type ChainFetch } from '../../src/api/accounts/other-chains.ts'
import { harness, register, PASSKEY_A, PASSKEY_B, sessionCookie } from './helpers.ts'

const RPC = 'https://l1.example/rpc-key'
const USDC_L1 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const T0 = new Date('2026-10-07T10:00:00Z')
const NOT_OBSERVED = [{ chainId: 1, name: 'Ethereum', status: 'not_observed', observedAt: T0.toISOString() }]

const abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
])
const SEL = {
  chainId: toFunctionSelector('function getChainId()'),
  block: toFunctionSelector('function getBlockNumber()'),
  eth: toFunctionSelector('function getEthBalance(address)'),
  usdc: toFunctionSelector('function balanceOf(address)'),
}
const word = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, '0')}` as const

type Inner = { target: string; callData: string }
type Result = { success: boolean; returnData: `0x${string}` }
type Node = {
  chainId: number
  block: number
  usdc: bigint
  eth: bigint
  /** Bends one inner result. */
  inner?: (call: Inner, honest: Result) => Result
  /** Replaces the whole JSON-RPC answer. */
  answer?: () => unknown
  http?: number
  wait?: Promise<void>
  requests: { url: string; method: string; to: string; tag: unknown }[]
  inners: Inner[]
}

/** One chain behind a JSON-RPC endpoint. Every value of an aggregate3 answer comes from this one state, as on a real node. */
function node(over: Partial<Node> = {}): Node & { fetch: ChainFetch } {
  const n: Node = { chainId: 1, block: 21_000_000, usdc: 0n, eth: 0n, requests: [], inners: [], ...over }
  const fetch: ChainFetch = async (input, init) => {
    const req = JSON.parse(String(init.body)) as { id: number; method: string; params: [{ to: string; data: `0x${string}` }, unknown] }
    n.requests.push({ url: input, method: req.method, to: req.params[0].to, tag: req.params[1] })
    if (n.wait) await n.wait
    if (n.http) return new Response('nope', { status: n.http })
    if (n.answer) return Response.json(n.answer())
    const { args } = decodeFunctionData({ abi, data: req.params[0].data })
    const results = args[0].map((call) => {
      n.inners.push({ target: call.target, callData: call.callData })
      const sel = call.callData.slice(0, 10)
      const honest: Result =
        sel === SEL.chainId ? { success: true, returnData: word(n.chainId) }
        : sel === SEL.block ? { success: true, returnData: word(n.block) }
        : sel === SEL.eth ? { success: true, returnData: word(n.eth) }
        : { success: true, returnData: word(n.usdc) }
      return n.inner ? n.inner(call, honest) : honest
    })
    return Response.json({ jsonrpc: '2.0', id: req.id, result: encodeFunctionResult({ abi, functionName: 'aggregate3', result: results }) })
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
  test('reports the amount on chain id 1 for the account address only, from one call to Multicall3', async () => {
    const n = node({ usdc: 150_000_000n, eth: 7n })
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    const v = await read(h, cookie, owner.accountKey)

    expect(v).toEqual({
      address: owner.address,
      accountChainId: 8453,
      chains: [{ chainId: 1, name: 'Ethereum', status: 'observed', block: 21_000_000, usdc: '150000000', eth: '7', observedAt: T0.toISOString() }],
    })
    // One request, one EVM execution: the chain id, the block and both balances cannot come from different places.
    expect(n.requests).toEqual([{ url: RPC, method: 'eth_call', to: MULTICALL3, tag: 'latest' }])
    const padded = owner.address.slice(2).toLowerCase().padStart(64, '0')
    expect(n.inners).toEqual([
      { target: MULTICALL3, callData: SEL.chainId },
      { target: MULTICALL3, callData: SEL.block },
      { target: MULTICALL3, callData: `${SEL.eth}${padded}` },
      { target: USDC_L1, callData: `${SEL.usdc}${padded}` },
    ])
  })

  test('the Base balance and the dashboard do not change: the amount on Ethereum is credited nowhere', async () => {
    const n = node({ usdc: 150_000_000n })
    const baseFunding = { usdc: '0', eth: '0', cbbtc: '0', active: false, positions: [] } as unknown as FundingView
    const operatorCalls: string[] = []
    const operatorFetch = async (input: string) => {
      operatorCalls.push(new URL(input).pathname)
      return Response.json(baseFunding)
    }
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC, LIVE_FUNDS: '1', OPERATOR_URL: 'https://operator.example', OPERATOR_SECRET: 'operator-secret' }, chainFetch: n.fetch, operatorFetch })
    const { cookie, owner } = await onboard(h)
    const tables = () => h.db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]
    const snapshot = () => JSON.stringify(tables().filter((t) => !/session|activity|rate|challenge/i.test(t.name)).map((t) => [t.name, h.db.raw.query(`SELECT * FROM ${t.name}`).all()]))
    const before = snapshot()
    const dashBefore = await (await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie })).text()

    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ chainId: 1, usdc: '150000000' })
    // The read does not talk to the operator at all.
    expect(operatorCalls).toEqual([])

    const funding = (await (await h.request(`/api/accounts/${owner.accountKey}/funding`, { cookie })).json()) as FundingView
    expect(funding.usdc).toBe('0')
    expect(await (await h.request(`/api/accounts/${owner.accountKey}/dashboard`, { cookie })).text()).toBe(dashBefore)
    expect(snapshot()).toBe(before)
    expect(h.db.raw.query('SELECT chain_id FROM accounts').all()).toEqual([{ chain_id: 8453 }])
  })

  test('a node on another chain is not observed, whatever balances it holds: a Base amount is never labelled Ethereum', async () => {
    for (const chainId of [8453, 10, 143]) {
      // The same address holds ETH and (hypothetically) a token at the USDC address on that chain.
      const n = node({ chainId, usdc: 99_000_000n, eth: 1_000_000_000_000_000_000n })
      const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch: n.fetch })
      const { cookie, owner } = await onboard(h)
      const text = await (await h.request(`/api/accounts/${owner.accountKey}/other-chains`, { cookie })).text()
      expect((JSON.parse(text) as OtherChainsView).chains).toEqual(NOT_OBSERVED as OtherChainsView['chains'])
      expect(text).not.toContain('99000000')
      expect(text).not.toContain('1000000000000000000')
    }
  })

  test('Base as it really is (no code at the Ethereum USDC address, ETH at the Safe) is not observed', async () => {
    const n = node({ chainId: 8453, eth: 1_000_000_000_000_000_000n, inner: (call, honest) => (call.target === USDC_L1 ? { success: true, returnData: '0x' } : honest) })
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    expect((await read(h, cookie, owner.accountKey)).chains).toEqual(NOT_OBSERVED as OtherChainsView['chains'])
  })

  test('no RPC configured: nothing is fetched and nothing is claimed', async () => {
    const n = node({ usdc: 1n })
    const h = harness(() => T0, { chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    expect((await read(h, cookie, owner.accountKey)).chains).toEqual(NOT_OBSERVED as OtherChainsView['chains'])
    expect(n.requests).toEqual([])
  })

  test('failures read as not observed, never as zero', async () => {
    const one = (r: Result) => encodeFunctionResult({ abi, functionName: 'aggregate3', result: [r] })
    const broken: Partial<Node>[] = [
      { http: 500 },
      { answer: () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }) },
      { answer: () => ({ jsonrpc: '2.0', id: 1, result: '0x' }) },
      { answer: () => ({ jsonrpc: '2.0', id: 1, result: 'lots' }) },
      { answer: () => ({ jsonrpc: '2.0', id: 1, result: word(0) }) },
      { answer: () => [{ jsonrpc: '2.0', id: 1, result: word(0) }] },
      { answer: () => ({ jsonrpc: '2.0', id: 1, result: one({ success: true, returnData: word(1) }) }) },
      { answer: () => null },
      { inner: (call, honest) => (call.target === USDC_L1 ? { success: false, returnData: '0x' } : honest) },
      { inner: (call, honest) => (call.target === USDC_L1 ? { success: true, returnData: '0x' } : honest) },
      { inner: (call, honest) => (call.target === USDC_L1 ? { success: true, returnData: `${word(5)}00` } : honest) },
      { inner: (call, honest) => (call.callData.startsWith(SEL.eth) ? { success: false, returnData: word(5) } : honest) },
      { inner: (call, honest) => (call.callData === SEL.block ? { success: true, returnData: word(2n ** 60n) } : honest) },
    ]
    for (const b of broken) {
      const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch: node({ usdc: 5n, eth: 5n, ...b }).fetch })
      const { cookie, owner } = await onboard(h)
      expect((await read(h, cookie, owner.accountKey)).chains).toEqual(NOT_OBSERVED as OtherChainsView['chains'])
    }
  })

  test('the RPC URL never reaches the log or the response, whatever the failure quotes', async () => {
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    try {
      const failures: ChainFetch[] = [
        async () => {
          throw new Error(`connect failed ${RPC}`)
        },
        async () => new Response(`not json, from ${RPC}`, { status: 200 }),
        async () => new Response(RPC, { status: 502 }),
        async () => Response.json({ id: 1, error: { message: RPC } }),
        async () => Response.json({ id: 1, result: RPC }),
      ]
      for (const chainFetch of failures) {
        const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch })
        const { cookie, owner } = await onboard(h)
        const text = await (await h.request(`/api/accounts/${owner.accountKey}/other-chains`, { cookie })).text()
        expect(text).not.toContain('l1.example')
        expect((JSON.parse(text) as OtherChainsView).chains[0]!.status).toBe('not_observed')
      }
    } finally {
      console.error = original
    }
    expect(logged.length).toBe(5)
    expect(logged.join('\n')).not.toContain('l1.example')
    expect(logged.join('\n')).not.toContain('rpc-key')
  })

  test('only the owner reads it; another session and no session get what the dashboard gives them', async () => {
    const n = node({ usdc: 150_000_000n })
    const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch: n.fetch })
    const a = await onboard(h, PASSKEY_A)
    const b = await onboard(h, PASSKEY_B)
    expect((await h.request(`/api/accounts/${a.owner.accountKey}/other-chains`)).status).toBe(401)
    expect((await h.request(`/api/accounts/${a.owner.accountKey}/other-chains`, { cookie: b.cookie })).status).toBe(404)
    expect((await h.request('/api/accounts/not-a-key/other-chains', { cookie: a.cookie })).status).toBe(404)
    expect(n.requests).toEqual([])
    const vb = await read(h, b.cookie, b.owner.accountKey)
    expect(vb.address).toBe(b.owner.address)
    expect(JSON.stringify(n.inners)).not.toContain(a.owner.address.slice(2).toLowerCase())
    // A read cached for one owner is not served to the other.
    const va = await read(h, a.cookie, a.owner.accountKey)
    expect(va.address).toBe(a.owner.address)
    expect(n.requests.length).toBe(2)
  })

  test('one read per account inside the cache window, sequential or at the same time', async () => {
    let now = T0
    let release = () => {}
    const n = node({ usdc: 1_000_000n, wait: new Promise<void>((r) => (release = r)) })
    const h = harness(() => now, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)

    // Ten requests at once: one RPC request. The nine that did not read answer at once, without waiting for the first.
    const first = read(h, cookie, owner.accountKey)
    await new Promise((r) => setTimeout(r, 20))
    const others = await Promise.all(Array.from({ length: 9 }, () => read(h, cookie, owner.accountKey)))
    expect(n.requests.length).toBe(1)
    for (const v of others) expect(v.chains).toEqual(NOT_OBSERVED as OtherChainsView['chains'])
    release()
    expect((await first).chains[0]).toMatchObject({ status: 'observed', usdc: '1000000' })

    n.wait = undefined
    n.usdc = 2_000_000n
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ usdc: '1000000' })
    now = new Date(T0.getTime() + CACHE_MS - 1)
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ usdc: '1000000' })
    expect(n.requests.length).toBe(1)
    now = new Date(T0.getTime() + CACHE_MS)
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ usdc: '2000000' })
    expect(n.requests.length).toBe(2)
  })

  test('a read whose request went away never settles: nobody waits on it and the next read starts once its time is up', async () => {
    let now = T0
    // The first read hangs for ever, as when Workers cancels the request that started it.
    const n = node({ usdc: 3_000_000n, wait: new Promise<void>(() => {}) })
    const h = harness(() => now, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    void read(h, cookie, owner.accountKey).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 20))
    expect(n.requests.length).toBe(1)

    n.wait = undefined
    const answered = await Promise.race([read(h, cookie, owner.accountKey), new Promise<'hung'>((r) => setTimeout(() => r('hung'), 500))])
    expect(answered).not.toBe('hung')
    expect((answered as OtherChainsView).chains).toEqual(NOT_OBSERVED as OtherChainsView['chains'])
    now = new Date(T0.getTime() + PENDING_MS - 1)
    expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
    expect(n.requests.length).toBe(1)

    now = new Date(T0.getTime() + PENDING_MS)
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ status: 'observed', usdc: '3000000' })
    expect(n.requests.length).toBe(2)
    expect(PENDING_MS).toBeGreaterThan(RPC_TIMEOUT_MS * MAX_PROVIDERS)
  })

  test('a full table does not erase a read under way or a backoff: a new account waits instead', () => {
    const t = T0.getTime()
    const ok = (usdc: string): OtherChainsView => ({ address: `0x${'1'.repeat(40)}`, accountChainId: 8453, chains: [{ chainId: 1, name: 'Ethereum', status: 'observed', block: 1, usdc, eth: '0', observedAt: T0.toISOString() }] })
    const failed: OtherChainsView = { address: `0x${'1'.repeat(40)}`, accountChainId: 8453, chains: NOT_OBSERVED as OtherChainsView['chains'] }
    const gate = new ReadGate(3)
    const reading2 = (g: ReadGate, key: string, at: number) => {
      const a = g.admit(key, at)
      if (a.kind !== 'read') throw new Error(`${key} was not admitted: ${a.kind}`)
      return a.done
    }
    const reading = (key: string, at: number) => {
      const a = gate.admit(key, at)
      if (a.kind !== 'read') throw new Error(`${key} was not admitted: ${a.kind}`)
      return a.done
    }
    reading('pending', t)
    reading('failed', t)(failed, t)
    reading('ok', t)(ok('5'), t)

    // Full, and every slot is live: the newcomer is not tracked and nothing is thrown away.
    expect(gate.admit('new', t + 1).kind).toBe('full')
    expect(gate.admit('pending', t + 1).kind).toBe('busy')
    expect(gate.admit('failed', t + 1)).toEqual({ kind: 'cached', view: failed })
    expect(gate.admit('ok', t + 1)).toEqual({ kind: 'cached', view: ok('5') })

    // Only slots whose own time is up make room: the failure after 10 s, while the good read stays its 30 s.
    expect(FAIL_MS).toBeLessThan(PENDING_MS)
    expect(gate.admit('new', t + FAIL_MS - 1).kind).toBe('full')
    expect(gate.admit('new', t + FAIL_MS).kind).toBe('read')
    expect(gate.admit('ok', t + FAIL_MS)).toEqual({ kind: 'cached', view: ok('5') })
    // The read under way keeps its slot until its own, longer, time is up.
    expect(gate.admit('other', t + PENDING_MS - 1).kind).toBe('full')
    expect(gate.admit('other', t + PENDING_MS).kind).toBe('read')
    expect(gate.admit('third', t + PENDING_MS).kind).toBe('full')

    // A read that took long: the backoff and the cache window run from when it ended, so three providers timing
    // out one after the other (12 s) do not use up a 10 s backoff before it starts.
    const slow = new ReadGate(2)
    reading2(slow, 'f', t)(failed, t + 12_000)
    expect(slow.admit('f', t + 12_000 + FAIL_MS - 1)).toEqual({ kind: 'cached', view: failed })
    expect(slow.admit('f', t + 12_000 + FAIL_MS).kind).toBe('read')
    reading2(slow, 'g', t)(ok('7'), t + 3_000)
    expect(slow.admit('g', t + 3_000 + CACHE_MS - 1)).toEqual({ kind: 'cached', view: ok('7') })
    expect(slow.admit('g', t + 3_000 + CACHE_MS).kind).toBe('read')

    // A read that was cancelled gives its slot back; cancelling late does not remove a newer slot.
    const c = new ReadGate(1)
    const c1 = c.admit('a', t)
    if (c1.kind !== 'read') throw new Error('not admitted')
    c1.cancel()
    const c2 = c.admit('b', t)
    expect(c2.kind).toBe('read')
    c1.cancel()
    expect(c.admit('b', t + 1).kind).toBe('busy')

    // A result that arrives after its slot was replaced does not overwrite the newer one.
    const g = new ReadGate(3)
    const a1 = g.admit('k', t)
    const a2 = g.admit('k', t + PENDING_MS)
    if (a1.kind !== 'read' || a2.kind !== 'read') throw new Error('not admitted')
    a2.done(ok('9'), t + PENDING_MS)
    a1.done(ok('1'), t + PENDING_MS)
    expect(g.admit('k', t + PENDING_MS + 1)).toEqual({ kind: 'cached', view: ok('9') })
    // A clock that went backwards is not a hit.
    expect(g.admit('k', t - 1).kind).toBe('read')
  })

  test('a failed read is not repeated for 10 s and is never kept as long as a good one', async () => {
    let now = T0
    const n = node({ usdc: 2_000_000n, http: 502 })
    const h = harness(() => now, { env: { ETHEREUM_RPC_URLS: RPC }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)
    for (let i = 0; i < 5; i++) expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
    expect(n.requests.length).toBe(1)

    n.http = undefined
    now = new Date(T0.getTime() + FAIL_MS - 1)
    expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
    expect(n.requests.length).toBe(1)
    now = new Date(T0.getTime() + FAIL_MS)
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ status: 'observed', usdc: '2000000' })
    expect(n.requests.length).toBe(2)
    expect(FAIL_MS).toBeLessThan(CACHE_MS)
  })

  test('a failure that took 12 s to happen is still not repeated for 10 s after it', async () => {
    let now = T0
    const n = node({ http: 503 })
    // Each provider call takes 4 s of the clock, as a timeout would.
    const chainFetch: ChainFetch = async (input, init) => {
      now = new Date(now.getTime() + RPC_TIMEOUT_MS)
      return n.fetch(input, init)
    }
    const h = harness(() => now, { env: { ETHEREUM_RPC_URLS: 'https://a.example/k,https://b.example/k,https://c.example/k' }, chainFetch })
    const { cookie, owner } = await onboard(h)
    expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
    expect(n.requests.length).toBe(3)
    expect(now.getTime() - T0.getTime()).toBe(12_000)
    expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
    now = new Date(now.getTime() + FAIL_MS - 1)
    expect((await read(h, cookie, owner.accountKey)).chains[0]!.status).toBe('not_observed')
    expect(n.requests.length).toBe(3)
    now = new Date(now.getTime() + 1)
    await read(h, cookie, owner.accountKey)
    expect(n.requests.length).toBe(6)
  })

  test('rate limiter: an account over its limit is not read, a cached answer costs nothing, and the key is the account', async () => {
    let now = T0
    const keys: string[] = []
    let left = 1
    const limiter = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: left-- > 0 }) }
    const n = node({ usdc: 4_000_000n })
    const h = harness(() => now, { env: { ETHEREUM_RPC_URLS: RPC, OTHER_CHAINS_LIMIT: limiter }, chainFetch: n.fetch })
    const { cookie, owner } = await onboard(h)

    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ status: 'observed', usdc: '4000000' })
    // Served from the gate: the limiter is not asked.
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ status: 'observed' })
    expect(keys).toEqual([owner.accountKey])

    // The window is over and the limiter says no: nothing is read, and the refusal leaves no slot behind.
    now = new Date(T0.getTime() + CACHE_MS)
    expect((await read(h, cookie, owner.accountKey)).chains).toEqual([{ chainId: 1, name: 'Ethereum', status: 'not_observed', observedAt: now.toISOString() }])
    expect(n.requests.length).toBe(1)
    left = 1
    expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ status: 'observed' })
    expect(n.requests.length).toBe(2)
    expect(keys).toEqual([owner.accountKey, owner.accountKey, owner.accountKey])
  })

  test('a full table: with the limiter the newcomer is still read, without it (or with it broken) it is not', async () => {
    const fill = (gate: ReadGate) => {
      if (gate.admit('someone-else', T0.getTime()).kind !== 'read') throw new Error('not admitted')
    }
    const run = async (limiter: { limit: (o: { key: string }) => Promise<{ success: boolean }> } | undefined) => {
      const gate = new ReadGate(1)
      fill(gate)
      const n = node({ usdc: 9_000_000n })
      const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC, ...(limiter ? { OTHER_CHAINS_LIMIT: limiter } : {}) }, chainFetch: n.fetch, chainGate: gate })
      const { cookie, owner } = await onboard(h)
      const first = (await read(h, cookie, owner.accountKey)).chains[0]!
      await read(h, cookie, owner.accountKey)
      // The other account's slot is still there, whatever happened to the newcomer.
      expect(gate.admit('someone-else', T0.getTime() + 1).kind).toBe('busy')
      return { status: first.status, rpc: n.requests.length }
    }
    const original = console.error
    console.error = () => {}
    try {
      // Not tracked, so each request reads: the limiter is what bounds it.
      expect(await run({ limit: async () => ({ success: true }) })).toEqual({ status: 'observed', rpc: 2 })
      expect(await run({ limit: async () => ({ success: false }) })).toEqual({ status: 'not_observed', rpc: 0 })
      expect(await run(undefined)).toEqual({ status: 'not_observed', rpc: 0 })
      expect(
        await run({
          limit: async () => {
            throw new Error('binding down')
          },
        }),
      ).toEqual({ status: 'not_observed', rpc: 0 })
    } finally {
      console.error = original
    }
  })

  test('a limiter that does not answer does not stop a tracked read', async () => {
    const original = console.error
    console.error = () => {}
    try {
      const n = node({ usdc: 1n })
      const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: RPC, OTHER_CHAINS_LIMIT: { limit: async () => Promise.reject(new Error('down')) } }, chainFetch: n.fetch })
      const { cookie, owner } = await onboard(h)
      expect((await read(h, cookie, owner.accountKey)).chains[0]).toMatchObject({ status: 'observed', usdc: '1' })
    } finally {
      console.error = original
    }
  })

  test('provider pool: the next provider answers when one fails, in the order written, and answers are never mixed', async () => {
    const A = 'https://a.example/key-a'
    const B = 'https://b.example/key-b'
    const C = 'https://c.example/key-c'
    const nodes: Record<string, ReturnType<typeof node>> = { [A]: node({ http: 429 }), [B]: node({ chainId: 8453, usdc: 77n, eth: 77n }), [C]: node({ usdc: 150_000_000n, eth: 3n, block: 21_000_009 }) }
    const order: string[] = []
    const chainFetch: ChainFetch = (input, init) => {
      order.push(input)
      return nodes[input]!.fetch(input, init)
    }
    const logged: string[] = []
    const original = console.error
    console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '))
    try {
      const h = harness(() => T0, { env: { ETHEREUM_RPC_URLS: `${A}, ${B}\n${C}` }, chainFetch })
      const { cookie, owner } = await onboard(h)
      // The first is out of quota, the second is on Base: the third answers, and every figure is its own.
      expect((await read(h, cookie, owner.accountKey)).chains).toEqual([{ chainId: 1, name: 'Ethereum', status: 'observed', block: 21_000_009, usdc: '150000000', eth: '3', observedAt: T0.toISOString() }])
      expect(order).toEqual([A, B, C])
    } finally {
      console.error = original
    }
    expect(logged).toEqual(['other chain not observed 1 provider 1 of 3 rpc http 429', 'other chain not observed 1 provider 2 of 3 rpc is on another chain'])

    // A healthy first provider is the only one asked.
    const first = node({ usdc: 1n })
    const second = node({ usdc: 2n })
    const h2 = harness(() => T0, { env: { ETHEREUM_RPC_URLS: `${A},${B}` }, chainFetch: (input, init) => (input === A ? first : second).fetch(input, init) })
    const o2 = await onboard(h2)
    expect((await read(h2, o2.cookie, o2.owner.accountKey)).chains[0]).toMatchObject({ usdc: '1' })
    expect(second.requests).toEqual([])

    // Every provider down: not observed, after asking each once.
    const down = node({ http: 503 })
    const h3 = harness(() => T0, { env: { ETHEREUM_RPC_URLS: `${A},${B},${C}` }, chainFetch: down.fetch })
    const o3 = await onboard(h3)
    expect((await read(h3, o3.cookie, o3.owner.accountKey)).chains).toEqual(NOT_OBSERVED as OtherChainsView['chains'])
    expect(down.requests.map((r) => r.url)).toEqual([A, B, C])
  })

  test('provider pool: only https URLs, no repeats, at most three', () => {
    expect(providerUrls(undefined)).toEqual([])
    expect(providerUrls('  ')).toEqual([])
    expect(providerUrls('https://a.example/k')).toEqual(['https://a.example/k'])
    expect(providerUrls('https://a.example/k, http://plain.example/k ,wss://ws.example/k, not a url,https://a.example/k\thttps://b.example/k')).toEqual(['https://a.example/k', 'https://b.example/k'])
    expect(providerUrls('https://1.example https://2.example https://3.example https://4.example')).toHaveLength(MAX_PROVIDERS)
  })

  test('the watch list is Ethereum only and never the chain Mamoru runs on', () => {
    expect(WATCHED_CHAINS).toEqual([{ chainId: 1, name: 'Ethereum', usdc: USDC_L1, multicall3: MULTICALL3 }])
    expect(WATCHED_CHAINS.some((w) => w.chainId === 8453)).toBe(false)
  })
})
