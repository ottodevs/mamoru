# Mumbai execution order (specs 011, 012, 013)

> **Status 7 Nov:** all three blocks merged and in production (app `44b971b0`, operators `5e06f9c0`). In the last hours the team skipped the CI wait to meet the deadline; the stacking order above held.

Priority: 011 cap, then 012 harvest, then 013 stats. Work runs in three blocks with a checkpoint after each; a block that runs long moves the next, never the order.

| Block | IST (6–7 Nov) | Contents | Checkpoint |
|---|---|---|---|
| B1 | 23:30–02:30 | 011 all tasks; 013 Phase D (design) in parallel | 011 on beta, Ot writes cap 10,000 on beta; mockups OK from Ot and Brais |
| B2 | 01:00–05:00 | 012 all tasks; 013 Phase B (data) | 012 fork e2e green, on beta |
| B3 | 01:30–05:30 | 013 Phase U (UI), only after the mockup OK | `/stats` on beta, checked at 1280 and 390 |
| — | 05:30–07:00 | Ot and Brais test everything on beta | GO |
| — | 07:00–07:30 | One production release of the whole event range | cap 10,000 written in production |

## Shared files: one branch at a time

Tasks that edit the same file stack in this order, across specs and within one: the later task **branches from the earlier task's branch** (never from `origin/main` while the earlier one is unmerged) and is rebased when it merges. The coordinator merges in the same order.

| File | Order |
|---|---|
| `packages/decide/src/types.ts`, `packages/decide/src/allocate/index.ts` | 011 T-CAP-06 → 012 HT1 → 012 HT2 → 012 HT3 |
| `apps/mamoru-operator/src/operator.ts` | 011 (T-CAP-06 operator part) → 012 HT5. 013 does not touch it |
| `apps/mamoru-operator/src/state.ts` | 011 T-CAP-06 → 012 HT5 → 012 HT6 → 013 B4 |
| `apps/mamoru-operator/src/yield-receipts.ts` | 012 HT6 → 013 B4 |
| `apps/mamoru-app/src/api/yield-ledger.ts` | 012 HT7 → 013 B1 → 013 B5 |

Migrations are written as `XXXX_*.sql`; the coordinator numbers them at merge in merge order. Operator changes from all three specs share redeploys: one to beta per block, one to production at the end.

## Rules for every task

Own locked worktree from `origin/main`, one pull request with label `ethglobal-mumbai`, small commits by a human author, no `Co-Authored-By` or model lines. Review by a model from a different vendor (`bun run review:pr`); funds-touching tasks (011 T-CAP-05..07, 012 all decide and operator tasks) get the two-reviewer gate. Merge and deploy only by the coordinator. A task is done when its scenario passes.
