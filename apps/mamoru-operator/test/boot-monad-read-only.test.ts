// otto/mamoru#63 (review of #110, P1-2): the operator booted on a chain 143 RPC with the Monad lab policy reads, and
// can neither sign nor submit: relayer refused, no bundler, owner prepare/submit CHAIN_READ_ONLY, no engine loop.
import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monadRegistry } from '@mamoru/registry'
import { bootOperator } from '../src/boot.ts'
import { operatorSignature } from '../src/server.ts'
import { ctx } from './owner-world.ts'

// A JSON-RPC stub that is Monad mainnet as far as boot can tell: chain id 143, an empty relayer. Anything else errors.
const methods: string[] = []
const rpc = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { id: number; method: string } | { id: number; method: string }[]
    const one = (r: { id: number; method: string }) => {
      methods.push(r.method)
      if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0x8f' }
      if (r.method === 'eth_getBalance') return { jsonrpc: '2.0', id: r.id, result: '0x0' }
      if (r.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: r.id, result: '0x1' }
      return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'stub' } }
    }
    return Response.json(Array.isArray(body) ? body.map(one) : one(body))
  },
})
const secret = randomBytes(32).toString('hex')
const env = { ...process.env }
process.env.MAMORU_LIVE = '1' // misconfigured on purpose: live is still Base only
const op = await bootOperator({ rpcUrl: `http://127.0.0.1:${rpc.port}/`, secret, stateDir: mkdtempSync(join(tmpdir(), 'mamoru-boot-143-')), port: 0, policyId: 'lab-wmon-usdc-monad-v1' })
process.env = env
afterAll(() => {
  op.stop()
  rpc.stop(true)
})

describe('operator booted on chain 143', () => {
  test('it reads the Monad registry and is not live, MAMORU_LIVE=1 or not', () => {
    expect(op.operator.cfg.registry).toBe(monadRegistry)
    expect(op.operator.cfg.chainId).toBe(143)
    expect(op.operator.cfg.live).toBe(false)
  })

  test('no loopback bundler and a relayer that refuses every send without touching the RPC', async () => {
    expect(op.operator.cfg.bundlerUrl).toBe('')
    const before = methods.length
    const e = (await op.operator.relayer.send({ to: op.operator.relayer.address, value: 1n }).catch((x: unknown) => x)) as { code?: string }
    expect(e.code).toBe('CHAIN_UNSUPPORTED')
    expect(methods.slice(before).filter((m) => m === 'eth_sendRawTransaction' || m === 'eth_estimateGas')).toEqual([])
  })

  test('owner prepare and submit over HTTP answer 503 CHAIN_READ_ONLY', async () => {
    const c = { ...ctx, chainId: 143 }
    const header = Buffer.from(JSON.stringify(c)).toString('base64url')
    for (const [method, path, body] of [
      ['POST', 'activate/prepare', {}],
      ['POST', 'stop/prepare', {}],
      ['POST', 'activate', { prepareId: 'x', authenticatorData: '', clientDataJSON: '', signature: '' }],
    ] as const) {
      const raw = JSON.stringify(body)
      const p = `/api/accounts/${c.accountKey}/${path}`
      // #140: the no-ts HMAC is refused past LEGACY_HMAC_UNTIL, so sign as the app Worker does, with x-mamoru-ts.
      const ts = Math.floor(Date.now() / 1000).toString()
      const sig = operatorSignature(secret, method, p, header, raw, ts)
      const res = await fetch(op.url + p, { method, headers: { 'x-mamoru-account': header, 'x-mamoru-ts': ts, 'x-mamoru-sig': sig, 'content-type': 'application/json' }, body: raw })
      expect({ path, status: res.status, code: ((await res.json()) as { code?: string }).code }).toEqual({ path, status: 503, code: 'CHAIN_READ_ONLY' })
    }
    expect(methods).not.toContain('eth_sendRawTransaction')
  })

  test('no engine loop runs', () => {
    expect(op.operator.engineHealthSnapshot()).toEqual([])
  })
})
