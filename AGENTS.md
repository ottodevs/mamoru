# Mamoru app

Public product repo. GitHub `ottodevs/mamoru` is the only push remote. Forgejo is fetch-only.

The closed architecture is `inputs/mamoru-spec-v1.md`. Do not reopen it. Accepted work lands on `main` by fast-forward. A branch exists only for the open slice, then it is deleted.

## Operating flow

Several agents and sessions work on this repo at once. The rules below keep them from overlapping. They replace the earlier "no pull request, fast-forward yourself" flow.

### Roles

- **Author**: any agent or person doing one unit of work. Never pushes `main` or `beta`, never merges their own pull request, never deploys, never touches the live operator, D1 or Worker secrets.
- **Coordinator**: one session at a time. Reviews, merges, numbers migrations, cuts releases, restarts the operator. Whoever holds the ticket with key `mamoru-release-coordinator` in status `doing` (`tk list --project otto/mamoru --key mamoru-release-coordinator`). Hand over by commenting on that ticket.

### One unit of work

1. **Ticket first.** One Forgejo ticket per unit (`tk add` / `tk status <id> doing`). `doing` is the claim: do not start on a ticket someone else holds.
2. **Check for overlap.** `gh pr list -R ottodevs/mamoru` and look at the files of the open pull requests (`gh pr diff <n> --name-only`). If your unit touches the same files, stack your branch on that pull request's branch or wait, and say so in your ticket. Hot files that almost always overlap: `apps/mamoru-operator/src/operator.ts`, `packages/domain/src/*`, `packages/registry/src/index.ts`, `AGENTS.md`, `package.json`.
3. **Own worktree, own branch.** `git worktree add ~/.cursor/worktrees/mamoru/<slug> -b <type>/<ticket>-<slug> origin/main`. The canonical checkout at `~/box/src/mamoru.workspace/mamoru` stays on a clean `main`: it is only for the coordinator's release scripts. No work, no commits and no branch switches there.
4. **One concern, small.** At most about 12 files unless the ticket says otherwise. `bun run release:check` passes (typecheck, tests, SPA build).
5. **Pull request on GitHub** (`gh pr create -R ottodevs/mamoru --base main`). The body has: the ticket link, the paths it touches, what was tested and what was not, risk, and **deploy notes** (D1 migration, new secret, operator restart, order of deploys). A migration file is added as `migrations/d1/NNNN_<name>.sql` with `NNNN` left as `XXXX`: the coordinator gives it its number at merge.
6. **Independent review.** A model different from the one that wrote the code reviews the pull request (Codex `gpt-6-astra`, or `cursor-agent --mode ask` with a GPT model when Codex has no quota). The verdict, `APTO` or `NO-GO` with findings, is posted as a pull request comment. `NO-GO`: fix commits on the same branch, review again. A reviewer's finding that predates the branch becomes a ticket, and the coordinator records that it was accepted.
7. **Merge by the coordinator**, with "Rebase and merge" so `main` stays linear (no squash, no merge commits, never force-push `main`). The branch is deleted and the worktree removed (`git worktree remove`). The ticket moves to `done` when the change is live, not at merge.

### Releases

Only the coordinator runs these, one release at a time, and each is announced in Mattermost `#mamoru` by `@mamorusan` and logged:

- App: `bun run deploy:beta` (exact tip of `origin/beta`, https://beta.mamoru.lol) and `bun run deploy:prod` / `bun run promote [sha]` (exact tip of `origin/main`). Both build from an immutable snapshot of the sha, smoke-test, write `~/.local/state/mamoru-app/releases.jsonl` and print the rollback command.
- Risky UI or API changes soak on beta first. Beta shares D1 and the live operator with production (real funds) but is **not** the same account: session cookies and the passkey RP ID are scoped to the hostname. Do not change the RP ID.
- D1 migrations: additive only, applied by the coordinator before the Worker that needs them.
- Operator: one process, one owner. It holds session keys and the relayer nonce; two operators at once corrupt both. Only the coordinator stops, starts or redeploys it, and says so in the tracking thread first.
- A release is a batch of merged pull requests. If two pull requests need an order (operator before app, migration before Worker), the deploy notes say it and the coordinator follows it.

Release scripts live in `scripts/release/`. Tickets live in Forgejo (`otto/mamoru`); code and pull requests live on GitHub (`ottodevs/mamoru`), which is the only push remote. Forgejo stays fetch-only.

## Read before writing a spec

1. `inputs/mamoru-spec-v1.md`
2. `inputs/SKILLS.md`
3. `.agents/skills/mamoru-sdd/SKILL.md`
4. The skill files that `inputs/SKILLS.md` names for the piece you are specifying.

## Verify

A spec change is done when `specs/` and `.specify/memory/constitution.md` exist, tasks do not say "implement now", and `git status` shows no `src/` or `package.json` created by the spec pass.

An implementation unit is done when its commit is on `main` and the accepting scenarios for that task pass.
