# Releasing Mamoru

Where a change is, who moves it next and with which command. Roles and the rules for one unit of work are in
[`AGENTS.md`](../../AGENTS.md); this file is the path after the merge. Mamoru holds real funds: every step
below exists so that what reaches production is exactly what was reviewed and watched on beta.

## The path of a change

```
ticket ─► branch + worktree ─► pull request ─► CI + independent review ─► main ─► beta ─► production
          author               author           CI, another model        coordinator, each arrow
```

| Stage | What it is | Who moves it | How |
|---|---|---|---|
| Pull request | One unit of work on `<type>/<ticket>-<slug>` | Author | `gh pr create -R ottodevs/mamoru --base main` |
| Review | CI green and an `APTO` verdict from a model that did not write the code | Reviewer | Verdict as a pull request comment |
| `main` | Reviewed and merged. **Not yet released** | Coordinator | "Rebase and merge" |
| `beta` | The sha of `main` now running on https://beta.mamoru.lol | Coordinator | `git push origin <sha>:beta`, then `bun run deploy:beta` |
| Production | The sha that soaked on beta, on https://app.mamoru.lol | Coordinator, with Otto's GO | `bun run deploy:prod` |

## Branches

- **`main`** is the trunk. Linear history, no merge commits, never force-pushed. A commit on `main` has
  passed CI and an independent review. It says nothing about what is deployed.
- **`beta`** is a pointer, not a place to work. It only ever moves forward to a commit that is already on
  `main`, and only the coordinator moves it. Nobody commits to it or opens a pull request against it.
- **Work branches** live for one pull request and are deleted at merge, with their worktree.

## Environments

| | Beta | Production |
|---|---|---|
| URL | https://beta.mamoru.lol | https://app.mamoru.lol |
| Worker | `mamoru-app-beta` | `mamoru-app` |
| Deploys | the tip of `origin/beta` | the sha that soaked on beta |
| D1 and operator | **shared with production: real funds** | |
| Accounts | its own: cookies and the passkey RP ID are scoped to the hostname | |

Beta is a canary, not a sandbox. A change that can lose or misstate money is proven on a fork and in tests
before it reaches beta, not on beta.

The operator and the engine Worker are not part of this path. They have one owner and their own procedure
(`AGENTS.md`, "Releases"; `ops/systemd/README.md`).

## Cutting a beta

When: after a merge that changes what a user sees or what the API answers, or a batch of them. Not on a
schedule, and not for a change that only touches the operator.

1. `git fetch origin` and choose the sha of `main` to release. Read the deploy notes of every pull request
   between `origin/beta` and that sha (`git log --oneline origin/beta..<sha>`).
2. Do what those notes ask first, in their order: D1 migration, secret, operator.
3. `git push origin <sha>:beta` (fast-forward only; git refuses anything else).
4. `bun run deploy:beta`. It builds from a clean snapshot of that sha, runs the checks, deploys, runs the
   smoke test and prints the rollback command.
5. Announce it in `#mamoru` as `@mamorusan`: the sha, what changes for a user, what to try, what is known
   to be broken.

## Soak

A sha is ready for production when all of this is true and written in the tracking thread:

- It has been on beta for at least **24 hours**, or **2 hours** for a change that only adds copy or a
  read-only view. A fix for an incident in production may go sooner, on Otto's word, and says so.
- Someone used the changed path on beta with a real passkey, and says what they did.
- No new error in the Worker logs of `mamoru-app-beta` that the change could explain.
- The deploy notes that apply to production (secrets, migrations) are done.

## Releasing to production

Needs Otto's GO, given for that sha.

1. The sha is the tip of `origin/beta`. **Production is deployed only when `origin/main` is at that same
   sha**: `deploy:prod` deploys the tip of `main`, and a tip ahead of beta holds commits nobody watched.
   If `main` has moved on, cut a new beta and soak it. (`otto/mamoru#118` unit B makes the script deploy
   the soaked sha and refuse anything else; until then this check is done by hand, and said out loud.)
2. `bun run deploy:prod`.
3. Tag the release and push the tag: `git tag -a app-YYYY.MM.DD.N <sha> -m "<one line>"` and
   `git push origin app-YYYY.MM.DD.N`. `N` starts at 1 each day.
4. Publish the notes: `gh release create app-YYYY.MM.DD.N --generate-notes`, then edit the top to say in
   plain words what changes for a user. Announce in `#mamoru` with the link.
5. Move the tickets to `done`. A ticket is done when its change is live, not when it merged.

## Rolling back

Every deploy prints its rollback command and writes it to `~/.local/state/mamoru-app/releases.jsonl`. A
Worker rollback takes seconds and does not touch D1 or the operator.

- Roll back first, find the cause after. Say so in the tracking thread.
- A D1 migration is additive only, so the previous Worker still runs against the new schema.
- After a rollback `beta` or the last tag no longer says what is deployed. Fix forward with a new pull
  request; do not move a branch backwards.

## Hotfix

The same path, shorter: a pull request against `main`, CI, one independent review, merge, beta, production.
What changes is the soak, which Otto can cut to the time it takes to try the fix on beta. There is no
branch that skips `main` and no deploy from a working tree.

## What CI checks, and what it does not

`.github/workflows/ci.yml` runs `bun run release:check` (typecheck, every test, the production build of the
app) on each pull request and on each push to `main` and `beta`.

It does not run the fork scenarios (`bun run scenarios`), the operator end-to-end scripts or Playwright:
they need a Base fork or a browser. A pull request that touches the operator, the account packages or the
policy says in its body which of those were run by hand.

## Repository settings

Applied by the coordinator; the rules above assume them.

- `main` and `beta` protected: the CI check required, linear history required, no force push, no deletion.
- Merge button: "Rebase and merge" only. Squash and merge commits are off.
- Branches are deleted automatically when their pull request merges.

```sh
gh api -X PATCH repos/ottodevs/mamoru -F allow_squash_merge=false -F allow_merge_commit=false \
  -F allow_rebase_merge=true -F delete_branch_on_merge=true
for b in main beta; do
  gh api -X PUT repos/ottodevs/mamoru/branches/$b/protection --input - <<'JSON'
{ "required_status_checks": { "strict": false, "contexts": ["check"] },
  "enforce_admins": false, "required_pull_request_reviews": null, "restrictions": null,
  "required_linear_history": true, "allow_force_pushes": false, "allow_deletions": false }
JSON
done
```

`enforce_admins` is off so the coordinator can still fast-forward `beta` and act in an incident; the
tracking thread is where that is accounted for.
