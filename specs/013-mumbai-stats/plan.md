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

- LP: per spec.md table, from `account_daily` (Base and, from Day0-Monad, Monad).
- Vault yield: read from spec 012's tables `yield_ledger_income` (`source = 'vault-yield'`) and
  `yield_ledger_vault_daily` (012 plan §3.1). Until 012 lands, the endpoint returns
  `vaultYield: { status: 'not_counted' }` and the UI says "fees only".

### 3.3 Volume: one new receipt fact

The operator already reads every engine op's receipt once (`apps/mamoru-operator/src/yield-receipts.ts`) and serves
per-day totals on `/snapshot` (`receipts[].days[]`). Add:

- `OpFacts.placed?: { pool: string; amount0: string; amount1: string }[]` from the NonfungiblePositionManager
  `IncreaseLiquidity(tokenId, liquidity, amount0, amount1)` events of this Safe's userOp (emitted on mint and on
  increase), and `vaultDeposits?: { vault: string; assets: string }[]` from ERC-4626 `Deposit(sender, owner, assets,
  shares)` where `owner` = the Safe.
- Priced like fees: at the first snapshot that prices the pool (vault assets are USDC, no pricing), then frozen.
- `DayReceiptWire.placedUsdc?: string`, absent while a part of the day is unpriced.
- Backfill: facts carry `v: 2`. A stored op with facts of `v` < 2 and a txHash is re-read once through the same
  `FACTS_PER_TICK` queue, so the history of volume comes from the ops the operator already stores. Old ops whose
  receipt can no longer be fetched stay unpriced: their days read "not counted".
- Worker: migration `migrations/d1/XXXX_receipts_placed.sql`: `ALTER TABLE yield_ledger_account_receipts ADD COLUMN
  placed_usdc INTEGER;` (additive, null = not counted). `writeReceipts` writes it.

### 3.4 Owners and the k ≥ 3 guard

Every aggregate is computed with its owner count: `COUNT(DISTINCT a.user_id)` joining `accounts a ON a.account_key =
d.account_key`. A point whose count is < 3 is replaced by `null` with `reason: 'TOO_FEW_ACCOUNTS'` before the
response is built (`stats/privacy.ts`, one pure function, unit-tested). Per-chain series exist in the response only
when every point passes; otherwise the chain split is dropped and only totals go out.

## 4. API: `GET /api/stats`

`apps/mamoru-app/src/api/stats/routes.ts`, mounted in `app.ts` with `app.route('/api/stats', statsRoutes())`.

- No session needed. It does not set `c.var.accountKey`, so `recordActivity` never fires.
- One payload, all history (≈ 60 daily points today); the client slices 1W/1M/3M/ALL. XX: one query set, one cache key.
- Response (`@mamoru/domain` type `StatsView`, new file `packages/domain/src/stats.ts`; `packages/domain` is hot:
  this unit only adds a file and one export line):

```ts
type Point = { day: string; usd: number | null; reason?: 'TOO_FEW_ACCOUNTS' | 'NOT_COUNTED' | 'PARTIAL'; owners?: number }
type StatsView = {
  readAt: string                 // ISO, when D1 was read
  tvlNow: { usd: number | null; readAt: string | null; reason?: string }
  tvl: Point[]                   // daily
  monadFrom: string | null       // Day0-Monad; earlier points are "Base only"
  volume: Point[]                // daily, from first day with placed_usdc
  earned24h: { usd: number | null; day: string; partial: boolean; vaultYield: 'counted' | 'not_counted' }
  earnedTotal: { usd: number | null; since: string; partial: boolean; vaultYield: 'counted' | 'not_counted' }
  sources: { tvl: string; volume: string; earned: string }   // human labels for "where it comes from"
}
```

`owners` is sent only rounded down to a band (`3+`, `10+`, `25+`, `50+`) to avoid inferring individual flows from
day-to-day count changes. USD numbers are rounded to whole dollars server side.

- Cache: `caches.default` keyed `https://stats.internal/v1`, TTL 300 s (precedent: `api/apy/routes.ts`).
  Response header `cache-control: public, max-age=60, s-maxage=300`, overriding the `/api/*` default `no-store`
  for this route only.
- Rate limit: new binding `STATS_READ_LIMIT` (`wrangler.jsonc`, both envs), 60 per minute per hashed client IP, like
  `middleware/read-limit.ts`. A 429 carries `retry-after: 60` and `READ_RATE_LIMITED`.
- Errors: D1 failure → 503 `STATS_UNAVAILABLE`; the cached copy, if any, is served with its `readAt`.

## 5. Portfolio data

- Total value chart: new `GET /api/accounts/:accountKey/value-series` in `api/accounts/` (behind the existing session
  and `accountReadLimit`): daily `total_close_usdc` of the owner's accounts (Base + sleeves, `sleevesOfUser`) summed by
  day, plus today's points from `account_worked_samples` summed per `read_at` (31-day retention; enough for today).
- Earned so far: extend the existing `earnedSoFar` (`api/accounts/yield.ts`) with vault yield when spec 012 provides
  it. Same "not counted" rule.

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
| XIX Between chains | Monad counted once (its sleeve rows), in transit not double counted: TVL sums Safes only |
| **XX Simplicity** | One endpoint, one payload, one cache key; no carry-forward; no backfill from samples; SVG over a library unless measured |

## 8. Deploy notes (coordinator)

1. Migration `XXXX_receipts_placed.sql`: apply before the Worker that writes `placed_usdc`.
2. Operator: one redeploy with the receipt `v: 2` facts (shares the batch redeploy with specs 011/012). Its first
   ticks re-read old receipts at `FACTS_PER_TICK`; watch RPC call counts on `/metrics`.
3. `wrangler.jsonc`: new `STATS_READ_LIMIT` ratelimit binding (namespace ids `377001` prod, `377002` beta).
4. Worker to beta; Ot and Brais check `/stats` without a session on `beta.mamoru.lol/stats`; then prod with the rest
   of the event release (PRD decision 5).
5. Order: migration → operator → Worker. The Worker tolerates an operator without `placedUsdc` (volume "not counted").
