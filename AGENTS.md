# Mamoru app

Public product repo. GitHub `ottodevs/mamoru` is the only push remote. Forgejo is fetch-only.

The closed architecture is `inputs/mamoru-spec-v1.md`. Do not reopen it. Accepted work lands on `main` by fast-forward. A branch exists only for the open slice, then it is deleted.

## Operating flow (post-hackathon)

Sprint mode (parallel lanes, deploy-during-build) ended 2026-09-27 with the ETHGlobal Tokyo submission. Fixes now go to production once tested, one unit at a time:

1. Branch per fix off `main`, one concern, at most ~12 files.
2. `bun run typecheck` and `bun test packages apps` pass locally (`bun run release:check` runs both plus the SPA build).
3. Push the branch. Codex `gpt-6-astra` reviews the commit; verdict is APTO or NO-GO. NO-GO: one fix commit on the same branch, review again. Do not stack unreviewed commits, do not open a pull request, do not squash.
4. Risky UI or API changes go to the `beta` branch first: `bun run deploy:beta` ships the exact commit at `origin/beta`'s tip to https://beta.mamoru.lol (same D1, same live operator as prod, opt-in testers, real funds) to soak before touching `main`. Beta is **not** the same account as prod: `__Host-` session cookies and the passkey RP ID are both scoped to the hostname, so beta always starts a fresh session with a fresh passkey (a new counterfactual Safe) on the shared backend. Do not change the passkey RP ID to "fix" this.
5. APTO (and, for beta changes, soaked): fast-forward `main` and delete the branch. `bun run promote [sha]` verifies `origin/beta`'s tip is a fast-forward of `origin/main` and pushes exactly that sha (never the local branch state), then runs `deploy:prod`; `bun run deploy:prod` alone always deploys `origin/main`'s current tip. Never force-push, never force the fast-forward.
6. Both deploy scripts build and deploy from an immutable detached-worktree snapshot of the exact sha (never the live working tree), so a dirty or unreviewed local branch can never reach a Worker. Every `deploy:prod` run appends a line to `~/.local/state/mamoru-app/releases.jsonl` (git sha, version id, previous version, smoke test result; path overridable via `MAMORU_RELEASE_LOG`) and prints the `wrangler rollback <version>` command, even if a post-deploy step throws.

Release scripts live in `scripts/release/` (`release:check`, `deploy:beta`, `deploy:prod`, `promote`, wired in `package.json`; `scripts/release/lib/*.test.ts` covers the SHA/fast-forward/env-scrubbing/log-path guards). Forgejo stays fetch-only.

## Read before writing a spec

1. `inputs/mamoru-spec-v1.md`
2. `inputs/SKILLS.md`
3. `.agents/skills/mamoru-sdd/SKILL.md`
4. The skill files that `inputs/SKILLS.md` names for the piece you are specifying.

## Verify

A spec change is done when `specs/` and `.specify/memory/constitution.md` exist, tasks do not say "implement now", and `git status` shows no `src/` or `package.json` created by the spec pass.

An implementation unit is done when its commit is on `main` and the accepting scenarios for that task pass.
