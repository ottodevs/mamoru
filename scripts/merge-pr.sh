#!/usr/bin/env bash
# Merge a pull request into main keeping every commit signed (GitHub shows "Verified").
#
# GitHub's "Rebase and merge" button rewrites each commit and cannot sign it, so main ended up with
# unverified commits even though every branch commit was signed. This does the same rebase locally,
# where commit.gpgsign re-signs each commit, waits for the required CI check on that exact sha, and then
# fast-forwards main to it. GitHub marks the pull request as merged when its head lands on main.
#
# Usage: scripts/merge-pr.sh <pr-number> [--keep-branch]
# Needs: gh authenticated as a maintainer, git with commit.gpgsign=true and a signing key GitHub knows.
set -euo pipefail

repo="ottodevs/mamoru"
pr="${1:?usage: scripts/merge-pr.sh <pr-number> [--keep-branch]}"
keep_branch="${2:-}"
root="$(git rev-parse --show-toplevel)"
# Coordinator only, and one coordinator operation at a time: the whole merge (CI wait included) holds the
# operation lock, so the lease cannot be taken from under it (scripts/release/lib/lease.ts).
op_lock="$HOME/.local/state/mamoru-coord/op.lock"
case ":${MAMORU_FLOCK_HELD:-}:" in
  *":$op_lock:"*) ;;
  *)
    mkdir -p "$(dirname "$op_lock")"
    set +e
    MAMORU_FLOCK_HELD="${MAMORU_FLOCK_HELD:+$MAMORU_FLOCK_HELD:}$op_lock" flock -n -E 75 "$op_lock" "$0" "$@"
    rc=$?
    set -e
    [ "$rc" = 75 ] && echo "refusing: another coordinator operation (a release, merge or operator redeploy) is running" >&2 && exit 1
    exit "$rc"
    ;;
esac
bun "$root/scripts/release/coord.ts" assert || exit 1

state="$(gh pr view "$pr" -R "$repo" --json state,baseRefName,headRefName,isCrossRepository \
  -q '[.state,.baseRefName,.headRefName,.isCrossRepository]|@tsv')"
read -r pr_state base head cross <<<"$state"
[ "$pr_state" = "OPEN" ] || { echo "PR #$pr is $pr_state" >&2; exit 1; }
[ "$base" = "main" ] || { echo "PR #$pr targets $base, not main" >&2; exit 1; }
[ "$cross" = "false" ] || { echo "PR #$pr comes from a fork; merge it by hand" >&2; exit 1; }
[ "$(git config --get commit.gpgsign)" = "true" ] || { echo "commit.gpgsign is not true: the rebase would drop signatures" >&2; exit 1; }

# One merge at a time on this machine: two sessions merging at once each rebase onto a main the other is moving.
# Never a shared /tmp: anyone could hold or plant the lock there.
lockdir="${XDG_RUNTIME_DIR:-$HOME/.cache}"
mkdir -p "$lockdir"
lock="$lockdir/mamoru-merge.lock"
exec 9>"$lock"
flock -n 9 || { echo "another merge is running (lock $lock): wait for it, then run this again" >&2; exit 1; }

git -C "$root" fetch -q origin main "$head"
old_head="$(git -C "$root" rev-parse "origin/$head")"

# A PR reviewed on an older main must not be rebased here onto a main that changed the same files since: the result
# is code nobody reviewed (two reviewed PRs can still break each other). Rebase the branch yourself, get that rebase
# reviewed (for funds, grants, signing or auth code: a GPT-6 APTO), push, and merge it then (nothing left to rebase).
base="$(git -C "$root" merge-base origin/main "origin/$head")"
if [ "$base" != "$(git -C "$root" rev-parse origin/main)" ]; then
  overlap="$(comm -12 <(git -C "$root" diff --name-only "$base" origin/main | sort) <(git -C "$root" diff --name-only "$base" "origin/$head" | sort))"
  if [ -n "$overlap" ]; then
    echo "PR #$pr was built on ${base:0:7}; main has since changed files it also changes:" >&2
    echo "$overlap" | sed 's/^/  /' >&2
    echo "rebase $head onto origin/main, get the rebase reviewed, push it, then run this again" >&2
    exit 1
  fi
fi
tmp="$(mktemp -d)"
cleanup() { git -C "$root" worktree remove --force "$tmp" >/dev/null 2>&1 || true; }
trap cleanup EXIT
git -C "$root" worktree add -q --detach "$tmp" "origin/$head"

if ! git -C "$tmp" rebase -q origin/main; then
  git -C "$tmp" rebase --abort || true
  echo "PR #$pr does not rebase cleanly onto main: rebase the branch first" >&2
  exit 1
fi
new_head="$(git -C "$tmp" rev-parse HEAD)"

# Every commit that lands on main must carry a good signature.
bad="$(git -C "$tmp" log --format='%h %G?' origin/main..HEAD | awk '$2 != "G"')"
[ -z "$bad" ] || { echo "unsigned or badly signed commits:"; echo "$bad"; exit 1; } >&2
[ -n "$(git -C "$tmp" log --format=%h origin/main..HEAD)" ] || { echo "PR #$pr has nothing to merge" >&2; exit 1; }

if [ "$new_head" != "$old_head" ]; then
  echo "rebased $head: $old_head -> $new_head; pushing and waiting for CI"
  git -C "$tmp" push -q --force-with-lease="$head:$old_head" origin "HEAD:$head"
fi

# The required check must have passed on exactly this sha, or main refuses the push anyway.
for _ in $(seq 1 90); do
  conclusion="$(gh api "repos/$repo/commits/$new_head/check-runs?check_name=check" \
    -q '[.check_runs[] | .conclusion // .status] | first // "none"')"
  case "$conclusion" in
    success) break ;;
    failure|cancelled|timed_out|action_required) echo "CI on $new_head: $conclusion" >&2; exit 1 ;;
  esac
  sleep 10
done
[ "$conclusion" = "success" ] || { echo "CI on $new_head did not finish in 15 minutes ($conclusion)" >&2; exit 1; }

# Not forced: if main moved since the fetch above (another machine merged), this push is not a fast-forward and git
# refuses it, so nothing lands on a main the overlap check did not see.
git -C "$tmp" push -q origin "$new_head:refs/heads/main"
echo "main is now $new_head"

for _ in $(seq 1 12); do
  [ "$(gh pr view "$pr" -R "$repo" --json state -q .state)" = "MERGED" ] && break
  sleep 5
done
echo "PR #$pr: $(gh pr view "$pr" -R "$repo" --json state -q .state)"
[ "$keep_branch" = "--keep-branch" ] || git -C "$root" push -q origin --delete "$head" || true
