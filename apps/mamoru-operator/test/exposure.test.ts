import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { baseRegistry } from '@mamoru/registry'
import { EXPOSURE_PATH, PeerExposure, elsewhereOf, exposureOf, joinReads, parsePeerOperators, totalOf, type ExposureWire, type PeerRead } from '../src/exposure.ts'
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

  test('what an engine counts elsewhere: everything the other chains hold, idle and placed, whoever runs', () => {
    const base = { chainId: 8453, idleUsdc: 400n * USDC, placedUsdc: 600n * USDC, active: true }
    const monad = { chainId: 143, idleUsdc: 900n * USDC, placedUsdc: 0n, active: false }
    expect(elsewhereOf({ ok: true, chains: [base] })).toBe(1_000n * USDC)
    expect(elsewhereOf({ ok: true, chains: [monad] })).toBe(900n * USDC)
    expect(elsewhereOf({ ok: true, chains: [base, monad] })).toBe(1_900n * USDC)
    expect(elsewhereOf({ ok: false, chainId: 8453 })).toBeNull()
    expect(elsewhereOf({ ok: true, chains: [] })).toBe(0n)
    expect(joinReads({ ok: true, chains: [base] }, { ok: false, chainId: 143 })).toEqual({ ok: false, chainId: 143 })
  })
})

/**
 * Merge gate round 1 (Opus, Argon): two chains reviewing from cached reads of each other. Each chain's room for new
 * money is cap - its own placed - everything the other holds; a chain places only its own idle money.
 */
describe('two chains placing from stale reads never place past the cap together', () => {
  const CAP = 1_000n * USDC
  const room = (ownPlaced: bigint, ownIdle: bigint, peer: PeerRead) => {
    const elsewhere = elsewhereOf(peer)
    if (elsewhere === null) return 0n
    const r = CAP - ownPlaced - elsewhere
    const left = r > 0n ? r : 0n
    return left < ownIdle ? left : ownIdle
  }
  const read = (chainId: number, idleUsdc: bigint, placedUsdc: bigint): PeerRead => ({ ok: true, chains: [{ chainId, idleUsdc, placedUsdc, active: true }] })

  test('Argon: Base holds a read of Monad (1,000 idle) from before Monad placed it; Base then gets a deposit', () => {
    // t=0 Base reads Monad: 1,000 idle. t=2 Monad reads Base (0, 0) and places its 1,000. t=5 Base gets 1,000 and
    // reviews on the t=0 read: Monad's idle money counts as committed to Monad, so Base places nothing.
    const monadPlaces = room(0n, 1_000n * USDC, read(8453, 0n, 0n))
    expect(monadPlaces).toBe(1_000n * USDC)
    const basePlaces = room(0n, 1_000n * USDC, read(143, 1_000n * USDC, 0n))
    expect(basePlaces).toBe(0n)
    expect(monadPlaces + basePlaces <= CAP).toBe(true)
  })

  test('Opus: Monad places on a read of Base (0, 0); a deposit on Base is placed on a read of Monad taken after the Monad deposit landed', () => {
    // A chain only places its own deposit, so that deposit landed before its review; the other chain's read, taken after
    // its own deposit landed, already shows it, idle or placed. Either order, the sum stays within the cap.
    for (const [first, second] of [[1_000n, 1_000n], [600n, 700n], [300n, 200n]] as const) {
      const a = room(0n, first * USDC, read(8453, 0n, 0n))
      const b = room(0n, second * USDC, read(143, first * USDC - a, a))
      expect(a + b <= CAP).toBe(true)
    }
  })

  test('what a stale read could still miss is bounded: an engine review never uses a read of the peer older than 2 s', async () => {
    // The residual window: both deposits landing and one being placed inside the age of the other's read (2 s here,
    // plus the peer's own read at most 2 s old). Outside it, the cases above hold.
    let now = Date.now()
    let n = 0
    const p = peer(() => wire({ idleUsdc: String(n++) }))
    const reader = new PeerExposure([{ chainId: 143, url: p.url }], SECRET, fetch, () => now)
    await reader.read(SAFE, 2_000)
    now += 1_999
    await reader.read(SAFE, 2_000)
    expect(p.asked).toHaveLength(1)
    now += 2
    await reader.read(SAFE, 2_000)
    expect(p.asked).toHaveLength(2)
  })

  test('the peer could not be read: no new money on either side', () => {
    expect(room(0n, 1_000n * USDC, { ok: false, chainId: 143 })).toBe(0n)
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
