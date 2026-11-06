// Stats figures from the chain (spec 013 amendment A1, task A1-D4). Read-only: nothing is sent.
// The account list comes from D1 (prod and beta, not test); every number comes from the chain, read with the
// operator's own snapshot reader at pinned blocks on Base and Monad. Daily figures re-read the chain at each day's
// close block (archive reads). Only aggregates are printed.
//
//   bun apps/mamoru-operator/scripts/stats-figures.ts [--from 2026-10-18] [--json out.json]
// RPCs: BASE_RPC_URL and MAMORU_MONAD_RPC_URL from the environment (never printed).

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, entry, erc4626Abi, monadRegistry, type Registry } from '@mamoru/registry'
import { multicall3Of } from '@mamoru/rpc'
import { inUsdc, usdcPools, usdcVaults } from '../src/chain.ts'
import { readSnapshot, type Snapshot } from '../src/snapshot.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const FROM = arg('--from') ?? '2026-10-18'
const OUT = arg('--json')
const USD_STABLES = new Set(['USDC', 'USDT'])
const K = 3

// ---- D1 (read-only) ----
const appDir = join(import.meta.dir, '../../mamoru-app')
function d1<T>(sql: string): T[] {
  const r = spawnSync('bunx', ['wrangler', 'd1', 'execute', 'mamoru', '--remote', '--json', '--command', sql], { cwd: appDir, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error(`d1: ${r.stderr.slice(0, 300)}`)
  return JSON.parse(r.stdout)[0].results as T[]
}
type AccountRow = { account_key: string; chain_id: number; address: string; env: string; created_at: string }
const accountRows = d1<AccountRow>(`SELECT account_key, chain_id, address, env, created_at FROM accounts WHERE env IN ('prod','beta') AND COALESCE(is_test,0) = 0 AND address IS NOT NULL`)
type ReceiptRow = { day: string; chain_id: number; account_key: string; collected_usdc: number | null }
const receipts = d1<ReceiptRow>(`SELECT r.day, r.chain_id, r.account_key, r.collected_usdc FROM yield_ledger_account_receipts r WHERE r.env IN ('prod','beta')`)
const latest = d1<{ chain_id: number; account_key: string; total_usdc: number; read_at: string }>(`SELECT chain_id, account_key, total_usdc, read_at FROM account_snapshot_latest WHERE env IN ('prod','beta')`)

// ---- chains ----
type Chain = { name: string; id: number; registry: Registry; client: PublicClient; mc3: Address; safes: { accountKey: string; safe: Address }[] }
function chainOf(name: string, registry: Registry, url: string | undefined): Chain {
  if (!url) throw new Error(`no RPC for ${name}`)
  const mc3 = multicall3Of(registry)
  if (!mc3) throw new Error(`no Multicall3 for ${name}`)
  const safes = accountRows.filter((a) => a.chain_id === registry.chainId).map((a) => ({ accountKey: a.account_key, safe: a.address as Address }))
  return { name, id: registry.chainId, registry, client: createPublicClient({ transport: http(url, { batch: true, timeout: 60_000, retryCount: 6, retryDelay: 800 }) }), mc3, safes }
}
const chains = [chainOf('Base', baseRegistry, process.env.BASE_RPC_URL), chainOf('Monad', monadRegistry, process.env.MAMORU_MONAD_RPC_URL)]

async function blockAt(c: Chain, t: number): Promise<bigint> {
  // Last block with timestamp <= t, by interpolation then a short walk.
  const head = await c.client.getBlock()
  if (Number(head.timestamp) <= t) return head.number
  let lo = { n: 1n, t: Number((await c.client.getBlock({ blockNumber: 1n })).timestamp) }
  let hi = { n: head.number, t: Number(head.timestamp) }
  for (let i = 0; i < 40 && hi.n - lo.n > 1n; i++) {
    const frac = (t - lo.t) / (hi.t - lo.t)
    let mid = lo.n + BigInt(Math.floor(Number(hi.n - lo.n) * frac))
    if (mid <= lo.n) mid = lo.n + 1n
    if (mid >= hi.n) mid = hi.n - 1n
    const mt = Number((await c.client.getBlock({ blockNumber: mid })).timestamp)
    if (mt <= t) lo = { n: mid, t: mt }
    else hi = { n: mid, t: mt }
    if (i > 6) {
      // switch to bisection once interpolation has narrowed the range
      const m2 = (lo.n + hi.n) / 2n
      const t2 = Number((await c.client.getBlock({ blockNumber: m2 })).timestamp)
      if (t2 <= t) lo = { n: m2, t: t2 }
      else hi = { n: m2, t: t2 }
    }
  }
  return lo.n
}

async function snap(c: Chain, block: bigint | null): Promise<Snapshot | null> {
  if (!c.safes.length) return null
  const targets = c.safes.map((s) => ({ accountKey: s.accountKey, safe: s.safe, active: true, armed: false, vaults: true }))
  // readSnapshot pins to the latest block; for history, wrap the client so every call is at `block`.
  const client = block === null ? c.client : pinned(c.client, block)
  return readSnapshot(client, c.mc3, c.id, c.registry, targets)
}

function pinned(client: PublicClient, block: bigint): PublicClient {
  return new Proxy(client, {
    get(target, prop, recv) {
      if (prop === 'getBlockNumber') return async () => block
      if (prop === 'getBlock') return async (a?: { blockNumber?: bigint }) => target.getBlock({ blockNumber: a?.blockNumber ?? block })
      return Reflect.get(target, prop, recv)
    },
  }) as PublicClient
}

// ---- prices ----
function priceTable(s: Snapshot, registry: Registry): (token: string, amount: bigint) => bigint {
  return (token, amount) => {
    if (token === 'USDC' || amount === 0n) return amount
    const pool = usdcPools(registry).find((p) => (entry(p, registry).token0 === token || entry(p, registry).token1 === token) && s.pools[p])
    if (!pool) throw new Error(`no USDC pool prices ${token} on ${registry.chain}`)
    return inUsdc(pool, token, amount, s.pools[pool]!.sqrtPriceX96, registry)
  }
}

const usd = (raw: bigint | number) => Number(raw) / 1e6
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)

// ---- now ----
type Acc = { total: number; working: number; idle: number; fees: number; chains: Set<string> }
const now = Math.floor(Date.now() / 1000)
const nowSnaps = new Map<string, Snapshot | null>()
for (const c of chains) nowSnaps.set(c.name, await snap(c, null))

const perAccount = new Map<string, Acc>()
const byToken = new Map<string, { usd: number; owners: Set<string> }>()
const byChain = new Map<string, { usd: number; owners: Set<string> }>()
const byPlace = new Map<string, { usd: number; owners: Set<string> }>()
const add = (m: Map<string, { usd: number; owners: Set<string> }>, k: string, v: number, owner: string) => {
  if (v <= 0) return
  const e = m.get(k) ?? { usd: 0, owners: new Set() }
  e.usd += v
  e.owners.add(owner)
  m.set(k, e)
}
let stablesUsd = 0
for (const c of chains) {
  const s = nowSnaps.get(c.name)
  if (!s) continue
  const price = priceTable(s, c.registry)
  for (const safe of s.safes) {
    const a = perAccount.get(safe.accountKey) ?? { total: 0, working: 0, idle: 0, fees: 0, chains: new Set() }
    const vault = usd(safe.vaultUsdc ?? 0n)
    a.total += usd(safe.totalUsdc)
    a.working += usd(safe.lpUsdc) + vault
    a.idle += usd(safe.idleUsdc)
    a.fees += usd(safe.feesUsdc + safe.owedUsdc)
    if (safe.totalUsdc > 0n) a.chains.add(c.name)
    perAccount.set(safe.accountKey, a)
    add(byChain, c.name, usd(safe.totalUsdc), safe.accountKey)
    // tokens: idle balances
    for (const [tok, amt] of Object.entries(safe.tokens)) {
      const v = usd(price(tok, amt))
      add(byToken, tok, v, safe.accountKey)
      if (USD_STABLES.has(tok)) stablesUsd += v
    }
    add(byPlace, 'Idle', usd(safe.idleUsdc), safe.accountKey)
    // vaults hold USDC
    add(byToken, 'USDC', vault, safe.accountKey)
    stablesUsd += vault
    add(byPlace, 'Stable vaults', vault, safe.accountKey)
    for (const p of safe.positions) {
      const e = entry(p.pool, c.registry)
      const t0 = e.token0!, t1 = e.token1!
      const leg0 = usd(price(t0, p.amount0 + p.collectable0))
      const leg1 = usd(price(t1, p.amount1 + p.collectable1))
      add(byToken, t0, leg0, safe.accountKey)
      add(byToken, t1, leg1, safe.accountKey)
      if (USD_STABLES.has(t0)) stablesUsd += leg0
      if (USD_STABLES.has(t1)) stablesUsd += leg1
      const stablePair = USD_STABLES.has(t0) && USD_STABLES.has(t1)
      add(byPlace, stablePair ? 'Stable pairs' : 'Volatile pairs', leg0 + leg1, safe.accountKey)
    }
  }
}

const accounts = [...perAccount.entries()]
const funded = accounts.filter(([, a]) => a.total > 1)
const S1 = accounts.reduce((n, [, a]) => n + a.total, 0)
const S2 = accounts.reduce((n, [, a]) => n + a.working, 0)
const S3 = accounts.reduce((n, [, a]) => n + a.idle, 0)
const uncollected = accounts.reduce((n, [, a]) => n + a.fees, 0)
const S7 = new Set(accountRows.map((a) => a.account_key)).size
const S7prod = new Set(accountRows.filter((a) => a.env === 'prod').map((a) => a.account_key)).size
const S8 = funded.length >= K ? S1 / funded.length : null
const S9 = funded.length >= K ? Math.max(...funded.map(([, a]) => a.total)) : null
const S10 = S1 > 0 ? stablesUsd / S1 : null

function guardSplit(m: Map<string, { usd: number; owners: Set<string> }>) {
  // k-anonymity by aggregation: every slice backed by < K accounts goes into "Other"; if "Other" is then backed by
  // < K accounts, the next smallest slice joins it, until it reaches K or the split cannot be shown at all.
  const rows = [...m.entries()].map(([k, v]) => ({ k, usd: v.usd, owners: v.owners })).sort((a, b) => b.usd - a.usd)
  const shown = rows.filter((r) => r.owners.size >= K)
  const merged = rows.filter((r) => r.owners.size < K)
  const ownersOf = (rs: typeof rows) => new Set(rs.flatMap((r) => [...r.owners])).size
  while (merged.length && ownersOf(merged) < K && shown.length) merged.push(shown.pop()!)
  if (merged.length && ownersOf(merged) < K) return { rows: null, reason: 'not enough accounts behind the split' }
  const out = shown.map((r) => ({ k: r.k, usd: r.usd, pct: r.usd / S1, owners: r.owners.size >= 10 ? '10+' : String(r.owners.size) }))
  if (merged.length) out.push({ k: merged.length === 1 ? merged[0]!.k : 'Other', usd: merged.reduce((n, r) => n + r.usd, 0), pct: merged.reduce((n, r) => n + r.usd, 0) / S1, owners: String(ownersOf(merged)) })
  return { rows: out, merged: merged.map((r) => r.k), reason: null }
}

// ---- history: one snapshot per chain per day close ----
const fromT = Math.floor(Date.parse(`${FROM}T00:00:00Z`) / 1000)
const closes: number[] = []
for (let t = fromT; t < now; t += 86400) closes.push(t)
closes.push(now)
const collectedBy = new Map<string, number>() // `${chain}|${day}` -> usd
for (const r of receipts) {
  const k = `${r.chain_id}|${r.day}`
  collectedBy.set(k, (collectedBy.get(k) ?? 0) + usd(r.collected_usdc ?? 0))
}
type DayChain = { day: string; chain: string; tvl: number; working: number; earned: number; fees: number; vaultYield: number; collected: number; complete: boolean }
const series: DayChain[] = []
const vaultPps = async (c: Chain, block: bigint): Promise<Record<string, number>> => {
  const out: Record<string, number> = {}
  for (const v of usdcVaults(c.registry)) {
    try {
      const one = 10n ** BigInt(entry(v, c.registry).decimals ?? 18)
      const assets = await c.client.readContract({ address: address(v, c.registry), abi: erc4626Abi, functionName: 'convertToAssets', args: [one], blockNumber: block })
      out[v] = Number(assets) / Number(one) // raw USDC per raw share
    } catch {
      /* vault not deployed at that block */
    }
  }
  return out
}
for (const c of chains) {
  let prev: { snap: Snapshot | null; pps: Record<string, number> } | null = null
  for (let i = 0; i < closes.length; i++) {
    const t = closes[i]!
    let block: bigint
    let s: Snapshot | null = null
    let pps: Record<string, number> = {}
    let ok = true
    try {
      block = await blockAt(c, t)
      s = await snap(c, block)
      pps = await vaultPps(c, block)
    } catch (e) {
      ok = false
      console.error(`${c.name} ${day(t)}: read failed: ${(e as Error).message.slice(0, 120)}`)
    }
    if (prev && i > 0) {
      const d = day(closes[i - 1]!)
      const tvl = s ? s.safes.reduce((n, x) => n + usd(x.totalUsdc), 0) : NaN
      const workClose = s ? s.safes.reduce((n, x) => n + usd(x.lpUsdc + (x.vaultUsdc ?? 0n)), 0) : NaN
      const workOpen = prev.snap ? prev.snap.safes.reduce((n, x) => n + usd(x.lpUsdc + (x.vaultUsdc ?? 0n)), 0) : 0
      // fees: accrued (since checkpoint) per position, close - open, plus fees collected that day
      const acc = (sn: Snapshot | null) => {
        const m = new Map<string, number>()
        for (const x of sn?.safes ?? []) for (const p of x.positions) m.set(p.tokenId.toString(), usd(p.feesUsdc))
        return m
      }
      const a1 = acc(s), a0 = acc(prev.snap)
      let dFees = 0
      for (const [id, v] of a1) dFees += v - (a0.get(id) ?? 0)
      for (const [id, v] of a0) if (!a1.has(id)) dFees -= v
      const collected = collectedBy.get(`${c.id}|${d}`) ?? 0
      // vault yield: shares held at close x pps change over the day
      let vy = 0
      for (const x of s?.safes ?? []) for (const v of x.vaults ?? []) {
        const p1 = pps[v.name], p0 = prev.pps[v.name]
        if (p1 && p0) vy += (Number(v.shares) * (p1 - p0)) / 1e6
      }
      const fees = dFees + collected
      if (!ok) console.error(`${c.name} ${d}: incomplete day`)
      series.push({ day: d, chain: c.name, tvl, working: (workOpen + workClose) / 2, earned: fees + vy, fees, vaultYield: vy, collected, complete: ok })
    }
    prev = { snap: s, pps }
  }
}

// ---- earned now (24 h, total) ----
// Window (now - 24 h, now]: accrued change per position between a read 24 h ago and now, plus fees collected in the
// window (receipts are per UTC day: today's in full, yesterday's prorated by the hours of yesterday in the window),
// plus vault yield = shares now x share-price change. Every token valued in USD at the read's pool price.
const earned24: Record<string, { fees: number; collected: number; vaultYield: number }> = {}
const fracYesterday = 1 - (now % 86400) / 86400
for (const c of chains) {
  const s1 = nowSnaps.get(c.name)
  if (!s1) continue
  const b0 = await blockAt(c, now - 86400)
  const s0 = await snap(c, b0)
  const accOf = (sn: Snapshot | null) => new Map((sn?.safes ?? []).flatMap((x) => x.positions.map((p) => [p.tokenId.toString(), usd(p.feesUsdc)] as const)))
  const a1 = accOf(s1), a0 = accOf(s0)
  let f = 0
  for (const [id, v] of a1) f += v - (a0.get(id) ?? 0)
  for (const [id, v] of a0) if (!a1.has(id)) f -= v
  const col = (collectedBy.get(`${c.id}|${day(now)}`) ?? 0) + fracYesterday * (collectedBy.get(`${c.id}|${day(now - 86400)}`) ?? 0)
  const p1 = await vaultPps(c, s1.block), p0 = await vaultPps(c, b0)
  let vy = 0
  for (const x of s1.safes) for (const v of x.vaults ?? []) if (p1[v.name] && p0[v.name]) vy += (Number(v.shares) * (p1[v.name]! - p0[v.name]!)) / 1e6
  earned24[c.name] = { fees: f, collected: col, vaultYield: vy }
}
const S4 = Object.values(earned24).reduce((n, e) => n + e.fees + e.collected + e.vaultYield, 0)
const collectedAll = [...collectedBy.values()].reduce((n, v) => n + v, 0)
const vaultYieldAll = series.reduce((n, r) => n + r.vaultYield, 0)
const S5 = collectedAll + uncollected + vaultYieldAll

// ---- APR ----
const days = [...new Set(series.map((r) => r.day))].sort()
const aprOf = (rows: DayChain[]) => {
  const e = rows.reduce((n, r) => n + r.earned, 0)
  const w = rows.reduce((n, r) => n + r.working, 0)
  return w > 0 ? (e / w) * 365 : null
}
const apr = days.map((d) => {
  const rows = series.filter((r) => r.day === d)
  const win = series.filter((r) => r.day <= d && r.day > days[Math.max(0, days.indexOf(d) - 7)]!)
  return {
    day: d,
    all: aprOf(rows),
    base: aprOf(rows.filter((r) => r.chain === 'Base')),
    monad: aprOf(rows.filter((r) => r.chain === 'Monad')),
    all7: aprOf(win),
    base7: aprOf(win.filter((r) => r.chain === 'Base')),
    monad7: aprOf(win.filter((r) => r.chain === 'Monad')),
    earned: rows.reduce((n, r) => n + r.earned, 0),
    collected: rows.reduce((n, r) => n + r.collected, 0),
    tvl: rows.reduce((n, r) => n + r.tvl, 0),
  }
})
const S6 = apr.at(-1)?.all7 ?? null

// ---- D1 vs chain ----
const d1Total = latest.reduce((n, r) => n + usd(r.total_usdc), 0)

const result = {
  readAt: new Date(now * 1000).toISOString(),
  blocks: Object.fromEntries([...nowSnaps].map(([k, s]) => [k, s?.block.toString() ?? null])),
  S1_totalDeposits: S1,
  S2_moneyWorking: S2,
  S3_idleCapital: S3,
  uncollectedFees: uncollected,
  S4_earned24h: S4,
  S4_parts: earned24,
  S5_totalEarned: S5,
  S5_parts: { collected: collectedAll, uncollected, vaultYieldSince: FROM, vaultYield: vaultYieldAll },
  S6_apr7d: S6,
  S7_totalAccounts: S7,
  S7_prodOnly: S7prod,
  fundedAccounts: funded.length,
  S8_averageAccount: S8,
  S9_largestAccount: S9,
  S10_inStables: S10,
  D1_byToken: guardSplit(byToken),
  D2_byChain: guardSplit(byChain),
  D3_byPlace: guardSplit(byPlace),
  T_daily: apr,
  check_D1_snapshotLatest: { d1Total, chainTotal: S1, diff: S1 - d1Total, d1Chains: [...new Set(latest.map((r) => r.chain_id))] },
}
console.log(JSON.stringify(result, (_, v) => (typeof v === 'number' ? Math.round(v * 1e4) / 1e4 : v), 2))
if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2))
