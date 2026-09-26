import { pairGrants } from './grants.ts'
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
  [labWethUsdcV1.policyId]: labWethUsdcV1,
}
