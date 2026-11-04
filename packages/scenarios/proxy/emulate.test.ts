import { describe, expect, test } from 'bun:test'
import { assertProfileFresh, createEmulator, type Emulation, type Forward, type RpcMsg } from './emulate.ts'
import { startEnginePort } from './index.ts'
import { freshEmulation, loadProfile } from './profile.ts'

// otto/mamoru#273: each capability of the emulation layer, against a fake upstream (no anvil).
const E = (code: number, message: string) => ({ code, message })
const EP = {
  refusedMethods: { eth_chainIdX: E(-32601, 'Method not found') },
  refusedParams: [{ method: 'eth_simulateV1', path: [0, 'validation'], equals: false, error: E(-32000, '`"validation": false` is not supported yet') }],
  simulateGasUsedIsLimit: true,
  simulateSenderNotEoa: E(-32000, 'sender not eoa'),
  getLogs: { maxSpan: 100, error: E(-32614, 'eth_getLogs is limited to a 100 range') },
  unknownBlock: E(-32602, 'Block requested not found. Request might be querying historical state that is not available. If possible, reformulate query to point to more recent blocks'),
}
const CONTRACT = '0x00000000000000000000000000000000000000c0'
const msg = (method: string, params: unknown[] = []): RpcMsg => ({ jsonrpc: '2.0', id: 1, method, params })

/** head 1000; CONTRACT has code; every other call echoes its method and params. */
function fake(head = 1000) {
  const seen: RpcMsg[] = []
  const forward: Forward = async (m) => {
    seen.push(m)
    if (m.method === 'eth_blockNumber') return { jsonrpc: '2.0', id: m.id, result: `0x${head.toString(16)}` }
    if (m.method === 'eth_getCode') return { jsonrpc: '2.0', id: m.id, result: m.params?.[0] === CONTRACT ? '0x6080' : '0x' }
    if (m.method === 'eth_simulateV1') return { jsonrpc: '2.0', id: m.id, result: [{ gasUsed: '0x5208', calls: [{ gasUsed: '0x5208', status: '0x1' }] }] }
    return { jsonrpc: '2.0', id: m.id, result: { method: m.method, params: m.params } }
  }
  return { forward, seen }
}
const sim = (from: string, extra: Record<string, unknown> = {}, gas = '0x7530') => msg('eth_simulateV1', [{ blockStateCalls: [{ calls: [{ from, to: '0x02', gas }] }], ...extra }, 'latest'])
const make = (chaos: Emulation['chaos'] = {}, ep = EP) => createEmulator({ endpoint: ep, chaos })

describe('#273 provider emulation', () => {
  test('a refused method answers its recorded error and never reaches upstream', async () => {
    const f = fake()
    const r = await make().handle(msg('eth_chainIdX'), f.forward)
    expect(r.error).toEqual(E(-32601, 'Method not found'))
    expect(f.seen).toHaveLength(0)
  })

  test('a refused param: validation false is refused, absent is served', async () => {
    const f = fake()
    expect((await make().handle(sim('0x01', { validation: false }), f.forward)).error?.message).toContain('not supported yet')
    expect((await make().handle(sim('0x01'), f.forward)).error).toBeUndefined()
  })

  test('eth_simulateV1 reports gasUsed = the gas limit given, block and call', async () => {
    const f = fake()
    const r = await make().handle(sim('0x01', {}, '0x7530'), f.forward)
    const blk = (r.result as { gasUsed: string; calls: { gasUsed: string }[] }[])[0]!
    expect(blk.calls[0]!.gasUsed).toBe('0x7530')
    expect(blk.gasUsed).toBe('0x7530')
    const plain = await make({}, { ...EP, simulateGasUsedIsLimit: false }).handle(sim('0x01'), f.forward)
    expect((plain.result as { gasUsed: string }[])[0]!.gasUsed).toBe('0x5208')
  })

  test('eth_simulateV1 refuses a sender that has code: sender not eoa', async () => {
    const f = fake()
    expect((await make().handle(sim(CONTRACT), f.forward)).error).toEqual(E(-32000, 'sender not eoa'))
    expect((await make().handle(sim('0x01'), f.forward)).error).toBeUndefined()
  })

  test('eth_getLogs past the span answers the exact error; within it passes', async () => {
    const f = fake()
    const logs = (from: number, to: number | string) => msg('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: typeof to === 'number' ? `0x${to.toString(16)}` : to }])
    expect((await make().handle(logs(100, 200), f.forward)).error).toBeUndefined()
    expect((await make().handle(logs(100, 201), f.forward)).error).toEqual(E(-32614, 'eth_getLogs is limited to a 100 range'))
    expect((await make().handle(logs(800, 'latest'), f.forward)).error?.code).toBe(-32614)
    expect((await make().handle(logs(950, 'latest'), f.forward)).error).toBeUndefined()
  })

  test('a read at a block the node does not have yet is -32602', async () => {
    const f = fake()
    const e = make()
    for (const m of [msg('eth_call', [{ to: '0x02' }, '0x3e9']), msg('eth_getCode', [CONTRACT, '0x3e9'])]) {
      const r = await e.handle(m, f.forward)
      expect(r.error?.code).toBe(-32602)
      expect(r.error?.message).toStartWith('Block requested not found. Request might be querying historical state')
    }
    expect((await e.handle(msg('eth_call', [{ to: '0x02' }, '0x3e8']), f.forward)).error).toBeUndefined()
    expect((await e.handle(msg('eth_call', [{ to: '0x02' }, 'latest']), f.forward)).error).toBeUndefined()
  })

  test('429 injection is deterministic for a seed and follows the rate', () => {
    const run = (seed: number, rate: number) => {
      const e = make({ seed, rate429: rate })
      return Array.from({ length: 200 }, () => e.rateLimited())
    }
    expect(run(7, 0.3)).toEqual(run(7, 0.3))
    expect(run(7, 0.3)).not.toEqual(run(8, 0.3))
    const hits = run(7, 0.3).filter(Boolean).length
    expect(hits).toBeGreaterThan(30)
    expect(hits).toBeLessThan(90)
    expect(run(7, 0).some(Boolean)).toBe(false)
    expect(run(7, 1).every(Boolean)).toBe(true)
  })

  test('after a write, reads see a head N blocks behind for the window, then catch up', async () => {
    const f = fake(1000)
    const e = make({ lag: { blocks: 5, requests: 2 } })
    await e.handle(msg('eth_call', [{ to: '0x02' }, 'latest']), f.forward)
    expect(f.seen.at(-1)!.params![1]).toBe('latest') // no write yet: served at head
    await e.handle(msg('eth_sendRawTransaction', ['0xdead']), f.forward)
    const a = await e.handle(msg('eth_call', [{ to: '0x02' }, 'latest']), f.forward)
    expect((a.result as { params: unknown[] }).params[1]).toBe('0x3e3') // 1000 - 5
    expect(((await e.handle(msg('eth_blockNumber'), f.forward)).result)).toBe('0x3e3')
    const c = await e.handle(msg('eth_call', [{ to: '0x02' }, 'latest']), f.forward)
    expect((c.result as { params: unknown[] }).params[1]).toBe('latest')
    expect(e.stats().lagged).toBe(2)
  })

  test('a lagging read of an explicit block is untouched', async () => {
    const f = fake(1000)
    const e = make({ lag: { blocks: 5, requests: 3 } })
    await e.handle(msg('eth_sendRawTransaction', ['0xdead']), f.forward)
    const r = await e.handle(msg('eth_call', [{ to: '0x02' }, '0x3e8']), f.forward)
    expect((r.result as { params: unknown[] }).params[1]).toBe('0x3e8')
  })
})

describe('#273 engine port', () => {
  async function upstream() {
    const calls: string[] = []
    const s = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        const m = (await req.json()) as RpcMsg
        calls.push(m.method)
        return Response.json({ jsonrpc: '2.0', id: m.id, result: m.method === 'eth_blockNumber' ? '0x3e8' : 'ok' })
      },
    })
    return { url: `http://127.0.0.1:${s.port}/`, calls, stop: () => s.stop(true) }
  }
  const post = (url: string, body: unknown) => fetch(url, { method: 'POST', body: JSON.stringify(body) })

  test('without a profile nothing changes: forwarded as is, lab methods refused', async () => {
    const up = await upstream()
    const port = startEnginePort(up.url)
    try {
      expect(await (await post(port.url, msg('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9999' }]))).json()).toEqual({ jsonrpc: '2.0', id: 1, result: 'ok' })
      expect(((await (await post(port.url, msg('anvil_mine'))).json()) as { error: { code: number } }).error.code).toBe(-32601)
      expect(up.calls).toEqual(['eth_getLogs'])
    } finally {
      port.stop()
      up.stop()
    }
  })

  test('with a profile: the range error and an HTTP 429 at rate 1', async () => {
    const up = await upstream()
    const port = startEnginePort(up.url, undefined, [], { endpoint: EP })
    const limited = startEnginePort(up.url, undefined, [], { endpoint: EP, chaos: { rate429: 1 } })
    try {
      const r = (await (await post(port.url, msg('eth_getLogs', [{ fromBlock: '0x1', toBlock: '0x9999' }]))).json()) as { error: { code: number } }
      expect(r.error.code).toBe(-32614)
      const res = await post(limited.url, msg('eth_blockNumber'))
      expect(res.status).toBe(429)
    } finally {
      port.stop()
      limited.stop()
      up.stop()
    }
  })
})

describe('#273 recorded profile', () => {
  test('the recorded Monad profile has every endpoint and the facts the ticket names', () => {
    const p = loadProfile('monad')
    expect(Object.keys(p.endpoints).sort()).toEqual(['drpc', 'monadinfra', 'rpc.monad.xyz', 'rpc1.monad.xyz', 'rpc3.monad.xyz'])
    expect(Date.parse(p.recordedAt)).toBeGreaterThan(0)
    expect(p.endpoints['rpc.monad.xyz']!.simulateGasUsedIsLimit).toBe(true)
    expect(p.endpoints['rpc.monad.xyz']!.simulateSenderNotEoa?.message).toBe('sender not eoa')
    for (const k of ['rpc1.monad.xyz', 'rpc3.monad.xyz', 'monadinfra', 'drpc']) expect(p.endpoints[k]!.refusedMethods.eth_simulateV1).toBeDefined()
  })

  test('staleness: fresh within 7 days, refused after with the refresh command', () => {
    const p = { chain: 'monad', recordedAt: '2026-11-04' }
    expect(() => assertProfileFresh(p, new Date('2026-11-11T00:00:00Z'))).not.toThrow()
    expect(() => assertProfileFresh(p, new Date('2026-11-12T00:00:00Z'))).toThrow(/PROFILE_STALE.*bun run scenarios:probe-profile monad/)
    expect(() => assertProfileFresh({ chain: 'monad', recordedAt: 'nope' })).toThrow(/PROFILE_STALE/)
  })

  test('freshEmulation refuses a stale recorded profile and an unknown endpoint', () => {
    const recorded = new Date(`${loadProfile('monad').recordedAt}T12:00:00Z`)
    expect(freshEmulation('monad', 'rpc.monad.xyz', {}, recorded).endpoint.getLogs?.maxSpan).toBe(100)
    expect(() => freshEmulation('monad', 'rpc.monad.xyz', {}, new Date(recorded.getTime() + 8 * 86_400_000))).toThrow(/PROFILE_STALE/)
    expect(() => freshEmulation('monad', 'nope', {}, recorded)).toThrow(/no endpoint/)
  })
})
