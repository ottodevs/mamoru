import { afterEach, describe, expect, test } from 'bun:test'
import { safeAnswer, startForkProxy, withoutUpstream } from './index.ts'

const KEYED = 'https://node.example.com/v1/0123456789abcdef0123456789abcdef?token=s3cr3t-token-value'
const SHORT = 'https://rpc/v1/secret'
const SECRETS = ['node.example.com', '0123456789abcdef0123456789abcdef', 's3cr3t-token-value']

describe('safeAnswer: what a provider answered, before it leaves the proxy', () => {
  test('a result passes exactly as it came, even when it holds the same characters as the key', () => {
    for (const result of ['0x6000deadbeef6000', '0x0123456789abcdef0123456789abcdef', { hash: '0xabc', number: '0x10', note: 'node.example.com' }, null, [], 0]) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: 7, result })
      expect(JSON.parse(safeAnswer(body, 200, 'https://rpc.example/v1/deadbeef'))).toEqual({ jsonrpc: '2.0', id: 7, result })
      expect(JSON.parse(safeAnswer(body, 200, KEYED))).toEqual({ jsonrpc: '2.0', id: 7, result })
    }
  })

  test('an error that names the URL or any part of it loses its message, whatever the JSON escaping', () => {
    const escaped = KEYED.replace(/0/g, '\\u0030').replace(/\//g, '\\/')
    const bodies = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: `unauthorized for ${KEYED}` } }),
      `{"jsonrpc":"2.0","id":1,"error":{"code":-32001,"message":"unauthorized for ${escaped}"}}`,
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'bad key 0123456789abcdef0123456789abcdef' } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'see docs', data: { url: KEYED } } }),
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32001, message: 'see docs', data: KEYED }, extra: KEYED }),
    ]
    for (const body of bodies) {
      const out = safeAnswer(body, 401, KEYED)
      for (const secret of SECRETS) expect(out).not.toContain(secret)
      expect(JSON.parse(out)).toMatchObject({ jsonrpc: '2.0', id: 1, error: { code: -32001 } })
      expect(JSON.parse(out).extra).toBeUndefined()
    }
    // A short URL whose parts are all short: nothing of it survives either.
    const short = safeAnswer(`{"jsonrpc":"2.0","id":2,"error":{"code":1,"message":"call to https:\\/\\/rpc\\/v1\\/secret failed"}}`, 500, SHORT)
    expect(JSON.parse(short)).toEqual({ jsonrpc: '2.0', id: 2, error: { code: 1, message: 'upstream error' } })
  })

  test('an ordinary error keeps its code, its message and its revert data', () => {
    const error = { code: 3, message: 'execution reverted: STF', data: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020' }
    expect(JSON.parse(safeAnswer(JSON.stringify({ jsonrpc: '2.0', id: 'a', error }), 200, KEYED))).toEqual({ jsonrpc: '2.0', id: 'a', error })
  })

  test('a batch is cleaned item by item', () => {
    const out = JSON.parse(safeAnswer(JSON.stringify([{ jsonrpc: '2.0', id: 1, result: '0x1' }, { jsonrpc: '2.0', id: 2, error: { code: 9, message: KEYED } }]), 200, KEYED))
    expect(out).toEqual([{ jsonrpc: '2.0', id: 1, result: '0x1' }, { jsonrpc: '2.0', id: 2, error: { code: 9, message: 'upstream error' } }])
  })

  test('anything that is not a JSON-RPC answer becomes a fixed error', () => {
    for (const body of [`<html>403 for ${KEYED}</html>`, `Unauthorized: ${KEYED}`, '', '"text"', '42', `{"message":"${KEYED}"}`]) {
      const out = safeAnswer(body, 403, KEYED)
      for (const secret of SECRETS) expect(out).not.toContain(secret)
      expect(JSON.parse(out)).toMatchObject({ jsonrpc: '2.0', error: { code: -32000, message: 'upstream error (http 403)' } })
    }
  })
})

describe('withoutUpstream: for text a person reads', () => {
  test('removes the URL and its parts, short ones too', () => {
    const out = withoutUpstream(`error calling ${KEYED}: host node.example.com, key 0123456789abcdef0123456789abcdef`, KEYED)
    for (const secret of [...SECRETS, KEYED]) expect(out).not.toContain(secret)
    expect(withoutUpstream('call to https://rpc/v1/secret failed: secret', SHORT)).not.toContain('secret')
    expect(withoutUpstream('plain text', KEYED)).toBe('plain text')
  })
})

describe('fork proxy', () => {
  const saved = process.env.PROXY_TEST_UPSTREAM
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    if (saved === undefined) delete process.env.PROXY_TEST_UPSTREAM
    else process.env.PROXY_TEST_UPSTREAM = saved
  })

  test('through the socket: a result arrives untouched and an error that quotes the URL arrives without it', async () => {
    process.env.PROXY_TEST_UPSTREAM = KEYED
    const proxy = startForkProxy('PROXY_TEST_UPSTREAM')
    const answers = [
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x0123456789abcdef0123456789abcdef' }), { status: 200 }),
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32001, message: `unauthorized for ${KEYED}` } }), { status: 401 }),
    ]
    globalThis.fetch = (async (input: unknown, init?: unknown) => (String(input) === KEYED ? answers.shift()! : realFetch(input as string, init as RequestInit))) as typeof fetch
    try {
      const ok = await realFetch(proxy.url, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_getCode"}' })
      expect(await ok.json()).toEqual({ jsonrpc: '2.0', id: 1, result: '0x0123456789abcdef0123456789abcdef' })
      const bad = await realFetch(proxy.url, { method: 'POST', body: '{"jsonrpc":"2.0","id":2,"method":"eth_chainId"}' })
      expect(bad.status).toBe(401)
      const text = await bad.text()
      for (const secret of SECRETS) expect(text).not.toContain(secret)
      expect(JSON.parse(text)).toEqual({ jsonrpc: '2.0', id: 2, error: { code: -32001, message: 'upstream error' } })
    } finally {
      proxy.stop()
    }
  })
})
