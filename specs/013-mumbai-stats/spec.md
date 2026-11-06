# 013: Stats, public and in the app

- Ticket: otto/mamoru#377. Related: #107 (harvest, spec 012), #376 (cap, spec 011).
- PRD: [`docs/ethglobal-mumbai/prd.md`](../../docs/ethglobal-mumbai/prd.md) (summary) §5.3 (final, 6 Nov).
- Status: draft r1, 6 Nov 2026. Built during ETHGlobal Mumbai (Continuity).
- Set: `spec.md` (what), `plan.md` (how), `design.md` (design phase and gate), `tasks.md`, `scenarios.md`.

## Problem

Mamoru runs with real money, but nobody outside Ot and Brais can see how much, or what it earns. The only aggregate
view is the private `/ops` console on the landing, which is frozen for this event and shows data per account. Judges,
partners and new users need one public page whose figures match the pitch.

## Scope

In: `app.mamoru.lol/stats` (new, public), a menu in the app with Portfolio and Stats, and three Portfolio pieces
(Total value chart, Earned so far card, Add capital / Withdraw on top). Out: the landing and `/ops` (frozen),
`mamoru.lol/stats` (must not exist), APY → real APR, working-capital columns, per-account or per-address data,
forecasts.

## Requirements

### Routes and access

- **STATS-R1.** `/` is Portfolio. With a session it shows the owner's account. Without one it shows the create /
  sign-in cards, as today.
- **STATS-R2.** `/stats` opens with no session, no account and no passkey prompt. It is linkable. Without a session it
  carries one call to action, "Start saving", that goes to `/`.
- **STATS-R3.** A menu with at least Portfolio and Stats is visible with and without a session: a top bar at desktop
  width, the mobile pattern chosen in design at 390 px. The names are provisional until Brais confirms them.
- **STATS-R4.** No UI task starts before Ot and Brais approve the mockups (design.md §6).

### Content of /stats

- **STATS-R5. Total deposits (TVL).** A line of the daily total over 1W, 1M, 3M and ALL, and the current figure.
  Counts LP positions, idle tokens, uncollected fees and vault shares, on Base and Monad, for prod and beta accounts.
- **STATS-R6. Total volume.** Daily bars of capital the engine placed or moved: new or increased LP positions plus
  vault deposits, in USDC at the time of the operation.
- **STATS-R7. Earned in the last 24h** and **Total earned**: LP fees (accrued and collected) plus vault yield
  (spec 012 HRV-R4, ledger label `vault-yield`).
- **STATS-R8. Hover or tap** on a chart shows that day's figure and its UTC date. Nothing projected forward.
- **STATS-R9. Aggregates only.** No account key, address, user id, transaction hash or per-account figure leaves the
  server for this page. No figure, series point or breakdown backed by fewer than 3 distinct owners is shown; it is
  withheld with reason `TOO_FEW_ACCOUNTS`.
- **STATS-R10. Truth on screen (constitution XVI).** Each figure says where it comes from and when it was read. A
  figure that is missing shows as "not counted", never 0. A chain whose history starts later than the series is
  labeled: the stretch before Monad's first day reads "Base only".
- **STATS-R11.** The four (i) texts are English, one sentence each, and are merged only with Ot's and Brais's OK.
  Proposals in design.md §5.
- **STATS-R12.** Test accounts (`accounts.is_test = 1`, `env = 'test'`) and rows of unknown environment are never
  counted.
- **STATS-R13. Load.** The public endpoint is cached at the edge and rate-limited per client, and reads only D1
  (never the operator or an RPC) on a request.

### Portfolio (with a session)

- **STATS-R14. Total value** with a chart as the main element: the account's daily close over Base and Monad, plus
  today's samples.
- **STATS-R15. Earned so far** in its own card, including vault yield (same definition as STATS-R7, scoped to the
  owner's accounts).
- **STATS-R16. Add capital and Withdraw** sit at the top of Portfolio. Their flows do not change.
- **STATS-R17.** Existing Portfolio UI changes only where STATS-R14..R16 need it. No new element, text or grouping
  without Ot's and Brais's OK.

## Metric definitions

UTC days. Money in USDC base units (6 decimals) server side, shown in USD with the rules of design.md §4.

| Metric | Definition | Source |
|---|---|---|
| TVL(day) | Σ `account_daily.total_close_usdc` over rows of that day with `env IN ('prod','beta')` | `account_daily` (Base from its first row; Monad from Day0-Monad, plan §3) |
| TVL now | Σ `account_snapshot_latest.total_usdc`, same env filter, rows read in the last 30 min | `account_snapshot_latest` |
| Owners(day) | `COUNT(DISTINCT accounts.user_id)` behind that day's rows (a Base account and its Monad sleeve are one owner) | join `accounts` |
| LP earned(day) | Σ (`fees_close_usdc − fees_open_usdc` + `collected_usdc`) per row; a row with `collected_usdc` NULL makes the day partial | `account_daily` (comment in 0009) |
| Vault yield(day) | Σ ledger entries labeled `vault-yield` for the day | spec 012 HRV-R4/R8 |
| Earned 24h | LP earned + vault yield of the last complete UTC day | as above |
| Total earned | Σ earned over every day with data | as above |
| Volume(day) | Σ `placed_usdc` (LP mint/increase + vault deposit, priced at the op's block) | new column, plan §4 |

## Edge cases

- **E1.** A day where the cron missed an account: the day is summed as read. No carry-forward (XX: no extra branch
  without measured need). The tooltip shows how many owners the day counts.
- **E2.** `collected_usdc` unpriced for a day: that day's earned is marked partial in the series and in Total earned.
- **E3.** Monad series empty or < 3 owners: the per-chain split is withheld, the total still counts Monad's rows.
- **E4.** Vault yield not yet in the ledger (spec 012 not deployed): Earned shows LP only, labeled "fees only, vault
  yield not counted".
- **E5.** Volume before its first recorded day: "not counted" for those days, never 0 bars.
- **E6.** A request at day rollover: the current UTC day is partial and drawn as such (last point marked "today, so
  far"), never mixed into "last 24h".
- **E7.** D1 unreachable: the endpoint answers 503 with `STATS_UNAVAILABLE`; the page says the figures could not be
  read and when it last had them, if cached.

## Acceptance (Given / When / Then)

Scenario ids are in `scenarios.md`.

- **G1 (STATS-R2).** Given a browser with no cookies, when it opens `/stats`, then the page renders the four figures
  and no passkey prompt or redirect happens.
- **G2 (STATS-R9).** Given the API response of `/api/stats`, when it is searched for any `account_key`, Safe address,
  `user_id` or tx hash present in D1, then none is found.
- **G3 (STATS-R9).** Given a day backed by 2 owners, when the series is built, then that point is null with
  `TOO_FEW_ACCOUNTS` and the chart draws a gap.
- **G4 (STATS-R10).** Given a metric with no source rows, when it is shown, then it reads "not counted".
- **G5 (STATS-R5).** Given the D1 on 6 Nov, when TVL(day) for Base is computed, then it equals the sum of
  `total_close_usdc` and includes the gtUSDCp shares (1,385.92 checked against idle+LP 671.19 + vault 714.15 + fees
  0.57).
- **G6 (STATS-R13).** Given 100 requests in a minute from one client, when they hit `/api/stats`, then the limiter
  answers 429 after its limit and D1 is read at most once per cache window.
- **G7 (STATS-R1, R3).** Given a signed-in owner, when they open `/`, then Portfolio shows; the menu reaches `/stats`
  and back without losing the session.
- **G8 (STATS-R12).** Given a test account with funds, when TVL is computed, then its rows are not in the sum.
