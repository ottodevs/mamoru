import { keccak256, stringToHex } from 'viem'
import type { Hex } from '@mamoru/domain'
import { amountsOf, canonicalJson, decide, pegDeviationBps, pegStep, PEG_CLEAR, stageStep, type Proposal } from '@mamoru/decide'
import { computeCaps, grantKey, policyHash, usageLimitFor, type Caps, type GrantTemplate, type PolicyVersion, type Price } from '@mamoru/policy'
import { entry, type RegistryEntry, type RegistryName } from '@mamoru/registry'
import { token0InToken1, token1InToken0 } from '@mamoru/uniswap-v3/quote'
import { emaTickOf, ETH_PRICE_POOL, observe, twapTick } from './observe.ts'
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

export type Pricer = (s: Sample, token: RegistryName, amount: bigint) => bigint

/** For every token of the dataset, the pool that prices it in the savings asset: a policy pool first. */
export function pricer(ds: Dataset, policy: PolicyVersion): Pricer {
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

/**
 * Lab (otto/mamoru#151 T5): the token amounts `p` spends against MamoruActionPolicy's budget — swaps' `amountIn`
 * (enter_swap and harvest's convert leg) and mints' both desired amounts (spec 007 "(c) budgets"). A decrease
 * (rerange, reduce) spends nothing against it.
 */
function budgetSpend(p: Proposal, e: RegistryEntry): { token: RegistryName; amount: bigint }[] {
  if (p.kind === 'enter_swap') return [{ token: p.tokenIn, amount: p.amountIn }]
  if (p.kind === 'enter_mint') return [{ token: e.token0!, amount: p.amount0Desired }, { token: e.token1!, amount: p.amount1Desired }]
  if (p.kind === 'harvest' && p.convert) return [{ token: p.convert.token, amount: p.convert.amount }]
  return []
}

/** The grant template a proposal runs under (`manage:<tokenId>` is the per-position `manage`), or undefined. */
function templateOf(policy: PolicyVersion, grant: string): GrantTemplate | undefined {
  const perPosition = /^manage:\d+$/.test(grant)
  return policy.session.grants.find((g) => (perPosition ? g.name === 'manage' : grantKey(g) === grant))
}

/** Usage limit of the session a proposal runs under, at the account cap the grants are sized at; null without such a grant. */
function limitOf(policy: PolicyVersion, grant: string, capUsdc: bigint): number | null {
  const t = templateOf(policy, grant)
  return t ? usageLimitFor(t, capUsdc) : null
}

/**
 * What a proposal adds to each cumulative rule of its grant, as the chain counts it (the calldata word): the swap's
 * `amountIn`, the mint's desired amounts. One entry per rule: [rule key, cap name, amount].
 */
function cumulativeSpend(t: GrantTemplate, p: Proposal): [string, string, bigint][] {
  const out: [string, string, bigint][] = []
  for (const [ai, a] of t.actions.entries()) {
    for (const [ri, r] of a.params.entries()) {
      if (typeof r.cumulative !== 'string' || !r.cumulative.startsWith('cap:')) continue
      const v =
        r.field === 'amountIn' ? (p.kind === 'enter_swap' ? p.amountIn : p.kind === 'harvest' ? (p.convert?.amount ?? 0n) : 0n)
        : r.field === 'amount0Desired' && p.kind === 'enter_mint' ? p.amount0Desired
        : r.field === 'amount1Desired' && p.kind === 'enter_mint' ? p.amount1Desired
        : 0n
      if (v > 0n) out.push([`${ai}:${ri}`, r.cumulative.slice(4), v])
    }
  }
  return out
}

/** The caps an approval signed at sample `s` carries: bps of the account cap, at that sample's prices (#149). */
export function capsAt(policy: PolicyVersion, s: Sample, price: Pricer, capUsdc: bigint): Caps {
  const ONE = 10n ** 24n
  const prices: Record<string, Price> = {}
  for (const f of policy.session.caps) {
    if (f.asset === policy.savingsAsset || prices[f.asset]) continue
    const v = price(s, f.asset, ONE)
    if (v === 0n) throw new Error(`no price for ${f.asset} at block ${s.block}`)
    prices[f.asset] = { num: ONE, den: v }
  }
  return computeCaps(policy, capUsdc, prices)
}

type GrantTally = { uses: number; peak: number; peakSpentBps: number | null }

function sessionUses(policy: PolicyVersion, tally: Map<string, GrantTally>, capUsdc: bigint): SessionUse[] {
  // Code-unit order, the same on every machine: the list goes into the result hash.
  return [...tally.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([grant, t]) => {
      const limit = limitOf(policy, grant, capUsdc)
      return { grant, limit, uses: t.uses, peakPerWindow: t.peak, peakSpentBps: t.peakSpentBps, exhausted: (limit !== null && t.peak > limit) || (t.peakSpentBps ?? 0) > 10_000 }
    })
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
  let depthWaits = 0
  let idleSum = 0
  let idleSamples = 0
  const tally = new Map<string, GrantTally>()
  const count = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<OpKind, number>
  let gasSpent = 0n
  let deposited = config.deposit
  let fees = 0n
  let discarded = 0
  let refused = 0
  const enforce = (config.sessions ?? 'enforce') === 'enforce'
  const renewal = config.sessionRenewal ?? 'renewed'
  const capUsdc = config.capUsdc ?? config.deposit
  const refresh = renewal === 'renewed' ? config.usageRefresh : undefined
  let rangeSum = 0
  let rangeSamples = 0
  const stablesPool = policy.buckets.find((b) => b.id === 'stables')?.pools[0]
  const stablesK = stablesPool ? ds.pools.indexOf(stablesPool) : -1
  // Volatile buckets: their pool, and the sign that turns its tick into the volatile token's price (an up tick).
  const staged = policy.buckets.filter((b) => b.id !== 'stables' && b.pools[0]).map((b) => {
    const e = entry(b.pools[0]!)
    return { bucket: b.id, k: ds.pools.indexOf(b.pools[0]!), sign: e.token0 === savings ? -1 : 1, highs: [] as { time: number; up: number }[] }
  })

  // A sample that lacks a pool the policy needs, or the pool that prices gas, is a gap: the run steps over it.
  const needed = [...new Set([...policy.buckets.flatMap((b) => b.pools), ETH_PRICE_POOL])].map((name) => ds.pools.indexOf(name))
  const usable = (s: Sample) => needed.every((k) => k >= 0 && s.pools[k])
  const first = ds.samples.slice(from, to + 1).find(usable)
  if (!first) throw new Error(`no sample of the window has every pool of ${policy.policyId} and ${ETH_PRICE_POOL}`)
  const hodl = hodlBasket(ds, first, policy, config.deposit)
  let prevIndex = -1
  // One session window: what the grants have used since the approval that opened it (#149).
  let winStart = first.time
  let caps = capsAt(policy, first, price, capUsdc)
  let usedIn = new Map<string, number>()
  let spentIn = new Map<string, bigint>()
  let refreshAt: number | null = null
  let usageRefreshes = 0
  const openWindow = (s: Sample, at: number) => {
    winStart = at
    caps = capsAt(policy, s, price, capUsdc)
    usedIn = new Map()
    spentIn = new Map()
    refreshAt = null
  }
  const topUps = [...(config.topUps ?? [])].sort((a, b) => a.at - b.at)
  let nextTopUp = 0
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
    // A deposit due at a sample the run stepped over lands at the next one it replays.
    for (; nextTopUp < topUps.length && topUps[nextTopUp]!.at <= i; nextTopUp++) {
      const t = topUps[nextTopUp]!
      w.balances[savings] = (w.balances[savings] ?? 0n) + t.amount
      deposited += t.amount
      // The benchmark receives the same money at the same time, in the same mix.
      for (const [token, amount] of Object.entries(hodlBasket(ds, s, policy, t.amount))) hodl[token] = (hodl[token] ?? 0n) + amount
    }
    // Lab (#101): how long each position has been out of range, and the account's peak, as the engine would track them.
    if (policy.range.lazy) for (const p of w.positions) {
      const ps = s.pools[ds.pools.indexOf(p.pool)]
      if (!ps) continue
      if (inRange(ps.tick, p)) p.outSince = null
      else p.outSince ??= s.time
    }
    if (policy.cppi) {
      const v = accountValue(ds, s, w, price).total
      if (w.peakValue === undefined || v > w.peakValue) w.peakValue = v
    }
    // Lab (#101 round 3): the depeg guard and the staged exits step at every sample, from the TWAP, as the engine would.
    const tw = policy.execution.twapWindowSeconds
    if (policy.depegGuard && stablesK >= 0) {
      const dev = s.pools[stablesK] ? pegDeviationBps(twapTick(ds, stablesK, i, tw)) : null
      w.peg = pegStep(w.peg ?? PEG_CLEAR, s.time, dev, policy.depegGuard)
      w.pegDeviationBps = dev
    }
    if (policy.stagedExit) for (const st of staged) {
      if (!s.pools[st.k]) continue
      const up = st.sign * twapTick(ds, st.k, i, tw)
      // Rolling 7-day high of the up tick: a deque of decreasing values.
      while (st.highs.length && s.time - st.highs[0]!.time > 7 * 86_400) st.highs.shift()
      while (st.highs.length && st.highs.at(-1)!.up <= up) st.highs.pop()
      st.highs.push({ time: s.time, up })
      const ema = emaTickOf(ds, st.k, i, tw)
      w.stages ??= {}
      w.stages[st.bucket] = stageStep(w.stages[st.bucket], { now: s.time, price: up, high7d: st.highs[0]!.up, ema: ema === null ? null : st.sign * ema }, policy.stagedExit)
    }
    if (series.time.length % every === 0) {
      const d = decide(observe(ds, i, w, policy, gas.priorityFeeWei), policy)
      reasons[d.reason] = (reasons[d.reason] ?? 0) + 1
      // otto/mamoru#127: how often a bucket waited for depth, and how much savings sat idle at each review.
      if (d.waiting?.some((w) => w.code === 'DECIDE_WAIT_DEPTH')) depthWaits++
      const idleNow = w.balances[savings] ?? 0n
      const totalNow = accountValue(ds, s, w, price).total
      if (totalNow > 0n) {
        idleSum += Number((idleNow * 10_000n) / totalNow)
        idleSamples++
      }
      const p: Proposal | null = d.proposal
      // Sessions are renewed every `validitySeconds`, and with `usageRefresh` also once the app offers it for usage;
      // inside one window a grant has `usageLimit` uses and each cumulative rule its cap.
      if (refreshAt !== null && s.time >= refreshAt) {
        openWindow(s, s.time)
        usageRefreshes++
      } else if (renewal === 'renewed' && s.time - winStart >= policy.session.validitySeconds) {
        let at = winStart
        while (s.time - at >= policy.session.validitySeconds) at += policy.session.validitySeconds
        openWindow(s, at)
      }
      const t = p ? templateOf(policy, p.grant) : undefined
      const limit = t ? usageLimitFor(t, capUsdc) : null
      const used = p ? (usedIn.get(p.grant) ?? 0) : 0
      const spend = p && t ? cumulativeSpend(t, p) : []
      const overCap = spend.some(([k, cap, v]) => (spentIn.get(`${p!.grant}|${k}`) ?? 0n) + v > (caps[cap] ?? 0n))
      if (p && renewal === 'once' && s.time - first.time >= policy.session.validitySeconds) {
        refused++
        reasons.SESSION_EXPIRED = (reasons.SESSION_EXPIRED ?? 0) + 1
      } else if (p && enforce && limit !== null && used >= limit) {
        refused++
        reasons.SESSION_USAGE_SPENT = (reasons.SESSION_USAGE_SPENT ?? 0) + 1
      } else if (p && enforce && overCap) {
        refused++
        reasons.POLICY_DENIED_CUMULATIVE = (reasons.POLICY_DENIED_CUMULATIVE ?? 0) + 1
      } else if (p) {
        const ps = s.pools[ds.pools.indexOf(p.pool)] as PoolSample
        const done = apply(w, p, ps, s.time, policy.execution.slippageBps)
        const e = entry(p.pool)
        const cost = done.ok ? gasCost(ds, s, p.kind, gas, savings) : 0n
        ops.push({
          i, block: s.block, time: s.time, kind: p.kind, pool: p.pool, grant: p.grant, code: d.code, reason: d.reason, trail: d.trail, ok: done.ok,
          ...(done.ok ? { spend: budgetSpend(p, e) } : { detail: done.detail }),
          gasCost: cost,
          feesValue: done.ok ? price(s, e.token0!, done.fees0) + price(s, e.token1!, done.fees1) : 0n,
        })
        if (done.ok) {
          gasSpent += cost
          count[p.kind]++
          const n = used + 1
          usedIn.set(p.grant, n)
          const g = tally.get(p.grant) ?? { uses: 0, peak: 0, peakSpentBps: null }
          g.uses++
          g.peak = Math.max(g.peak, n)
          for (const [k, cap, v] of spend) {
            const key = `${p.grant}|${k}`
            const total = (spentIn.get(key) ?? 0n) + v
            spentIn.set(key, total)
            const c = caps[cap] ?? 0n
            g.peakSpentBps = Math.max(g.peakSpentBps ?? 0, c === 0n ? Number.MAX_SAFE_INTEGER : Number((total * 10_000n) / c))
          }
          tally.set(p.grant, g)
          // The app offers the renewal once a grant has used `atBps` of its limit or of a cumulative cap, as the operator
          // does (usageView); the owner taps `delaySeconds` later.
          const nearCap = spend.some(([k, cap]) => (caps[cap] ?? 0n) > 0n && (spentIn.get(`${p.grant}|${k}`) ?? 0n) * 10_000n >= (caps[cap] ?? 0n) * BigInt(refresh?.atBps ?? 10_000))
          if (refresh && refreshAt === null && ((limit !== null && n * 10_000 >= limit * refresh.atBps) || nearCap)) refreshAt = s.time + refresh.delaySeconds
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
  const sessions = sessionUses(policy, tally, capUsdc)
  const pHash = policyHash(policy)
  const facts = { simVersion: SIM_VERSION, datasetId: ds.id, policyHash: pHash, from, to, every, gaps, enforce, renewal, refused, deposit: config.deposit, topUps, gas, end, hodlEnd, fees, gasSpent, ops: ops.map(({ trail: _t, ...o }) => o), reasons, sessions, ...(config.capUsdc === undefined ? {} : { capUsdc }), ...(refresh ? { refresh, usageRefreshes } : {}) }
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
    usageRefreshes,
    metrics,
    capacity: { depthWaits, idleBps: idleSamples === 0 ? 0 : Math.round(idleSum / idleSamples) },
    resultHash: keccak256(stringToHex(canonicalJson(facts))) as Hex,
  }
}
