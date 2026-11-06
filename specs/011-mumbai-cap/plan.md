# 011 plan: how

Spec: `spec.md`. All paths relative to the repo root. Line numbers as of `ethglobal-mumbai-start` (`c8674dd2`).

## 1. App cap read (CAP-R0, CAP-R1)

Take the worktree diff as is:
- `apps/mamoru-app/src/api/engine-settings.ts`: new `settingsCapOf(db, accountKey, env)`: newest canary naming the
  account, else newest environment-wide version of that `env`; `capBaseUnits(settings)` or `null`.
- `apps/mamoru-app/src/api/accounts/chain-funding.ts` `capOf`: override → `settingsCapOf` → fallback.
- `apps/mamoru-app/src/api/app.ts:40`: comment only, `LIVE_CAP_USDC` stays as the code default.
- `apps/mamoru-app/test/api/chain-funding.test.ts`: 3 tests (env version, canary over env + override over both,
  null cap → default).

The rule must match the operator's `resolveFor` (`apps/mamoru-operator/src/engine-settings.ts`). If they disagree on a
case (rollback rows, `rollback_of`), the operator wins and the test names the case.

## 2. Depth proof (CAP-R2)

- `packages/backtest/src/cap-depth.test.ts` + `packages/backtest/src/fixtures/base-pool-depth-53823027.json` +
  `apps/mamoru-operator/scripts/depth-fixture.ts` (regenerates the fixture from Base). Pure, runs in `release:check`.
  Expected today: 10k places almost all; 100k leaves ~22,512 waiting on stables depth; Stop returns all but 6–7 bps.
- `apps/mamoru-operator/test/e2e-depth.ts`: anvil fork of Base, operator booted with `MAMORU_DEPTH=30,500,5` and
  `MAMORU_CAP_USDC`. Changes before running: default `MAMORU_POLICY` = `conservador-live-v7`; after settle, log one
  summary line per waiting code (`waited code=… usdc=…`), plus every chain revert reason seen (`POLICY_DENIED_AMOUNT`,
  `BudgetExceeded`, `Cap24hExceeded`, `Cap30Exceeded`); then Stop and check USDC back ≥ deposit − 0.1 %.
  Add `"e2e:depth": "bun test/e2e-depth.ts"` to `apps/mamoru-operator/package.json`.
- Opt-in, not CI (cold fork, up to 10 min). Runs: `DEPOSIT_USDC=10000` and `DEPOSIT_USDC=100000`, output to
  `specs/011-mumbai-cap/results/e2e-depth-{10k,100k}.log` with the fork block and sha.
- V4 run (`MAMORU_POLICY` of the T8 policy) only if time allows: no live account is on V4.

## 3. Renewal (CAP-R3)

No new code expected: `capRaise` is computed (`operator.ts:2006`) and shown by the app. Verify with the existing
renewal flow on beta after CAP-R4 (one beta account at C = 1,000 → renew → funding `capUsdc` 10,000). If the app does
not surface `capRaise` on the home screen, that is a defect for T-CAP-05, not a new screen.

## 4. Settings (CAP-R4), ops, no code

Ot, in landing `/ops` → Engine settings: new version, env `beta`, template of the active one, `capUsdc: 10000`,
depth unchanged (`30/500/5`), reason "ETHGlobal Mumbai: cap 10k (#376)". Read back:
`wrangler d1 execute mamoru --remote --command "SELECT id, env, json_extract(settings_json,'$.capUsdc') cap, created_at FROM engine_settings_versions ORDER BY id DESC LIMIT 4"`
and operator `/metrics` `capRefused` empty. Same in `prod` at the final cut (PRD §7, 07:00 IST).

## 5. Bridge limit (CAP-R5)

- `packages/decide/src/types.ts` `SessionObs`: add `amountLeft?: bigint` and `perCall?: bigint` (absent = no cap,
  V4).
- `packages/decide/src/allocate/index.ts:385-401`: `amount = min(gap, free, perCall, amountLeft)`. If
  `amountLeft < entryMin` → `waiting.push({ code: 'DECIDE_WAIT_BRIDGE_LIMIT' })` and no proposal. Add the code to
  the `Waiting` union (`:39`) and `types.ts:438`.
- Operator fills both for the `bridge-out` grant of V3 accounts: `perCall` and `total` from
  `v4BudgetCaps(policy, signedCap)` (`operator.ts:7292` already does this for the remote spec), `amountLeft = total −
  sum of this approval's bridge-outs` from the bridge journal in `bridge-out.ts` (moves since the approval's
  `validAfter`, state ≥ `burned`). Lives in a new helper `apps/mamoru-operator/src/bridge-left.ts` + one call site in
  the observation builder of `operator.ts` (hot file: one small hunk).
- The return leg (Monad → Base, `returnDue`) runs on the remote Safe's own grant; same clipping there if its policy has
  a total (`policies-monad.ts`), else unchanged.
- Read of live totals for `results/`: operator state `remote.spec.capUsdc` per active account (6 Nov: 500 USDC on 7 v7
  accounts with a sleeve).

## 6. Waiting reason copy (CAP-R6), proposal for OK

On the one idle line of `apps/mamoru-app/src/web/routes/home.tsx`, after the amount, one phrase for the largest
waiting amount, linking to `docs/waiting.md#<anchor>` on GitHub:

| Code | Phrase (EN) | Anchor |
|---|---|---|
| over cap / `DEPOSIT_OVER_CAP` | Above your cap | `above-cap` |
| `capRaise` present | Waiting for renewal | `renewal` |
| `DECIDE_WAIT_DEPTH` | Waiting for pool depth | `depth` |
| `Cap24hExceeded` / `POLICY_DENIED_AMOUNT` window | Daily limit reached | `daily-limit` |
| `DECIDE_WAIT_BRIDGE_LIMIT` | Bridge limit reached | `bridge-limit` |
| other codes | (no phrase, as today) | — |

`docs/waiting.md`: one short paragraph per anchor. Mapping in a small pure module
`apps/mamoru-app/src/web/lib/waiting-reason.ts` with a test. Nothing ships without the OK in the thread.
Daily limit: the operator must surface it as a waiting code first: `DECIDE_WAIT_DAILY_LIMIT` when the last revert of
an entry was a window/budget denial and the window has not moved (T-CAP-07).

## 7. Sequences

Deposit 10k on a renewed v7 account: deposit seen → allocate by depth (stables, balance, Monad sleeve) → entries until
the 24 h window or depth stops them → rest in `waiting` with codes → next window, more entries. Monad share: bridge
per call ≤ 2,000 (20 % of 10k), total ≤ 5,000 per approval.

## 8. Failure modes

- Settings rule mismatch app vs operator → app shows a cap the operator does not apply. Mitigation: one shared test
  table of cases (§1).
- Journal under-counts a bridge-out → a send reverts `POLICY_DENIED_AMOUNT`; existing retry/backoff, and the next read
  corrects `amountLeft`. Never over-asks after the first revert because the revert is recorded as spent-unknown → wait.
- Fork e2e flakes on RPC: rerun once; record both.

## 9. Deploy notes

No D1 migration. Order: operator (CAP-R5, T-CAP-06/07) → app Worker (CAP-R1, R6) → settings version (Ot). Operator
redeploy by the coordinator only (`operator:deploy <sha>`), batched with 012 if both are ready. Beta first; prod at the
final cut without soak (`deploy:prod <sha> --min-soak-hours=0 --hotfix="ethglobal-mumbai"`, PRD decision 5).

## 10. Constitution check

- **I No custody / IX Explicit session:** the cap rises only through a renewal the owner signs; no grant widened. ✔
- **V Gates:** above 100 still requires depth sizing (unchanged refusal). ✔
- **XIII Reproducible scenarios:** fork block and sha in every log. ✔
- **XVI Truth on screen:** waiting money shows its reason; unknown cap shows no cap, never 100. ✔
- **XIX Cross-chain:** CCTP standard, fee 0, recipient fixed; bridge waits with a code when the grant total is used. ✔
- **XX Simplicity:** one phrase per reason, no new screens; bridge clip is `min()` + one code. ✔
