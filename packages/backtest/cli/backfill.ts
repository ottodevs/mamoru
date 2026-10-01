// Builds a dataset file from an archive node: every registry pool at one block every `--step` blocks.
//   bun packages/backtest/cli/backfill.ts --days 30 --step 150 --out .local/base-30d.json
// One Multicall3 eth_call and one eth_getBlockByNumber per sample. Samples already fetched are kept in a cache next
// to the output, so an interrupted run resumes. Never uses the operator's RPC key: BACKFILL_RPC_URL takes one or
// more archive endpoints separated by commas; requests rotate over them and a throttled one is skipped for a while.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from 'viem'
import { base } from 'viem/chains'
import { baseRegistry } from '@mamoru/registry'
import { encodeDataset, makeDataset } from '../src/dataset.ts'
import type { PoolSample, Sample } from '../src/types.ts'

const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
])
const READS = ['slot0', 'liquidity', 'feeGrowthGlobal0X128', 'feeGrowthGlobal1X128'] as const

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i >= 0 ? process.argv[i + 1] : fallback
  if (v === undefined) throw new Error(`missing --${name}`)
  return v
}

const POOLS = baseRegistry.entries.filter((e) => e.kind === 'pool')

async function readSample(client: PublicClient, block: bigint): Promise<Sample> {
  const contracts = POOLS.flatMap((e) => [
    ...READS.map((functionName) => ({ address: e.address, abi: poolAbi, functionName }) as const),
    { address: e.address, abi: poolAbi, functionName: 'observe', args: [[0]] } as const,
  ])
  const [b, results] = await Promise.all([client.getBlock({ blockNumber: block }), client.multicall({ contracts, blockNumber: block, allowFailure: true, batchSize: 8_192 })])
  const per = READS.length + 1
  const pools: (PoolSample | null)[] = POOLS.map((_e, i) => {
    const [slot0, liquidity, fg0, fg1, observe] = results.slice(i * per, (i + 1) * per)
    if (slot0?.status !== 'success' || liquidity?.status !== 'success' || fg0?.status !== 'success' || fg1?.status !== 'success') return null
    const s0 = slot0.result as readonly [bigint, number, number, number, number, number, boolean]
    const cumulatives = observe?.status === 'success' ? (observe.result as readonly [readonly bigint[], readonly bigint[]])[0] : undefined
    return { sqrtPriceX96: s0[0], tick: s0[1], liquidity: liquidity.result as bigint, feeGrowthGlobal0X128: fg0.result as bigint, feeGrowthGlobal1X128: fg1.result as bigint, tickCumulative: cumulatives?.[0] ?? null }
  })
  return { block: Number(b.number), hash: b.hash as Hex, time: Number(b.timestamp), baseFeeWei: b.baseFeePerGas ?? 0n, pools }
}

const big = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)
const unbig = (_k: string, v: unknown) => (typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v)

const out = arg('out')
const step = BigInt(arg('step', '150'))
// Public archive endpoints that answered historical eth_call on 2026-10-02. All of them throttle by source address.
// base.drpc.org and mainnet.base.org also serve archive state but are the live operator's fallbacks: a backfill from
// the operator's host would starve it, so they are not defaults.
const DEFAULT_URLS = 'https://base-mainnet.public.blastapi.io,https://base.gateway.tenderly.co,https://gateway.tenderly.co/public/base'
const urls = (process.env.BACKFILL_RPC_URL ?? DEFAULT_URLS).split(',').map((u) => u.trim()).filter(Boolean)
const concurrency = Number(arg('concurrency', '4'))
const endpoints = urls.map((url) => ({ host: new URL(url).host, restUntil: 0, client: createPublicClient({ chain: base, transport: http(url, { retryCount: 0, timeout: 20_000 }) }) as PublicClient }))
let turn = 0

/** Runs `f` on the next endpoint that is not resting. An endpoint that fails rests for a minute; with all resting, it waits. */
async function onAny<T>(f: (c: PublicClient) => Promise<T>): Promise<T> {
  let last: unknown = new Error('no endpoint answered')
  for (let failures = 0; failures < endpoints.length * 4; ) {
    const awake = endpoints.filter((e) => e.restUntil <= Date.now())
    if (awake.length === 0) {
      await new Promise((r) => setTimeout(r, 5_000))
      continue
    }
    const e = awake[turn++ % awake.length]!
    try {
      return await f(e.client)
    } catch (err) {
      last = err
      failures++
      e.restUntil = Date.now() + 60_000
    }
  }
  throw last
}

const head = (await onAny((c) => c.getBlock({ blockTag: 'safe' }))).number
// Base produces a block every two seconds: 43,200 a day.
const to = process.argv.includes('--to-block') ? BigInt(arg('to-block')) : head - (head % step)
const from = process.argv.includes('--from-block') ? BigInt(arg('from-block')) : to - BigInt(Math.round(Number(arg('days', '7')) * 43_200))
const blocks: bigint[] = []
for (let b = from - (from % step); b <= to; b += step) blocks.push(b)

mkdirSync(dirname(out), { recursive: true })
const cache = `${out}.cache.jsonl`
const have = new Map<number, Sample>()
if (existsSync(cache)) for (const line of readFileSync(cache, 'utf8').split('\n')) if (line) { const s = JSON.parse(line, unbig) as Sample; have.set(s.block, s) }
const todo = blocks.filter((b) => !have.has(Number(b)))
console.log(`blocks ${from}..${to} every ${step}: ${blocks.length} samples, ${have.size} cached, ${todo.length} to fetch from ${endpoints.map((e) => e.host).join(', ')}`)

let done = 0
let failed = 0
const started = Date.now()
async function worker(): Promise<void> {
  for (let b = todo.shift(); b !== undefined; b = todo.shift()) {
    try {
      // A throttled endpoint answers the aggregate with every inner call failed. A pool that is really missing at
      // this block stays null after the retries; anything else is a gap in the data and must not be kept.
      let s = await onAny((c) => readSample(c, b))
      for (let attempt = 0; attempt < 5 && s.pools.some((p) => p === null); attempt++) {
        await new Promise((r) => setTimeout(r, 1_000 * (attempt + 1)))
        s = await onAny((c) => readSample(c, b))
      }
      if (s.pools.every((p) => p === null)) throw new Error('no pool answered')
      have.set(s.block, s)
      appendFileSync(cache, `${JSON.stringify(s, big)}\n`)
    } catch (err) {
      failed++
      console.error(`block ${b}: ${String((err as Error)?.message ?? err).split('\n')[0]}`)
    }
    if (++done % 250 === 0) console.log(`${done} fetched, ${failed} failed, ${Math.round((Date.now() - started) / 1000)} s`)
  }
}
await Promise.all(Array.from({ length: concurrency }, worker))

const samples = blocks.flatMap((b) => have.get(Number(b)) ?? [])
const ds = makeDataset(base.id, POOLS.map((e) => e.name), samples)
writeFileSync(out, JSON.stringify(encodeDataset(ds)))
console.log(`${out}: ${ds.samples.length} samples, ${failed} blocks failed, id ${ds.id}`)
if (failed > 0) process.exitCode = 1
