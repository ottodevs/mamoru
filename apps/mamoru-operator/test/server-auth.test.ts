// otto/mamoru#140 (part1 #6.1): the per-account HMAC is replayable with no timestamp or nonce. Confirms the fix —
// a signed `x-mamoru-ts` is part of the MAC and must sit within REQUEST_SKEW_MS of the operator's clock — while
// the no-ts (old) form still verifies, so the app Worker and this operator can deploy in either order.
import { describe, expect, test } from 'bun:test'
import type { AccountContext } from '@mamoru/domain'
// Cross-runtime check only: the app Worker's own signer (Web Crypto) must key the ts-signed scheme identically
// to this operator's (node:crypto), or a correctly-signed real request would 401 for real. Not a package import
// mamoru-operator otherwise depends on — test-only, verifying the wire protocol the two apps agree on.
import { operatorSignature as appOperatorSignature } from '../../mamoru-app/src/api/accounts/operator.ts'
import type { Operator } from '../src/operator.ts'
import { operatorSignature, REQUEST_SKEW_MS, startServer } from '../src/server.ts'

const SECRET = 'test-operator-secret'
const CTX: AccountContext = {
  accountKey: 'acc-1',
  chainId: 8453,
  address: '0x1111111111111111111111111111111111111111',
  owners: ['0x2222222222222222222222222222222222222222'],
  passkey: { credentialId: 'cred', x: '0x1', y: '0x2' },
} as unknown as AccountContext

const header = () => Buffer.from(JSON.stringify(CTX)).toString('base64url')

function fakeOperator(): Operator {
  return { funding: async () => ({ ok: true }) } as unknown as Operator
}

function boot(op: Operator) {
  const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics: { snapshot: () => ({ cumulative: {}, cuEstimateTotal: 0, last48h: [] }) } as never, gitSha: 'abc', bootedAt: Date.now() })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

async function get(base: string, path: string, opts: { ts?: string | null; sigTs?: string | null } = {}): Promise<Response> {
  const h = header()
  const ts = opts.ts === undefined ? Math.floor(Date.now() / 1000).toString() : opts.ts
  const sigTs = opts.sigTs === undefined ? ts : opts.sigTs
  const sig = operatorSignature(SECRET, 'GET', path, h, '', sigTs)
  const headers: Record<string, string> = { 'x-mamoru-account': h, 'x-mamoru-sig': sig }
  if (ts !== null) headers['x-mamoru-ts'] = ts
  return fetch(`${base}${path}`, { headers })
}

describe('operator HMAC: a signed timestamp bounds how long a captured request can be replayed', () => {
  test('a request signed with the current timestamp verifies', async () => {
    const { server, base } = boot(fakeOperator())
    try {
      const res = await get(base, '/api/accounts/acc-1/funding')
      expect(res.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })

  test('the same request replayed past the skew window is refused, even though its signature matches its own timestamp', async () => {
    const { server, base } = boot(fakeOperator())
    try {
      const stale = Math.floor((Date.now() - REQUEST_SKEW_MS - 5_000) / 1000).toString()
      const res = await get(base, '/api/accounts/acc-1/funding', { ts: stale })
      expect(res.status).toBe(401)
      expect((await res.json()) as unknown).toMatchObject({ code: 'OPERATOR_AUTH' })
    } finally {
      server.stop(true)
    }
  })

  test('a timestamp from the near future (clock skew, not a replay) is still inside the window', async () => {
    const { server, base } = boot(fakeOperator())
    try {
      const soon = Math.floor((Date.now() + 10_000) / 1000).toString()
      const res = await get(base, '/api/accounts/acc-1/funding', { ts: soon })
      expect(res.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })

  test('changing the timestamp without re-signing fails: ts is part of the MAC, not a free-standing field', async () => {
    const { server, base } = boot(fakeOperator())
    try {
      const now = Math.floor(Date.now() / 1000).toString()
      // Signed for a stale ts, then the header is swapped for a fresh one before sending.
      const stale = Math.floor((Date.now() - REQUEST_SKEW_MS - 5_000) / 1000).toString()
      const res = await get(base, '/api/accounts/acc-1/funding', { ts: now, sigTs: stale })
      expect(res.status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('no x-mamoru-ts header (old caller): the pre-#140 3-line signature still verifies, no skew check', async () => {
    const { server, base } = boot(fakeOperator())
    try {
      const res = await get(base, '/api/accounts/acc-1/funding', { ts: null })
      expect(res.status).toBe(200)
    } finally {
      server.stop(true)
    }
  })

  test('the app Worker (Web Crypto) and this operator (node:crypto) key the ts-signed scheme identically', async () => {
    const [op, app] = await Promise.all([
      Promise.resolve(operatorSignature(SECRET, 'POST', '/api/accounts/acc-1/transfer', 'hdr', 'body', '1700000000')),
      appOperatorSignature(SECRET, 'POST', '/api/accounts/acc-1/transfer', 'hdr', 'body', '1700000000'),
    ])
    expect(app).toBe(op)
  })

  test('a captured POST cannot be turned into a forever-valid one by shifting ts into the body under the old 3-line form', async () => {
    const op = { prepareTransfer: async () => ({ ok: true }) } as unknown as Operator
    const { server, base } = boot(op)
    try {
      const path = '/api/accounts/acc-1/transfer/prepare'
      const h = header()
      const ts = Math.floor(Date.now() / 1000).toString()
      const body = '{"to":"0x0","amountUsdc":"1"}'
      const captured = operatorSignature(SECRET, 'POST', path, h, body, ts) // the real, 4-line, ts-keyed signature
      // The attack this closes: forge a request with no x-mamoru-ts, reusing `captured` as-is, and move `ts` into
      // the body it signs for instead. Before the ts-signed scheme used its own derived key, this body made the
      // old 3-line payload byte-identical to the captured 4-line one, so `captured` verified under it too — with
      // no skew check at all, since the old form has none. Now the two forms are keyed differently; it fails.
      const forgedBody = `${ts}\n${body}`
      const res = await fetch(`${base}${path}`, { method: 'POST', body: forgedBody, headers: { 'x-mamoru-account': h, 'x-mamoru-sig': captured } })
      expect(res.status).toBe(401)
    } finally {
      server.stop(true)
    }
  })
})
