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

state="$(gh pr view "$pr" -R "$repo" --json state,baseRefName,headRefName,isCrossRepository \
  -q '[.state,.baseRefName,.headRefName,.isCrossRepository]|@tsv')"
read -r pr_state base head cross <<<"$state"
[ "$pr_state" = "OPEN" ] || { echo "PR #$pr is $pr_state" >&2; exit 1; }
[ "$base" = "main" ] || { echo "PR #$pr targets $base, not main" >&2; exit 1; }
[ "$cross" = "false" ] || { echo "PR #$pr comes from a fork; merge it by hand" >&2; exit 1; }
[ "$(git config --get commit.gpgsign)" = "true" ] || { echo "commit.gpgsign is not true: the rebase would drop signatures" >&2; exit 1; }

git -C "$root" fetch -q origin main "$head"
old_head="$(git -C "$root" rev-parse "origin/$head")"
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

git -C "$tmp" push -q origin "$new_head:refs/heads/main"
echo "main is now $new_head"

for _ in $(seq 1 12); do
  [ "$(gh pr view "$pr" -R "$repo" --json state -q .state)" = "MERGED" ] && break
  sleep 5
done
echo "PR #$pr: $(gh pr view "$pr" -R "$repo" --json state -q .state)"
[ "$keep_branch" = "--keep-branch" ] || git -C "$root" push -q origin --delete "$head" || true
