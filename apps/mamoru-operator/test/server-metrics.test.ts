import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { metricsSignature } from '@mamoru/operator-auth'
import { classifyEngineError, EngineHealthTracker, RpcMetrics } from '../src/metrics.ts'
import type { Operator } from '../src/operator.ts'
import { startServer } from '../src/server.ts'

type MetricsPayload = {
  generatedAt: string
  operator: { gitSha: string; chainId: number; policyId: string; relayer: { address: string }; accounts: { known: number; active: number; armed: number } }
  rpc: { cumulative: Record<string, Record<string, { requests: number }>>; last48h: unknown[] }
  engines: { account: string; lastDecisionCode: string | null; lastErrorClass: string | null }[]
}

const SECRET = 'test-operator-secret'
const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-server-metrics-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fakeOperator(): Operator {
  return {
    cfg: { chainId: 8453, live: true, policy: { policyId: 'conservador-live-v2' } },
    relayer: { address: '0x1111111111111111111111111111111111111111' },
    relayerBalance: async () => ({ wei: '812345678901234567', cachedAgeMs: 12 }),
    accountsSummary: () => ({ known: 14, active: 9, armed: 1 }),
    engineHealthSnapshot: () => [
      { account: '3f9a7c21', lastReviewAt: '2026-10-02T09:14:40.000Z', lastDecisionCode: 'DECIDE_HOLD', consecutiveErrors: 0, lastErrorClass: null, lastErrorAt: null, reviewsLastHour: 58, errorsLastHour: 0 },
      { account: '9b0e41aa', lastReviewAt: '2026-10-02T09:14:55.000Z', lastDecisionCode: null, consecutiveErrors: 4, lastErrorClass: 'rpc_other', lastErrorAt: '2026-10-02T09:14:55.000Z', reviewsLastHour: 12, errorsLastHour: 4 },
    ],
  } as unknown as Operator
}

function boot() {
  const op = fakeOperator()
  const rpcMetrics = new RpcMetrics(tmpDir())
  rpcMetrics.recordRequest('base-mainnet.g.alchemy.com#1', 'eth_call', false)
  const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics, gitSha: '5efba44', bootedAt: Date.now() - 123_000 })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

describe('GET /metrics auth', () => {
  test('a correctly-signed request for the current minute is accepted', async () => {
    const { server, base } = boot()
    try {
      const minute = Math.floor(Date.now() / 60_000)
      const sig = await metricsSignature(SECRET, 'GET', '/metrics', minute)
      const res = await fetch(`${base}/metrics`, { headers: { 'x-mamoru-sig': sig } })
      expect(res.status).toBe(200)
      const body = (await res.json()) as MetricsPayload
      expect(body.operator.gitSha).toBe('5efba44')
    } finally {
      server.stop(true)
    }
  })

  test('a signature for a minute older than the accepted window is rejected', async () => {
    const { server, base } = boot()
    try {
      const minute = Math.floor(Date.now() / 60_000)
      const sig = await metricsSignature(SECRET, 'GET', '/metrics', minute - 5)
      const res = await fetch(`${base}/metrics`, { headers: { 'x-mamoru-sig': sig } })
      expect(res.status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('a bad signature is rejected', async () => {
    const { server, base } = boot()
    try {
      const res = await fetch(`${base}/metrics`, { headers: { 'x-mamoru-sig': 'deadbeef' } })
      expect(res.status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('a missing signature is rejected', async () => {
    const { server, base } = boot()
    try {
      const res = await fetch(`${base}/metrics`)
      expect(res.status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('the per-account HMAC scheme does not grant access to /metrics', async () => {
    const { server, base } = boot()
    try {
      // A valid signature for a *different* scheme/path must not verify here.
      const sig = await metricsSignature(SECRET, 'GET', '/api/accounts/x/funding', Math.floor(Date.now() / 60_000))
      const res = await fetch(`${base}/metrics`, { headers: { 'x-mamoru-sig': sig } })
      expect(res.status).toBe(401)
    } finally {
      server.stop(true)
    }
  })
})

/** Walks the payload and flags anything that looks like a secret: a private-key-shaped hex string, a bare RPC URL, or a suspicious key name. */
function findSecretLooking(value: unknown, path = '$'): string[] {
  const hits: string[] = []
  const suspiciousKey = /secret|sessionkey|privatekey|relayerkey|passkey|signature/i
  const hex64 = /^0x[0-9a-fA-F]{64}$/
  const rpcUrl = /^https?:\/\//i
  const walk = (v: unknown, p: string) => {
    if (typeof v === 'string') {
      if (hex64.test(v)) hits.push(`${p}: looks like a private key`)
      if (rpcUrl.test(v)) hits.push(`${p}: looks like a bare RPC URL`)
      return
    }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`))
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (suspiciousKey.test(k)) hits.push(`${p}.${k}: suspicious key name`)
        walk(x, `${p}.${k}`)
      }
    }
  }
  walk(value, path)
  return hits
}

describe('GET /metrics payload', () => {
  test('matches the documented shape and contains no secret-looking fields', async () => {
    const { server, base } = boot()
    try {
      const minute = Math.floor(Date.now() / 60_000)
      const sig = await metricsSignature(SECRET, 'GET', '/metrics', minute)
      const res = await fetch(`${base}/metrics`, { headers: { 'x-mamoru-sig': sig } })
      const body = (await res.json()) as MetricsPayload

      expect(typeof body.generatedAt).toBe('string')
      expect(body.operator.chainId).toBe(8453)
      expect(body.operator.policyId).toBe('conservador-live-v2')
      expect(body.operator.relayer.address).toBe('0x1111111111111111111111111111111111111111')
      expect(body.operator.accounts).toEqual({ known: 14, active: 9, armed: 1 })
      expect(body.rpc.cumulative['base-mainnet.g.alchemy.com#1']!.eth_call!.requests).toBe(1)
      expect(Array.isArray(body.rpc.last48h)).toBe(true)
      expect(body.engines.length).toBe(2)
      expect(body.engines[0]!.account).toBe('3f9a7c21')

      expect(findSecretLooking(body)).toEqual([])
    } finally {
      server.stop(true)
    }
  })
})

describe('GET /metrics never carries injected secret-shaped free text (finding #5)', () => {
  test('a keyed Alchemy URL, a bearer token, a private-key-like hex string and an email never reach the serialised payload', async () => {
    // Exactly the operator.ts data flow: classify first (closed enum), record only the class —
    // the free text is never stored anywhere a /metrics read could reach.
    const alchemyUrl = 'https://base-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-'
    // Shaped like a bearer token (a long opaque run), deliberately not using any real provider's
    // key-prefix convention (e.g. Stripe's "sk_live_"), which GitHub's push-protection secret
    // scanner flags as a plausible real credential even inside a test fixture.
    const bearerToken = 'NOTREAL_TEST_TOKEN_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_fixture'
    const privateKeyLike = `0x${'ab'.repeat(32)}`
    const email = 'ops-oncall+incident@example.com'
    const nasty = [`rate limited at ${alchemyUrl}`, `auth failed: Bearer ${bearerToken}`, `leaked key ${privateKeyLike}`, `alert sent to ${email}`]

    const tracker = new EngineHealthTracker()
    nasty.forEach((msg, i) => {
      const code = i === 0 ? 'OBS_RPC_UNAVAILABLE' : 'REVIEW_ERROR'
      tracker.record(`account-${i}`, false, code, classifyEngineError(code, msg))
    })

    const op = {
      cfg: { chainId: 8453, live: true, policy: { policyId: 'conservador-live-v2' } },
      relayer: { address: '0x1111111111111111111111111111111111111111' },
      relayerBalance: async () => ({ wei: '1', cachedAgeMs: 1 }),
      accountsSummary: () => ({ known: 4, active: 4, armed: 0 }),
      engineHealthSnapshot: () => nasty.map((_, i) => tracker.snapshot(`account-${i}`)),
    } as unknown as Operator

    const rpcMetrics = new RpcMetrics(tmpDir())
    const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics, gitSha: '5efba44', bootedAt: Date.now() })
    try {
      const minute = Math.floor(Date.now() / 60_000)
      const sig = await metricsSignature(SECRET, 'GET', '/metrics', minute)
      const res = await fetch(`http://127.0.0.1:${server.port}/metrics`, { headers: { 'x-mamoru-sig': sig } })
      const raw = await res.text()

      for (const msg of nasty) expect(raw).not.toContain(msg)
      expect(raw).not.toContain('alchemy.com/v2')
      expect(raw).not.toContain(bearerToken)
      expect(raw).not.toContain(privateKeyLike)
      expect(raw).not.toContain(email)
      expect(raw).not.toContain('@example.com')

      // No 32+ char hex or base64 run anywhere except the relayer address (40 hex chars) and the git sha (7 chars, well under 32 anyway).
      const RELAYER_ADDRESS_HEX = '1111111111111111111111111111111111111111'
      const longRuns = raw.match(/[0-9a-fA-F]{32,}/g) ?? []
      const unexpected = longRuns.filter((run) => run !== RELAYER_ADDRESS_HEX)
      expect(unexpected).toEqual([])

      // And the classes that DID make it through are exactly the closed enum, visible for ops triage without any free text.
      const body = JSON.parse(raw) as MetricsPayload
      expect(body.engines.map((e) => e.lastErrorClass).sort()).toEqual(['internal', 'internal', 'internal', 'rpc_other'].sort())
    } finally {
      server.stop(true)
    }
  })
})
