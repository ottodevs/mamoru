// Lab #186: public data for the USDC ERC-4626 shortlist on Base, compacted to one small JSON file.
//   bun specs/004-loss-control/results/stables-4626-2026-10-23/fetch.ts [--out <file>]
// Sources (free, no key): DefiLlama yields (daily APY and TVL per pool), the Morpho API (daily share price and
// assets of the MetaMorpho vaults, daily utilization of the markets they supply), the Aave v3 API (USDC reserve on
// Base now). No RPC. Re-running on another day gives other numbers: the file records when it was fetched.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : join(import.meta.dir, '..', 'raw', 'stables-4626-data.json')
const START = 1_717_200_000 // 2024-06-01
const END = Math.floor(Date.now() / 1000)

/** The shortlist. `llama`: DefiLlama pool id; `morpho`: MetaMorpho vault (null for Aave). */
export const VAULTS = [
  { id: 'gtUSDCp', name: 'Gauntlet USDC Prime (MetaMorpho)', address: '0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61', llama: 'e0672197-9f3e-4414-bca5-e6b4c90aa469', morpho: true },
  { id: 'sparkUSDC', name: 'Spark USDC Vault (MetaMorpho v1.1)', address: '0x7BfA7C4f149E7415b73bdeDfe609237e29CBF34A', llama: 'a5fab52f-73fa-4f44-9c09-9af1eb20996c', morpho: true },
  { id: 'steakUSDC', name: 'Steakhouse USDC (MetaMorpho)', address: '0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183', llama: '81ae8812-f04f-4f6e-9d71-ee5778f3a178', morpho: true },
  { id: 'waBasUSDC', name: 'Aave v3 Base USDC, static aToken v2 (waBasUSDC)', address: '0xC768c589647798a6EE01A91FdE98EF2ed046DBD6', llama: '7e0661bf-8cf3-45e6-9424-31916d4c7b84', morpho: false },
] as const

/** Morpho Blue markets the MetaMorpho vaults above held more than 1M USDC in on the fetch day. */
const MARKETS = [
  { id: 'cbBTC/USDC 86%', key: '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836' },
  { id: 'WETH/USDC 86%', key: '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda' },
  { id: 'cbETH/USDC 77%', key: '0x0ca10126f6c94cbd9cf0a48cc9516ae5e3dec5aa68303e6d988ee37c5149bf0d' },
] as const

async function json(url: string, body?: unknown): Promise<any> {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  const j = (await r.json()) as any
  if (j.errors) throw new Error(`${url}: ${JSON.stringify(j.errors).slice(0, 300)}`)
  return j
}
const morpho = (query: string) => json('https://api.morpho.org/graphql', { query }).then((j) => j.data)
const opts = `options: {startTimestamp: ${START}, endTimestamp: ${END}, interval: DAY}`
const r4 = (x: number) => Math.round(x * 1e4) / 1e4

const vaults = []
for (const v of VAULTS) {
  const chart = await json(`https://yields.llama.fi/chart/${v.llama}`)
  // [unix, apyBase %, tvlUsd (M)]; DefiLlama's base APY of a MetaMorpho vault is net of its fee. For Aave its TVL is
  // the reserve's available liquidity (supply − borrow), not its supply.
  const apy = (chart.data as any[]).map((p) => [Math.floor(Date.parse(p.timestamp) / 1000), r4(p.apyBase ?? p.apy ?? 0), r4((p.tvlUsd ?? 0) / 1e6)])
  let morphoData: unknown = null
  if (v.morpho) {
    const d = await morpho(`{ vaultByAddress(address: "${v.address}", chainId: 8453) { creationTimestamp state { totalAssetsUsd netApy apy fee timelock curator owner guardian curators { name } } liquidity { usd } historicalState { sharePriceNumber(${opts}) { x y } totalAssetsUsd(${opts}) { x y } } } }`)
    const s = d.vaultByAddress
    morphoData = {
      created: Number(s.creationTimestamp),
      now: { totalAssetsUsdM: r4(s.state.totalAssetsUsd / 1e6), liquidityUsdM: r4(s.liquidity.usd / 1e6), apyPct: r4(s.state.apy * 100), netApyPct: r4(s.state.netApy * 100), fee: s.state.fee, timelockSeconds: Number(s.state.timelock), curator: s.state.curator, owner: s.state.owner, guardian: s.state.guardian, curators: s.state.curators.map((c: any) => c.name) },
      sharePrice: (s.historicalState.sharePriceNumber as any[]).filter((p) => p.y !== null).map((p) => [p.x, Math.round(p.y * 1e9) / 1e9]).sort((a, b) => a[0] - b[0]),
      totalAssetsUsdM: (s.historicalState.totalAssetsUsd as any[]).filter((p) => p.y !== null).map((p) => [p.x, r4(p.y / 1e6)]).sort((a, b) => a[0] - b[0]),
    }
  }
  vaults.push({ id: v.id, name: v.name, address: v.address, llamaPool: v.llama, apy, morpho: morphoData })
  console.error(`${v.id}: ${apy.length} APY points`)
}

const markets = []
for (const m of MARKETS) {
  const d = await morpho(`{ marketById(marketId: "${m.key}", chainId: 8453) { creationTimestamp badDebt { usd } realizedBadDebt { usd } state { utilization supplyAssetsUsd liquidityAssetsUsd } historicalState { utilization(${opts}) { x y } } } }`)
  const s = d.marketById
  markets.push({
    id: m.id,
    key: m.key,
    created: Number(s.creationTimestamp),
    badDebtUsd: s.badDebt?.usd ?? null,
    realizedBadDebtUsd: s.realizedBadDebt?.usd ?? null,
    now: { utilization: r4(s.state.utilization), supplyUsdM: r4(s.state.supplyAssetsUsd / 1e6), liquidityUsdM: r4(s.state.liquidityAssetsUsd / 1e6) },
    utilization: (s.historicalState.utilization as any[]).filter((p) => p.y !== null).map((p) => [p.x, r4(p.y)]).sort((a, b) => a[0] - b[0]),
  })
  console.error(`${m.id}: ${markets.at(-1)!.utilization.length} utilization points`)
}

const aave = await json('https://api.v3.aave.com/graphql', {
  query: '{ market(request:{address:"0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", chainId:8453}) { reserves { underlyingToken { symbol address } supplyInfo { apy { value } total { value } } borrowInfo { utilizationRate { value } availableLiquidity { usd } } } } }',
})
const usdc = (aave.data.market.reserves as any[]).find((r) => r.underlyingToken.symbol === 'USDC')
const aaveNow = { supplyUsdM: r4(Number(usdc.supplyInfo.total.value) / 1e6), utilization: r4(Number(usdc.borrowInfo.utilizationRate.value)), liquidityUsdM: r4(Number(usdc.borrowInfo.availableLiquidity.usd) / 1e6), apyPct: r4(Number(usdc.supplyInfo.apy.value) * 100) }

writeFileSync(OUT, `${JSON.stringify({ fetchedAt: new Date().toISOString(), sources: ['yields.llama.fi/chart/<pool>', 'api.morpho.org/graphql', 'api.v3.aave.com/graphql'], vaults, markets, aaveUsdcNow: aaveNow })}\n`)
console.error(`wrote ${OUT}`)
