# 013 plan: how Stats is built

Spec: `spec.md`. Tasks: `tasks.md`. Design gate: `design.md`.

## 1. Shape

```
operator (Base, Monad)  --GET /snapshot (signed)-->  app Worker cron (*/10)  -->  D1
                                                                                  |
browser /stats  --GET /api/stats (public, cached 5 min, rate-limited)-->  Worker reads D1 aggregates only
browser /       --existing session APIs--> Portfolio (+ GET /api/accounts/:key/value-series)
```

Nothing new runs on a request except D1 reads. The operator is touched only to add one fact to its op receipts
(volume, §4). No contract changes. Landing untouched.

## 2. Routes (SPA, `apps/mamoru-app/src/web/`)

- `router.tsx`: add `createRoute({ path: '/stats', component: lazyRouteComponent(() => import('./stats/page.tsx'), 'StatsPage') })`.
  Lazy: the chart code does not weigh on `/`. The SPA fallback (`wrangler.jsonc` `not_found_handling:
  single-page-application`) already serves `/stats`; `run_worker_first` stays `/api/*`, `/hooks/*`.
- `routes/root.tsx`: the menu (component `components/app-nav.tsx`) above `<Outlet />`, visible on every route. It reads
  `useSession()` only to mark the active state; it never triggers a passkey prompt.
- `routes/index.tsx`: unchanged logic (Portfolio with session, cards without). Portfolio pieces live in `home.tsx`
  (96 KB, hot for UI: one Portfolio unit at a time).

## 3. Data

### 3.1 Monad into `account_daily` (Day0-Monad)

Today `runYieldLedger` (`src/worker.ts:17`) writes `account_snapshot_latest` and `account_daily` for Base only;
for Monad (`operatorUrlFor(env, 143)`) it calls `pullWorkedSamples`, which writes worked samples and receipts, not the
daily totals. Monad sleeves are rows of `accounts` with `chain_id = 143` (0017, `sleeves.ts`), so `resolveAccount`
already maps a Monad Safe to its sleeve's `account_key`.

Change: `pullWorkedSamples` (`yield-ledger.ts:410`) also calls `writeAccountSnapshot(db, snapshot, now)`.
Before merging, check that `writeAccountSnapshot` has no Base-only assumption (the comment at `:405` says "the account
snapshot is Base-bound": read why; if it is the registry used to value positions, the Monad snapshot already carries
`valueUsdc` per position and `vaults[].valueUsdc`, so it should hold). Day0-Monad = the first `day` with
`chain_id = 143` rows. No backfill from `account_worked_samples` (31-day retention, no idle when positions exist:
it would be wrong; XX).

### 3.2 Earned

One definition, one module: spec 012's `apps/mamoru-app/src/api/earned.ts` (012 plan "R5, R9: event ledger"), used by
Portfolio and by `/api/stats`. Stats only sums it over accounts and applies the privacy guard; it defines nothing.

- **One cutoff T for every headline:** T = the oldest of the latest fee samples of the accounts that contribute (each
  account's latest sample is fresh within the stale rule of §3.6, older ones are `partial`). All figures are "as of T".
- Total earned = Σ `yield_ledger_income.usd` with `t_s ≤ T` (all sources, incl. `backfill`) + accrued at T. A Collect
  after T is not yet counted (its fees are still in the accrued level at T): no double count.
- **Earned 24h, rolling**, one window for all accounts, (T − 24h, T]:
  Σ income with `T − 24h < t_s ≤ T` and `source ≠ 'backfill'` (Collect events at block time, vault-yield rows at
  sample time) + (accrued at T − accrued at T − 24h). A Collect after T is left for the next sample, so fees are never
  counted both as accrued and as collected. **Approximate by decision** (Ot and Brais, 6 Nov 17:16Z): vault yield
  comes from share-value samples, and the (i) does not promise an exact figure.
- Accrued at a time = the nearest `account_worked_samples` row at or before it; needs
  `ALTER TABLE account_worked_samples ADD COLUMN fees_usd INTEGER` (per pool row, from the snapshot's
  `positions[].feesUsdc`; null for vault and idle rows; 31-day retention is enough). Owned by B5.
- Any `usd = null`, `explained = 0` or missing sample in the window → `partial`, with the parts not counted.
- Vault yield missing: "not counted" is a beta-only state (spec R18).

### 3.3 Per-op ledger: collected, placed, time

The operator already reads every engine op's receipt once (`apps/mamoru-operator/src/yield-receipts.ts`, facts frozen
on the stored op) and serves per-day totals on `/snapshot`. 012 HT6 extends these facts; this task stacks on it.
Add:

- `OpFacts.placed?: { pool: string; amount0: string; amount1: string }[]` from NonfungiblePositionManager
  `IncreaseLiquidity(tokenId, liquidity, amount0, amount1)` events of this Safe's userOp (mint and increase), and
  `vaultDeposits?: { vault: string; assets: string }[]` from ERC-4626 `Deposit(sender, owner, assets, shares)` with
  `owner` = the Safe.
- **Priced at the op's block:** the USDC leg is exact from the event amounts; the volatile leg at the pool's `slot0`
  read with `eth_call` at the op's `blockNumber`, then frozen. A read that fails (no archive state for an old block)
  leaves the op unpriced: never a later price.
- Wire: `receipts[].ops?: { id, at, placedUsdc?, priced: boolean }[]` for ops of the last 35 days.
- Worker: migration `migrations/d1/XXXX_ledger_ops.sql` creates
  `yield_ledger_ops (chain_id, account_key, env, op_id, at, placed_usdc INTEGER, priced INTEGER,
  updated_at, PRIMARY KEY (chain_id, op_id))` (volume only; collected fees live in 012's `yield_ledger_income`) and the `fees_usd` column of §3.2. `writeReceipts` upserts ops.
- Volume(day) = Σ `placed_usdc` of ops whose `at` falls in the day; **one unpriced op makes the day `partial` with
  value null**, never a short sum.
- Backfill: facts carry `v: 2`; a stored op with older facts and a txHash is re-read once through the
  `FACTS_PER_TICK` queue. Ops older than the wire window are written by the first pulls after deploy, oldest first.

### 3.4 Owners and the k ≥ 3 guard

Every published figure is computed with its owner count: `COUNT(DISTINCT a.user_id)` joining `accounts a ON
a.account_key = x.account_key`. `stats/privacy.ts` (pure, unit-tested) runs over the whole `StatsView` before it is
cached: series points, `tvlNow`, `earned24h`, `earnedTotal`, `fundedAccounts` and each per-chain split. Anything
with < 3 owners becomes `null` with `TOO_FEW_ACCOUNTS`. A chain split is dropped unless every point passes. The
guard is also the only way a figure reaches the repo (design D2).

### 3.5 USDC in flight between chains

Base → Monad: the Base operator keeps the CCTP burns journal (`bridge-monad.ts`) and already has the single rule the
engine and the money map use (`inFlightBurns`, otto/mamoru#269): a burn is in flight while not minted, or when it was
minted at a Monad block after the block of the Monad read being valued. The Base snapshot wire adds
`bridges?: { safe, accountKey, amountUsdc, state, burnBlock, burnAt, mintedBlock?, mintedAt? }[]` (unpruned burns).
Each stored row carries its read `block`, so the Worker compares the Base read's block with `burnBlock` and the Monad
read's block with `mintedBlock`. The Worker applies that rule
against the `block` of the Monad sleeve's row it has stored, and adds the result to TVL now and to the day's close.
This counts each USDC once: on the source side until the Monad read that includes the mint, then in the sleeve.
Out-of-order reads: if an account's Base read is older than a burn and its Monad read is newer than that burn's mint,
the same USDC is in both reads; the Worker subtracts it once. Any case the rule cannot place (missing block, unknown
state) makes TVL now and the day's point `partial` instead of guessing.

Monad → Base (return home, `return-home.ts`): if its journal exposes the same fields, the same rule against the Base
row's block; otherwise any open return makes TVL now and that day's point `partial`. B8 decides which by reading the
code, and says so in its PR.

### 3.6 Freshness

`dataAsOf` per figure = the oldest `read_at` (or day close block time) among the rows that contribute. The UI shows
"data as of 18:20 UTC"; older than 1 h → flagged stale. `readAt` (request time) is not shown.

### 3.7 Accepted risk: differences between readings

Two public readings (two days, or now and the last close) can be subtracted. If one of three owners alone deposits in
between, the difference is that deposit. Any public TVL has this; Ot accepted public aggregates (PRD §5.3). Mitigation
only: whole-dollar rounding of every published figure, owner counts in bands. No further guard. Product decision, not
an open finding: reviewers flag it, Ot and Brais accepted it for the hackathon.

## 4. API: `GET /api/stats`

`apps/mamoru-app/src/api/stats/routes.ts`, mounted in `app.ts` with `app.route('/api/stats', statsRoutes())`.

- No session needed. It does not set `c.var.accountKey`, so `recordActivity` never fires.
- One payload, all history (≈ 60 daily points today); the client slices 1W/1M/3M/ALL. XX: one query set, one cache key.
- Response (`@mamoru/domain` type `StatsView`, new file `packages/domain/src/stats.ts`; `packages/domain` is hot:
  this unit only adds a file and one export line):

```ts
type Reason = 'TOO_FEW_ACCOUNTS' | 'NOT_COUNTED' | 'PARTIAL'
type Figure = { usd: number | null; reason?: Reason; dataAsOf: string | null; stale?: true }
type Point = { day: string; usd: number | null; reason?: Reason; owners?: '3+' | '10+' | '25+' | '50+' }
type StatsView = {
  tvlNow: Figure
  tvl: Point[]                   // daily
  monadFrom: string | null       // the day Monad tracking was deployed (B1 release), a system date, never the first
                                 // day of any owner's activity; earlier points are "Base only"
  volume: Point[]                // daily
  earned24h: Figure & { vaultYield: 'counted' | 'not_counted' }
  earnedTotal: Figure & { since: string; vaultYield: 'counted' | 'not_counted' }
  fundedAccounts: { count: number | null; reason?: Reason; dataAsOf: string | null }
  chains?: { chainId: number; tvl: Point[] }[]   // only when every point passes the guard
  sources: { tvl: string; volume: string; earned: string }
}
```

`owners` is sent only as a band. USD numbers, including TVL now, are rounded to whole dollars server side (§3.7).

- Cache: `caches.default` keyed `https://stats.internal/v1`, TTL 300 s (precedent: `api/apy/routes.ts`).
  Response header `cache-control: public, max-age=60, s-maxage=300`, overriding the `/api/*` default `no-store`
  for this route only.
- Rate limit: new binding `STATS_READ_LIMIT` (`wrangler.jsonc`, both envs), 60 per minute per hashed client IP, like
  `middleware/read-limit.ts`. A 429 carries `retry-after: 60` and `READ_RATE_LIMITED`.
- Errors: D1 failure → 503 `STATS_UNAVAILABLE`; the cached copy, if any, is served with its own `dataAsOf`.

## 5. Portfolio data

- Total value chart: new `GET /api/accounts/:accountKey/value-series` in `api/accounts/` (behind the existing session
  and `accountReadLimit`): daily `total_close_usdc` of the owner's accounts (Base + sleeves, `sleevesOfUser`) summed by
  day, plus today's points from `account_worked_samples`: on a common 10-min grid, each chain contributes its last
  sample at or before the grid time (last known value), never an exact `read_at` join; a chain with no sample in the
  last 30 min marks the point `partial`.
- Earned so far: `earnedSoFarUsd` with 012's `vaultYieldUsd` (012 plan). Required for prod (spec R18).

## 6. Charts

No chart library in the app today. Default: hand-written SVG components (`web/stats/chart/`: line with range, bars,
crosshair tooltip, axis ticks), no new dependency, a few KB, full control of the type, ticks and motion budget. The
design phase may replace this with a library only with a measured reason (bundle and quality), recorded in
`design.md`.

## 7. Constitution check

| Principle | How 013 complies |
|---|---|
| I No custody / IX session | `/stats` reads aggregates; no signing, no session needed; Portfolio flows unchanged |
| VII Authority of data | Every figure comes from D1 rows written from the operator's chain reads; no client-side computation of money |
| XV Panel / VIII Login and view | Logged-in Portfolio stays the owner's; `/stats` is a separate public view, no account data |
| **XVI Truth on screen** | Source and read time per figure; missing = "not counted"; partial days and "Base only" labeled; no forecasts |
| XVII Secrets | No new secret; the rate-limit key hashes the IP with the existing session secret |
| XIX Between chains | Monad counted once (its sleeve rows); USDC in flight counted once by the #269 rule (§3.5), else `partial` |
| **XX Simplicity** | One endpoint, one payload, one cache key; one guard over the whole view; carry-forward bounded at 2 days; reuse of the #269 in-flight rule; SVG over a library unless measured |

## 8. Deploy notes (coordinator)

1. Migration `XXXX_ledger_ops.sql` (new table + `account_worked_samples.fees_usd`): before the Worker that writes it.
2. Operator: one redeploy with receipt facts `v: 2`, per-op wire and `bridges` (shared with the 011/012 batch). Its
   first ticks re-read old receipts and `eth_call` historical `slot0` at `FACTS_PER_TICK`; watch RPC counts on `/metrics`.
3. `wrangler.jsonc`: new `STATS_READ_LIMIT` ratelimit binding (namespace ids `377001` prod, `377002` beta; checked
   unused).
4. Order: migration → operator → Worker with B1 + B5 → Worker with B6 (B6 merges only after B1 and B5, tasks.md).
5. Beta: Ot and Brais check `beta.mamoru.lol/stats` without a session; STATS-S13/S14 pass on beta; volume and vault
   yield counted (R18). Then prod with the rest of the event release (PRD decision 5).
