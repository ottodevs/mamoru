// Checks the fee model against the chain: for real positions, what the simulator says they earned over the dataset
// window against what a static `collect` returns at the end of it.
//   bun packages/backtest/cli/calibrate.ts --dataset .local/base-30d.json --owner 0x... [--owner 0x...]
// Reads only. Each position is measured from its last touch (collect or liquidity change) to the end of the dataset,
// so the difference of two static collects is fees and nothing else.
import { readFileSync } from 'node:fs'
import { createPublicClient, encodeFunctionData, decodeFunctionResult, http, maxUint128, parseAbi, type Address, type PublicClient } from 'viem'
import { base } from 'viem/chains'
import { address, entry, nameOf } from '@mamoru/registry'
import { decodeDataset, type DatasetJson } from '../src/dataset.ts'
import { accrue, valueIn, type SimPosition } from '../src/world.ts'

const npmAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }',
  'function collect(CollectParams params) returns (uint256 amount0, uint256 amount1)',
])
const factoryAbi = parseAbi(['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'])

function args(name: string): string[] {
  return process.argv.flatMap((a, i) => (a === `--${name}` && process.argv[i + 1] ? [process.argv[i + 1]!] : []))
}

/** First line of an error with every URL removed: an endpoint URL can carry a key. */
function redact(err: unknown): string {
  return String((err as Error)?.message ?? err).split('\n')[0]!.replace(/https?:\/\/\S+/g, '<url>')
}
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err) => {
    console.error(redact(err))
    process.exit(1)
  })
}

const ds = decodeDataset(JSON.parse(readFileSync(args('dataset')[0]!, 'utf8')) as DatasetJson)
const client = createPublicClient({ chain: base, transport: http(process.env.BACKFILL_RPC_URL ?? 'https://mainnet.base.org', { retryCount: 4, retryDelay: 800, timeout: 30_000 }) }) as PublicClient
const npm = address('NonfungiblePositionManager')

async function collectable(owner: Address, tokenId: bigint, block: bigint): Promise<[bigint, bigint] | null> {
  const data = encodeFunctionData({ abi: npmAbi, functionName: 'collect', args: [{ tokenId, recipient: owner, amount0Max: maxUint128, amount1Max: maxUint128 }] })
  try {
    const r = await client.call({ account: owner, to: npm, data, blockNumber: block })
    if (!r.data) return null
    const [a0, a1] = decodeFunctionResult({ abi: npmAbi, functionName: 'collect', data: r.data })
    return [a0, a1]
  } catch {
    return null
  }
}

const last = ds.samples.at(-1)!
let checked = 0
for (const owner of args('owner') as Address[]) {
  const n = await client.readContract({ address: npm, abi: npmAbi, functionName: 'balanceOf', args: [owner], blockNumber: BigInt(last.block) })
  for (let i = 0n; i < n; i++) {
    const tokenId = await client.readContract({ address: npm, abi: npmAbi, functionName: 'tokenOfOwnerByIndex', args: [owner, i], blockNumber: BigInt(last.block) })
    const pos = await client.readContract({ address: npm, abi: npmAbi, functionName: 'positions', args: [tokenId], blockNumber: BigInt(last.block) })
    const poolAddr = await client.readContract({ address: address('UniswapV3Factory'), abi: factoryAbi, functionName: 'getPool', args: [pos[2], pos[3], pos[4]] })
    const name = nameOf(poolAddr)
    const k = name ? ds.pools.indexOf(name) : -1
    if (!name || k < 0 || pos[7] === 0n) continue
    // Every touch of a position (a collect, an increase, a decrease) changes at least one of five stored values:
    // its liquidity, the two `feeGrowthInside*Last` checkpoints, or the two `tokensOwed` balances. From the last touch
    // on all five stay what they are at the end. The first sample where they already match is found by binary
    // search, about 14 archive reads for a 30-day dataset; a touch that left all five exactly as before would be
    // missed, and would also have moved no tokens.
    const untouchedSince = async (j: number) => {
      const p = await client.readContract({ address: npm, abi: npmAbi, functionName: 'positions', args: [tokenId], blockNumber: BigInt(ds.samples[j]!.block) }).catch(() => null)
      return !!p && p[7] === pos[7] && p[8] === pos[8] && p[9] === pos[9] && p[10] === pos[10] && p[11] === pos[11]
    }
    let lo = 0
    let hi = ds.samples.length - 1
    if (!(await untouchedSince(hi))) continue
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (await untouchedSince(mid)) hi = mid
      else lo = mid + 1
    }
    const start = lo
    if (start >= ds.samples.length - 1) continue
    const before = await collectable(owner, tokenId, BigInt(ds.samples[start]!.block))
    const after = await collectable(owner, tokenId, BigInt(last.block))
    if (!before || !after) continue
    const sim: SimPosition = { tokenId, pool: name, tickLower: pos[5], tickUpper: pos[6], liquidity: pos[7], owed0: 0n, owed1: 0n }
    let f0 = 0n
    let f1 = 0n
    let prev = ds.samples[start]!.pools[k]
    for (let j = start + 1; j < ds.samples.length; j++) {
      const cur = ds.samples[j]!.pools[k]
      if (!prev || !cur) continue
      const f = accrue(sim, prev, cur)
      f0 += f.fees0
      f1 += f.fees1
      prev = cur
    }
    const e = entry(name)
    const savings = e.token0 === 'USDC' ? 'USDC' : e.token1!
    const end = ds.samples.at(-1)!.pools[k]!
    const chain = valueIn(e, end, e.token0!, after[0] - before[0], savings) + valueIn(e, end, e.token1!, after[1] - before[1], savings)
    const model = valueIn(e, end, e.token0!, f0, savings) + valueIn(e, end, e.token1!, f1, savings)
    const days = (last.time - ds.samples[start]!.time) / 86_400
    const err = chain === 0n ? 'n/a' : `${((Number(model - chain) / Number(chain)) * 100).toFixed(1)}%`
    console.log(`${name} #${tokenId} [${pos[5]}, ${pos[6]}) L=${pos[7]} over ${days.toFixed(2)} days: chain ${chain} model ${model} raw ${savings}  error ${err}  (token0 ${after[0] - before[0]} vs ${f0}, token1 ${after[1] - before[1]} vs ${f1})`)
    checked++
  }
}
console.log(`${checked} positions checked`)
