import type { Registry } from '@mamoru/registry'
import type { Address, PublicClient } from 'viem'
import { poolSnapshotAbi } from './abis.ts'
import type { Anchor } from './provenance.ts'

/** What a backtest needs of one pool at one block: price, active liquidity and the fee growth counters. */
export type PoolSnapshot = {
  pool: Address
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  feeGrowthGlobal0X128: bigint
  feeGrowthGlobal1X128: bigint
  /** Null when `observe` cannot answer; the TWAP is then rebuilt from the tick series. */
  tickCumulative: bigint | null
  feeProtocol: number
}

const READS = ['slot0', 'liquidity', 'feeGrowthGlobal0X128', 'feeGrowthGlobal1X128'] as const

/** Every pool of the registry, not only the pools of the live policy: the Lab compares pools the engine does not enter yet. */
export function snapshotPools(registry: Registry): Address[] {
  return registry.entries.filter((e) => e.kind === 'pool').map((e) => e.address)
}

/** Calldata bytes viem packs into one aggregate3. Five reads of a pool take 116, so one request holds about 70 pools. */
const MULTICALL_BATCH_BYTES = 8_192

/**
 * All pools at `H` through Multicall3: one `eth_call` for the registry as it is today, instead of five per pool.
 * A pool with a failed read is left out; the others are kept.
 */
export async function readPoolSnapshots(client: PublicClient, pools: readonly Address[], anchor: Anchor): Promise<PoolSnapshot[]> {
  if (pools.length === 0) return []
  const contracts = pools.flatMap((address) => [
    ...READS.map((functionName) => ({ address, abi: poolSnapshotAbi, functionName }) as const),
    { address, abi: poolSnapshotAbi, functionName: 'observe', args: [[0]] } as const,
  ])
  type Read = { status: 'success'; result: unknown } | { status: 'failure' }
  const at = { contracts, blockNumber: BigInt(anchor.blockNumber), batchSize: MULTICALL_BATCH_BYTES } as const
  let results = (await client.multicall({ ...at, allowFailure: true })) as Read[]
  // viem reports a failed request as every call failed. One more try, this time letting the cause out so the sync can log it.
  if (results.every((r) => r.status === 'failure')) results = ((await client.multicall({ ...at, allowFailure: false })) as unknown[]).map((result) => ({ status: 'success', result }))
  const per = READS.length + 1
  const out: PoolSnapshot[] = []
  pools.forEach((pool, i) => {
    const [slot0, liquidity, fg0, fg1, observe] = results.slice(i * per, (i + 1) * per)
    if (slot0?.status !== 'success' || liquidity?.status !== 'success' || fg0?.status !== 'success' || fg1?.status !== 'success') return
    const s0 = slot0.result as readonly [bigint, number, number, number, number, number, boolean]
    const cumulatives = observe?.status === 'success' ? (observe.result as readonly [readonly bigint[], readonly bigint[]])[0] : undefined
    out.push({
      pool,
      sqrtPriceX96: s0[0],
      tick: s0[1],
      liquidity: liquidity.result as bigint,
      feeGrowthGlobal0X128: fg0.result as bigint,
      feeGrowthGlobal1X128: fg1.result as bigint,
      tickCumulative: cumulatives?.[0] ?? null,
      feeProtocol: s0[5],
    })
  })
  return out
}
