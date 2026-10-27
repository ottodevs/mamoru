import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseRegistry } from '@mamoru/registry'
import { EXPOSURE_PATH, PeerExposure, elsewhereOf, exposureOf, parsePeerOperators, placesFirst, totalOf, type ExposureWire } from '../src/exposure.ts'
import { RpcMetrics } from '../src/metrics.ts'
import type { Operator } from '../src/operator.ts'
import { startServer } from '../src/server.ts'

// otto/mamoru#212: the cap is the account's total across chains; the other chain is read from its operator.
const SECRET = 'test-operator-secret'
const SAFE = '0x1c046083d60655f3cde66130d774ac64c5a5d60a'
const USDC = 1_000_000n
const dirs: string[] = []
const servers: { stop(force: boolean): void }[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A peer operator on chain 143 answering `answer` for every Safe. */
function peer(answer: (address: string) => Partial<ExposureWire> | Promise<Partial<ExposureWire>>, chainId = 143) {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-exposure-'))
  dirs.push(d)
  const asked: string[] = []
  const op = {
    cfg: { chainId, registry: baseRegistry, live: true, policy: { policyId: 'p' } },
    relayer: { address: '0x1111111111111111111111111111111111111111' },
    exposureFor: async (address: string) => {
      asked.push(address)
      return answer(address)
    },
  } as unknown as Operator
  const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics: new RpcMetrics(d), gitSha: 'x', bootedAt: Date.now() })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, asked }
}

const wire = (over: Partial<ExposureWire> = {}): Partial<ExposureWire> => ({ chainId: 143, address: SAFE, block: '1', idleUsdc: (300n * USDC).toString(), placedUsdc: (450n * USDC).toString(), active: true, ...over })

describe('one chain\'s exposure', () => {
  test('idle USDC and USDC on its way are idle; other tokens and positions are placed', () => {
    const e = exposureOf(8453, [{ token: 'USDC', valueUsdc: '100000000' }, { token: 'cbBTC', valueUsdc: '25000000' }], [300n * USDC, 50n * USDC], 20n * USDC, true)
    expect(e).toEqual({ chainId: 8453, idleUsdc: 120n * USDC, placedUsdc: 375n * USDC, active: true })
    expect(totalOf(e)).toBe(495n * USDC)
  })

  test('what an engine counts elsewhere: placed money, plus the savings of a running chain that places first', () => {
    const base = { chainId: 8453, idleUsdc: 400n * USDC, placedUsdc: 600n * USDC, active: true }
    const monad = { chainId: 143, idleUsdc: 900n * USDC, placedUsdc: 0n, active: true }
    expect(placesFirst(8453, 143)).toBe(true)
    expect(placesFirst(143, 8453)).toBe(false)
    // Monad leaves room for the 400 Base may still place; Base does not wait for Monad's savings.
    expect(elsewhereOf(143, { ok: true, chains: [base] })).toBe(1_000n * USDC)
    expect(elsewhereOf(8453, { ok: true, chains: [monad] })).toBe(0n)
    // Base stopped: its savings are not about to be placed.
    expect(elsewhereOf(143, { ok: true, chains: [{ ...base, active: false }] })).toBe(600n * USDC)
    expect(elsewhereOf(143, { ok: false, chainId: 8453 })).toBeNull()
    expect(elsewhereOf(143, { ok: true, chains: [] })).toBe(0n)
  })
})

describe('MAMORU_PEER_OPERATORS', () => {
  test('chainId=url pairs; the own chain is skipped so both units carry the same value', () => {
    const v = '143=http://127.0.0.1:8788, 8453=http://127.0.0.1:8787'
    expect(parsePeerOperators(v, 8453)).toEqual([{ chainId: 143, url: 'http://127.0.0.1:8788' }])
    expect(parsePeerOperators(v, 143)).toEqual([{ chainId: 8453, url: 'http://127.0.0.1:8787' }])
    expect(parsePeerOperators(undefined, 8453)).toEqual([])
    expect(parsePeerOperators(' ', 8453)).toEqual([])
  })

  test('malformed, plain http off loopback, or a chain twice: refused at boot', () => {
    expect(() => parsePeerOperators('143', 8453)).toThrow('chainId=url')
    expect(() => parsePeerOperators('143=nope', 8453)).toThrow('not a URL')
    expect(() => parsePeerOperators('143=http://10.0.0.2:8788', 8453)).toThrow('not https')
    expect(() => parsePeerOperators('143=http://127.0.0.1:8788,143=http://127.0.0.1:8789', 8453)).toThrow('twice')
    expect(parsePeerOperators('143=https://monad.example', 8453)).toEqual([{ chainId: 143, url: 'https://monad.example' }])
  })
})

describe('reading the peer operator', () => {
  test('signed read of the same Safe on the peer chain, kept briefly', async () => {
    const p = peer(() => wire())
    const calls: string[] = []
    const reader = new PeerExposure([{ chainId: 143, url: p.url }], SECRET, (u, i) => (calls.push(u), fetch(u, i)))
    const r = await reader.read(SAFE.toUpperCase().replace('0X', '0x'), 30_000)
    expect(r).toEqual({ ok: true, chains: [{ chainId: 143, idleUsdc: 300n * USDC, placedUsdc: 450n * USDC, active: true }] })
    expect(p.asked).toEqual([SAFE])
    await reader.read(SAFE, 30_000)
    expect(calls).toHaveLength(1)
    // Older than asked for: read again.
    await reader.read(SAFE, 0)
    expect(calls).toHaveLength(2)
  })

  test('no peers: an empty read, the chain alone counts', async () => {
    expect(await new PeerExposure([], SECRET).read(SAFE, 0)).toEqual({ ok: true, chains: [] })
  })

  test('fails closed: unreachable, refused, another chain, another Safe, or a malformed answer', async () => {
    const down = new PeerExposure([{ chainId: 143, url: 'http://127.0.0.1:9' }], SECRET)
    expect(await down.read(SAFE, 0)).toEqual({ ok: false, chainId: 143 })
    const ok = peer(() => wire())
    expect(await new PeerExposure([{ chainId: 143, url: ok.url }], 'another-secret').read(SAFE, 0)).toEqual({ ok: false, chainId: 143 })
    for (const bad of [wire({ chainId: 8453 }), wire({ address: '0x2222222222222222222222222222222222222222' }), wire({ idleUsdc: '-1' }), wire({ placedUsdc: '1.5' }), { chainId: 143 }]) {
      const p = peer(() => bad)
      expect(await new PeerExposure([{ chainId: 143, url: p.url }], SECRET).read(SAFE, 0)).toEqual({ ok: false, chainId: 143 })
    }
    const slow = peer(async () => (await Bun.sleep(300), wire()))
    expect(await new PeerExposure([{ chainId: 143, url: slow.url }], SECRET, fetch, Date.now, 50).read(SAFE, 0)).toEqual({ ok: false, chainId: 143 })
  })

  test('one of two peers failing fails the whole read', async () => {
    const good = peer(() => wire())
    const reader = new PeerExposure([{ chainId: 143, url: good.url }, { chainId: 10, url: 'http://127.0.0.1:9' }], SECRET)
    expect(await reader.read(SAFE, 0)).toEqual({ ok: false, chainId: 10 })
  })
})

describe(`GET ${EXPOSURE_PATH}<address>`, () => {
  test('unsigned, or signed for another path: 401; not an address: 400', async () => {
    const p = peer(() => wire())
    expect((await fetch(`${p.url}${EXPOSURE_PATH}${SAFE}`)).status).toBe(401)
    const { metricsSignature } = await import('@mamoru/operator-auth')
    const minute = Math.floor(Date.now() / 60_000)
    const other = await metricsSignature(SECRET, 'GET', '/metrics', minute)
    expect((await fetch(`${p.url}${EXPOSURE_PATH}${SAFE}`, { headers: { 'x-mamoru-sig': other } })).status).toBe(401)
    const path = `${EXPOSURE_PATH}nope`
    expect((await fetch(`${p.url}${path}`, { headers: { 'x-mamoru-sig': await metricsSignature(SECRET, 'GET', path, minute) } })).status).toBe(400)
    expect(p.asked).toEqual([])
  })
})
