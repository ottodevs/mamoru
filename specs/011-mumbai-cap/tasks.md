# 011 tasks

Rules for every task: own worktree from `origin/main`, branch `<type>/376-<slug>`, PR on GitHub with label
`ethglobal-mumbai`, `release:check` green, `review:pr` by a different model, merge by the coordinator. Commits small,
human author, no model trailers. Must not, in every task: touch contracts or policies' grants, `mamoru-astro`, D1
schema, secrets, deploy anything.

Parallel groups: **A** (T-CAP-01, T-CAP-02, T-CAP-04) start at once. **B** (T-CAP-03) after T-CAP-02 merged.
**C** (T-CAP-05, T-CAP-06, T-CAP-07) start at once; T-CAP-07 stacks on T-CAP-06 if both touch `allocate/index.ts`.
**Ops** (T-CAP-08, T-CAP-09) after A and C are on beta.

| Id | Reqs | Files (≤ 12) | Accepting scenario | Must not |
|---|---|---|---|---|
| T-CAP-01 | R0, R1 | `apps/mamoru-app/src/api/engine-settings.ts`, `apps/mamoru-app/src/api/accounts/chain-funding.ts`, `apps/mamoru-app/src/api/app.ts`, `apps/mamoru-app/test/api/chain-funding.test.ts` (from `.cell-wt/376-cap-e2e`) | SCN-CAP-01 | change the operator; change `LIVE_CAP_USDC` value |
| T-CAP-02 | R0, R2 | `packages/backtest/src/cap-depth.test.ts`, `packages/backtest/src/fixtures/base-pool-depth-53823027.json`, `apps/mamoru-operator/scripts/depth-fixture.ts` | SCN-CAP-02 | change engine sizing to make it pass |
| T-CAP-03 | R0, R2 | `apps/mamoru-operator/test/e2e-depth.ts`, `apps/mamoru-operator/package.json`, `specs/011-mumbai-cap/results/e2e-depth-{10k,100k}.log` | SCN-CAP-03, SCN-CAP-04 | run against a live chain; commit an RPC URL with key |
| T-CAP-04 | R0 | none (ops): after T-CAP-01..03 merged, `git worktree unlock` + `remove` `.cell-wt/376-cap-e2e`, comment on #376 | — | `git worktree prune`; remove other worktrees |
| T-CAP-05 | R6 | `apps/mamoru-app/src/web/lib/waiting-reason.ts` (+test), `apps/mamoru-app/src/web/routes/home.tsx` (idle line only), `docs/waiting.md` | SCN-CAP-08 | merge before Ot+Brais OK on copy; add rows, per-chain lines or paragraphs |
| T-CAP-06 | R5 | `packages/decide/src/types.ts`, `packages/decide/src/allocate/index.ts` (+test), `apps/mamoru-operator/src/bridge-left.ts` (+test), `apps/mamoru-operator/src/operator.ts` (one hunk in the observation builder) | SCN-CAP-06, SCN-CAP-07 | change grants or caps formulas; touch `packages/domain` beyond the code union |
| T-CAP-07 | R6 | `packages/decide/src/allocate/index.ts` or `packages/decide/src/types.ts` (code), operator revert → waiting mapping (one hunk), tests | SCN-CAP-09 | retry a denied entry inside the same window |
| T-CAP-08 | R4 | none (ops, Ot): beta settings version cap 10000; D1 + `/metrics` read recorded in `results/settings-beta.md` | SCN-CAP-10 | write prod before the final cut |
| T-CAP-09 | R3, R4 | none (ops): beta renewal, then at the final cut prod version + one real renewal and deposit > 1,000; evidence `results/prod-cap.md` | SCN-CAP-05, SCN-CAP-11 | force a renewal for users |

Order of merge: T-CAP-01, T-CAP-02 → T-CAP-03 → T-CAP-06 → T-CAP-07 → T-CAP-05 (after copy OK). Operator redeploy once
for T-CAP-06 + T-CAP-07 (batched with 012 when ready).
