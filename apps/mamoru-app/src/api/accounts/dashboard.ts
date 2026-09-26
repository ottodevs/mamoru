import {
  PRODUCTION_BANNER,
  type DashboardPayload,
  type Figure,
  type Hex0x,
  type IndexHealth,
  type PoolRef,
  type PoolView,
  type Provenance,
  type ReasonCode,
  type TokenHolding,
} from '@mamoru/domain'
import { entry } from '@mamoru/registry'
import { conservadorV1 } from '@mamoru/policy'
import { accountSetup, counterfactualAddress } from '@mamoru/account/recovery'
import type { Db } from '../env.ts'
import { aged, everythingObserved, notObserved } from '../provenance.ts'
import { ownersOf, type AccountRow } from './store.ts'

export type AccountStateRow = {
  account_key: string
  chain_id: number
  block: number
  block_hash: Hex0x
  observed_at: string
  deployed: number
  tokens_json: string
  total_value: string | null
}

export type SourceStateRow = {
  chain_id: number
  rpc_status: 'ok' | 'unavailable'
  block: number | null
  safe_block: number | null
  observed_at: string
  index_provider: IndexHealth['provider']
  index_status: IndexHealth['status']
  index_block: number | null
  index_code: ReasonCode | null
  index_checked_at: string
}

export type DashboardInput = {
  account: AccountRow
  state: AccountStateRow | null
  source: SourceStateRow | null
  pools: PoolView[]
}

export async function loadDashboardInput(db: Db, account: AccountRow): Promise<DashboardInput> {
  const [state, source, poolRows] = await Promise.all([
    db.prepare('SELECT * FROM proj_account_state WHERE account_key = ? AND chain_id = ?').bind(account.account_key, account.chain_id).first<AccountStateRow>(),
    db.prepare('SELECT * FROM source_state WHERE chain_id = ?').bind(account.chain_id).first<SourceStateRow>(),
    db.prepare('SELECT payload_json FROM proj_pool_state WHERE chain_id = ? ORDER BY pool_address').bind(account.chain_id).all<{ payload_json: string }>(),
  ])
  return { account, state, source, pools: poolRows.results.map((r) => JSON.parse(r.payload_json) as PoolView) }
}

// Inputs Actions needs that the sprint does not project yet (packages/projector derives Actions later).
const ACTIONS_INPUTS_NOT_PROJECTED = ['journal', 'decisions', 'sessions', 'positions', 'savings ledger'] as const

function poolRef(name: string): PoolRef {
  const e = entry(name)
  if (e.kind !== 'pool' || !e.token0 || !e.token1 || e.fee === undefined || e.tickSpacing === undefined) throw new Error(`${name} is not a pool entry`)
  return { address: e.address, token0: e.token0, token1: e.token1, fee: e.fee, tickSpacing: e.tickSpacing, name: e.name }
}

function holding(tokens: TokenHolding[], token: TokenHolding['token'], role: TokenHolding['role']): TokenHolding | undefined {
  return tokens.find((t) => t.token === token && t.role === role)
}

/** DashboardPayload from D1 rows only (dashboard.md §9). Missing data is null + not_observed, never zero. */
export function buildDashboard(input: DashboardInput, now: Date): DashboardPayload {
  const { account, state, source } = input
  const chainId = account.chain_id
  const miss = <T>(src: Provenance['source'], unit?: string) => notObserved<T>(src, chainId, now, unit)

  const rebuilt = counterfactualAddress(accountSetup(ownersOf(account), BigInt(account.salt_nonce)))
  const addressMatches = rebuilt.toLowerCase() === account.address.toLowerCase()
  const address: Figure<Hex0x> = {
    value: account.address,
    provenance: { source: 'd1', chainId, observedAt: account.created_at, status: 'fresh', ...(addressMatches ? { detail: 'ONB_ADDRESS_MATCH' as const } : {}) },
  }

  const chainProvenance = (src: 'chain_rpc' | 'estimate'): Provenance | null =>
    state ? { source: src, chainId, blockNumber: state.block, blockHash: state.block_hash, observedAt: state.observed_at, status: 'fresh' } : null
  const rpcProv = chainProvenance('chain_rpc')
  const estimateProv = chainProvenance('estimate')

  const tokens: TokenHolding[] = state ? (JSON.parse(state.tokens_json) as TokenHolding[]) : []
  const deployed: Figure<boolean> = state && rpcProv ? { value: state.deployed === 1, provenance: rpcProv } : miss('chain_rpc')
  const totalValue: Figure<string> =
    state?.total_value != null && estimateProv ? { value: state.total_value, unit: 'USDC', provenance: estimateProv } : miss('estimate', 'USDC')
  const totalMissing =
    totalValue.value !== null ? [] : !state ? ['account state'] : tokens.filter((t) => t.value.value === null).map((t) => `${t.token} value`)

  const amountOf = (token: TokenHolding['token'], role: TokenHolding['role']): Figure<string> =>
    holding(tokens, token, role)?.amount ?? miss('chain_rpc', token)

  const notObservedInputs = [
    ...ACTIONS_INPUTS_NOT_PROJECTED,
    ...(state ? [] : ['account state']),
    ...(source ? [] : ['source health']),
    ...(input.pools.length ? [] : ['pool state']),
  ]

  const payload: DashboardPayload = {
    mode: 'production',
    chainId,
    chains: [{ chainId, name: 'Base', observed: true }],
    sources: source
      ? {
          rpc: {
            status: source.rpc_status,
            ...(source.block !== null ? { block: source.block } : {}),
            ...(source.safe_block !== null ? { safeBlock: source.safe_block } : {}),
            observedAt: source.observed_at,
          },
          index: {
            provider: source.index_provider,
            status: source.index_status,
            ...(source.index_block !== null ? { indexedBlock: source.index_block } : {}),
            ...(source.index_code !== null ? { code: source.index_code } : {}),
            checkedAt: source.index_checked_at,
          },
        }
      : // No health row yet: the reader has not reported, so nothing is claimed about it.
        { rpc: { status: 'unavailable', observedAt: now.toISOString() }, index: { provider: 'multibaas', status: 'not_configured', checkedAt: now.toISOString() } },
    banner: { kind: 'simulation', text: PRODUCTION_BANNER, ...(source?.block != null ? { block: source.block } : {}) },
    account: {
      key: account.account_key,
      address,
      deployed,
      preset: 'conservador',
      policyVersion: account.policy_version,
      fundsGate: 'closed',
      totalValue,
      totalMissing,
    },
    actions: { items: [], complete: false, notObserved: notObservedInputs },
    currentAction: {
      recentDecisions: [],
      chainOps: [],
      session: miss('journal'),
      paused: miss('journal'),
      nextReviewAt: miss('journal'),
      notes: ['FUNDS_GATE_CLOSED'],
    },
    portfolio: {
      tokens,
      positions: { managed: 0, unmanaged: 0, value: miss('chain_rpc', 'USDC') },
      allocation: conservadorV1.buckets.map((b) => ({ bucket: b.id, preference: b.preference, actual: miss<number>('estimate'), code: 'STRATEGY_PREFERENCE' as const })),
      unmanaged: [],
      total: totalValue,
    },
    treasury: {
      idle: { usdc: amountOf('USDC', 'plan'), cbBTC: amountOf('cbBTC', 'plan'), value: miss('estimate', 'USDC') },
      lp: miss('chain_rpc', 'USDC'),
      savings: miss('journal', 'USDC'),
      gasReserve: amountOf('ETH', 'gas'),
      outsidePlan: miss('estimate', 'USDC'),
      convert: {
        route: { protocol: 'uniswap-v3', pool: poolRef('pool:USDC/cbBTC/500'), router: 'SwapRouter02', method: 'exactInputSingle', quoter: 'QuoterV2' },
        pending: miss('journal', 'cbBTC'),
        quote: miss('estimate', 'USDC'),
        state: 'held',
        code: 'FUNDS_GATE_CLOSED',
      },
      swaps: [],
    },
    pools: { positions: [], plan: input.pools },
    savings: {
      ledgerTotal: miss('journal', 'USDC'),
      usdcBalance: amountOf('USDC', 'plan'),
      available: miss('journal', 'USDC'),
      pending: miss('journal', 'USDC'),
    },
    savingsLog: { rows: [] },
    provenanceComplete: false,
  }
  const out = aged(payload, now)
  return { ...out, provenanceComplete: everythingObserved(out) }
}
