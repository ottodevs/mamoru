// Confirms the server.ts catch-all never leaks a raw caught exception's message to the client —
// only HttpError's own (safe, audited) message, or a fixed generic string for anything else.
import { describe, expect, test } from 'bun:test'
import type { AccountContext } from '@mamoru/domain'
import { HttpError, type Operator } from '../src/operator.ts'
import { operatorSignature, startServer } from '../src/server.ts'

const SECRET = 'test-operator-secret'
const CTX: AccountContext = {
  accountKey: 'acc-1',
  chainId: 8453,
  address: '0x1111111111111111111111111111111111111111',
  owners: ['0x2222222222222222222222222222222222222222'],
  passkey: { credentialId: 'cred', x: '0x1', y: '0x2' },
} as unknown as AccountContext

function header(): string {
  return Buffer.from(JSON.stringify(CTX)).toString('base64url')
}

async function signedGet(base: string, path: string): Promise<Response> {
  const h = header()
  const sig = operatorSignature(SECRET, 'GET', path, h, '')
  return fetch(`${base}${path}`, { headers: { 'x-mamoru-account': h, 'x-mamoru-sig': sig } })
}

function fakeOperator(funding: () => Promise<unknown>): Operator {
  return { funding } as unknown as Operator
}

function boot(op: Operator) {
  const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics: { snapshot: () => ({ cumulative: {}, cuEstimateTotal: 0, last48h: [] }) } as never, gitSha: 'abc', bootedAt: Date.now() })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

describe('server.ts error responses never leak a raw exception message', () => {
  test('an HttpError returns its own (safe) message and code', async () => {
    const op = fakeOperator(async () => {
      throw new HttpError(409, 'CAP_EXCEEDED', 'the Safe holds 10 USDC, cap is 5 USDC')
    })
    const { server, base } = boot(op)
    try {
      const res = await signedGet(base, '/api/accounts/acc-1/funding')
      expect(res.status).toBe(409)
      const body = (await res.json()) as { error: string; code: string }
      expect(body.code).toBe('CAP_EXCEEDED')
      expect(body.error).toBe('the Safe holds 10 USDC, cap is 5 USDC')
    } finally {
      server.stop(true)
    }
  })

  test('a plain (non-HttpError) exception never reaches the client: fixed message, fixed code, 500', async () => {
    const op = fakeOperator(async () => {
      throw new Error('connect ECONNREFUSED https://base-mainnet.g.alchemy.com/v2/SUPER_SECRET_KEY_123')
    })
    const { server, base } = boot(op)
    try {
      const res = await signedGet(base, '/api/accounts/acc-1/funding')
      expect(res.status).toBe(500)
      const body = (await res.json()) as { error: string; code: string }
      expect(body.code).toBe('OPERATOR_ERROR')
      expect(body.error).toBe('the operator hit an unexpected error handling this request')
      expect(body.error).not.toContain('alchemy.com')
      expect(body.error).not.toContain('SUPER_SECRET_KEY_123')
      expect(JSON.stringify(body)).not.toContain('SUPER_SECRET_KEY_123')
    } finally {
      server.stop(true)
    }
  })
})
