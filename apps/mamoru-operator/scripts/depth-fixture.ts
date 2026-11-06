// Read-only (otto/mamoru#376): the pool state depth sizing reads (slot0, active liquidity, the 30 min TWAP tick and
// harmonic-mean liquidity), for the Base pools the live policies use, at one block, printed as the JSON fixture of
// packages/backtest/src/fixtures/. Public RPC by default: bun apps/mamoru-operator/scripts/depth-fixture.ts > fixture.json
import { createPublicClient, http, parseAbi } from 'viem'
import { base } from 'viem/chains'
import { baseRegistry, entry } from '@mamoru/registry'

const rpc = process.env.CAPACITY_RPC ?? 'https://mainnet.base.org'
const c = createPublicClient({ chain: base, transport: http(rpc) })
const WINDOW = 1800
const POOLS = ['pool:USDC/USDT/100', 'pool:USDC/cbBTC/500', 'pool:WETH/USDC/3000'] as const
const abi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
  'function liquidity() view returns (uint128)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
])

const block = await c.getBlock({ blockTag: 'latest' })
const pools: Record<string, { sqrtPriceX96: string; tick: number; liquidity: string; twapTick: number; twapLiquidity: string }> = {}
for (const name of POOLS) {
  const at = { address: entry(name, baseRegistry).address, abi, blockNumber: block.number } as const
  const [s0, L, obs] = await Promise.all([
    c.readContract({ ...at, functionName: 'slot0' }),
    c.readContract({ ...at, functionName: 'liquidity' }),
    c.readContract({ ...at, functionName: 'observe', args: [[WINDOW, 0]] }),
  ])
  // The same reductions as packages/rpc (twapTick rounds toward minus infinity; twapLiquidity is window·2^128/Δ).
  const dt = obs[0][1]! - obs[0][0]!
  let t = dt / BigInt(WINDOW)
  if (dt < 0n && dt % BigInt(WINDOW) !== 0n) t -= 1n
  const dl = obs[1][1]! - obs[1][0]!
  pools[name] = { sqrtPriceX96: s0[0].toString(), tick: s0[1], liquidity: L.toString(), twapTick: Number(t), twapLiquidity: ((BigInt(WINDOW) << 128n) / dl).toString() }
}
console.log(JSON.stringify({ chainId: 8453, block: Number(block.number), timestamp: Number(block.timestamp), twapWindowSeconds: WINDOW, pools }, null, 2))
