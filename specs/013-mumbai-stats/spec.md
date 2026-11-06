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
  Counts LP positions, idle tokens, uncollected fees, vault shares and USDC in flight between chains, on Base and
  Monad, for prod and beta accounts.
- **STATS-R6. Total volume.** Daily bars of capital the engine placed or moved: new or increased LP positions plus
  vault deposits, valued at the op's block.
- **STATS-R7. Earned in the last 24h** (rolling 24 h ending at the data time) and **Total earned**: LP fees (accrued
  and collected) plus vault yield (spec 012 HRV-R4, `yield_ledger_income.source = 'vault-yield'`).
- **STATS-R7b. Funded accounts.** Number of owners whose accounts hold more than 1 USDC now (the "users" figure the
  pitch cites, PRD §4). Copy needs OK.
- **STATS-R8. Hover or tap** on a chart shows that day's figure and its UTC date. Nothing projected forward.
- **STATS-R9. Aggregates only.** No account key, address, user id, transaction hash or per-account figure leaves the
  server for this page. **Every published figure** (TVL now, each series point, Earned 24h, Total earned, Funded
  accounts, any per-chain split) is backed by at least 3 distinct owners or withheld with reason `TOO_FEW_ACCOUNTS`.
  The same rule binds every figure committed to the repo (mockups, screenshots, samples).
- **STATS-R10. Truth on screen (constitution XVI).** Each figure says where it comes from and its `dataAsOf`: the
  oldest chain read that contributes to it, not the request time. Data older than 1 h is flagged stale. A missing
  figure shows as "not counted", never 0. A chain whose history starts later than the series is labeled: the stretch
  before Monad's first day reads "Base only".
- **STATS-R11.** The (i) texts are English, one sentence each, and are merged only with Ot's and Brais's OK.
  Proposals in design.md §5.
- **STATS-R12.** Test accounts (`accounts.is_test = 1`, `env = 'test'`) and rows of unknown environment are never
  counted.
- **STATS-R13. Load.** The public endpoint is cached at the edge and rate-limited per client, and reads only D1
  (never the operator or an RPC) on a request.
- **STATS-R18. Release content.** Volume (B4) and vault yield (spec 012) are required in the production release.
  "Not counted" for either is allowed only as an interim state on beta.

### Portfolio (with a session)

- **STATS-R14. Total value** with a chart as the main element: the account's daily close over Base and Monad, plus
  today's samples, each chain at its last known value at each time (never an exact-timestamp join).
- **STATS-R15. Earned so far** in its own card, including vault yield (same definition as STATS-R7, scoped to the
  owner's accounts).
- **STATS-R16. Add capital and Withdraw** sit at the top of Portfolio. Their flows do not change.
- **STATS-R17.** Existing Portfolio UI changes only where STATS-R14..R16 need it. No new element, text or grouping
  without Ot's and Brais's OK.

## Metric definitions

UTC days. Money in USDC base units (6 decimals) server side, published rounded to whole dollars, shown with the rules
of design.md §4. Every figure goes through the k ≥ 3 guard (R9) last.

| Metric | Definition | Source |
|---|---|---|
| Value(account, day) | `account_daily.total_close_usdc`; if the account has no row that day but has one in the 2 previous days, that last close, and the day is `partial` | `account_daily` (Base from its first row; Monad from Day0-Monad, plan §3) |
| TVL(day) | Σ Value(account, day) over accounts with `env IN ('prod','beta')` + in-flight USDC at day close (plan §3.5) | as above |
| TVL now | Σ `account_snapshot_latest.total_usdc` (rows older than 30 min carried ≤ 2 days, then `partial`) + in-flight now | `account_snapshot_latest` |
| Owners | `COUNT(DISTINCT accounts.user_id)` behind a figure (a Base account and its Monad sleeve are one owner) | join `accounts` |
| Funded accounts | owners whose Σ TVL now over their accounts > 1 USDC | as TVL now |
| LP earned(day) | Σ (`fees_close_usdc − fees_open_usdc` + `collected_usdc`); any NULL `collected_usdc` → day `partial` | `account_daily` |
| Vault yield(day) | Σ `yield_ledger_income.usd` with `source = 'vault-yield'`; any NULL → `partial` | spec 012 |
| Earned 24h | Σ over accounts [accrued fees now − accrued fees at now−24h + fees collected by ops with block time in (now−24h, now]] + vault yield prorated (plan §3.2) | plan §3.2 |
| Total earned | Σ earned over every day with data | as above |
| Volume(day) | Σ placed USD of ops with block time in that day; any unpriced op → day `partial`, value null | plan §3.3 |

## Edge cases

- **E1.** An account missing from a day's read: carried forward from its last close ≤ 2 days, point `partial`
  (tooltip: "some accounts carried from their last reading"). Older than 2 days: not counted, point `partial`.
  Never a fake dip.
- **E2.** `collected_usdc` or vault yield unpriced: that day's earned is `partial`, and so is Total earned.
- **E3.** A per-chain split with < 3 owners: withheld; the totals still count that chain.
- **E4.** Vault yield or volume not yet available: "not counted" on beta only (R18).
- **E5.** Volume before its first recorded day: "not counted", never 0 bars.
- **E6.** The current UTC day is drawn as partial ("today, so far").
- **E7.** D1 unreachable: 503 `STATS_UNAVAILABLE`; the cached copy is served with its own `dataAsOf`.
- **E8.** USDC in flight between chains: counted once, by the rule in plan §3.5; when the rule cannot be applied the
  point is `partial`.

## Acceptance (Given / When / Then)

Scenario ids are in `scenarios.md`.

- **G1 (STATS-R2).** Given a browser with no cookies, when it opens `/stats`, then the page renders the figures
  and no passkey prompt or redirect happens.
- **G2 (STATS-R9).** Given the API response of `/api/stats`, when it is searched for any `account_key`, Safe address,
  `user_id` or tx hash present in D1, then none is found.
- **G3 (STATS-R9).** Given any figure (series point, TVL now, Earned 24h, Total earned, Funded accounts, chain split)
  backed by 2 owners, when the response is built, then it is null with `TOO_FEW_ACCOUNTS`.
- **G4 (STATS-R10).** Given a metric with no source rows, when it is shown, then it reads "not counted".
- **G5 (STATS-R5).** Given the D1 on 6 Nov, when TVL(day) for Base is computed, then it equals the sum of
  `total_close_usdc` and includes the gtUSDCp shares (1,385.92 checked against idle+LP 671.19 + vault 714.15 + fees
  0.57).
- **G6 (STATS-R13).** Given 100 requests in a minute from one client, when they hit `/api/stats`, then the limiter
  answers 429 after its limit and D1 is read at most once per cache window.
- **G7 (STATS-R1, R3).** Given a signed-in owner, when they open `/`, then Portfolio shows; the menu reaches `/stats`
  and back without losing the session.
- **G8 (STATS-R12).** Given a test account with funds, when TVL is computed, then its rows are not in the sum.
- **G9 (STATS-R5, E1).** Given an account read on day 1 and day 3 but not day 2, when TVL(day 2) is built, then the
  account counts at its day-1 close and the point is `partial`.
- **G10 (STATS-R7).** Given a harvest at 14:00 UTC today, when Earned 24h is read at 15:00, then it includes that
  harvest's collected fees.
- **G11 (STATS-R18).** Given the production release candidate, when `/api/stats` is read on beta, then volume and
  vault yield are counted (not `not_counted`).
