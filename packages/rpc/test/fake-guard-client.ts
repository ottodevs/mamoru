// Shared by the rpc and operator tests of the guard history (#172): a fake chain answering only the pool reads.
import { createPublicClient, custom, decodeFunctionData, encodeFunctionData, encodeFunctionResult, isAddressEqual, parseAbi, type Address, type Hex } from 'viem'
import { uniswapV3PoolAbi } from '@mamoru/registry'
import { multicall3Abi } from '../src/multicall.ts'

const observeAbi = parseAbi(['function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'])
export const MULTICALL3 = `0x${'ca11'.repeat(10)}` as Address
export const BTC_POOL = `0x${'b7c0'.repeat(10)}` as Address
export const STABLE_POOL = `0x${'5ab1'.repeat(10)}` as Address

/** Decodes one `observe(uint32[])` call and answers it: reverts if any requested offset is past `maxLookback`. */
function observeResult(data: Hex, tick: bigint, base: bigint, maxLookback: number): { success: boolean; returnData: Hex } {
  const { args } = decodeFunctionData({ abi: observeAbi, data })
  const secondsAgos = args[0] as readonly number[]
  if (secondsAgos.some((s) => s > maxLookback)) return { success: false, returnData: '0x' }
  const tickCumulatives = secondsAgos.map((s) => base - BigInt(s) * tick)
  const secondsPerLiquidity = secondsAgos.map(() => 0n)
  return { success: true, returnData: encodeFunctionResult({ abi: observeAbi, functionName: 'observe', result: [tickCumulatives, secondsPerLiquidity] }) }
}

/** Pool calls every fake client answered (observe and fee growth), for the call-count tests of #172. */
export const poolCalls = { n: 0 }

/** A client with two pools: one whose oracle answers any lookback (the stables pool today, see LC-T6), one that only answers within `maxLookback` (cbBTC/WETH today). */
export function fakeClient(maxLookback: number, fees?: { growth: bigint; failOn?: Address }) {
  const pools: Record<string, { tick: bigint; base: bigint; maxLookback: number }> = {
    [STABLE_POOL.toLowerCase()]: { tick: 0n, base: 0n, maxLookback: Number.MAX_SAFE_INTEGER },
    [BTC_POOL.toLowerCase()]: { tick: 7n, base: 1_000_000n, maxLookback },
  }
  const answer = (to: Address, data: Hex): { success: boolean; returnData: Hex } => {
    const pool = pools[to.toLowerCase()]
    if (!pool) return { success: false, returnData: '0x' }
    poolCalls.n++
    // #172: fee growth globals, token1 twice token0; one pool may revert them.
    for (const [i, fn] of (['feeGrowthGlobal0X128', 'feeGrowthGlobal1X128'] as const).entries()) {
      if (data.slice(0, 10) !== encodeFunctionData({ abi: uniswapV3PoolAbi, functionName: fn }).slice(0, 10)) continue
      if (!fees || (fees.failOn && isAddressEqual(fees.failOn, to))) return { success: false, returnData: '0x' }
      return { success: true, returnData: encodeFunctionResult({ abi: uniswapV3PoolAbi, functionName: fn, result: fees.growth * BigInt(i + 1) }) }
    }
    return observeResult(data, pool.tick, pool.base, pool.maxLookback)
  }
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: readonly unknown[] }) {
        if (method !== 'eth_call') throw new Error(`unexpected method ${method}`)
        const { to, data } = (params as readonly [{ to: Address; data: Hex }])[0]!
        if (isAddressEqual(to, MULTICALL3)) {
          const { args } = decodeFunctionData({ abi: multicall3Abi, data })
          const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]
          const results = calls.map((c) => answer(c.target, c.callData))
          return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results })
        }
        const r = answer(to, data)
        if (!r.success) throw Object.assign(new Error('execution reverted'), { code: 3, data: '0x' })
        return r.returnData
      },
    }),
  })
}

