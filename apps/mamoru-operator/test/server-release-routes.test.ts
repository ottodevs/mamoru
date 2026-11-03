// otto/mamoru#354: the return-home release routes (#278) are dispatched by server.ts but ROUTE did not list them, so a
// RemotePeer's release / releaseStatus / releaseCancel got the generic 404 before dispatch. They now reach the operator,
// signed like every other peer route, and an unsigned or wrongly signed request never reaches it.
import { describe, expect, test } from 'bun:test'
import type { AccountContext } from '@mamoru/domain'
import type { Operator } from '../src/operator.ts'
import { RemotePeer } from '../src/remote-peer.ts'
import { operatorSignature, startServer } from '../src/server.ts'

const SECRET = 'test-operator-secret'
const CTX = { accountKey: 'acc-1', chainId: 143, address: '0x1111111111111111111111111111111111111111', owners: ['0x2222222222222222222222222222222222222222'], passkey: { credentialId: 'cred', x: '0x1', y: '0x2' } } as unknown as AccountContext
const header = Buffer.from(JSON.stringify(CTX)).toString('base64url')
const rpcMetrics = { snapshot: () => ({ cumulative: {}, cuEstimateTotal: 0, last48h: [] }) } as never

function withServer() {
  const seen: string[] = []
  const op = {
    requestRelease: async (c: AccountContext, b: { id: string; amount: string }) => (seen.push(`release:${c.accountKey}:${b.id}:${b.amount}`), { id: b.id, state: 'requested' }),
    releaseStatus: async (c: AccountContext, b: { id?: string }) => (seen.push(`status:${c.accountKey}:${b.id ?? ''}`), { id: b.id ?? null, state: 'requested' }),
    cancelRelease: async (c: AccountContext, b: { id: string }) => (seen.push(`cancel:${c.accountKey}:${b.id}`), { id: b.id, state: 'cancelled' }),
  } as unknown as Operator
  const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics, gitSha: 'abc', bootedAt: Date.now(), bridgeOut: null })
  return { seen, server, base: `http://127.0.0.1:${server.port}` }
}

describe('release routes (#278, #354)', () => {
  test('RemotePeer release, releaseStatus and releaseCancel reach dispatch', async () => {
    const { seen, server, base } = withServer()
    try {
      const peer = new RemotePeer(143, base, SECRET)
      expect(await peer.release(CTX, 'r1', 5_000_000n)).toEqual({ id: 'r1', state: 'requested' } as never)
      expect(await peer.releaseStatus(CTX, 'r1')).toEqual({ id: 'r1', state: 'requested' } as never)
      expect(await peer.releaseStatus(CTX)).toEqual({ id: null, state: 'requested' } as never)
      expect(await peer.releaseCancel(CTX, 'r1')).toEqual({ id: 'r1', state: 'cancelled' } as never)
      expect(seen).toEqual(['release:acc-1:r1:5000000', 'status:acc-1:r1', 'status:acc-1:', 'cancel:acc-1:r1'])
    } finally {
      server.stop(true)
    }
  })

  test('without a valid signature each is refused before the operator is reached', async () => {
    const { seen, server, base } = withServer()
    try {
      // A peer holding another secret: its requests are well formed but signed wrongly.
      const wrong = new RemotePeer(143, base, 'not-the-secret')
      await expect(wrong.release(CTX, 'r1', 1n)).rejects.toMatchObject({ status: 401, code: 'OPERATOR_AUTH' })
      await expect(wrong.releaseStatus(CTX, 'r1')).rejects.toMatchObject({ status: 401, code: 'OPERATOR_AUTH' })
      await expect(wrong.releaseCancel(CTX, 'r1')).rejects.toMatchObject({ status: 401, code: 'OPERATOR_AUTH' })
      const ts = String(Math.floor(Date.now() / 1000))
      for (const route of ['release', 'release/status', 'release/cancel']) {
        const path = `/api/accounts/acc-1/${route}`
        // No signature at all.
        const none = await fetch(base + path, { method: 'POST', headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts }, body: '{"id":"r1"}' })
        expect(none.status).toBe(401)
        // A valid signature over another body: the body is part of what is signed.
        const sig = operatorSignature(SECRET, 'POST', path, header, '{"id":"r1"}', ts)
        const tampered = await fetch(base + path, { method: 'POST', headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': sig }, body: '{"id":"r2"}' })
        expect(tampered.status).toBe(401)
      }
      expect(seen).toEqual([])
    } finally {
      server.stop(true)
    }
  })
})
