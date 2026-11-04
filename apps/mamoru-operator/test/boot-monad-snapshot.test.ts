// otto/mamoru#343 phase B: the Monad operator measures capital for the worked APY with a plain snapshot loop, behind
// MAMORU_SNAPSHOT_MONAD=1 (it pulls no engine settings, so the yield_ledger flag is unreachable there).
import { afterAll, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootOperator } from '../src/boot.ts'
import { metricsSignature } from '@mamoru/operator-auth'

const rpc = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as { id: number; method: string } | { id: number; method: string }[]
    const one = (r: { id: number; method: string }) => {
      if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0x8f' }
      if (r.method === 'eth_getBalance') return { jsonrpc: '2.0', id: r.id, result: '0x0' }
      return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'stub' } }
    }
    return Response.json(Array.isArray(body) ? body.map(one) : one(body))
  },
})
const secret = randomBytes(32).toString('hex')
const boot = () => bootOperator({ rpcUrl: `http://127.0.0.1:${rpc.port}/`, secret, stateDir: mkdtempSync(join(tmpdir(), 'mamoru-boot-143-snap-')), port: 0, policyId: 'lab-wmon-usdc-monad-v1' })
const status = async (url: string) => {
  const sig = await metricsSignature(secret, 'GET', '/snapshot', Math.floor(Date.now() / 60_000))
  return (await fetch(`${url}/snapshot`, { headers: { 'x-mamoru-sig': sig } })).status
}
const env = { ...process.env }
const stops: (() => void)[] = []
afterAll(() => {
  process.env = env
  for (const s of stops) s()
  rpc.stop(true)
})

describe('operator booted on chain 143: snapshot loop', () => {
  test('without MAMORU_SNAPSHOT_MONAD the route stays off (404), as before', async () => {
    delete process.env.MAMORU_SNAPSHOT_MONAD
    const op = await boot()
    stops.push(op.stop)
    expect(await status(op.url)).toBe(404)
  })

  test('with MAMORU_SNAPSHOT_MONAD=1 a loop runs on the Monad registry: 503 until its first read lands, not 404', async () => {
    process.env.MAMORU_SNAPSHOT_MONAD = '1'
    const op = await boot()
    stops.push(op.stop)
    expect(await status(op.url)).toBe(503)
  })
})
