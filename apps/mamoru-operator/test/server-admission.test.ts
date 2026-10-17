// otto/mamoru#140 (part2 #7): the HTTP side bounds what it reads and holds open before any work is done.
import { describe, expect, test } from 'bun:test'
import type { AccountContext } from '@mamoru/domain'
import type { Operator } from '../src/operator.ts'
import { operatorSignature, startServer } from '../src/server.ts'
import { Admission, boundedText, DEFAULT_ADMISSION } from '../src/admission.ts'

const SECRET = 'test-operator-secret'
const CTX = { accountKey: 'acc-1', chainId: 8453, address: '0x1111111111111111111111111111111111111111', owners: ['0x2222222222222222222222222222222222222222'], passkey: { credentialId: 'cred', x: '0x1', y: '0x2' } } as unknown as AccountContext
const header = Buffer.from(JSON.stringify(CTX)).toString('base64url')

function boot(op: Partial<Operator>, admission = {}) {
  const server = startServer(op as Operator, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics: { snapshot: () => ({}) } as never, gitSha: 'abc', bootedAt: Date.now(), admission })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

function post(base: string, path: string, body: string, sig?: string): Promise<Response> {
  const ts = Math.floor(Date.now() / 1000).toString()
  return fetch(`${base}${path}`, { method: 'POST', body, headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': sig ?? operatorSignature(SECRET, 'POST', path, header, body, ts) } })
}

describe('request admission', () => {
  test('a body over the limit is refused with 413 before the operator sees it', async () => {
    let called = 0
    const { server, base } = boot({ prepareTransfer: async () => (called++, {}) as never, prepareStop: async () => (called++, {}) as never }, { maxBodyBytes: 1024 })
    try {
      expect((await post(base, '/api/accounts/acc-1/transfer/prepare', 'x'.repeat(4096))).status).toBe(413)
      // A Stop body has its own, fixed ceiling (4 KiB).
      expect((await post(base, '/api/accounts/acc-1/stop/prepare', 'x'.repeat(5000))).status).toBe(413)
      expect(called).toBe(0)
    } finally {
      server.stop(true)
    }
  })

  test('auth headers that cannot be a signature are refused before the body is read', async () => {
    const { server, base } = boot({})
    try {
      for (const sig of ['', 'nothex', 'a'.repeat(63), 'A'.repeat(64)]) {
        const res = await post(base, '/api/accounts/acc-1/stop/prepare', '{}', sig)
        expect(res.status).toBe(401)
      }
    } finally {
      server.stop(true)
    }
  })

  test('prepares are rate-limited per account; Stop has its own bucket, untouched by the others', async () => {
    const { server, base } = boot({ prepareTransfer: async () => ({ ok: true }) as never, prepareStop: async () => ({ ok: true }) as never }, { preparesPerMinute: 2, stopPreparesPerMinute: 1 })
    try {
      const codes = []
      for (let i = 0; i < 3; i++) codes.push((await post(base, '/api/accounts/acc-1/transfer/prepare', '{}')).status)
      expect(codes).toEqual([200, 200, 429])
      expect((await post(base, '/api/accounts/acc-1/stop/prepare', '{}')).status).toBe(200)
      expect((await post(base, '/api/accounts/acc-1/stop/prepare', '{}')).status).toBe(429)
    } finally {
      server.stop(true)
    }
  })

  test('one account holds at most its share of requests open', async () => {
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    const { server, base } = boot({ prepareTransfer: async () => (await held, { ok: true }) as never, prepareStop: async () => ({ ok: true }) as never }, { maxInFlightPerAccount: 1, maxInFlight: 1 })
    try {
      const first = post(base, '/api/accounts/acc-1/transfer/prepare', '{}')
      await Bun.sleep(30)
      const second = await post(base, '/api/accounts/acc-1/transfer/prepare', '{}')
      expect(second.status).toBe(503)
      // The other bucket is full, for this account and for all: a Stop still goes through.
      expect((await post(base, '/api/accounts/acc-1/stop/prepare', '{}')).status).toBe(200)
      release()
      expect((await first).status).toBe(200)
    } finally {
      server.stop(true)
    }
  })

  test('limits follow the Safe, not the accountKey: another key for the same Safe shares them', async () => {
    const { server, base } = boot({ prepareTransfer: async () => ({ ok: true }) as never }, { preparesPerMinute: 1 })
    try {
      expect((await post(base, '/api/accounts/acc-1/transfer/prepare', '{}')).status).toBe(200)
      const other = Buffer.from(JSON.stringify({ ...CTX, accountKey: 'acc-2' })).toString('base64url')
      const ts = Math.floor(Date.now() / 1000).toString()
      const path = '/api/accounts/acc-2/transfer/prepare'
      const res = await fetch(`${base}${path}`, { method: 'POST', body: '{}', headers: { 'x-mamoru-account': other, 'x-mamoru-ts': ts, 'x-mamoru-sig': operatorSignature(SECRET, 'POST', path, other, '{}', ts) } })
      expect(res.status).toBe(429)
    } finally {
      server.stop(true)
    }
  })

  test('unauthenticated Stop requests take no Stop slot', async () => {
    const { server, base } = boot({ prepareStop: async () => ({ ok: true }) as never }, { maxInFlightStop: 1 })
    try {
      // Bodies that never finish, under a well-shaped but false signature.
      const slow = Array.from({ length: 3 }, () => {
        const stream = new ReadableStream<Uint8Array>({ start: (c) => void c.enqueue(new TextEncoder().encode('{')) })
        return fetch(`${base}/api/accounts/acc-1/stop/prepare`, { method: 'POST', body: stream, headers: { 'x-mamoru-account': header, 'x-mamoru-sig': 'a'.repeat(64) } }).catch(() => null)
      })
      await Bun.sleep(50)
      expect((await post(base, '/api/accounts/acc-1/stop/prepare', '{}')).status).toBe(200)
      void slow
    } finally {
      server.stop(true)
    }
  })

  test('the stop prepare passes revokeOnly through', async () => {
    let seen: unknown
    const { server, base } = boot({ prepareStop: async (_c: AccountContext, o?: { revokeOnly?: boolean }) => ((seen = o), { ok: true }) as never })
    try {
      expect((await post(base, '/api/accounts/acc-1/stop/prepare', '{"revokeOnly":true}')).status).toBe(200)
      expect(seen).toEqual({ revokeOnly: true })
    } finally {
      server.stop(true)
    }
  })

  test('in-flight ceiling across accounts', () => {
    const a = new Admission({ ...DEFAULT_ADMISSION, maxInFlight: 2, maxInFlightPerAccount: 1, preparesPerMinute: 1, preparesPerMinuteAll: 1 })
    expect([a.enter(), a.enter(), a.enter()]).toEqual([true, true, false])
    a.leave()
    expect(a.enter()).toBe(true)
    expect(a.allowPrepare('x', 0)).toBe(true)
    expect(a.allowPrepare('y', 1)).toBe(false)
    expect(a.allowPrepare('y', 60_001)).toBe(true)
    expect(a.enterAccount('x')).toBe(true)
    expect(a.enterAccount('x')).toBe(false)
    expect(a.enterAccount('x', 'stop')).toBe(true)
    expect(a.allowPrepare('x', 60_002, 'stop')).toBe(true)
  })

  test('a body that trickles in past the deadline is refused', async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(new TextEncoder().encode('{'))
        await Bun.sleep(200)
        c.enqueue(new TextEncoder().encode('}'))
        c.close()
      },
    })
    expect(await boundedText(new Request('http://x/', { method: 'POST', body: stream }), 1024, 50)).toBeNull()
  })
})
