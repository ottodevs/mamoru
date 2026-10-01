# Mamoru app

Public product repo. GitHub `ottodevs/mamoru` is the only push remote. Forgejo is fetch-only.

The closed architecture is `inputs/mamoru-spec-v1.md`. Do not reopen it. Accepted work lands on `main` by fast-forward. A branch exists only for the open slice, then it is deleted.

## Operating flow (post-hackathon)

Sprint mode (parallel lanes, deploy-during-build) ended 2026-09-27 with the ETHGlobal Tokyo submission. Fixes now go to production once tested, one unit at a time:

1. Branch per fix off `main`, one concern, at most ~12 files.
2. `bun run typecheck` and `bun test packages apps` pass locally (`bun run release:check` runs both plus the SPA build).
3. Push the branch. Codex `gpt-6-astra` reviews the commit; verdict is APTO or NO-GO. NO-GO: one fix commit on the same branch, review again. Do not stack unreviewed commits, do not open a pull request, do not squash.
4. Risky UI or API changes go to the `beta` branch first: `bun run deploy:beta` ships them to https://beta.mamoru.lol (same D1, same live operator as prod, opt-in testers, real funds) to soak before touching `main`.
5. APTO (and, for beta changes, soaked): fast-forward `main` and delete the branch. `bun run promote` does this fast-forward from `beta` and runs `deploy:prod`; `bun run deploy:prod` alone requires HEAD to already be `origin/main` on a clean tree. Never force-push, never force the fast-forward.
6. Every `deploy:prod` run appends a row to `docs/releases.md` (git sha, version id, previous version, smoke test result) and prints the `wrangler rollback <version>` command.

Release scripts live in `scripts/release/` (`release:check`, `deploy:beta`, `deploy:prod`, `promote`, wired in `package.json`). Forgejo stays fetch-only.

## Read before writing a spec

1. `inputs/mamoru-spec-v1.md`
2. `inputs/SKILLS.md`
3. `.agents/skills/mamoru-sdd/SKILL.md`
4. The skill files that `inputs/SKILLS.md` names for the piece you are specifying.

## Verify

A spec change is done when `specs/` and `.specify/memory/constitution.md` exist, tasks do not say "implement now", and `git status` shows no `src/` or `package.json` created by the spec pass.

An implementation unit is done when its commit is on `main` and the accepting scenarios for that task pass.
