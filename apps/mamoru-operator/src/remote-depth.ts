/**
 * otto/mamoru#401: a remote Safe's sessions are enabled inside its setup (MamoruActionPolicyV3, setup mode), so the
 * policy's depth check (LeftClaw M-5) runs at the first swap, mint or increase instead (`_liveChecks`): while the pool's
 * depth over the band is under the session's `perWindow`, every such call fails validation (the bundler answers AA23).
 * A Monad Safe sized at half the Base cap carried a 15k USDC daily budget into a WMON/USDC pool ~7.4k deep: its engine
 * proposed the same swap every review for days. This reads what the contract reads, so the engine holds instead, and
 * sizes a new remote Safe's cap so its budget fits the pool.
 */
import { parseAbi, type Address } from 'viem'
import { policyDepthIn } from '@mamoru/uniswap-v3/policy-depth'
import type { RegistryName } from '@mamoru/registry'

const POOL_ABI = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function ticks(int24 tick) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
])

const POLICY_ABI = parseAbi([
  'struct Config { uint32 twapWindow; uint32 twapShortWindow; uint24 bandTicks; uint64 generation; bool budgetIn1; uint32 budgetWindow; int24 anchorTick; uint24 anchorBand; uint128 perWindow; uint128 total; bytes32 initHash; }',
  'function configOf(address account, address pool) view returns (Config)',
  'struct Spend { uint64 generation; uint64 updatedAt; bool in1; uint128 debt; uint128 total; }',
  'function spendOf(address account, address pool) view returns (Spend)',
])

/** The reads this module makes (a viem PublicClient, or a test double). */
export type DepthClient = { readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }): Promise<unknown> }

export type DepthPool = { name: RegistryName; address: Address; token0: Address; token1: Address }

/**
 * `_depthIn(pool, p, band, in1)` read for read at `blockNumber`: the smaller, in the budget token (token1 when `in1`), of
 * what selling into the pool takes to move its price `band` ticks either way.
 */
export async function readPoolDepth(client: DepthClient, pool: DepthPool, band: number, in1: boolean, blockNumber?: bigint, maxSteps?: number): Promise<bigint> {
  const at = blockNumber === undefined ? {} : { blockNumber }
  const read = (functionName: string, args?: readonly unknown[]) => client.readContract({ address: pool.address, abi: POOL_ABI, functionName, ...(args ? { args } : {}), ...at })
  const [slot0, liquidity, tickSpacing] = (await Promise.all([read('slot0'), read('liquidity'), read('tickSpacing')])) as [readonly [bigint, number], bigint, number]
  return policyDepthIn(
    {
      sqrtPriceX96: slot0[0],
      tick: Number(slot0[1]),
      liquidity,
      tickSpacing: Number(tickSpacing),
      liquidityNet: async (t) => ((await read('ticks', [t])) as readonly [bigint, bigint])[1],
    },
    pool.token0,
    pool.token1,
    band,
    in1,
    maxSteps,
  )
}

/**
 * The pools of `account` whose deferred depth check is still owed and would refuse now. A config never charged
 * (`spendOf(...).updatedAt` 0) has not passed `_liveChecks` yet: a swap, mint or increase that passes them is charged in
 * the same validation. A pool without a config (`twapWindow` 0) is left out. Any failed read throws.
 */
export async function depthShortOf(client: DepthClient, policy: Address, account: Address, pools: readonly DepthPool[], blockNumber?: bigint): Promise<{ pool: RegistryName; depth: bigint; perWindow: bigint }[]> {
  const at = blockNumber === undefined ? {} : { blockNumber }
  const out: { pool: RegistryName; depth: bigint; perWindow: bigint }[] = []
  for (const p of pools) {
    const [c, s] = (await Promise.all([
      client.readContract({ address: policy, abi: POLICY_ABI, functionName: 'configOf', args: [account, p.address], ...at }),
      client.readContract({ address: policy, abi: POLICY_ABI, functionName: 'spendOf', args: [account, p.address], ...at }),
    ])) as [{ twapWindow: number; bandTicks: number; budgetIn1: boolean; perWindow: bigint }, { updatedAt: bigint }]
    if (Number(c.twapWindow) === 0 || BigInt(s.updatedAt) !== 0n) continue
    const depth = await readPoolDepth(client, p, Number(c.bandTicks), c.budgetIn1, blockNumber)
    if (depth < BigInt(c.perWindow)) out.push({ pool: p.name, depth, perWindow: BigInt(c.perWindow) })
  }
  return out
}

/** Share of the pool's depth a new remote Safe's daily budget may take: the check runs at its first swap, days later maybe. */
export const REMOTE_DEPTH_FIT_BPS = 5_000n

/**
 * The largest cap at most `cap` whose daily budget (`windowAt(c)`, linear in the cap: the signed formulas) fits
 * `fitBps` of `depth`. `cap` itself when it already fits.
 */
export function fitRemoteCap(cap: bigint, depth: bigint, windowAt: (cap: bigint) => bigint, fitBps: bigint = REMOTE_DEPTH_FIT_BPS): bigint {
  const limit = (depth * fitBps) / 10_000n
  if (windowAt(cap) <= limit) return cap
  const unit = 1_000_000_000_000n
  const perUnit = windowAt(unit)
  if (perUnit <= 0n) return cap
  let c = (limit * unit) / perUnit
  if (c > cap) c = cap
  // Rounding in the formulas: step down until the window fits.
  while (c > 0n && windowAt(c) > limit) c -= 1n
  return c
}

/** MamoruActionPolicyV4 (MamoruV4Helper): a priced op's value times this must fit the pool's band depth (I2). */
export const V4_DEPTH_MULTIPLE = 20n
/** MamoruV4Helper.MAX_DEPTH_STEPS: V4's depth walk stops after this many tick boundaries per direction. */
export const V4_MAX_DEPTH_STEPS = 64
/** Share of V4's per-op bound the engine sizes to: the depth is read before inclusion and the value at the band edge. */
export const OP_ROOM_BPS = 8_000n

/**
 * otto/mamoru#410: the most one swap, mint or increase in `pool` may be worth under MamoruActionPolicyV4 (I2,
 * `_requireDepth`: depth over `band` >= DEPTH_MULTIPLE x value), in the budget unit, with OP_ROOM_BPS of margin.
 */
export async function v4OpRoom(client: DepthClient, pool: DepthPool, band: number, in1: boolean, blockNumber?: bigint): Promise<bigint> {
  const depth = await readPoolDepth(client, pool, band, in1, blockNumber, V4_MAX_DEPTH_STEPS)
  return (depth * OP_ROOM_BPS) / (10_000n * V4_DEPTH_MULTIPLE)
}
