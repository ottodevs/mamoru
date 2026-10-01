import { concat, keccak256, stringToHex } from 'viem'
import type { Hex } from '@mamoru/domain'
import { canonicalJson } from '@mamoru/decide'
import type { RegistryName } from '@mamoru/registry'
import type { Dataset, PoolSample, Sample } from './types.ts'

/** Hash of the content: chain, pools and every sample folded in order. */
export function datasetId(d: { chainId: number; pools: RegistryName[]; samples: Sample[] }): Hex {
  let h = keccak256(stringToHex(canonicalJson({ chainId: d.chainId, pools: d.pools })))
  for (const s of d.samples) h = keccak256(concat([h, keccak256(stringToHex(canonicalJson(s)))]))
  return h
}

/** Samples in block order, one per block, with the content hash as id. */
export function makeDataset(chainId: number, pools: RegistryName[], samples: Sample[]): Dataset {
  const sorted = [...samples].sort((a, b) => a.block - b.block).filter((s, i, all) => i === 0 || s.block !== all[i - 1]!.block)
  for (const s of sorted) if (s.pools.length !== pools.length) throw new Error(`sample at block ${s.block} has ${s.pools.length} pools, the dataset names ${pools.length}`)
  return { id: datasetId({ chainId, pools, samples: sorted }), chainId, pools, samples: sorted }
}

type PoolJson = [sqrtPriceX96: string, tick: number, liquidity: string, feeGrowth0: string, feeGrowth1: string, tickCumulative: string | null]
type SampleJson = { b: number; h: Hex; t: number; f: string; p: (PoolJson | null)[] }
export type DatasetJson = { format: 'mamoru-dataset-v1'; id: Hex; chainId: number; pools: RegistryName[]; samples: SampleJson[] }

/** Compact JSON: integers wider than 53 bits as decimal strings. */
export function encodeDataset(d: Dataset): DatasetJson {
  const pool = (p: PoolSample | null): PoolJson | null =>
    p && [p.sqrtPriceX96.toString(), p.tick, p.liquidity.toString(), p.feeGrowthGlobal0X128.toString(), p.feeGrowthGlobal1X128.toString(), p.tickCumulative === null ? null : p.tickCumulative.toString()]
  return { format: 'mamoru-dataset-v1', id: d.id, chainId: d.chainId, pools: d.pools, samples: d.samples.map((s) => ({ b: s.block, h: s.hash, t: s.time, f: s.baseFeeWei.toString(), p: s.pools.map(pool) })) }
}

/** Reads a dataset file and refuses one whose content does not hash to its id. */
export function decodeDataset(j: DatasetJson): Dataset {
  if (j.format !== 'mamoru-dataset-v1') throw new Error(`unknown dataset format ${String(j.format)}`)
  const pool = (p: PoolJson | null): PoolSample | null =>
    p && { sqrtPriceX96: BigInt(p[0]), tick: p[1], liquidity: BigInt(p[2]), feeGrowthGlobal0X128: BigInt(p[3]), feeGrowthGlobal1X128: BigInt(p[4]), tickCumulative: p[5] === null ? null : BigInt(p[5]) }
  const samples: Sample[] = j.samples.map((s) => ({ block: s.b, hash: s.h, time: s.t, baseFeeWei: BigInt(s.f), pools: s.p.map(pool) }))
  const id = datasetId({ chainId: j.chainId, pools: j.pools, samples })
  if (id !== j.id) throw new Error(`dataset content hashes to ${id}, the file says ${j.id}`)
  return { id, chainId: j.chainId, pools: j.pools, samples }
}
