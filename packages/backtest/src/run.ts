import { keccak256, stringToHex } from 'viem'
import type { Hex } from '@mamoru/domain'
import { amountsOf, canonicalJson, decide, type Proposal } from '@mamoru/decide'
import { grantKey, policyHash, type PolicyVersion } from '@mamoru/policy'
import { entry, type RegistryEntry, type RegistryName } from '@mamoru/registry'
import { token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { ETH_PRICE_POOL, observe } from './observe.ts'
import type { Dataset, GasModel, Metrics, OpEntry, OpKind, PoolSample, RunResult, Sample, SessionUse, SimConfig } from './types.ts'
import { accrue, apply, inRange, newWorld, valueIn, type World } from './world.ts'

export const SIM_VERSION = 'backtest-1'

/**
 * Gas of one operation. Swap and mint are the medians of 14 live receipts on Base (2026-09-26 to 2026-10-01): 470,200
 * and 835,285 gas, an L1 data fee near 3.1e9 wei. Harvest, re-range and reduce have no live receipt yet;
 * theirs are estimates between the two.
 */
export const DEFAULT_GAS: GasModel = {
  unitsByKind: { enter_swap: 470_000n, enter_mint: 835_000n, harvest: 650_000n, rerange: 700_000n, reduce: 600_000n },
  priorityFeeWei: 1_000_000n,
  l1FeeWei: 3_100_000_000n,
}

const WEEK = 7 * 86_400
const KINDS: readonly OpKind[] = ['enter_swap', 'enter_mint', 'harvest', 'rerange', 'reduce']

type Pricer = (s: Sample, token: RegistryName, amount: bigint) => bigint

/** For every token of the dataset, the pool that prices it in the savings asset: a policy pool first. */
function pricer(ds: Dataset, policy: PolicyVersion): Pricer {
  const savings = policy.savingsAsset
  const policyPools = new Set(policy.buckets.flatMap((b) => b.pools))
  const by = new Map<RegistryName, { k: number; e: RegistryEntry }>()
  const order = ds.pools.map((name, k) => ({ k, e: entry(name) })).sort((a, b) => Number(policyPools.has(b.e.name)) - Number(policyPools.has(a.e.name)))
  for (const { k, e } of order) {
    const other = e.token0 === savings ? e.token1 : e.token1 === savings ? e.token0 : undefined
    if (other && !by.has(other)) by.set(other, { k, e })
  }
  return (s, token, amount) => {
    if (token === savings) return amount
    if (amount === 0n) return 0n
    const via = by.get(token)
    const ps = via && s.pools[via.k]
    if (!via || !ps) throw new Error(`no pool of the dataset prices ${token} in ${savings} at block ${s.block}`)
    return valueIn(via.e, ps, token, amount, savings)
  }
}

function accountValue(ds: Dataset, s: Sample, w: World, price: Pricer): { total: bigint; lp: bigint; lpInRange: bigint } {
  let total = 0n
  let lp = 0n
  let lpInRange = 0n
  for (const [token, amount] of Object.entries(w.balances)) total += price(s, token, amount)
  for (const p of w.positions) {
    const ps = s.pools[ds.pools.indexOf(p.pool)]
    if (!ps) continue
    const e = entry(p.pool)
    const a = amountsOf(ps.sqrtPriceX96, p.tickLower, p.tickUpper, p.liquidity)
    const v = price(s, e.token0!, a.amount0 + p.owed0) + price(s, e.token1!, a.amount1 + p.owed1)
    total += v
    lp += v
    if (inRange(ps.tick, p)) lpInRange += v
  }
  return { total, lp, lpInRange }
}

/** Gas of one operation in raw savings units, through the ETH price pool. */
function gasCost(ds: Dataset, s: Sample, kind: OpKind, gas: GasModel, savings: RegistryName): bigint {
  const wei = gas.unitsByKind[kind] * (s.baseFeeWei + gas.priorityFeeWei) + gas.l1FeeWei
  const e = entry(ETH_PRICE_POOL)
  const ps = s.pools[ds.pools.indexOf(ETH_PRICE_POOL)]!
  if (e.token0 !== savings && e.token1 !== savings) throw new Error(`${ETH_PRICE_POOL} does not price gas in ${savings}`)
  return e.token0 === savings ? token1InToken0(wei, ps.sqrtPriceX96) : token0InToken1(wei, ps.sqrtPriceX96)
}

/** The first entry mix of every bucket, held without providing liquidity: half savings, half the other token of its pool. */
function hodlBasket(ds: Dataset, s: Sample, policy: PolicyVersion, deposit: bigint): Record<RegistryName, bigint> {
  const savings = policy.savingsAsset
  const total = BigInt(policy.buckets.reduce((n, b) => n + b.preference, 0))
  const held: Record<RegistryName, bigint> = { [savings]: 0n }
  for (const b of policy.buckets) {
    const share = total === 0n ? 0n : (deposit * BigInt(b.preference)) / total
    const name = b.pools[0]
    const ps = name ? s.pools[ds.pools.indexOf(name)] : null
    if (!name || !ps) {
      held[savings]! += share
      continue
    }
    const e = entry(name)
    const half = share / 2n
    const other = e.token0 === savings ? e.token1! : e.token0!
    held[savings]! += share - half
    held[other] = (held[other] ?? 0n) + (e.token0 === savings ? token0InToken1(half, ps.sqrtPriceX96) : token1InToken0(half, ps.sqrtPriceX96))
  }
  return held
}

function bps(num: bigint, den: bigint): number {
  return den === 0n ? 0 : Number((num * 1_000_000n) / den) / 100
}

function drawdowns(time: number[], value: bigint[]): { maxDrawdownBps: number; worstWeekBps: number } {
  let peak = 0n
  let maxDd = 0
  let worst = 0
  let j = 0
  for (let i = 0; i < value.length; i++) {
    const v = value[i]!
    if (v > peak) peak = v
    maxDd = Math.max(maxDd, bps(peak - v, peak))
    while (time[i]! - time[j + 1 <= i ? j + 1 : j]! >= WEEK && j + 1 <= i) j++
    const base = value[j]!
    if (base > v) worst = Math.max(worst, bps(base - v, base))
  }
  return { maxDrawdownBps: maxDd, worstWeekBps: worst }
}

/** Usage limit of the session a proposal runs under, or null when the policy has no such grant. */
function limitOf(policy: PolicyVersion, grant: string): number | null {
  const perPosition = /^manage:\d+$/.test(grant)
  return policy.session.grants.find((g) => (perPosition ? g.name === 'manage' : grantKey(g) === grant))?.usageLimit ?? null
}

function sessionUses(policy: PolicyVersion, uses: Map<string, number[]>, t0: number): SessionUse[] {
  const out: SessionUse[] = []
  for (const [grant, times] of [...uses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const limit = limitOf(policy, grant)
    const windows = new Map<number, number>()
    for (const at of times) {
      const w = Math.floor((at - t0) / policy.session.validitySeconds)
      windows.set(w, (windows.get(w) ?? 0) + 1)
    }
    const peak = Math.max(0, ...windows.values())
    out.push({ grant, limit, uses: times.length, peakPerWindow: peak, exhausted: limit !== null && peak > limit })
  }
  return out
}

/**
 * Replays a dataset through the production `decide`. Each sample: positions earn the fees of the interval, the
 * engine reviews the account as it would have on chain, and at most one proposal is executed at that sample's price.
 */
export function runBacktest(ds: Dataset, policy: PolicyVersion, config: SimConfig): RunResult {
  const from = config.from ?? 0
  const to = config.to ?? ds.samples.length - 1
  if (ds.samples.length === 0 || from < 0 || to >= ds.samples.length || from > to) throw new Error(`empty window ${from}..${to} over ${ds.samples.length} samples`)
  for (const name of new Set(policy.buckets.flatMap((b) => b.pools))) if (!ds.pools.includes(name)) throw new Error(`the dataset has no ${name}, a pool of ${policy.policyId}`)
  const every = Math.max(1, config.reviewEvery ?? 1)
  const gas: GasModel = { ...DEFAULT_GAS, ...config.gas, unitsByKind: { ...DEFAULT_GAS.unitsByKind, ...config.gas?.unitsByKind } }
  const savings = policy.savingsAsset
  const price = pricer(ds, policy)
  const w = newWorld(savings, config.deposit)
  const series = { time: [] as number[], value: [] as bigint[], hodl: [] as bigint[] }
  const ops: OpEntry[] = []
  const reasons: Record<string, number> = {}
  const uses = new Map<string, number[]>()
  const count = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<OpKind, number>
  let gasSpent = 0n
  let deposited = config.deposit
  let fees = 0n
  let discarded = 0
  let refused = 0
  const enforce = (config.sessions ?? 'enforce') === 'enforce'
  let rangeSum = 0
  let rangeSamples = 0

  // A sample that lacks a pool the policy needs, or the pool that prices gas, is a gap: the run steps over it.
  const needed = [...new Set([...policy.buckets.flatMap((b) => b.pools), ETH_PRICE_POOL])].map((name) => ds.pools.indexOf(name))
  const usable = (s: Sample) => needed.every((k) => k >= 0 && s.pools[k])
  const first = ds.samples.slice(from, to + 1).find(usable)
  if (!first) throw new Error(`no sample of the window has every pool of ${policy.policyId} and ${ETH_PRICE_POOL}`)
  const hodl = hodlBasket(ds, first, policy, config.deposit)
  let prevIndex = -1
  let gaps = 0

  for (let i = from; i <= to; i++) {
    const s = ds.samples[i]!
    if (!usable(s)) {
      gaps++
      continue
    }
    if (prevIndex >= 0) {
      const prev = ds.samples[prevIndex]!
      for (const p of w.positions) {
        const k = ds.pools.indexOf(p.pool)
        const a = prev.pools[k]
        const b = s.pools[k]
        if (!a || !b) continue
        const f = accrue(p, a, b)
        const e = entry(p.pool)
        fees += price(s, e.token0!, f.fees0) + price(s, e.token1!, f.fees1)
      }
    }
    for (const t of config.topUps ?? []) {
      if (t.at !== i) continue
      w.balances[savings] = (w.balances[savings] ?? 0n) + t.amount
      deposited += t.amount
      // The benchmark receives the same money at the same time, in the same mix.
      for (const [token, amount] of Object.entries(hodlBasket(ds, s, policy, t.amount))) hodl[token] = (hodl[token] ?? 0n) + amount
    }
    if (series.time.length % every === 0) {
      const d = decide(observe(ds, i, w, policy, gas.priorityFeeWei), policy)
      reasons[d.reason] = (reasons[d.reason] ?? 0) + 1
      const p: Proposal | null = d.proposal
      // Sessions are renewed every `validitySeconds`; inside one window a grant has `usageLimit` uses.
      const window = Math.floor((s.time - first.time) / policy.session.validitySeconds)
      const limit = p ? limitOf(policy, p.grant) : null
      const used = p ? (uses.get(p.grant) ?? []).filter((at) => Math.floor((at - first.time) / policy.session.validitySeconds) === window).length : 0
      if (p && enforce && limit !== null && used >= limit) {
        refused++
        reasons.SESSION_USAGE_SPENT = (reasons.SESSION_USAGE_SPENT ?? 0) + 1
      } else if (p) {
        const ps = s.pools[ds.pools.indexOf(p.pool)] as PoolSample
        const done = apply(w, p, ps, s.time, policy.execution.slippageBps)
        const e = entry(p.pool)
        const cost = done.ok ? gasCost(ds, s, p.kind, gas, savings) : 0n
        ops.push({
          i, block: s.block, time: s.time, kind: p.kind, pool: p.pool, grant: p.grant, code: d.code, reason: d.reason, trail: d.trail, ok: done.ok,
          ...(done.ok ? {} : { detail: done.detail }),
          gasCost: cost,
          feesValue: done.ok ? price(s, e.token0!, done.fees0) + price(s, e.token1!, done.fees1) : 0n,
        })
        if (done.ok) {
          gasSpent += cost
          count[p.kind]++
          uses.set(p.grant, [...(uses.get(p.grant) ?? []), s.time])
        } else discarded++
      }
    }
    const v = accountValue(ds, s, w, price)
    series.time.push(s.time)
    series.value.push(v.total - gasSpent)
    series.hodl.push(Object.entries(hodl).reduce((n, [token, amount]) => n + price(s, token, amount), 0n))
    if (v.lp > 0n) {
      rangeSum += bps(v.lpInRange, v.lp)
      rangeSamples++
    }
    prevIndex = i
  }

  const last = ds.samples[prevIndex]!
  const end = series.value.at(-1)!
  const hodlEnd = series.hodl.at(-1)!
  const metrics: Metrics = {
    days: (last.time - first.time) / 86_400,
    start: deposited,
    end,
    net: end - deposited,
    hodl: hodlEnd,
    vsHodl: end - hodlEnd,
    fees,
    gas: gasSpent,
    operations: count,
    discarded,
    refused,
    timeInRangeBps: rangeSamples === 0 ? 0 : Math.round(rangeSum / rangeSamples),
    ...drawdowns(series.time, series.value),
    returnBps: bps(end - deposited, deposited),
  }
  const sessions = sessionUses(policy, uses, first.time)
  const pHash = policyHash(policy)
  const facts = { simVersion: SIM_VERSION, datasetId: ds.id, policyHash: pHash, from, to, every, gaps, enforce, refused, deposit: config.deposit, topUps: config.topUps ?? [], gas, end, hodlEnd, fees, gasSpent, ops: ops.map(({ trail: _t, ...o }) => o), reasons, sessions }
  return {
    simVersion: SIM_VERSION,
    datasetId: ds.id,
    policyId: policy.policyId,
    policyHash: pHash,
    window: { fromBlock: first.block, toBlock: last.block, fromTime: first.time, toTime: last.time, samples: series.time.length, gaps },
    series,
    ops,
    reasons,
    sessions,
    metrics,
    resultHash: keccak256(stringToHex(canonicalJson(facts))) as Hex,
  }
}
