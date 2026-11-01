import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { metricsSignature } from '@mamoru/operator-auth'
import { RpcMetrics } from '../src/metrics.ts'
import type { Operator } from '../src/operator.ts'
import { startServer } from '../src/server.ts'

const SECRET = 'test-operator-secret'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const STATS = {
  'pool:USDC/USDT/100': { tvlUsd: 210_000, tvl1dAgoUsd: null, tvl7dAgoUsd: null, tvl30dAgoUsd: null, volume7dUsd: 7e6, volumeLastDayUsd: 1e6, volume28dAvgUsd: 9e5, asOf: 1_793_500_000 },
}

function boot(stats: typeof STATS | null) {
  const d = mkdtempSync(join(tmpdir(), 'mamoru-server-pool-stats-'))
  dirs.push(d)
  let calls = 0
  const op = { cfg: { chainId: 8453, live: true, policy: { policyId: 'p' } }, relayer: { address: '0x1111111111111111111111111111111111111111' }, poolStatsView: () => (calls++, stats) } as unknown as Operator
  const server = startServer(op, { secret: SECRET, hostname: '127.0.0.1', port: 0, rpcMetrics: new RpcMetrics(d), gitSha: 'x', bootedAt: Date.now() })
  return { server, base: `http://127.0.0.1:${server.port}`, calls: () => calls }
}

const sig = async (path: string) => ({ 'x-mamoru-sig': await metricsSignature(SECRET, 'GET', path, Math.floor(Date.now() / 60_000)) })

describe('GET /pool-stats (otto/mamoru#248)', () => {
  test('unsigned is refused and never reads the cache', async () => {
    const b = boot(STATS)
    try {
      expect((await fetch(`${b.base}/pool-stats`)).status).toBe(401)
      expect(b.calls()).toBe(0)
    } finally {
      b.server.stop(true)
    }
  })

  test('a /metrics signature does not open /pool-stats', async () => {
    const b = boot(STATS)
    try {
      expect((await fetch(`${b.base}/pool-stats`, { headers: await sig('/metrics') })).status).toBe(401)
    } finally {
      b.server.stop(true)
    }
  })

  test('signed: the cached stats as they are, with the chain', async () => {
    const b = boot(STATS)
    try {
      const res = await fetch(`${b.base}/pool-stats`, { headers: await sig('/pool-stats') })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ chainId: 8453, pools: STATS })
    } finally {
      b.server.stop(true)
    }
  })

  test('signed, no cache on this chain (Monad): 404', async () => {
    const b = boot(null)
    try {
      expect((await fetch(`${b.base}/pool-stats`, { headers: await sig('/pool-stats') })).status).toBe(404)
    } finally {
      b.server.stop(true)
    }
  })

  test('POST is not allowed', async () => {
    const b = boot(STATS)
    try {
      expect((await fetch(`${b.base}/pool-stats`, { method: 'POST', headers: await sig('/pool-stats') })).status).toBe(405)
    } finally {
      b.server.stop(true)
    }
  })
})
