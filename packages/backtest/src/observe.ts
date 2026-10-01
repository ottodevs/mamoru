import type { Hex } from '@mamoru/domain'
import type { Observation, PoolObs, SessionObs } from '@mamoru/decide'
import { grantKey, type PolicyVersion } from '@mamoru/policy'
import { address, entry, type RegistryName } from '@mamoru/registry'
import type { Dataset, Sample } from './types.ts'
import type { World } from './world.ts'

/** Gas budget of one engine userOp (verification + call + pre-verification), the figure `decide` prices a harvest with. */
export const OP_GAS_UNITS = 5_100_000n
export const ETH_PRICE_POOL = 'pool:WETH/USDC/3000'
const ACCOUNT = '0x00000000000000000000000000000000000051a7' as const
const ID = (`0x${'00'.repeat(32)}`) as Hex
/** Sessions never lapse in a run; how many uses each grant took is reported against its limit instead. */
const FOREVER = 2 ** 40

/** Mean tick over the policy window from the oracle cumulatives of the samples, rounded toward negative infinity. */
export function twapTick(ds: Dataset, poolIndex: number, i: number, windowSeconds: number): number {
  const now = ds.samples[i]!
  const cur = now.pools[poolIndex]!
  if (cur.tickCumulative === null) return cur.tick
  // The oldest sample still inside the window, or the first one before it.
  let j = i
  while (j > 0 && now.time - ds.samples[j]!.time < windowSeconds) j--
  const old = ds.samples[j]!
  const before = old.pools[poolIndex]
  const secs = BigInt(now.time - old.time)
  if (!before || before.tickCumulative === null || secs <= 0n) return cur.tick
  const delta = cur.tickCumulative - before.tickCumulative
  let tick = delta / secs
  if (delta < 0n && delta % secs !== 0n) tick -= 1n
  return Number(tick)
}

function sessions(policy: PolicyVersion, w: World): SessionObs[] {
  const keys = policy.session.grants.filter((g) => !g.perPosition).map((g) => grantKey(g))
  for (const p of w.positions) keys.push(`manage:${p.tokenId}`)
  return [...new Set(keys)].map((grant) => ({ grant, permissionId: ID, validUntil: FOREVER, active: true }))
}

/** The observation the live engine would have read at this sample, for the simulated account. */
export function observe(ds: Dataset, i: number, w: World, policy: PolicyVersion, priorityFeeWei: bigint): Observation {
  const s: Sample = ds.samples[i]!
  const pools: PoolObs[] = []
  ds.pools.forEach((name, k) => {
    const ps = s.pools[k]
    if (!ps) return
    const e = entry(name)
    pools.push({
      name,
      address: e.address,
      token0: e.token0!,
      token1: e.token1!,
      fee: e.fee!,
      tickSpacing: e.tickSpacing!,
      sqrtPriceX96: ps.sqrtPriceX96,
      tick: ps.tick,
      liquidity: ps.liquidity,
      twapTick: twapTick(ds, k, i, policy.execution.twapWindowSeconds),
      identity: { factoryPool: e.address, token0: address(e.token0!), token1: address(e.token1!), fee: e.fee!, tickSpacing: e.tickSpacing! },
    })
  })
  const eth = s.pools[ds.pools.indexOf(ETH_PRICE_POOL)]
  if (!eth) throw new Error(`sample ${i} (block ${s.block}) has no ${ETH_PRICE_POOL}: gas cannot be priced`)
  const balances: Record<RegistryName, bigint> = { ...w.balances }
  return {
    chainId: ds.chainId,
    block: { number: BigInt(s.block), hash: s.hash, timestamp: BigInt(s.time) },
    safeBlock: { number: BigInt(s.block), hash: s.hash },
    account: { address: ACCOUNT, deployed: true, nonceKey: 0n, nonce: 0n },
    sessions: sessions(policy, w),
    // The run assumes the gas reserve is kept topped up; what the operations cost is charged to the result.
    native: policy.gasReserveWei,
    balances,
    positions: w.positions.map((p) => ({
      tokenId: p.tokenId, pool: p.pool, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity,
      collectable0: p.owed0, collectable1: p.owed1, principalOwed0: 0n, principalOwed1: 0n, managed: true,
    })),
    pools,
    ethPrice: { pool: ETH_PRICE_POOL, sqrtPriceX96: eth.sqrtPriceX96, token0: entry(ETH_PRICE_POOL).token0! },
    gas: { maxFeePerGas: s.baseFeeWei * 2n + priorityFeeWei, opGasUnits: OP_GAS_UNITS },
    deposits: [],
    intents: { paused: false, exitRequested: false },
    slot: null,
    lastRerangeAt: w.lastRerangeAt,
  }
}
