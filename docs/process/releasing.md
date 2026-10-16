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
| Production | The sha that soaked on beta, on https://app.mamoru.lol | Coordinator, with Otto's GO | `bun run deploy:prod <sha>` |

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
3. `git push origin <sha>:beta`. Git refuses this unless it is a fast-forward of `beta`. Once `beta` is
   protected, GitHub also refuses it until CI has finished green on that sha: after a merge, wait for the CI
   run on `main` (`gh run list -R ottodevs/mamoru --branch main --limit 1`).
4. `bun run deploy:beta`. It fetches `beta` and `main`, refuses a tip that is not a commit of `main`, builds
   from a clean snapshot of the tip, runs typecheck and tests, deploys and runs the smoke test. It writes
   the deploy to the release log and prints the rollback command. The soak is counted from that record.
5. Check that the sha it printed is the one you pushed.
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

Needs Otto's GO, given for one sha: the one that soaked. Write it in the tracking thread.

1. `bun run deploy:prod <sha>`. The script holds the rules, and refuses if any is not met:
   - the sha is written in full, all 40 characters; a branch, a tag, `HEAD` or a short sha is refused,
     and so is any second word on the command line;
   - it must be the tip of `origin/beta`, so it is what is running on beta;
   - it must be a commit of `origin/main`;
   - by the release log, beta must have been running it without interruption for at least 24 hours: the
     latest beta deploy is this sha with a passing smoke test, and no other commit and no failed smoke
     test since the run began. Putting another commit on beta and coming back starts the soak again.
   `main` may be ahead: commits merged after the beta was cut are not in the release, and the script says so.
2. Shorter soak, when "Soak" above allows it: `--min-soak-hours=2`. Under two hours is a hotfix and needs
   the reason, which goes into the release log: `--min-soak-hours=0.5 --hotfix="withdrawals answer 500"`.
3. The script ends by printing the two commands that tag and publish the release (`app-YYYY.MM.DD.N`, the
   next free `N` of the day). Run them, writing the one line that says what changes for a user. Check the
   tag push succeeded before `gh release create`: `--verify-tag` refuses to invent a missing tag.
4. Announce in `#mamoru` with the link to the release.
5. Move the tickets to `done`. A ticket is done when its change is live, not when it merged.

The soak is read from the release log of the machine that ran `deploy:beta`
(`~/.local/state/mamoru-app/releases.jsonl`). Releases are cut from one machine; a beta deployed from
another one does not count here, and the script will say there is no record.
A rollback of beta done by hand with `wrangler rollback` is not in the log. After one, deploy the sha
again with `bun run deploy:beta` so the log says what beta runs; the soak starts from there.

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

Where the version id comes from: each `deploy:beta` and `deploy:prod` that reaches the deploy step appends a
line to `~/.local/state/mamoru-app/releases.jsonl` on the machine that ran it, with `env`, `sha`,
`versionId`, `previousVersionId` and `smokeOk`. `previousVersionId` is what to roll back to, and the script
prints the full command. A run that fails before or during `wrangler deploy` writes nothing and prints what
wrangler said: check `wrangler deployments list` to see whether a new version went live.

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
- Merges: `scripts/merge-pr.sh <pr>`, never the GitHub button. The button's "Rebase and merge" rewrites each
  commit and cannot sign it, so main showed unverified commits. The script rebases locally (commit.gpgsign
  re-signs), waits for CI on that sha and fast-forwards main; GitHub marks the pull request merged.
- Signed commits required on `main` and `beta` (`required_signatures`), so an unsigned push or the button is refused.
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
  gh api -X POST repos/ottodevs/mamoru/branches/$b/protection/required_signatures
done
```

What these settings do and do not do:

- `enforce_admins` is off, so an administrator can still act in an incident; the tracking thread is where
  that is accounted for. A coordinator who is not an administrator can push a sha to `beta` only once CI
  has passed on it, which every sha of `main` has.
- They do not enforce who the coordinator is or that an independent review happened. Those stay rules of
  `AGENTS.md`, checked by people.
