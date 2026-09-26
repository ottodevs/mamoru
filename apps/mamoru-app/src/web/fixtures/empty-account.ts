import { PRODUCTION_BANNER, type DashboardPayload, type Figure, type Hex0x, type PoolRef, type Provenance } from '@mamoru/domain'

// Dev and test only. A production v1 account right after onboarding (dashboard.md §7 "Vacío"):
// counterfactual, zero balances read at a block, no session, no decision yet.
export const FIXTURE_BLOCK = 52_114_380
export const FIXTURE_OBSERVED_AT = '2026-09-26T18:20:00.000Z'
export const FIXTURE_ACCOUNT_KEY = 'acct_fixture_01'
export const FIXTURE_ADDRESS: Hex0x = '0x7a3C5f0e8D21b94E6f0A1c2B3d4E5F60718293aB'

const at = (source: Provenance['source'], extra: Partial<Provenance> = {}): Provenance => ({
  source,
  chainId: 8453,
  observedAt: FIXTURE_OBSERVED_AT,
  status: 'fresh',
  ...extra,
})
const rpc = (): Provenance => at('chain_rpc', { blockNumber: FIXTURE_BLOCK })
const fig = <T>(value: T | null, provenance: Provenance, unit?: string): Figure<T> => (unit ? { value, unit, provenance } : { value, provenance })
const zero = (unit: string, provenance: Provenance = rpc()): Figure<string> => fig('0', provenance, unit)

export const USDC_CBBTC_POOL: PoolRef = {
  address: '0xfBB6Eed8e7aa03B138556eeDaF5D271A5E1e43ef',
  token0: 'USDC',
  token1: 'cbBTC',
  fee: 500,
  tickSpacing: 10,
  name: 'USDC/cbBTC 0.05%',
}

export const emptyAccount: DashboardPayload = {
  mode: 'production',
  chainId: 8453,
  chains: [{ chainId: 8453, name: 'Base', observed: true }],
  sources: {
    rpc: { status: 'ok', block: FIXTURE_BLOCK, safeBlock: FIXTURE_BLOCK - 12, observedAt: FIXTURE_OBSERVED_AT },
    index: { provider: 'multibaas', status: 'indexing', indexedBlock: FIXTURE_BLOCK - 3, checkedAt: FIXTURE_OBSERVED_AT },
  },
  banner: { kind: 'simulation', text: PRODUCTION_BANNER },
  account: {
    key: FIXTURE_ACCOUNT_KEY,
    address: fig(FIXTURE_ADDRESS, at('d1', { detail: 'ONB_ADDRESS_MATCH' })),
    deployed: fig(false, rpc()),
    preset: 'conservador',
    policyVersion: 'conservador-v1',
    fundsGate: 'closed',
    totalValue: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })),
    totalMissing: [],
  },
  actions: { items: [], complete: true, notObserved: [] },
  currentAction: {
    recentDecisions: [],
    chainOps: [],
    session: fig('missing', at('chain_rpc', { blockNumber: FIXTURE_BLOCK })),
    paused: fig(false, at('journal')),
    nextReviewAt: fig('2026-09-26T18:25:00.000Z', at('journal')),
    notes: [],
  },
  portfolio: {
    tokens: [
      { token: 'USDC', role: 'plan', amount: zero('USDC'), value: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })) },
      { token: 'cbBTC', role: 'plan', amount: zero('cbBTC'), value: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })) },
      {
        token: 'WETH',
        role: 'outside_plan',
        amount: zero('WETH'),
        value: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })),
        code: 'OBS_UNMANAGED_ASSET',
      },
      { token: 'ETH', role: 'gas', amount: zero('ETH'), value: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })) },
    ],
    positions: { managed: fig(0, rpc()), unmanaged: fig(0, rpc()), value: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })) },
    allocation: [
      { bucket: 'stables', preference: 5000, actual: fig(0, rpc()), code: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' },
      { bucket: 'btc-usdc', preference: 4000, actual: fig(0, rpc()), code: 'STRATEGY_PREFERENCE' },
      { bucket: 'risk', preference: 1000, actual: fig(0, rpc()), code: 'PLAN_BUCKET_NO_EXECUTABLE_POOL' },
    ],
    unmanaged: [],
    total: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })),
  },
  treasury: {
    idle: { usdc: zero('USDC'), cbBTC: zero('cbBTC'), value: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })) },
    lp: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })),
    savings: zero('USDC', at('journal')),
    gasReserve: zero('ETH'),
    outsidePlan: zero('USDC', at('estimate', { blockNumber: FIXTURE_BLOCK })),
    convert: {
      route: { protocol: 'uniswap-v3', pool: USDC_CBBTC_POOL, router: 'SwapRouter02', method: 'exactInputSingle', quoter: 'QuoterV2' },
      pending: zero('cbBTC'),
      quote: fig<string>(null, at('estimate', { status: 'not_observed' }), 'USDC'),
      state: 'nothing_to_convert',
    },
    swaps: [],
  },
  pools: { positions: [], plan: [] },
  savings: {
    ledgerTotal: zero('USDC', at('journal')),
    usdcBalance: zero('USDC'),
    available: zero('USDC', at('journal')),
    pending: zero('USDC', at('journal')),
  },
  savingsLog: { rows: [] },
  provenanceComplete: true,
}
