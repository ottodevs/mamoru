# 013 tasks

Ticket otto/mamoru#377 (subtasks as a checklist there). Each task is one PR from its own worktree off `origin/main`,
label `ethglobal-mumbai`, `release:check` green, `review:pr` by a different model, merged by the coordinator.
No `Co-Authored-By` or model lines. Paths are under `apps/mamoru-app/` unless written otherwise.

Parallel groups: tasks in the same group can run at once; a later group waits for what it names.

## Phase D: design (starts now, no code)

| Id | What | Files | Reqs | Accepts | Must not |
|---|---|---|---|---|---|
| D1 | Research brief | `specs/013-mumbai-stats/design/research.md` | R3, R5–R8 | design.md §1 | copy Fables layout |
| D2 | Data export for mockups: run the plan §4 queries read-only on D1 and save the shape | `specs/013-mumbai-stats/design/stats-sample.json` | R5–R10 | figures match G5 | include any account key, address or per-account row |
| D3 | Mockups 1280/390, Stats and Portfolio, all states; impeccable + hallmark passes | `specs/013-mumbai-stats/design/*.html`, `*.png` | R1–R17 | design.md §6.1–3 | add tokens; show forecasts |
| D4 | Post for OK; record the OK link here | this file (Gate line) | R4, R11, R17 | Gate below | start U-tasks before the OK |

**Gate (D4):** _pending — link to Ot's and Brais's OK in `#devcon-8`._

## Phase B: data and API (starts now, parallel with D)

Group B-a (independent):

| Id | What | Files | Reqs | Accepts | Must not |
|---|---|---|---|---|---|
| B1 | Monad daily totals: `pullWorkedSamples` also writes `account_snapshot_latest` and `account_daily` (plan §3.1); first confirm `writeAccountSnapshot` has no Base-only assumption | `src/api/yield-ledger.ts`, `test/api/yield-ledger*.test.ts` | R5, R10 | STATS-S04 | backfill from worked samples; touch Base pull |
| B2 | Privacy guard: pure `guard(points, k=3)` and owner bands | `src/api/stats/privacy.ts`, `test/api/stats-privacy.test.ts` | R9 | STATS-S02, S03 | return owner counts below 3 or exact counts |
| B3 | `StatsView` type | `packages/domain/src/stats.ts`, one export line in `packages/domain/src/index.ts` | R5–R10 | typecheck | change any other domain file (hot) |
| B4 | **Stacks on 012 HT6** (same files; reuse its ERC-4626 decoding). Operator receipt facts v2: `placed` (IncreaseLiquidity) and `vaultDeposits` (ERC-4626 Deposit, owner = Safe), priced and frozen like fees; `placedUsdc` per day; re-read of v<2 facts through the existing queue | `apps/mamoru-operator/src/yield-receipts.ts`, its test, wire type in the same file | R6 | STATS-S07 | touch `operator.ts`; read more than `FACTS_PER_TICK` per tick |

Group B-b (after B2, B3; B4 optional — volume reads "not counted" without it):

| Id | What | Files | Reqs | Accepts | Must not |
|---|---|---|---|---|---|
| B5 | Migration `XXXX_receipts_placed.sql` + `writeReceipts` writes `placed_usdc` | `migrations/d1/XXXX_receipts_placed.sql`, `src/api/yield-ledger.ts`, test | R6 | STATS-S07 | rewrite existing rows' other columns |
| B6 | `GET /api/stats`: queries (plan §3–4), guard, cache, `STATS_READ_LIMIT`, 503 path | `src/api/stats/routes.ts`, `src/api/stats/queries.ts`, `src/api/app.ts` (one `route` line), `wrangler.jsonc`, `src/api/env.ts` (binding type), `test/api/stats.test.ts` | R2, R5–R10, R12, R13 | STATS-S01..S06, S08 | set `accountKey`; read the operator or RPC; return per-account rows |
| B7 | `GET /api/accounts/:key/value-series` | `src/api/accounts/value-series.ts`, `src/api/accounts/routes.ts`, test | R14 | STATS-S10 | widen what another owner can read |

B5 and B6 both touch nothing in common except `yield-ledger.ts` vs `stats/`: B5 owns `yield-ledger.ts`; B1 and B5 are
stacked (B5 on B1's branch) because both edit `yield-ledger.ts`.

## Phase U: UI (only after the Gate)

Group U-a:

| Id | What | Files | Reqs | Accepts | Must not |
|---|---|---|---|---|---|
| U1 | Chart primitives (SVG line, bars, axis, crosshair tooltip, range control) per design.md §4 | `src/web/stats/chart/*.tsx`, tests | R8, R10 | STATS-S09 | add a chart dependency without the design.md record |
| U2 | Menu + `/stats` route (lazy) | `src/web/router.tsx`, `src/web/routes/root.tsx`, `src/web/components/app-nav.tsx`, `src/web/stats/page.tsx` (shell), e2e | R1–R3 | STATS-S01, S11 | change the cards' logic in `routes/index.tsx` |

Group U-b (after U1, U2, B6):

| Id | What | Files | Reqs | Accepts | Must not |
|---|---|---|---|---|---|
| U3 | Stats page content: 4 figures, TVL line, volume bars, (i) texts, sources, states, CTA | `src/web/stats/*.tsx`, `src/web/api/queries.ts` (one hook) | R2, R5–R11 | STATS-S01, S05, S09 | merge copy without the OK |
| U4 | Portfolio: Total value chart on top (after B7) | `src/web/routes/home.tsx` (Portfolio section only), `src/web/portfolio/value-chart.tsx` | R14, R17 | STATS-S10 | touch other Home sections |

Group U-c (after U4; `home.tsx` is one unit at a time):

| Id | What | Files | Reqs | Accepts | Must not |
|---|---|---|---|---|---|
| U5 | Earned so far card (with vault yield when spec 012 lands) and Add capital / Withdraw at the top | `src/web/routes/home.tsx`, `src/api/accounts/yield.ts` | R15–R17 | STATS-S12 | change the add/withdraw flows |
| U6 | Visual check at 1280 and 390 on the served route (`worker.fetch` / beta), screenshots in the PR | — | all | design.md §4 budget | ship without screenshots |

## Done

`/stats` on `app.mamoru.lol` without a session, Base + Monad, prod + beta; figures equal to `/api/stats`; the pitch
cites those figures (PRD §4).
