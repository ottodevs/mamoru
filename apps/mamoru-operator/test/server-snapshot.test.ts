import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { metricsSignature } from '@mamoru/operator-auth'
import { RpcMetrics } from '../src/metrics.ts'
import type { Operator } from '../src/operator.ts'
import { startServer } from '../src/server.ts'
import { SnapshotLoop, type Snapshot } from '../src/snapshot.ts'

const SECRET = 'test-operator-secret'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const SNAP: Snapshot = {
  chainId: 8453,
  block: 52644273n,
  readAt: '2026-10-15T10:00:00.000Z',
  pools: {},
  safes: [{ accountKey: 'c23e94e1-2b74-47e5-a46e-56f3e4d366a1', safe: '0x1C046083d60655f3CDe66130d774ac64C5A5D60a', active: true, armed: false, deployed: true, eth: 1n, tokens: { USDC: 189962n }, positions: [], idleUsdc: 189962n, lpUsdc: 0n, feesUsdc: 0n, owedUsdc: 0n, totalUsdc: 189962n }],
  calls: 3,
}

function boot(snapshot: SnapshotLoop | null) {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-server-snapshot-'))
  dirs.push(d)
  const op = { cfg: { chainId: 8453, live: true, policy: { policyId: 'p' } }, relayer: { address: '0x1111111111111111111111111111111111111111' } } as unknown as Operator
  const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics: new RpcMetrics(d), gitSha: 'x', bootedAt: Date.now(), snapshot })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

const signed = async () => ({ 'x-mamoru-sig': await metricsSignature(SECRET, 'GET', '/snapshot', Math.floor(Date.now() / 60_000)) })

describe('GET /snapshot (otto/mamoru#136)', () => {
  test('unsigned is refused', async () => {
    const { server, base } = boot(null)
    try {
      expect((await fetch(`${base}/snapshot`)).status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('a /metrics signature does not open /snapshot', async () => {
    const { server, base } = boot(null)
    try {
      const sig = await metricsSignature(SECRET, 'GET', '/metrics', Math.floor(Date.now() / 60_000))
      expect((await fetch(`${base}/snapshot`, { headers: { 'x-mamoru-sig': sig } })).status).toBe(401)
    } finally {
      server.stop(true)
    }
  })

  test('signed, no loop at all (not Base, or no MULTICALL3): 404', async () => {
    const { server, base } = boot(null)
    try {
      expect((await fetch(`${base}/snapshot`, { headers: await signed() })).status).toBe(404)
    } finally {
      server.stop(true)
    }
  })

  test('signed, a loop exists but was never started (otto/mamoru#129: the yield_ledger flag is off): 404', async () => {
    const { server, base } = boot(new SnapshotLoop(async () => SNAP, 60_000))
    try {
      expect((await fetch(`${base}/snapshot`, { headers: await signed() })).status).toBe(404)
    } finally {
      server.stop(true)
    }
  })

  test('signed, running but before the first read lands: 503', async () => {
    const loop = new SnapshotLoop(() => new Promise<Snapshot>(() => {}), 60_000)
    loop.start()
    const { server, base } = boot(loop)
    try {
      expect((await fetch(`${base}/snapshot`, { headers: await signed() })).status).toBe(503)
    } finally {
      loop.stop()
      server.stop(true)
    }
  })

  test('otto/mamoru#129: read once, then the flag turns off (stop) — 404, never the now-stale snapshot', async () => {
    const loop = new SnapshotLoop(async () => SNAP, 60_000)
    loop.start()
    await new Promise((r) => setTimeout(r, 5))
    expect(loop.current).not.toBeNull()
    loop.stop()
    const { server, base } = boot(loop)
    try {
      expect((await fetch(`${base}/snapshot`, { headers: await signed() })).status).toBe(404)
    } finally {
      server.stop(true)
    }
  })

  test('signed: the latest snapshot, account keys cut to 8 characters, bigints as strings', async () => {
    const loop = new SnapshotLoop(async () => SNAP, 60_000)
    loop.start()
    await new Promise((r) => setTimeout(r, 5))
    const { server, base } = boot(loop)
    try {
      const res = await fetch(`${base}/snapshot`, { headers: await signed() })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { block: string; safes: { accountKey: string; totalUsdc: string }[] }
      expect(body.block).toBe('52644273')
      expect(body.safes[0]!.accountKey).toBe('c23e94e1')
      expect(body.safes[0]!.totalUsdc).toBe('189962')
    } finally {
      loop.stop()
      server.stop(true)
    }
  })
})
