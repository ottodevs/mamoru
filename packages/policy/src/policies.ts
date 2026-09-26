import { manageAnyGrants, pairGrants } from './grants.ts'
import type { CapFormula, PolicyVersion } from './types.ts'

const usdcCbbtcCaps: CapFormula[] = [
  { name: 'usdcSwapPerCall', asset: 'USDC', bpsOfDeposit: 2500 },
  { name: 'usdcSwapTotal', asset: 'USDC', bpsOfDeposit: 5000 },
  { name: 'usdcMint', asset: 'USDC', bpsOfDeposit: 5000 },
  { name: 'cbbtcMint', asset: 'cbBTC', bpsOfDeposit: 5500 },
  { name: 'cbbtcConvertPerCall', asset: 'cbBTC', bpsOfDeposit: 5500 },
  { name: 'cbbtcConvertTotal', asset: 'cbBTC', bpsOfDeposit: 5500 },
]

const usdcCbbtcPair = {
  stable: 'USDC',
  volatile: 'cbBTC',
  token0: 'USDC',
  token1: 'cbBTC',
  fee: 500,
  caps: {
    stableSwapPerCall: 'usdcSwapPerCall',
    stableSwapTotal: 'usdcSwapTotal',
    mint0: 'usdcMint',
    mint1: 'cbbtcMint',
    volatileConvertPerCall: 'cbbtcConvertPerCall',
    volatileConvertTotal: 'cbbtcConvertTotal',
  },
}

/**
 * Engineering parameters (harvest, range, execution, session caps and windows)
 * are versioned with the policy. They are not Packaging numbers and no
 * scenario asserts their value.
 */
export const conservadorV1: PolicyVersion = {
  policyId: 'conservador-v1',
  version: '1.0.0',
  preset: 'conservador',
  chain: 'base',
  buckets: [
    { id: 'stables', preference: 5000, pools: [] },
    { id: 'btc-usdc', preference: 4000, pools: ['pool:USDC/cbBTC/500'] },
    { id: 'risk', preference: 1000, pools: [] },
  ],
  savingsAsset: 'USDC',
  gasReserveWei: 2_000_000_000_000_000n,
  harvest: { costFactorBps: 30000 },
  range: { widthTicks: 2000, adjust: 'on_out_of_range', cooldownSeconds: 86_400 },
  execution: { slippageBps: 50, maxTwapDeviationTicks: 100, twapWindowSeconds: 1800, observationTtlSeconds: 120 },
  session: {
    validitySeconds: 30 * 86_400,
    renewalWindowSeconds: 5 * 86_400,
    caps: usdcCbbtcCaps,
    grants: pairGrants(usdcCbbtcPair, { enterSwap: 8, enterMint: 8, manage: 64 }),
  },
  shadow: ['packaging:eny', 'packaging:eel', 'packaging:price-impact', 'packaging:tvl', 'packaging:depeg'],
}

/** Conservador v1 for the fork: same grants, signed only for the fork chain id. */
export const conservadorLabV1: PolicyVersion = {
  ...conservadorV1,
  policyId: 'conservador-lab-v1',
  chain: 'fork',
}

/**
 * Conservador v1 for the live real-funds demo on Base (sprint amendment
 * 2026-09-26): same grants and caps, a small ETH reserve so a 5-25 USDC
 * account does not need a large gas top-up.
 */
export const conservadorLiveV1: PolicyVersion = {
  ...conservadorV1,
  policyId: 'conservador-live-v1',
  gasReserveWei: 300_000_000_000_000n,
  // 15 minutes between re-ranges so the demo can show one; out of range or within 10% of an edge.
  range: { ...conservadorV1.range, cooldownSeconds: 900 },
  session: {
    ...conservadorV1.session,
    grants: [...conservadorV1.session.grants, ...manageAnyGrants(usdcCbbtcPair, { manage: 256, convert: 64 })],
  },
}

/** A policy that enables the live manage grants (manage-any, convert-any) at activation. */
export function hasManageAny(policy: PolicyVersion): boolean {
  return policy.session.grants.some((g) => g.name === 'manage-any')
}

/**
 * Test-only: the fork E2E shortens the re-range cooldown. Honoured only with
 * MAMORU_TEST_OVERRIDES=1; the live operator never sets it.
 */
export function withTestOverrides(policy: PolicyVersion, env: Record<string, string | undefined>): PolicyVersion {
  if (env.MAMORU_TEST_OVERRIDES !== '1' || env.MAMORU_TEST_RERANGE_COOLDOWN_S === undefined) return policy
  return { ...policy, range: { ...policy.range, cooldownSeconds: Number(env.MAMORU_TEST_RERANGE_COOLDOWN_S) } }
}

/** One pair of a multi-pool policy: caps named `<prefix>…`, sized in bps of the account cap. */
function pairOf(prefix: string, pool: string, stable: string, volatile: string, token0: string, token1: string, fee: number, bps: { swapPerCall: number; swapTotal: number; mint: number }) {
  const n = (s: string) => `${prefix}${s}`
  const caps: CapFormula[] = [
    { name: n('SwapPerCall'), asset: stable, bpsOfDeposit: bps.swapPerCall },
    { name: n('SwapTotal'), asset: stable, bpsOfDeposit: bps.swapTotal },
    { name: n('Mint0'), asset: token0, bpsOfDeposit: bps.mint },
    { name: n('Mint1'), asset: token1, bpsOfDeposit: bps.mint },
    { name: n('ConvertPerCall'), asset: volatile, bpsOfDeposit: bps.mint },
    { name: n('ConvertTotal'), asset: volatile, bpsOfDeposit: bps.mint },
  ]
  const grants = pairGrants(
    {
      stable,
      volatile,
      token0,
      token1,
      fee,
      pool,
      caps: {
        stableSwapPerCall: n('SwapPerCall'),
        stableSwapTotal: n('SwapTotal'),
        mint0: n('Mint0'),
        mint1: n('Mint1'),
        volatileConvertPerCall: n('ConvertPerCall'),
        volatileConvertTotal: n('ConvertTotal'),
      },
    },
    { enterSwap: 16, enterMint: 16, manage: 64 },
  )
  return { caps, grants }
}

const stablesPair = pairOf('stables', 'pool:USDC/USDT/100', 'USDC', 'USDT', 'USDC', 'USDT', 100, { swapPerCall: 5000, swapTotal: 10000, mint: 10000 })
const btcPair = pairOf('btc', 'pool:USDC/cbBTC/500', 'USDC', 'cbBTC', 'USDC', 'cbBTC', 500, { swapPerCall: 4000, swapTotal: 8000, mint: 8000 })
const riskPair = pairOf('risk', 'pool:WETH/USDC/3000', 'USDC', 'WETH', 'WETH', 'USDC', 3000, { swapPerCall: 2000, swapTotal: 4000, mint: 4000 })

/**
 * Conservador v2 for the live demo (sprint 2026-09-26): the three buckets on three Uniswap v3 pools of Base,
 * target weights of the whole account value, re-balanced from idle capital at every review.
 * - stables 50%: USDC/USDT 0.01%, the deepest stable/stable v3 pool with USDC on Base (range +-0.2%);
 * - btc-usdc 40%: USDC/cbBTC 0.05%;
 * - risk 10%: WETH/USDC 0.3% (deeper than 0.05% in active liquidity).
 * One enter-swap and one enter-mint grant per pair, all enabled by the one owner activation. Caps are bps of the
 * account cap (LIVE_CAP_USDC) with room for one entry per pool plus top-ups; usage limits leave 16 ops per grant.
 */
export const conservadorLiveV2: PolicyVersion = {
  ...conservadorLiveV1,
  policyId: 'conservador-live-v2',
  version: '2.0.0',
  buckets: [
    { id: 'stables', preference: 5000, pools: ['pool:USDC/USDT/100'] },
    { id: 'btc-usdc', preference: 4000, pools: ['pool:USDC/cbBTC/500'] },
    { id: 'risk', preference: 1000, pools: ['pool:WETH/USDC/3000'] },
  ],
  range: { ...conservadorV1.range, widthTicksByPool: { 'pool:USDC/USDT/100': 40 } },
  allocation: 'target-weights',
  minEntry: 100_000n,
  rebalanceBandBps: 300,
  session: {
    ...conservadorV1.session,
    caps: [...stablesPair.caps, ...btcPair.caps, ...riskPair.caps],
    grants: [...stablesPair.grants, ...btcPair.grants, ...riskPair.grants],
  },
}

/** Scenario policy for M07: LP on WETH/USDC 0.3%, only in the lab. */
export const labWethUsdcV1: PolicyVersion = {
  ...conservadorV1,
  policyId: 'lab-weth-usdc-v1',
  chain: 'fork',
  buckets: [
    { id: 'stables', preference: 5000, pools: [] },
    { id: 'btc-usdc', preference: 4000, pools: [] },
    { id: 'risk', preference: 1000, pools: ['pool:WETH/USDC/3000'] },
  ],
  range: { widthTicks: 3000, adjust: 'on_out_of_range', cooldownSeconds: 86_400 },
  session: {
    ...conservadorV1.session,
    caps: [
      { name: 'usdcSwapPerCall', asset: 'USDC', bpsOfDeposit: 2500 },
      { name: 'usdcSwapTotal', asset: 'USDC', bpsOfDeposit: 5000 },
      { name: 'wethMint', asset: 'WETH', bpsOfDeposit: 5500 },
      { name: 'usdcMint', asset: 'USDC', bpsOfDeposit: 5000 },
      { name: 'wethConvertPerCall', asset: 'WETH', bpsOfDeposit: 5500 },
      { name: 'wethConvertTotal', asset: 'WETH', bpsOfDeposit: 5500 },
    ],
    grants: pairGrants(
      {
        stable: 'USDC',
        volatile: 'WETH',
        token0: 'WETH',
        token1: 'USDC',
        fee: 3000,
        caps: {
          stableSwapPerCall: 'usdcSwapPerCall',
          stableSwapTotal: 'usdcSwapTotal',
          mint0: 'wethMint',
          mint1: 'usdcMint',
          volatileConvertPerCall: 'wethConvertPerCall',
          volatileConvertTotal: 'wethConvertTotal',
        },
      },
      { enterSwap: 8, enterMint: 8, manage: 64 },
    ),
  },
}

export const POLICIES: Record<string, PolicyVersion> = {
  [conservadorV1.policyId]: conservadorV1,
  [conservadorLabV1.policyId]: conservadorLabV1,
  [conservadorLiveV1.policyId]: conservadorLiveV1,
  [conservadorLiveV2.policyId]: conservadorLiveV2,
  [labWethUsdcV1.policyId]: labWethUsdcV1,
}
