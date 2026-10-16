import { manageAnyGrants, pairGrants } from './grants.ts'
import type { CapFormula, PolicyVersion, UsageTier } from './types.ts'

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
    // One approval lasts a year (owner decision, 2026-10-11); the app offers the renewal in the last 30 days.
    validitySeconds: 365 * 86_400,
    renewalWindowSeconds: 30 * 86_400,
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

const USDC = 1_000_000n

/**
 * otto/mamoru#149: usage limits of the live v2 grants, for one approval to last its 365 days. Measured in the Lab
 * (conservador-live-v2, with and without depth sizing, Sep 2026, Sep 2025, Apr 2026, Jun 2025, Dec 2024, Oct 2025):
 * the worst 30 days of any pool, crash weeks counted as if a whole month were a crash, times 12 and then 1.25.
 * Harvests (convert-any) grow with the account; re-ranges, reduces and entries do not.
 * Worst 30 days per pool at 1k / 10k / 100k / 1M USDC: convert-any 60 / 390 / 2,037 / 4,816; manage-any 99 / 124 / 159 /
 * 64; enter-swap 43 / 133 / 176 / 48; enter-mint 9 / 9 / 9 / 43.
 */
const CONVERT_ANY_BY_CAP: readonly UsageTier[] = [
  { upToUsdc: 1_000n * USDC, usageLimit: 1_000 },
  { upToUsdc: 10_000n * USDC, usageLimit: 6_000 },
  { upToUsdc: 100_000n * USDC, usageLimit: 32_000 },
  { upToUsdc: 1_000_000n * USDC, usageLimit: 75_000 },
]
const LIVE_USAGE = { enterSwap: 3_000, enterMint: 1_000, manageAny: 2_500 }

/**
 * #149: entry swaps add up to the cumulative cap of enter-swap, and target-weights re-balances with them: Sep 2026 used
 * about 60% of the 2.0.0 stables total in one month on top of the first entry (25%); calm months and crash weeks less.
 * The swap totals are this many times the 2.0.0 share: at the Sep 2026 rate the row offers a renewal (80%) about every
 * 3.5 months, about 3 taps a year more than the yearly renewal, and none in a calm year. Not 12x: a leaked session key
 * could swap that total at a manipulated price (amountOutMinimum only needs to be above zero). Mint totals stay one
 * entry: re-mints after a re-range run under manage-any, and in the Lab enter-mint only ever paid the first entry.
 */
const SWAP_TOTALS = 3

/** One pair of a multi-pool policy: caps named `<prefix>…`, sized in bps of the account cap. */
function pairOf(prefix: string, pool: string, stable: string, volatile: string, token0: string, token1: string, fee: number, bps: { swapPerCall: number; swapTotal: number; mint: number }) {
  const n = (s: string) => `${prefix}${s}`
  const caps: CapFormula[] = [
    { name: n('SwapPerCall'), asset: stable, bpsOfDeposit: bps.swapPerCall },
    { name: n('SwapTotal'), asset: stable, bpsOfDeposit: bps.swapTotal * SWAP_TOTALS },
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
    { enterSwap: LIVE_USAGE.enterSwap, enterMint: LIVE_USAGE.enterMint, manage: 64 },
  )
  // Live manage grants (owner decision 2026-09-26): re-range, reduce and harvest any position of this pair.
  grants.push(
    ...manageAnyGrants(
      { stable, volatile, token0, token1, fee, pool, caps: { stableSwapPerCall: n('SwapPerCall'), stableSwapTotal: n('SwapTotal'), mint0: n('Mint0'), mint1: n('Mint1'), volatileConvertPerCall: n('ConvertPerCall'), volatileConvertTotal: n('ConvertTotal') } },
      { manage: LIVE_USAGE.manageAny, convert: CONVERT_ANY_BY_CAP },
    ),
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
 * account cap (LIVE_CAP_USDC) with room for one entry per pool plus top-ups.
 * 2.1.0 (#149): usage limits and the entry swap totals sized for the approval's 365 days at the account cap (see
 * CONVERT_ANY_BY_CAP and SWAP_TOTALS). Accounts approved under 2.0.0 keep the limits they signed (16 entries,
 * 256 manage-any, 64 convert-any per pool) until a renewal, which the app offers when a grant has used 80% of them.
 */
export const conservadorLiveV2: PolicyVersion = {
  ...conservadorLiveV1,
  policyId: 'conservador-live-v2',
  version: '2.1.0',
  buckets: [
    { id: 'stables', preference: 5000, pools: ['pool:USDC/USDT/100'] },
    { id: 'btc-usdc', preference: 4000, pools: ['pool:USDC/cbBTC/500'] },
    { id: 'risk', preference: 1000, pools: ['pool:WETH/USDC/3000'] },
  ],
  range: { ...conservadorLiveV1.range, widthTicksByPool: { 'pool:USDC/USDT/100': 40 } },
  allocation: 'target-weights',
  minEntry: 100_000n,
  rebalanceBandBps: 300,
  session: {
    ...conservadorV1.session,
    caps: [...stablesPair.caps, ...btcPair.caps, ...riskPair.caps],
    grants: [...stablesPair.grants, ...btcPair.grants, ...riskPair.grants],
  },
}

/**
 * Spec 004 (#101) fall freeze: thresholds that passed the Lab gate (16 Oct 2026, Sep 2026, Oct 2025 and Feb 2025
 * windows): the 24 h trend thresholds of `RISK_REGIME_TREND` (cbBTC 7%, WETH 9%) with the `RISK_REGIME_VOL` ones
 * (80%, 100%). The half-trend thresholds (3.5%, 4.5%) failed: worse than no rule in October 2025.
 */
export const FALL_FREEZE_DEFAULTS = {
  'btc-usdc': { fallBps: 700, volBps: 8000 },
  risk: { fallBps: 900, volBps: 10_000 },
} as const

/**
 * Lab policy: conservador-live-v2 with the fall freeze. Not live: the engine does not yet build
 * `Observation.guard` (spec 004 LC-T6), so on chain the rule would only abstain.
 */
export const conservadorLabGuardsV1: PolicyVersion = {
  ...conservadorLiveV2,
  policyId: 'conservador-lab-guards-v1',
  version: '1.0.0',
  chain: 'fork',
  guards: { byBucket: { 'btc-usdc': { fallFreeze: { ...FALL_FREEZE_DEFAULTS['btc-usdc'] } }, risk: { fallFreeze: { ...FALL_FREEZE_DEFAULTS.risk } } } },
}

/**
 * Lab policy for the range-geometry experiments (#101): conservador-live-v2 on a fork, with no geometry rule, so it
 * trades exactly as live. A sweep turns `geometry.skew` / `geometry.volWidth` on by override.
 */
export const conservadorLabGeometryV1: PolicyVersion = {
  ...conservadorLiveV2,
  policyId: 'conservador-lab-geometry-v1',
  version: '1.0.0',
  chain: 'fork',
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
  [conservadorLabGuardsV1.policyId]: conservadorLabGuardsV1,
  [conservadorLabGeometryV1.policyId]: conservadorLabGeometryV1,
}
