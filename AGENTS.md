# Mamoru app

Public product repo. GitHub `ottodevs/mamoru` is the only push remote. Forgejo is fetch-only.

The closed architecture is `inputs/mamoru-spec-v1.md`. Do not reopen it. Accepted work lands on `main` by fast-forward. A branch exists only for the open slice, then it is deleted.

## Operating flow

Several agents and sessions work on this repo at once. The rules below keep them from overlapping. They replace the earlier "no pull request, fast-forward yourself" flow.

### Roles

- **Author**: any agent or person doing one unit of work. Never pushes `main` or `beta`, never merges their own pull request, never deploys, never touches the live operator, D1 or Worker secrets.
- **Coordinator**: one session at a time. Merges, numbers migrations, cuts releases, redeploys the operator. It is whoever holds the **coordinator lease**: `bun run coord status`. Claim it with `bun run coord claim --as <your session name> --note "<what you will do>"` (your name is the one ListAgents gives you, e.g. `noema-7a`), give it back with `bun run coord release --as <name>` when done. It lapses after 3 h without use, so a session that died blocks nobody. `take --reason` takes a live one and says so; use it only when the holder is gone or agreed. `merge-pr.sh`, `deploy:beta`, `deploy:prod` and `operator:deploy` refuse without it (they read `MAMORU_COORD_AS`). Claims, hand-overs and every operator redeploy are written on `otto/mamoru#83`, the tracking thread. Need something merged or released and you are not the coordinator: ask on #83; do not do it yourself.

### One unit of work

1. **Ticket first.** One Forgejo ticket per unit (`tk add` / `tk status <id> doing`). `doing` is the claim: do not start on a ticket someone else holds.
2. **Check for overlap.** `gh pr list -R ottodevs/mamoru` and look at the files of the open pull requests (`gh pr diff <n> --name-only`). If your unit touches the same files, stack your branch on that pull request's branch or wait, and say so in your ticket. Hot files that almost always overlap: `apps/mamoru-operator/src/operator.ts`, `packages/domain/src/*`, `packages/registry/src/index.ts`, `AGENTS.md`, `package.json`.
3. **Own worktree, own branch.** `git worktree add ~/.cursor/worktrees/mamoru/<slug> -b <type>/<ticket>-<slug> origin/main`. The canonical checkout at `~/box/src/mamoru.workspace/mamoru` stays on a clean `main`: it is only for the coordinator's release scripts. No work, no commits and no branch switches there.
4. **One concern, small.** At most about 12 files unless the ticket says otherwise. `bun run release:check` passes (typecheck, tests, SPA build).
5. **Pull request on GitHub** (`gh pr create -R ottodevs/mamoru --base main`). CI runs `release:check` on it. The body follows `.github/pull_request_template.md`: the ticket link, the paths it touches, what was tested and what was not, risk, and **deploy notes** (D1 migration, new secret, operator restart, order of deploys). A migration file is added as `migrations/d1/NNNN_<name>.sql` with `NNNN` left as `XXXX`: the coordinator gives it its number at merge.
6. **Independent review.** A model different from the one that wrote the code reviews the pull request: `bun run review:pr <n>`. It waits its turn (one Codex review at a time across every session; never start `codex exec` by hand beside it), reviews the diff GitHub has for the PR (never a local `git diff`, whose refs move under other sessions), alternates `gpt-6-sol` and `gpt-6-astra` by the seat's quota, and posts the verdict on the PR. When the Codex seat is out, review on another seat by hand and say which. The verdict, `APTO` or `NO-GO` with findings, is posted as a pull request comment. `NO-GO`: fix commits on the same branch, review again. A reviewer's finding that predates the branch becomes a ticket, and the coordinator records that it was accepted.
7. **Merge by the coordinator**, with "Rebase and merge" so `main` stays linear (no squash, no merge commits, never force-push `main`). The branch is deleted and the worktree removed (`git worktree remove`). The ticket moves to `done` when the change is live, not at merge.

### Releases

The path from `main` to beta to production, the soak and the rollback are in [`docs/process/releasing.md`](docs/process/releasing.md). `main` is reviewed and merged, not released: `beta` is a pointer the coordinator fast-forwards to a sha of `main`, and production gets the sha that soaked there.

Only the coordinator runs these, one release at a time, and each is announced in Mattermost `#mamoru` by `@mamorusan` and logged:

- App: `bun run deploy:beta` (exact tip of `origin/beta`, which must be a commit of `main`; https://beta.mamoru.lol) and `bun run deploy:prod <sha>` (the named sha, which must be the tip of `origin/beta`, on `main`, and on beta for 24 hours by the release log). Both build from an immutable snapshot of the sha, smoke-test, write `~/.local/state/mamoru-app/releases.jsonl` and print the rollback command.
- Risky UI or API changes soak on beta first. Beta shares D1 and the live operator with production (real funds) but is **not** the same account: session cookies and the passkey RP ID are scoped to the hostname. Do not change the RP ID.
- D1 migrations: additive only, applied by the coordinator before the Worker that needs them.
- Operator: one process, one owner. It holds session keys and the relayer nonce; two operators at once corrupt both. Only the coordinator redeploys it, and only with `MAMORU_COORD_AS=<name> bun run operator:deploy <sha>`: one redeploy at a time, never to a sha that drops what it runs (a rollback says `--rollback --reason`), healthy only when the signed `/metrics` answers with the new sha, back to the previous sha by itself when not. It runs as its own systemd unit (`mamoru-operator-deploy-*`), so it finishes even if your session ends. It deploys only commits signed by an allowed key (and refuses when the running one is not, since it could not roll back to it), names the environment variables the new code reads that the running one did not, counts healthy only when the new boot started an engine loop for every active account, and `--check` runs all of it without moving anything. No `git checkout` and `systemctl restart` by hand. Several merged pull requests that each need a restart share one redeploy to the tip of `main`.
- Scheduled work (a timer for a release at a given hour) is created by the coordinator only and named on #83 with its unit. Look for one before creating your own: `systemctl --user list-timers 'mamoru-*'`. When it fires it claims the lease under its own name (`bun run coord claim --as timer-<unit>`), runs with `MAMORU_COORD_AS=timer-<unit>` and releases it; if a session holds the lease at that moment it does not run, and says so on #83.
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
