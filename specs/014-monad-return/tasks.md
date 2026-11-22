# 014 tasks (remaining after 41a0eb1c)

Rules for every task: own locked worktree from `origin/main`, branch `<type>/428-<slug>`, PR on GitHub,
`release:check` green, `review:pr` by a different model, merge by the coordinator. Must not, in every task: deploy,
touch D1 rows or secrets, change contracts, add an owner/module/guard to any Safe, or show anything new in the app
before Ot and Brais's OK (RH-09).

| Id | Reqs | Files (≤ 12) | Accepting scenario | Must not |
|---|---|---|---|---|
| T-RH-01 | RH-03 | `apps/mamoru-app/src/api/accounts/operator.ts` (`checkReturnHome`: on-chain USDC balance and enabled sessions on Monad), test | SCN-RH-01 | trust any address or amount from the request body |
| T-RH-02 | RH-02 | `packages/account/return-home/index.ts`, `apps/mamoru-operator/src/operator.ts` (removed set from chain + read-back after settle), tests | SCN-RH-01, SCN-RH-03 | remove a session the Safe did not enable |
| T-RH-03 | RH-07 | `packages/domain/src/app-api.ts` (`sell`), `packages/account/return-home/index.ts`, `apps/mamoru-operator/src/operator.ts` (`planReturnHome`), Worker TWAP floor in `apps/mamoru-app/src/api/accounts/operator.ts`, tests | SCN-RH-02, SCN-RH-09 | price at anything but the pool TWAP; sell when a position is open |
| T-RH-04 | RH-01, RH-06 | `packages/domain/src/app-api.ts` (`WhatsNew.policy` adds `'base-v8'`), `apps/mamoru-operator/src/operator.ts` (view + peer `return-home/status`), `apps/mamoru-operator/src/server.ts`, tests | SCN-RH-05, SCN-RH-06 | change the v4 `WhatsNew` path |
| T-RH-05 | RH-04, RH-05 | `apps/mamoru-operator/test/e2e-v8-move.ts`, `apps/mamoru-operator/test/e2e-return-home.ts`, `apps/mamoru-operator/package.json`, `results/` logs | SCN-RH-07, SCN-RH-08, SCN-RH-09 | run against a live chain; commit an RPC URL with a key |
| T-RH-06 | RH-09 | app screen and Home card (after the owners' OK only) | SCN-RH-06 (view), manual on beta | merge before both OKs; add lines beyond the approved copy |
| T-RH-07 | RH-10 | none (ops, coordinator): `base_v8` scope = b54dda3a on beta, then one prod account, then `*` | SCN-RH-10 | widen the scope before SCN-RH-10 passes on beta |
| T-RH-08 | all | none (ops): real-account run, evidence in `results/` | SCN-RH-10 | sign for a user |

Order: T-RH-01, T-RH-02, T-RH-03 (same files: stack them) → T-RH-04 → T-RH-05 → owners' OK → T-RH-06 → T-RH-07 →
T-RH-08. One operator redeploy for T-RH-02..04.
