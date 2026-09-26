import type { ReasonCode } from '@mamoru/domain'
import type { Address, PublicClient } from 'viem'
import { balanceOfAbi, poolReadAbi } from './abis.ts'
import { twapTick } from './math.ts'

/** Pool state at `H`. A null field was not observed. */
export type PoolState = {
  sqrtPriceX96: bigint | null
  tick: number | null
  liquidity: bigint | null
  twapTick: number | null
  twapCode?: ReasonCode
  balance0: bigint | null
  balance1: bigint | null
}

function settled<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === 'fulfilled' ? r.value : null
}

/** slot0, liquidity, observe over the TWAP window and both token balances, all at one block. */
export async function readPoolState(
  client: PublicClient,
  pool: Address,
  token0: Address,
  token1: Address,
  blockNumber: bigint,
  twapWindowSeconds: number | undefined,
): Promise<PoolState> {
  const at = { blockNumber }
  const [slot0, liquidity, observe, balance0, balance1] = await Promise.allSettled([
    client.readContract({ address: pool, abi: poolReadAbi, functionName: 'slot0', ...at }),
    client.readContract({ address: pool, abi: poolReadAbi, functionName: 'liquidity', ...at }),
    twapWindowSeconds
      ? client.readContract({ address: pool, abi: poolReadAbi, functionName: 'observe', args: [[twapWindowSeconds, 0]], ...at })
      : Promise.reject(new Error('no twap window')),
    client.readContract({ address: token0, abi: balanceOfAbi, functionName: 'balanceOf', args: [pool], ...at }),
    client.readContract({ address: token1, abi: balanceOfAbi, functionName: 'balanceOf', args: [pool], ...at }),
  ])
  const s0 = settled(slot0)
  const obs = settled(observe)
  const cumulatives = obs?.[0]
  const state: PoolState = {
    sqrtPriceX96: s0 ? s0[0] : null,
    tick: s0 ? s0[1] : null,
    liquidity: settled(liquidity),
    twapTick: null,
    balance0: settled(balance0),
    balance1: settled(balance1),
  }
  if (twapWindowSeconds && cumulatives && cumulatives.length === 2) {
    state.twapTick = twapTick(cumulatives[0]!, cumulatives[1]!, twapWindowSeconds)
  } else {
    state.twapCode = 'EHG_TWAP_UNAVAILABLE'
  }
  return state
}
