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
| Production | The sha that soaked on beta, on https://app.mamoru.lol | Coordinator, with Otto's GO | "Releasing to production", every step |

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
3. Write down what beta runs now, so there is something to go back to: in `apps/mamoru-app`,
   `bunx wrangler deployments list --env beta` and note the newest version id in the tracking thread.
   `deploy:beta` does not record it: it writes nothing to the release log and prints a rollback command only
   when its smoke test fails.
4. `git push origin <sha>:beta`. Git refuses this unless it is a fast-forward of `beta`. It does not check
   that the sha is on `main`: `git merge-base --is-ancestor <sha> origin/main` first.
   Once `beta` is protected, GitHub also refuses the push until CI has finished green on that sha: after a
   merge, wait for the CI run on `main` (`gh run list -R ottodevs/mamoru --branch main --limit 1`).
5. `bun run deploy:beta`. It fetches `beta` again, builds from a clean snapshot of its tip, runs typecheck
   and tests, deploys and runs the smoke test. Check that the sha it prints is the one you pushed.
6. Announce it in `#mamoru` as `@mamorusan`: the sha, the version id before and after, what changes for a
   user, what to try, what is known to be broken.

## Soak

A sha is ready for production when all of this is true and written in the tracking thread:

- It has been on beta for at least **24 hours**, or **2 hours** for a change that only adds copy or a
  read-only view. A fix for an incident in production may go sooner, on Otto's word, and says so.
- Someone used the changed path on beta with a real passkey, and says what they did.
- No new error in the Worker logs of `mamoru-app-beta` that the change could explain.
- The deploy notes that apply to production (secrets, migrations) are done.

## Releasing to production

Needs Otto's GO, given for one sha: the one that soaked. Call it `S` and write it in the tracking thread.

Today the scripts do not hold this for you. `deploy:prod` takes no sha: it fetches `main` and deploys
whatever its tip is at that moment. So until `otto/mamoru#118` unit B makes it deploy `S` and refuse
anything else, the coordinator holds it by hand:

1. **Freeze.** Say in the tracking thread that a release is under way. Nothing is merged and no branch is
   moved until step 5 is done. The coordinator is the only one who merges, so this is a rule for one seat.
2. **Look at the server, not at local refs:** `git fetch origin main beta`, then
   `git rev-parse origin/main origin/beta`. Both must print `S`. If `main` is ahead, there are commits
   nobody watched: cut a new beta and soak it. Do not deploy.
3. `bun run deploy:prod`.
4. **Read the sha it printed** (`deploying origin/main at …`). If it is not `S`, roll back at once with the
   command in "Rolling back", then find out who moved `main`.
5. Tag `S` and push the tag: `git tag -a app-YYYY.MM.DD.N S -m "<one line>"` and
   `git push origin app-YYYY.MM.DD.N`. `N` starts at 1 each day. Check the push succeeded before the next
   step.
6. Publish the notes: `gh release create app-YYYY.MM.DD.N --verify-tag --generate-notes`, then edit the top
   to say in plain words what changes for a user. `--verify-tag` matters: without it a tag that is missing
   on the server is created at the tip of `main`. Announce in `#mamoru` with the link.
7. Move the tickets to `done`. A ticket is done when its change is live, not when it merged.

**Do not use `bun run promote`** while this section stands. It was written for the earlier model (work
reaches `beta` first and `main` is fast-forwarded to it). It checks a sha against `beta` and then calls
`deploy:prod` without passing it, so the sha you give it is not what pins the deploy; and it knows nothing
about soak or GO.

## Rolling back

A Worker rollback takes seconds. It puts back the previous Worker code and nothing else: D1, secrets and
the operator stay as they are.

```sh
cd apps/mamoru-app
bunx wrangler deployments list --env beta        # or without --env for production
bunx wrangler rollback --env beta <version id>   # production: no --env
```

When a deploy script printed a rollback command, use that one as printed: it is the same call with the
path and the environment filled in.

Where the version id comes from:

- **Production:** each `deploy:prod` that reaches the deploy step appends a line to
  `~/.local/state/mamoru-app/releases.jsonl` on the machine that ran it, with `sha`, `versionId`,
  `previousVersionId` and `smokeOk`. `previousVersionId` is what to roll back to. The script also prints the
  full command. A run that fails before or during `wrangler deploy` writes nothing: check
  `wrangler deployments list` to see whether a new version went live.
- **Beta:** the id you noted in step 3 of "Cutting a beta". If it was not noted, the second newest entry of
  `wrangler deployments list --env beta`.

Rules:

- Roll back first, find the cause after. Say so in the tracking thread.
- A D1 migration is additive only, which is what lets the previous Worker run against the new schema. It is
  a reason to expect that, not a proof: the deploy notes of a pull request with a migration say that the
  previous Worker was run against the new schema.
- After a rollback `beta` or the last tag no longer says what is deployed. Fix forward with a new pull
  request; do not move a branch backwards.

## Hotfix

The same path, shorter: a pull request against `main`, CI, one independent review, merge, beta, production.
What changes is the soak, which Otto can cut to the time it takes to try the fix on beta. There is no
branch that skips `main` and no deploy from a working tree.

## What CI checks, and what it does not

`.github/workflows/ci.yml` runs `bun run release:check` on each pull request and on each push to `main`
and `beta`: typecheck, the tests under `packages`, `apps` and `scripts/release` that need nothing but the
checkout, and the production build of the app.

It does not run what needs a chain or a browser: the fork scenarios (`bun run scenarios`), the operator
end-to-end scripts, Playwright, and the suites that skip themselves without `RPC_URL` and Anvil (the live
owner path in `packages/account/live`). A pull request that touches the operator, the account packages or
the policy says in its body which of those were run by hand.

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

What these settings do and do not do:

- `enforce_admins` is off, so an administrator can still act in an incident; the tracking thread is where
  that is accounted for. A coordinator who is not an administrator can push a sha to `beta` only once CI
  has passed on it, which every sha of `main` has.
- They do not enforce who the coordinator is or that an independent review happened. Those stay rules of
  `AGENTS.md`, checked by people.
