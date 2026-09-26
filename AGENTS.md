# Mamoru app

Public product repo. GitHub `ottodevs/mamoru` is the only push remote. Forgejo is fetch-only.

The closed architecture is `inputs/mamoru-spec-v1.md`. Do not reopen it. Accepted work lands on `main` by fast-forward. A branch exists only for the open slice, then it is deleted.

## Sprint mode (until 2026-09-27 02:00 CEST, ETHGlobal Tokyo submission)

Ot approved this on 2026-09-26. It overrides "One unit" and the deploy ban in `tasks.md` rule 5 until the deadline. Everything else in the spec still holds: no signing or sending on Base, funds gate closed, `CORE_DRY_RUN=true`, no keys in the repo, no `wrangler.toml`.

Five lanes run in parallel. Each lane has one worktree and one branch `lane/<name>`, and writes only inside its paths. Only the integrator (L0) pushes `main` and deploys.

| Lane | Owns |
|---|---|
| L0 integrator | `packages/domain/src/dashboard-payload.ts`, `packages/domain/src/app-api.ts`, `AGENTS.md`, deploys |
| L1 engine lab (T003) | `packages/{journal,decide,rpc,erc4337,projector}/`, quote part of `packages/uniswap-v3/`, `packages/scenarios/{driver,bundler}/`, T003 entries in `scenarios/catalog/` |
| L2 SPA | `apps/mamoru-app/{index.html,vite.config.ts,package.json,tsconfig.json,src/web/**,test/e2e/**}` |
| L3 API and onboarding | `apps/mamoru-app/{wrangler.jsonc,src/api/**,src/worker.ts,test/api/**}`, `migrations/d1/**`, `packages/account/proofs/` |
| L4 Base read model | `apps/mamoru-engine/**`, `packages/multibaas/**`, `scripts/multibaas/**` |

- The SPA and the API meet only through `@mamoru/domain` (`DashboardPayload`, `app-api.ts`). A lane that needs a new field asks L0.
- Push your lane branch after each green step. Never push `main`. Never force-push.
- Before a push: `bun run typecheck` and `bun test` pass, and scenarios accepted before stay green.
- L0 rejects a branch that touches files outside its lane.

## Now

T002 is the open task, from `specs/001-mamoru-v1/tasks.md`. The owner walkaway batch and recovery kit are on `main` at `1d75734`. The next slice is still T002: WALK-01 and WALK-04. Do not start T003. Do not deploy. Do not push Forgejo.

## One unit

The next task stays off `main` until its review passes. One task, then stop.

1. Implement only the open slice of that task from `tasks.md`. One writer at a time, in turn: Cursor Agent `--model claude-opus-5-5-high`, or Claude Code `--model claude-opus-5-5 --effort high`. Only the files that slice needs. One concern, at most 12 files.
2. One short commit on a branch that exists for that slice alone. Push it to GitHub. Do not start another slice on that branch.
3. Codex `gpt-6-astra` at medium reviews that commit. Verdict is APTO or NO-GO. It does not rewrite the commit.
4. NO-GO: one fix commit on the same branch, then review again. APTO: fast-forward `main` and delete the branch.
5. Only then take the next slice. The next task starts when Ot says so.

Do not stack a phase of unreviewed commits. Do not open a pull request. Do not squash. Forgejo stays fetch-only.

## Read before writing a spec

1. `inputs/mamoru-spec-v1.md`
2. `inputs/SKILLS.md`
3. `.agents/skills/mamoru-sdd/SKILL.md`
4. The skill files that `inputs/SKILLS.md` names for the piece you are specifying.

## Verify

A spec change is done when `specs/` and `.specify/memory/constitution.md` exist, tasks do not say "implement now", and `git status` shows no `src/` or `package.json` created by the spec pass.

An implementation unit is done when its commit is on `main` and the accepting scenarios for that task pass.
