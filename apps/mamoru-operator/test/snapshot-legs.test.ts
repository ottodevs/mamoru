import { describe, expect, test } from 'bun:test'
import { baseRegistry, entry } from '@mamoru/registry'
import { inUsdc, usdcPools } from '../src/chain.ts'
import { idleByToken, type PoolState } from '../src/snapshot.ts'

// Spec 013 A1-D2: the snapshot's per-token USD of idle balances, so Stats' "By token" splits exactly. Position legs
// (value0Usdc/value1Usdc) are the same inUsdc calls that make up valueUsdc in readSnapshot.

const pool = usdcPools(baseRegistry).find((p) => entry(p, baseRegistry).token0 !== 'USDC' || entry(p, baseRegistry).token1 !== 'USDC')!
const e = entry(pool, baseRegistry)
const other = e.token0 === 'USDC' ? e.token1! : e.token0!
const pools: Record<string, PoolState> = { [pool]: { sqrtPriceX96: 2n ** 96n * 50n, tick: 0, feeGrowthGlobal0X128: 0n, feeGrowthGlobal1X128: 0n } }

describe('idleByToken', () => {
  test('USDC at face value, another token at its pool price, zero balances left out; the values add up to idle', () => {
    const v = idleByToken({ USDC: 5_000_000n, [other]: 10n ** 15n, USDT: 0n }, pools, baseRegistry)
    expect(Object.keys(v).sort()).toEqual(['USDC', other].sort())
    expect(v.USDC).toBe(5_000_000n)
    expect(v[other]).toBe(inUsdc(pool, other, 10n ** 15n, pools[pool]!.sqrtPriceX96, baseRegistry))
  })

})
