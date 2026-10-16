// Read-only: capacity of candidate Base pools for depth-sized entries (otto/mamoru#127). Public RPC by default.
import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { base } from 'viem/chains'

const rpc = process.env.CAPACITY_RPC ?? 'https://mainnet.base.org'
const c = createPublicClient({ chain: base, transport: http(rpc, { batch: true }) })
const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD' as Address
const QUOTER = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a' as Address
const T: Record<string, { a: Address; d: number }> = {
  USDC: { a: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', d: 6 },
  USDT: { a: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', d: 6 },
  cbBTC: { a: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', d: 8 },
  WETH: { a: '0x4200000000000000000000000000000000000006', d: 18 },
}
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const poolAbi = parseAbi(['function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)', 'function liquidity() view returns (uint128)', 'function token0() view returns (address)'])
const ercAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])
const quoterAbi = parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160,uint32,uint256)'])

// Candidate pools per bucket and the policy range width used to size a position (ticks, full width).
const C: { bucket: string; volatile: string; fee: number; width: number; live?: boolean }[] = [
  { bucket: 'stables', volatile: 'USDT', fee: 100, width: 40, live: true },
  { bucket: 'stables', volatile: 'USDT', fee: 500, width: 40 },
  { bucket: 'btc-usdc', volatile: 'cbBTC', fee: 500, width: 2000, live: true },
  { bucket: 'btc-usdc', volatile: 'cbBTC', fee: 3000, width: 2000 },
  { bucket: 'btc-usdc', volatile: 'cbBTC', fee: 100, width: 2000 },
  { bucket: 'risk', volatile: 'WETH', fee: 3000, width: 2000, live: true },
  { bucket: 'risk', volatile: 'WETH', fee: 500, width: 2000 },
  { bucket: 'risk', volatile: 'WETH', fee: 100, width: 2000 },
]
const IMPACT_BPS = [10, 30, 50]
const SHARE_PCT = [1, 5, 10]
const Q96 = 2 ** 96

async function impactBps(tokenIn: Address, tokenOut: Address, fee: number, amountIn: bigint, spotOutPerIn: number, dIn: number, dOut: number): Promise<number> {
  try {
    const { result } = await c.simulateContract({ address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle', args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }] })
    const out = Number(result[0]) / 10 ** dOut
    const ideal = (Number(amountIn) / 10 ** dIn) * spotOutPerIn * (1 - fee / 1e6)
    return (1 - out / ideal) * 1e4
  } catch {
    return Infinity
  }
}

const rows: unknown[] = []
for (const p of C) {
  const usdc = T.USDC!, vol = T[p.volatile]!
  const pool = await c.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'getPool', args: [usdc.a, vol.a, p.fee] })
  if (pool === '0x0000000000000000000000000000000000000000') { rows.push({ ...p, pool: null }); continue }
  const [s0, L, t0, bU, bV] = await Promise.all([
    c.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
    c.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }),
    c.readContract({ address: pool, abi: poolAbi, functionName: 'token0' }),
    c.readContract({ address: usdc.a, abi: ercAbi, functionName: 'balanceOf', args: [pool] }),
    c.readContract({ address: vol.a, abi: ercAbi, functionName: 'balanceOf', args: [pool] }),
  ])
  const usdcIs0 = t0.toLowerCase() === usdc.a.toLowerCase()
  const d0 = usdcIs0 ? usdc.d : vol.d, d1 = usdcIs0 ? vol.d : usdc.d
  const sp = Number(s0[0]) / Q96 // sqrt(raw token1/token0)
  const raw = sp * sp
  const p1per0 = raw * 10 ** (d0 - d1) // human token1 per token0
  const volUsd = usdcIs0 ? 1 / p1per0 : p1per0 // USDC per volatile
  const tvl = Number(bU) / 10 ** usdc.d + (Number(bV) / 10 ** vol.d) * volUsd
  // Liquidity per 1 USDC of position value, centred range of the policy width.
  const half = p.width / 2
  const sa = sp * Math.pow(1.0001, -half / 2), sb = sp * Math.pow(1.0001, half / 2)
  const amt0PerL = (sb - sp) / (sp * sb), amt1PerL = sp - sa // raw units per unit L
  const valuePerL = usdcIs0 ? amt0PerL / 10 ** usdc.d + (amt1PerL / 10 ** vol.d) * volUsd : (amt0PerL / 10 ** vol.d) * volUsd + amt1PerL / 10 ** usdc.d
  const share = Object.fromEntries(SHARE_PCT.map((y) => [`share${y}`, Math.round(((y / 100) * Number(L)) * valuePerL)]))
  // Entry swap USDC -> volatile; a centred entry swaps about half the bucket's money.
  const spotVolPerUsdc = 1 / volUsd
  const swapCap: Record<string, number> = {}
  for (const x of IMPACT_BPS) {
    let lo = 1, hi = 50_000_000
    if ((await impactBps(usdc.a, vol.a, p.fee, BigInt(hi) * 10n ** BigInt(usdc.d), spotVolPerUsdc, usdc.d, vol.d)) <= x) { swapCap[`swap${x}`] = hi; continue }
    for (let i = 0; i < 22; i++) {
      const mid = Math.sqrt(lo * hi)
      const imp = await impactBps(usdc.a, vol.a, p.fee, BigInt(Math.floor(mid * 10 ** usdc.d)), spotVolPerUsdc, usdc.d, vol.d)
      if (imp <= x) lo = mid; else hi = mid
    }
    swapCap[`swap${x}`] = Math.round(lo)
  }
  rows.push({ bucket: p.bucket, pool: `USDC/${p.volatile}/${p.fee}`, live: !!p.live, address: pool, tvl: Math.round(tvl), activeL: L.toString(), volUsd, ...swapCap, ...share })
}
console.log(JSON.stringify(rows, null, 1))
