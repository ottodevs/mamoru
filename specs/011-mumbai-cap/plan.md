# 011 plan: how

Spec: `spec.md`. All paths relative to the repo root. Line numbers as of `ethglobal-mumbai-start` (`c8674dd2`).

## 1. App cap read (CAP-R0, CAP-R1)

Take the worktree diff as is:
- `apps/mamoru-app/src/api/engine-settings.ts`: new `settingsCapOf(db, accountKey, env)`: newest canary naming the
  account, else newest environment-wide version of that `env`; `capBaseUnits(settings)` or `null`.
- `apps/mamoru-app/src/api/accounts/chain-funding.ts` `capOf`: override → `settingsCapOf` → fallback, **then
  clipped to the account's signed cap** (the C in its stored grant/spec row) when known: shown cap =
  `min(settings cap, signed C)`. Signed C unknown → `capKnown: false` and no number (never the settings cap alone), so
  an account signed at 1,000 never sees 10,000 before it renews; `capRaise` carries the 10,000 offer.
- `apps/mamoru-app/src/api/app.ts:40`: comment only, `LIVE_CAP_USDC` stays as the code default.
- `apps/mamoru-app/test/api/chain-funding.test.ts`: the worktree's 3 tests plus: signed 1,000 with settings 10,000
  → 1,000 and `capRaise`; signed unknown → `capKnown: false`; rollback row → the version `resolveFor` picks.

The rule must match the operator's `resolveFor` (`apps/mamoru-operator/src/engine-settings.ts`). If they disagree on a
case (rollback rows, `rollback_of`), the operator wins and the test names the case.

## 2. Depth proof (CAP-R2)

- `packages/backtest/src/cap-depth.test.ts` + `packages/backtest/src/fixtures/base-pool-depth-53823027.json` +
  `apps/mamoru-operator/scripts/depth-fixture.ts` (regenerates the fixture from Base). Pure, runs in `release:check`.
  Expected today: 10k places almost all; 100k leaves ~22,512 waiting on stables depth; Stop returns all but 6–7 bps.
- `apps/mamoru-operator/test/e2e-depth.ts`: anvil fork of Base, operator booted with `MAMORU_DEPTH=30,500,5` and
  `MAMORU_CAP_USDC` **equal to the deposit** (C = 10,000 for the 10k run, C = 100,000 for the 100k run: the signed
  cap a real renewed account would have, so the spending windows bind as in production). Changes before running:
  default `MAMORU_POLICY` = `conservador-live-v7`; after settle, log one summary line per waiting code
  (`waited code=… usdc=…`) and every chain revert reason seen (`POLICY_DENIED_AMOUNT`, `BudgetExceeded`,
  `Cap24hExceeded`, `Cap30Exceeded`). Asserts: (a) placed + waiting + idle = deposit ± gas; (b) the expected window
  wait computed from the policy's own window limits for C (helper reads them from `policies-v7.ts`): if required entries
  + swaps exceed the window, the window denial (revert reason in the log, decoded by 012 HT5 or as raw selector) must be logged with at least that excess waiting, else the run fails; (c) Stop
  returns USDC ≥ deposit − 0.1 %.
  Add `"e2e:depth": "bun test/e2e-depth.ts"` to `apps/mamoru-operator/package.json`.
- Opt-in, not CI (cold fork, up to 10 min). Runs: `DEPOSIT_USDC=10000` and `DEPOSIT_USDC=100000`, output to
  `specs/011-mumbai-cap/results/e2e-depth-{10k,100k}.log` with the fork block and sha.
- V4 run (`MAMORU_POLICY` of the T8 policy) only if time allows: no live account is on V4.

## 3. Renewal (CAP-R3)

No new code expected: `capRaise` is computed (`operator.ts:2006`) and shown by the app. Verify with the existing
renewal flow on beta after CAP-R4 (one beta account at C = 1,000 → renew → funding `capUsdc` 10,000). If the app does
not surface `capRaise` on the home screen, that is a defect for T-CAP-05, not a new screen.

## 4. Settings (CAP-R4), ops, no code

Ot, in landing `/ops` (no landing code change) → Engine settings: new version, env `beta`, template of the active one, `capUsdc: 10000`,
depth unchanged (`30/500/5`), reason "ETHGlobal Mumbai: cap 10k (#376)". Read back:
`wrangler d1 execute mamoru --remote --command "SELECT id, env, json_extract(settings_json,'$.capUsdc') cap, created_at FROM engine_settings_versions ORDER BY id DESC LIMIT 4"`
The row alone does not prove the cap is effective (rollback rows, canaries). The proof is the **resolved** value:
operator `/metrics` per-account `settingsVersion` + `capUsdc` for a named beta account, and the app funding endpoint for
the same account returning `capRaise.capUsdc` = 10,000 (before renewal) and `capUsdc` = 10,000 (after). `capRefused`
empty. Same in `prod` at the final cut (PRD §7, 07:00 IST).

## 5. Bridge limit (CAP-R5)

- `packages/decide/src/types.ts` `SessionObs`: add `bridgeLimit: { kind: 'v3'; perCall: bigint; amountLeft: bigint }
  | { kind: 'none' } | { kind: 'unknown' }`. **Fail closed:** `none` only for V4 policies (set from the policy family,
  not from absence); `unknown` (journal read failed, policy variant not mapped) → no bridge proposal, waiting
  `DECIDE_WAIT_BRIDGE_LIMIT`.
- `packages/decide/src/allocate/index.ts:385-401`: `amount = min(gap, free, perCall, amountLeft)`. If
  `amountLeft < entryMin` → `waiting.push({ code: 'DECIDE_WAIT_BRIDGE_LIMIT' })` and no proposal. Add the code to
  the `Waiting` union (`:39`) and `types.ts:438`.
- Operator fills both for the `bridge-out` grant of V3 accounts: `perCall` and `total` from
  `v4BudgetCaps(policy, signedCap)` (`operator.ts:7292` already does this for the remote spec), `amountLeft = total −
  sum of this approval's bridge-outs` from the bridge journal in `bridge-out.ts` (moves since the approval's
  `validAfter`, **every move from `sending` on counts**: sending, sent, burned, minted, done, and any reverted or
  unknown-outcome move counts as spent until its receipt proves otherwise; moves never broadcast, and moves whose receipt
  shows a revert, are excluded). Lives in a new helper `apps/mamoru-operator/src/bridge-left.ts` + one call site in
  the observation builder of `operator.ts` (hot file: one small hunk).
- The return leg (Monad → Base, `askReturn`) only runs for V4 accounts today: its first guard is
  `!this.onV4(acc) → return` (`operator.ts:6371`, verified at `c8674dd2`), and V4 has no bridge total: nothing to clip
  in 011. T-CAP-06 adds a guard test (SCN-CAP-13) so a later change cannot open it to V3 without the clip. The V3 Stop
  path is not changed by 011. If 012 or later enables returns for V3, it must reuse `bridgeLimit` on the
  remote grant (stated as a must in 012).
- Read of live totals for `results/`: operator state `remote.spec.capUsdc` per active account (6 Nov: 500 USDC on 7 v7
  accounts with a sleeve).

## 6. Waiting reason copy (CAP-R6)

Decision (Ot and Brais, 6 Nov 17:16Z): the UI names only two reasons. Spending windows, the V3 bridge limit and
"above the cap" get **no UI message** (the limits go away soon); they stay in the operator log only.

On the one idle line of `apps/mamoru-app/src/web/routes/home.tsx`, after the amount, one phrase for the largest
waiting amount, linking to `docs/waiting.md#<anchor>` on GitHub:

| Source | Phrase (EN) | Anchor |
|---|---|---|
| `capRaise` present | Waiting for renewal | `renewal` |
| `DECIDE_WAIT_DEPTH` | Waiting for pool depth | `depth` |
| any other code | (no phrase, as today) | — |

`docs/waiting.md`: one short paragraph per anchor. Mapping in a small pure module
`apps/mamoru-app/src/web/lib/waiting-reason.ts` with a test. Phrases approved in principle; final wording shown in
the PR for OK.

## 7. Sequences

Deposit 10k on a renewed v7 account: deposit seen → allocate by depth (stables, balance, Monad sleeve) → entries until
the 24 h window or depth stops them → rest in `waiting` with codes → next window, more entries. Monad share: bridge
per call ≤ 2,000 (20 % of 10k), total ≤ 5,000 per approval.

## 8. Failure modes

- Settings rule mismatch app vs operator → app shows a cap the operator does not apply. Mitigation: one shared test
  table of cases (§1).
- A bridge-out with no receipt yet is an unknown-outcome move and counts as spent (SCN-CAP-12a). A receipt-proven
  revert spent nothing and stops counting (SCN-CAP-12b). A `POLICY_DENIED_AMOUNT` revert also means the journal and the
  chain disagree, so the grant goes to `bridgeLimit.kind = 'unknown'` (wait, `DECIDE_WAIT_BRIDGE_LIMIT`) until
  `bridge-left.ts` rebuilds the spent total from the chain: the Safe's CCTP `DepositForBurn` logs since the approval's
  `validAfter`. Then `amountLeft` = total − (that on-chain sum + every journal move broadcast but not yet in those logs),
  and bridging resumes. Implemented in T-CAP-06.
- A spending-window revert on an entry or swap (V4 `Cap24hExceeded`/`Cap30Exceeded`/`BudgetExceeded`, V3
  `POLICY_DENIED_AMOUNT`), on any op that spends (entry, swap, vault deposit): the operator backs off **every
  spending op** for that account and chain until the window can have moved, logging the reason once. 24 h window
  (`Cap24hExceeded`): until 24 h after the oldest spend in it. 30-day or budget (`Cap30Exceeded`, `BudgetExceeded`):
  until the oldest spend in the 30 days is 30 days old when the journal knows it, else one re-probe per 24 h (at most one
  revert a day). Unknown window (V3 `POLICY_DENIED_AMOUNT`): one re-probe per 24 h. Exits, collects and redeems are not
  spends and are never held back. No retry inside the window, no UI
  message (owners' decision). T-CAP-07.
- Fork e2e flakes on RPC: rerun once; record both.

## 9. Deploy notes

No D1 migration. Order: operator (CAP-R5, T-CAP-06, T-CAP-07) → app Worker (CAP-R1, R6) → settings version (Ot). Operator
redeploy by the coordinator only (`operator:deploy <sha>`), batched with 012 if both are ready. Beta first; prod at the
final cut without soak (`deploy:prod <sha> --min-soak-hours=0 --hotfix="ethglobal-mumbai"`, PRD decision 5).

## 10. Constitution check

- **I No custody / IX Explicit session:** the cap rises only through a renewal the owner signs; no grant widened. ✔
- **V Gates:** above 100 still requires depth sizing (unchanged refusal). ✔
- **XIII Reproducible scenarios:** fork block and sha in every log. ✔
- **XVI Truth on screen:** waiting money shows its reason; unknown cap shows no cap, never 100. ✔
- **XIX Cross-chain:** CCTP standard, fee 0, recipient fixed; bridge waits with a code when the grant total is used. ✔
- **XX Simplicity:** one phrase per reason, no new screens; bridge clip is `min()` + one code. ✔
