# 012 tasks: full harvest (r2)

Spec `spec.md`, plan `plan.md`, scenarios `scenarios.md`. Ticket otto/mamoru#107 (subtasks as its checklist).
Shared-file order across 011/012/013: `specs/mumbai-execution.md` (it wins over this file if they disagree).
Every task: own locked worktree, PR with label `ethglobal-mumbai`, `release:check` green, two-reviewer gate for decide
and operator tasks, merge by the coordinator. No `Co-Authored-By` or model lines. No contract, registry or secret
change. No deploy from a task.

## Branches

- **HT1** branches from 011 T-CAP-06's branch (it edits `packages/decide/src/types.ts`); `packages/domain` too.
- **HT2** branches from HT1. **HT3** branches from HT2. (`types.ts`/`allocate/index.ts`: T-CAP-06 → HT1 → HT2 → HT3.)
- **HT4** (tests on decide) branches from HT3.
- **HT5** (`operator.ts`) branches from the 011 operator branch (T-CAP-06), after HT1 merges into it.
- **HT6** (`yield-receipts.ts`, `snapshot.ts`; and `state.ts` facts) branches from **HT5** (both edit `state.ts`), so
  the serialized state carries HT5's `harvested`/`returnedAt`; 013 B4 branches from HT6.
- **HT7** (`yield-ledger.ts`, migration, earned module) from HT6; 013 B1 branches from HT7, 013 B5 from B1.
- **HT8** (UI marker) from HT7. **HT9** (V3 Monad check) from `origin/main`, read-only first. **HT10** last.

Each later task is rebased when its parent merges; the coordinator merges in this order.

## Tasks

| Id | What | Files | Reqs | Accepts | Must not |
|---|---|---|---|---|---|
| HT1 | Types and codes | `packages/domain/src/reason-codes.ts` (`DECIDE_WAIT_BUDGET`, `DECIDE_WAIT_HARVEST_SALE`, `DECIDE_WAIT_RENEWAL`), `packages/domain/src/app-api.ts` (`earnedStatus`, `notCounted`), `packages/decide/src/types.ts` (`harvested`, `budget`, `remote.idle/idleSince`, `harvestSale` flag) | R1 R4 R7 R10 | typecheck | change existing meanings |
| HT2 | Harvest sale + room check | `packages/decide/src/harvest/index.ts`, `packages/decide/src/index.ts` (precedence), `packages/decide/src/rerange/index.ts` (principal-only balance), `packages/decide/src/allocate/index.ts` (principal-only balance, room gate), tests | R1 R2 R7 | S02 S03 S04 S05 | gate exit/rerange/harvest/reduce/redeem; sell more than `min(harvested, balance)` |
| HT3 | Sweep + idle-USDC return + anti ping-pong | `packages/decide/src/allocate/index.ts`, `packages/decide/src/vault.test.ts`, `allocate.test.ts` | R3 R4 | S06 S10 S11 S12 S18 | change `DRIFT_BPS`, band or `vaultMinDeposit`; touch `waiting` money |
| HT4 | Live-policy unit checks | `packages/decide/src/harvest.test.ts` | R11 | unit part of S13 | change source |
| HT5 | Operator: `harvested` bookkeeping, `budget` read, `remote.idle/idleSince`, `returnedAt`, V4 revert decode | `apps/mamoru-operator/src/operator.ts` (observation builder, one hunk; revert decode, one hunk), `apps/mamoru-operator/src/session-usage.ts`, `apps/mamoru-operator/src/state.ts` (`harvested`, `returnedAt`), tests | R1 R2 R4 R7 | S16 S17 S21 | more than one `budgetLeft` read per account per review; touch bridge-out sizing |
| HT6 | Receipts: Collect events per log, ERC-4626 Deposit/Withdraw (owner = Safe), sale amounts | `apps/mamoru-operator/src/yield-receipts.ts`, `apps/mamoru-operator/src/snapshot.ts` (vault samples + flows on the wire), tests | R1 R5 R9 | S07 S08 | RPC reads outside the receipt path |
| HT7 | Event ledger + earned module | `migrations/d1/XXXX_income_events.sql`, `apps/mamoru-app/src/api/yield-ledger.ts`, `apps/mamoru-app/src/api/earned.ts` (new), `apps/mamoru-app/src/api/accounts/yield.ts`, tests | R5 R9 R10 | S09 S19 S22 S24 | rewrite other tables' rows |
| HT8 | Portfolio "not counted" marker | `apps/mamoru-app/src/web/routes/home.tsx` (`<Earned>`), its component file, test; copy in the PR for OK | R10 | S15 | other UI changes; merge without Ot+Brais OK on the copy |
| HT9 | V3 Monad return: check, then implement or record | read: `scripts/` one-off reader on a fork of live state; then `packages/decide/src/allocate/index.ts` remote branch (stacked after HT3) if a session exists | R4 R11 | S14 | enable a grant; change a policy file; contract change |
| HT10 | Fork e2e + live reconciliations | `apps/mamoru-operator/test/e2e-harvest.ts` (new), `scripts/reconcile-vault-basis.ts` (new, read-only), `specs/012-mumbai-harvest/results/*.md` | R1 R3 R5 R11 | S01 S13 S20; S21 after prod | send on mainnet; write to prod D1 |

## Deploy (coordinator)

Migration → operator redeploy (one per block) → app Worker on beta. Prod with the hackathon batch; S21 recorded after.
