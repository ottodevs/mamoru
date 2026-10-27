// otto/mamoru#211: the Move to Base and ETH conversion routes reach BridgeOut. Before this, ROUTE did not list them,
// so the Worker's forwards for bridge-out (#133) always got the generic 404 and the app never offered a move.
import { describe, expect, test } from 'bun:test'
import type { AccountContext } from '@mamoru/domain'
import type { BridgeOut } from '../src/bridge-out.ts'
import type { Operator } from '../src/operator.ts'
import { operatorSignature, startServer } from '../src/server.ts'

const SECRET = 'test-operator-secret'
const CTX = { accountKey: 'acc-1', chainId: 8453, address: '0x1111111111111111111111111111111111111111', owners: ['0x2222222222222222222222222222222222222222'], passkey: { credentialId: 'cred', x: '0x1', y: '0x2' } } as unknown as AccountContext
const header = Buffer.from(JSON.stringify(CTX)).toString('base64url')

const calls: string[] = []
const bridge = {
  status: async () => (calls.push('status'), { route: null, enabled: true, convert: null }),
  prepare: async () => (calls.push('prepare'), { prepareId: 'p' }),
  submit: async () => (calls.push('submit'), { route: null, enabled: true }),
  prepareConvert: async () => (calls.push('prepareConvert'), { prepareId: 'c' }),
  submitConvert: async () => (calls.push('submitConvert'), { route: null, enabled: true }),
} as unknown as BridgeOut

async function call(base: string, method: string, path: string, body = '') {
  const ts = Math.floor(Date.now() / 1000).toString()
  const sig = operatorSignature(SECRET, method, path, header, body, ts)
  return fetch(`${base}${path}`, { method, headers: { 'x-mamoru-account': header, 'x-mamoru-sig': sig, 'x-mamoru-ts': ts, 'content-type': 'application/json' }, ...(method === 'POST' ? { body } : {}) })
}

describe('bridge-out and eth-convert routes (#133, #211)', () => {
  for (const withBridge of [true, false]) {
    test(withBridge ? 'each route reaches BridgeOut' : 'without an Ethereum RPC every route is BRIDGE_OFF, not the generic 404', async () => {
      const server = startServer({} as Operator, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics: { snapshot: () => ({ cumulative: {}, cuEstimateTotal: 0, last48h: [] }) } as never, gitSha: 'abc', bootedAt: Date.now(), bridgeOut: withBridge ? bridge : null })
      const base = `http://127.0.0.1:${server.port}`
      calls.length = 0
      try {
        const res = [
          await call(base, 'GET', '/api/accounts/acc-1/bridge-out'),
          await call(base, 'POST', '/api/accounts/acc-1/bridge-out/prepare'),
          await call(base, 'POST', '/api/accounts/acc-1/bridge-out', '{"prepareId":"p"}'),
          await call(base, 'POST', '/api/accounts/acc-1/eth-convert/prepare'),
          await call(base, 'POST', '/api/accounts/acc-1/eth-convert', '{"prepareId":"c"}'),
        ]
        if (withBridge) {
          expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
          expect(calls).toEqual(['status', 'prepare', 'submit', 'prepareConvert', 'submitConvert'])
        } else {
          for (const r of res) expect(((await r.json()) as { code?: string }).code).toBe('BRIDGE_OFF')
        }
      } finally {
        server.stop(true)
      }
    })
  }
})
