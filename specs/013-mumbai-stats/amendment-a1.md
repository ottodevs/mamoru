# 013 Amendment A1: what Stats shows (Ot and Brais, 6 Nov 18:37–18:49Z)

Supersedes the metric set, copy and mockups of `spec.md` R5–R8, `design.md` and PR #302. Routes, menu, privacy
guard (k ≥ 3, allow-if), freshness (`dataAsOf`) and the earned module (spec 012 `earned.ts`) stay.

**Why:** the first mockups copied another product's two charts (deposits, volume). Mamoru's users, the team, judges
and investors want to know **where the money is, what it earns, and whether that return holds over time**. Every
figure is either a **snapshot** (one number: exact now, or an average over a stated period) or a **chart** of a
**distribution** (proportions) or a **change over time**.

## Page

- Title **Stats**. Subtitle: "Every Mamoru account, added up." No pre-title, no "Start saving" button.
- Figures carry no subtitle. Each has one (i) icon, vertically centred on the label, same icon as the rest of the
  app; the tooltip says how it is computed in one sentence.
- **Every figure counts every chain.** No "Base only", no "not counted", no legend for data states. If a figure is not
  complete it is **not published** (the block is hidden) until it is; the page never shows a figure it knows is
  incomplete. A stale read (> 1 h) hides the figure the same way.

## Snapshots (top)

| Id | Figure | Definition | (i) text (EN, proposed) |
|---|---|---|---|
| S1 | Total deposits | Σ over all accounts and chains of idle + LP position value + vault value + uncollected fees, USD at the read's prices | "Value held in every Mamoru account, on every chain." |
| S2 | Money working | Σ LP position value + vault value | "Capital placed in pools and vaults right now." |
| S3 | Idle capital | Σ idle (Safe balances not placed) | "Capital waiting to be placed: deposits in progress, pool depth or limits." |
| S4 | Earned in the last 24h | Σ over accounts of earned 24 h (012 `earned.ts`): fees collected + fees accrued not yet collected + vault yield, every token valued in USD at the read's price (WETH, WMON, cbBTC included before any sale) | "Fees and vault yield earned in the last 24 hours, valued in USD." |
| S5 | Total earned | Same, since each account opened | "All fees and vault yield earned since launch, valued in USD." |
| S6 | Average APR (7 days) | Capital-weighted APR over the last 7 days (method below) | "What the money working earned over the last 7 days, as a yearly rate, before compounding." |
| S7 | Total accounts | Count of accounts created (prod), funded or not | "Accounts created in Mamoru." |
| S8 | Average account | S1 / accounts with value > $1 | "Average value of an account with funds." |
| S9 | Largest account | Max account value, the number only, never the account | "Value of the largest single account." |
| S10 | In stablecoins | Share of S1 held in USD stablecoins (idle USDC, stable LP legs, stable vaults) | "Share of all value held in dollar stablecoins." |

S8 and S9 need ≥ 3 funded accounts (allow-if); S9 shows no address, date or chain.

## Distributions

- **D1 By token:** USD exposure per asset (USDC, USDT, WETH, cbBTC, WMON, …), each LP split into its two legs at the
  read's amounts (`amount0/amount1` from the position, not a 50/50 guess). Donut or one stacked bar + table with $ and %.
- **D2 By chain:** Base, Monad: $ and %.
- **D3 By place (risk view):** Stable vaults · Stable pairs (USDC/USDT) · Volatile pairs (WETH, cbBTC, WMON) · Idle.
  This is the "where is the risk" chart.

A slice backed by < 3 accounts is merged into "Other" (complementary rule: if only one slice would be hidden, hide
the whole split).

## Over time (since the first day every chain is known)

- **T1 APR:** daily capital-weighted APR (thin line) and its **7-day moving average** (thick line); toggle All / Base /
  Monad. Shows whether today's figure (e.g. Monad at 95 %) holds. Range 1W / 1M / ALL.
- **T2 Earned per day:** bars of USD earned per day (fees + vault yield), the collected part distinct from accrued.
- **T3 Total deposits:** line of S1 per day close.

No volume chart.

## APR method (aggregate) and APY (account)

- Aggregate uses **APR, not APY**: `APR_day = Σ earned_day / Σ avg working capital_day × 365`, summed over accounts
  (capital-weighted: a $10,000 account weighs 100× a $100 one, so the line is what a dollar in Mamoru earned). Idle
  capital is excluded from the denominator (it is shown apart as S3). No compounding is assumed.
- An account's Portfolio keeps APY (its own compounding history). Small accounts earn a different rate (gas floor
  before reinvesting, no vault position below `vaultMinDeposit`); that is why the aggregate is capital-weighted and
  why Stats shows no per-account rates.
- Optional if data allows, k ≥ 3 per band: **APR by account size** (< $100, $100–1,000, > $1,000), 30 days, bars.
  It answers "does the rate depend on size". Shipped only if each band has ≥ 3 accounts.

## Data (what exists, what is added)

- Now: `account_snapshot_latest` (Base rows only today; Monad is added by task A1-D1), positions with
  pool and value; `account_worked_samples` per pool every ~10 min since 4 Nov 10:29Z, Base and Monad.
- Add: per-position token amounts (`amount0`, `amount1`, token symbols) on the snapshot (operator `snapshot.ts`), so
  D1 is exact; Monad rows in `account_snapshot_latest` and `account_daily`.
- History: Monad accounts exist since 1 Nov; Monad samples since 4 Nov. Before 4 Nov the Monad sleeves are read at
  day-close blocks from an archive RPC if available; otherwise every time series starts on 4 Nov (all chains known).
- **Correctness gate:** before publishing, S1–S10 are recomputed by an independent script that reads the chain
  directly (Safe balances, positions, vault shares) for every account and must match the API within $1 or 0.5 %.
  Result in `results/stats-reconcile-<date>.md`.

## Tasks (replace 013 Phase U and the API shape; Phase B guard, ledger and value-series stay)

| Id | What | Accepts |
|---|---|---|
| A1-D1 | Monad rows in snapshot latest + daily (B1, finish) | Monad Safes appear; S1 matches chain |
| A1-D2 | Position token amounts on the snapshot | D1 legs sum to LP value ± $1 |
| A1-D3 | `GET /api/stats` v2: S1–S10, D1–D3, T1–T3, guard, `dataAsOf`; hide incomplete | unit + fixture |
| A1-D4 | Reconcile script vs chain | results file, all within tolerance |
| A1-U1 | Mockups again with real figures, then OK | Ot + Brais OK |
| A1-U2 | Build the page | 1280 / 390 screenshots on the served route |
