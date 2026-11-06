// Stats history backfill (spec 013 amendment A1). Read-only on the chain and on D1: it writes one SQL file the
// coordinator applies after the migrations (INSERT OR IGNORE: rows the live cron already wrote are never touched).
//
//   bun apps/mamoru-operator/scripts/stats-backfill.ts --out backfill.sql [--monad-from 2026-11-01] [--vault-from 2026-10-18]
//
// It reads every account's Safe at each UTC day's close block (archive reads, the operator's own snapshot reader, the
// same method as scripts/stats-figures.ts) and produces:
// - account_daily rows for chain 143 (Monad sleeves) from --monad-from to yesterday: the day's close (total, idle, LP,
//   accrued fees) and its open (the previous close); collected fees and gas come from D1's receipts at apply time.
// - stats_vault_daily rows for every chain from --vault-from to yesterday: shares held at the close × the share-price
//   change over the day, the vault yield the income ledger did not exist yet to record.
// Today is left to the live cron. RPCs: BASE_RPC_URL and MAMORU_MONAD_RPC_URL from the environment (never printed).

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPublicClient, http, type PublicClient } from 'viem'
import type { Address } from '@mamoru/domain'
import { address, baseRegistry, entry, erc4626Abi, monadRegistry, type Registry } from '@mamoru/registry'
import { multicall3Of } from '@mamoru/rpc'
import { usdcVaults } from '../src/chain.ts'
import { readSnapshot, type Snapshot } from '../src/snapshot.ts'

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const OUT = arg('--out')
if (!OUT) throw new Error('--out <file.sql> is required')
const MONAD_FROM = arg('--monad-from') ?? '2026-11-01'
const VAULT_FROM = arg('--vault-from') ?? '2026-10-18'
const DAY = 86_400

// ---- D1, read-only ----
const appDir = join(import.meta.dir, '../../mamoru-app')
function d1<T>(sql: string): T[] {
  const r = spawnSync('bunx', ['wrangler', 'd1', 'execute', 'mamoru', '--remote', '--json', '--command', sql], { cwd: appDir, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status !== 0) throw new Error(`d1: ${r.stderr.slice(0, 300)}`)
  return JSON.parse(r.stdout)[0].results as T[]
}
type AccountRow = { account_key: string; chain_id: number; address: string; env: string }
const accounts = d1<AccountRow>(`SELECT account_key, chain_id, address, env FROM accounts WHERE env IN ('prod','beta') AND COALESCE(is_test,0) = 0 AND address IS NOT NULL`)

// ---- chains ----
type Chain = { name: string; id: number; registry: Registry; client: PublicClient; mc3: Address; rows: AccountRow[] }
function chainOf(name: string, registry: Registry, url: string | undefined): Chain {
  if (!url) throw new Error(`no RPC for ${name}`)
  const mc3 = multicall3Of(registry)
  if (!mc3) throw new Error(`no Multicall3 for ${name}`)
  return { name, id: registry.chainId, registry, client: createPublicClient({ transport: http(url, { batch: true, timeout: 60_000, retryCount: 6, retryDelay: 800 }) }), mc3, rows: accounts.filter((a) => a.chain_id === registry.chainId) }
}
const chains = [chainOf('Base', baseRegistry, process.env.BASE_RPC_URL), chainOf('Monad', monadRegistry, process.env.MAMORU_MONAD_RPC_URL)]

/** The last block with timestamp <= t (interpolation, then bisection). */
async function blockAt(c: Chain, t: number): Promise<bigint> {
  const head = await c.client.getBlock()
  if (Number(head.timestamp) <= t) return head.number
  let lo = { n: 1n, t: Number((await c.client.getBlock({ blockNumber: 1n })).timestamp) }
  let hi = { n: head.number, t: Number(head.timestamp) }
  for (let i = 0; i < 60 && hi.n - lo.n > 1n; i++) {
    let mid = i < 8 ? lo.n + BigInt(Math.floor(Number(hi.n - lo.n) * ((t - lo.t) / (hi.t - lo.t)))) : (lo.n + hi.n) / 2n
    if (mid <= lo.n) mid = lo.n + 1n
    if (mid >= hi.n) mid = hi.n - 1n
    const mt = Number((await c.client.getBlock({ blockNumber: mid })).timestamp)
    if (mt <= t) lo = { n: mid, t: mt }
    else hi = { n: mid, t: mt }
  }
  return lo.n
}

/** readSnapshot pins to the latest block; for history every call is made at `block`. */
function pinned(client: PublicClient, block: bigint): PublicClient {
  return new Proxy(client, {
    get(target, prop, recv) {
      if (prop === 'getBlockNumber') return async () => block
      if (prop === 'getBlock') return async (a?: { blockNumber?: bigint }) => target.getBlock({ blockNumber: a?.blockNumber ?? block })
      return Reflect.get(target, prop, recv)
    },
  }) as PublicClient
}

async function readAt(c: Chain, block: bigint): Promise<{ snap: Snapshot; pps: Record<string, number> }> {
  const targets = c.rows.map((a) => ({ accountKey: a.account_key, safe: a.address as Address, active: true, armed: false, vaults: true }))
  const snap = await readSnapshot(pinned(c.client, block), c.mc3, c.id, c.registry, targets)
  const pps: Record<string, number> = {}
  for (const v of usdcVaults(c.registry)) {
    try {
      const one = 10n ** BigInt(entry(v, c.registry).decimals ?? 18)
      const assets = await c.client.readContract({ address: address(v, c.registry), abi: erc4626Abi, functionName: 'convertToAssets', args: [one], blockNumber: block })
      pps[v] = Number(assets) / Number(one)
    } catch {
      // not deployed at that block
    }
  }
  return { snap, pps }
}

const isoDay = (t: number) => new Date(t * 1000).toISOString().slice(0, 10)
const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`
const today0 = Math.floor(Date.now() / 1000 / DAY) * DAY
const lines: string[] = [
  `-- Stats backfill (spec 013 A1), generated ${new Date().toISOString()} by apps/mamoru-operator/scripts/stats-backfill.ts.`,
  '-- Apply after the migrations 0027_stats_vault_daily.sql and the A1 ones. Idempotent: INSERT OR IGNORE only.',
]
const counts = { daily: 0, vault: 0, failedDays: 0 }

for (const c of chains) {
  if (!c.rows.length) continue
  const from = c.id === monadRegistry.chainId ? MONAD_FROM : VAULT_FROM
  const fromT = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000)
  let prev: { snap: Snapshot; pps: Record<string, number>; block: bigint } | null = null
  // Close of day d = the start of d + 1. The first read is the open of the first day.
  for (let t = fromT; t <= today0; t += DAY) {
    let cur: { snap: Snapshot; pps: Record<string, number>; block: bigint } | null = null
    try {
      const block = await blockAt(c, t)
      cur = { ...(await readAt(c, block)), block }
    } catch (e) {
      console.error(`${c.name} ${isoDay(t)}: read failed: ${(e as Error).message.slice(0, 160)}`)
    }
    if (prev && cur) {
      const d = isoDay(t - DAY)
      const before = new Map(prev.snap.safes.map((s) => [s.safe.toLowerCase(), s]))
      for (const s of cur.snap.safes) {
        const row = c.rows.find((a) => a.address.toLowerCase() === s.safe.toLowerCase())!
        const open = before.get(s.safe.toLowerCase())
        // Every sleeve gets a row, funded or not: Stats needs Monad known on every day from its first account on.
        if (c.id === monadRegistry.chainId && d >= MONAD_FROM) {
          const addr = s.safe.toLowerCase()
          lines.push(
            `INSERT OR IGNORE INTO account_daily (day, chain_id, address, account_key, env, block_open, block_close, total_open_usdc, total_close_usdc, idle_close_usdc, lp_close_usdc, fees_open_usdc, fees_close_usdc, collected_usdc, gas_paid_wei) VALUES (` +
              [sqlStr(d), c.id, sqlStr(addr), sqlStr(row.account_key), sqlStr(row.env), prev.block, cur.block, open?.totalUsdc ?? 0n, s.totalUsdc, s.idleUsdc, s.lpUsdc, open?.feesUsdc ?? 0n, s.feesUsdc].join(', ') +
              `, (SELECT r.collected_usdc FROM yield_ledger_account_receipts r WHERE r.day = ${sqlStr(d)} AND r.chain_id = ${c.id} AND r.address = ${sqlStr(addr)}), (SELECT r.gas_paid_wei FROM yield_ledger_account_receipts r WHERE r.day = ${sqlStr(d)} AND r.chain_id = ${c.id} AND r.address = ${sqlStr(addr)}));`,
          )
          counts.daily++
        }
        let vy = 0
        for (const v of s.vaults ?? []) {
          const p1 = cur.pps[v.name]
          const p0 = prev.pps[v.name]
          if (p1 && p0) vy += Number(v.shares) * (p1 - p0)
        }
        if (s.vaults?.length) {
          lines.push(`INSERT OR IGNORE INTO stats_vault_daily (day, chain_id, account_key, usd) VALUES (${sqlStr(d)}, ${c.id}, ${sqlStr(row.account_key)}, ${Math.round(vy)});`)
          counts.vault++
        }
      }
    } else if (prev && !cur) {
      counts.failedDays++
    }
    prev = cur
  }
}

writeFileSync(OUT, lines.join('\n') + '\n')
console.log(JSON.stringify({ out: OUT, ...counts }))
if (counts.failedDays) process.exitCode = 1
