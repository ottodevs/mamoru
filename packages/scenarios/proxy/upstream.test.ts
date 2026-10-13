import { afterEach, describe, expect, test } from 'bun:test'
import { startForkProxy, withoutUpstream } from './index.ts'

const KEYED = 'https://node.example.com/v1/0123456789abcdef0123456789abcdef?token=s3cr3t-token-value'

describe('withoutUpstream', () => {
  test('removes the URL and every part of it long enough to be a key', () => {
    const text = `error calling ${KEYED}: host node.example.com, path 0123456789abcdef0123456789abcdef, query s3cr3t-token-value`
    const out = withoutUpstream(text, KEYED)
    for (const part of ['node.example.com', '0123456789abcdef0123456789abcdef', 's3cr3t-token-value', KEYED]) expect(out).not.toContain(part)
    expect(out).toContain('error calling <upstream>')
  })
  test('leaves ordinary text and short parts alone', () => {
    expect(withoutUpstream('{"result":"0x1"} v1 token', KEYED)).toBe('{"result":"0x1"} v1 token')
    expect(withoutUpstream('not a url secret-value here', 'secret-value')).toBe('not a url <upstream> here')
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

  test('an upstream error that quotes its own URL reaches the caller without it', async () => {
    process.env.PROXY_TEST_UPSTREAM = KEYED
    const proxy = startForkProxy('PROXY_TEST_UPSTREAM')
    globalThis.fetch = (async (input: unknown, init?: unknown) =>
      String(input) === KEYED ? new Response(JSON.stringify({ error: { message: `unauthorized for ${KEYED}` } }), { status: 401 }) : realFetch(input as string, init as RequestInit)) as typeof fetch
    try {
      const res = await realFetch(proxy.url, { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId"}' })
      const body = await res.text()
      expect(res.status).toBe(401)
      expect(body).toContain('unauthorized for <upstream>')
      expect(body).not.toContain('0123456789abcdef')
      expect(body).not.toContain('s3cr3t')
    } finally {
      proxy.stop()
    }
  })
})
