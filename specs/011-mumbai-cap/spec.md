# 011: Cap 10,000 USDC per account, safe and provable

Ticket: otto/mamoru#376. Event: ETHGlobal Mumbai 2026 (Continuity), priority 1 of 3 (then 012 harvest, 013 stats).
Source: Mumbai PRD §5.1, §9 and annex B.4 (Ot and Brais, 6 Nov 2026), summarized in `ETHGLOBAL.md`.
Status: draft r1. Plan: `plan.md`. Tasks: `tasks.md`. Scenarios: `scenarios.md`.

## Problem

The account cap is 1,000 USDC. Depositors are ready to put in more. The engine already sizes entries to pool depth and
the operator already accepts a cap above the 100 USDC default when depth sizing is on, but nothing proves that 10k or
100k in one account is placed safely and comes back whole, the app falls back to a fixed 100 when the operator is not
reachable, and money above what can be placed sits idle without a reason the user can read.

## State on 6 Nov 2026 (read, not assumed)

- Operator: `capOf` (`apps/mamoru-operator/src/operator.ts:1466`) takes the account's own cap, else its engine settings
  (canary, else environment), else the 100 default. Above 100 it requires `settings.depth` and a `target-weights`
  policy, or it keeps 100 and logs `[alert]`. Every live policy (v2, v4–v7, Monad sleeve) is `target-weights`.
- Running accounts are held to `effectiveCap` (`operator.ts:1518`): the current cap, never above the cap their approval
  was signed for. A higher cap is offered as a renewal (`approval.capRaise`, `operator.ts:2006`, app-api `capRaise`).
- Settings bounds already allow `capUsdc` 1..1,000,000 (`packages/policy/src/engine-settings.ts:72`); above 100 they
  need depth sizing (`:192`).
- App: `LIVE_CAP_USDC = '100000000'` (`apps/mamoru-app/src/api/app.ts:40`) is the chain-read fallback when the operator
  does not answer; the chain read ignores the engine settings cap.
- Settings are written by Ot in landing `/ops` (`mamoru-astro/src/engine-settings-store.ts:170`, table
  `engine_settings_versions`). No code change there (landing frozen); Ot only writes a version.
- **Live accounts (operator state, 6 Nov 17:58Z): 11 active, all V3** (2 on `conservador-live-v2`, 9 on
  `conservador-live-v7`), none on V4 T8. v7 accounts signed C = 1,000 USDC; their Monad sleeve's bridge total is
  500 USDC (50 % of C, `policies-v6.ts:27-30`). So no live account can hold 10k until its owner renews.
- Uncommitted worktree `.cell-wt/376-cap-e2e` (base `c8674dd2`, before the event): `settingsCapOf()` in the app,
  3 API tests, `cap-depth.test.ts` against real Base pool depth (fixture block 53823027), `e2e-depth.ts` fork e2e
  (never run). Its default policy is `conservador-live-v2`, not the v7 most accounts run.
- Waiting money already reaches the app: `funding.engine.waiting[]` with `code` and `amountUsdc`
  (`packages/domain/src/app-api.ts:108`). Codes: `DECIDE_WAIT_DEPTH`, `DECIDE_WAIT_GAS`, `DECIDE_WAIT_BRIDGE`,
  `DECIDE_WAIT_VAULT_LIQUIDITY`, `DECIDE_ENTRY_PAUSED_FALL`. On 5 Nov Ot removed the per-chain idle rows and reason
  sentences (`c8674dd2`): the idle line is one line.
- Bridge-out sizing (`packages/decide/src/allocate/index.ts:385-401`) takes `min(gap, free)`. It does not clip to the
  V3 grant's per-call cap (20 % of C) or to what is left of its total (50 % of C); `SessionObs` has `usesLeft` but no
  amount left.

## Requirements

- **CAP-R0** The `.cell-wt/376-cap-e2e` work is integrated whole as event work: new branch from `origin/main`, small
  commits, PR, review; the worktree is then removed and `#376` says why.
- **CAP-R1** The app shows the cap that holds the account: operator funding first; without the operator, the account
  override, else its active engine settings cap, else the code default, **clipped to the cap the account signed**
  (signed C unknown → no number shown). Never a fixed 100 when settings say otherwise, never a cap the account has not
  signed (that one is the renewal offer, `capRaise`).
- **CAP-R2** A fork e2e with 10,000 and 100,000 USDC deposits, under the prod engine settings and the policy new
  accounts get, shows: what fits is placed per pool by depth, what does not fit waits with its code, and Stop returns
  everything as USDC. Each run uses a signed cap equal to its deposit, so the spending windows bind as for a real
  renewed account. The log states, per run, how much waited and for which reason, and the run fails if the window wait
  that the policy limits predict is not logged.
- **CAP-R3** An account whose signed cap is below the current cap sees the renewal (one approval) and, after it, the
  new cap in funding and in the app.
- **CAP-R4** Ot writes an engine settings version with `capUsdc = 10000` (depth on) in beta, then in prod at the final
  cut. Proven by the **resolved** cap for a named account (operator `/metrics` + app funding), not by the D1 row alone.
- **CAP-R5** Bridge-out never asks for more than the grant allows: each send ≤ the per-call cap, and the sum stays
  within what is left of the grant's total, counting every move from `sending` on (and reverted or unknown ones) as
  spent. When the total is used up, or what is left cannot be read, the bucket waits with its own code instead of
  retrying (fail closed). V4 accounts have no such total (only `maxFee` ≤ 10 bps) and are unaffected. Circle's per-message limit
  (10,000,000 USDC, Base and Monad) is above every amount here.
- **CAP-R6** Money that is not placed says why in one short phrase on the existing idle line, linked to a public doc
  section, **only for two reasons: pool depth and pending renewal** (Ot and Brais, 6 Nov). Spending windows, the V3
  bridge limit and money above the cap have no UI message; they are logged by the operator. No paragraphs, no
  per-chain rows.

## Edge cases

- E1 Settings version above 100 without depth: refused by validation; operator keeps 100 and alerts (unchanged).
- E2 Account override (`account_cap_overrides`) present: it wins over settings, both in operator and app (CAP-R1).
- E3 Canary version naming the account: it wins over the environment version (same rule as the operator).
- E4 Deposit above the signed cap while running: the excess stays idle, reason "waiting for renewal" if a higher cap
  is available, else "above the cap".
- E5 D1 unreadable from the app: the default is a placeholder and the app shows no cap (unchanged, `known: false`).
- E6 V3 bridge total exhausted on a v7 account (500 USDC at C = 1,000): Monad share waits, code `DECIDE_WAIT_BRIDGE_LIMIT`,
  until the owner renews (a renewal signs a new total).
- E7 Beta and prod share D1 and the operator: the beta version applies to beta accounts only (`env`).

## Acceptance

- **ACC-1** (CAP-R2) `SCN-CAP-03` and `SCN-CAP-04` green, logs committed under `specs/011-mumbai-cap/results/`.
- **ACC-2** (CAP-R1) `SCN-CAP-01` green in `release:check`.
- **ACC-3** (CAP-R4) D1 read shows the 10,000 version active in beta and prod; `/metrics` shows no refused cap.
- **ACC-4** (CAP-R5) `SCN-CAP-06` green; the grant totals of live accounts read and recorded in `results/`.
- **ACC-5** (CAP-R3) a real account renews and then deposits more than 1,000 USDC, with tx links.

## Out of scope

Contracts and policies (no new grant, no new caps formula). The 1,000,000 cap (after the 100k proof). Landing code.
APY/APR changes. Moving live accounts to V4.
