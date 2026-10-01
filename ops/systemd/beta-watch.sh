#!/usr/bin/env bash
# Polls GitHub for new commits on `beta` and runs `bun run deploy:beta` from a dedicated detached
# worktree. deploy:beta already does its own check + build + smoke test + rollback command on
# failure, so this script only tracks "have we deployed this sha yet" and logs the outcome.
# Not installed by default: see ops/systemd/README.md to wire the matching .service/.timer.
set -euo pipefail

STATE="${MAMORU_BETA_STATE:-$HOME/.local/state/mamoru-beta-deploy}"
WT="$STATE/worktree"
REPO_URL="git@github.com:ottodevs/mamoru.git"
LOCK="$STATE/deploy.lock"
mkdir -p "$STATE"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "deploy already running"
  exit 0
fi

sha=$(git ls-remote "$REPO_URL" refs/heads/beta | awk '{print $1}')
if [ -z "$sha" ]; then
  echo "origin has no beta branch" >&2
  exit 1
fi

last=""
if [ -f "$STATE/deployed-sha" ]; then
  last=$(cat "$STATE/deployed-sha")
fi
if [ "$sha" = "$last" ]; then
  echo "already deployed $sha"
  exit 0
fi

if [ ! -d "$WT/.git" ]; then
  git clone --branch beta "$REPO_URL" "$WT"
fi
git -C "$WT" fetch origin beta
git -C "$WT" checkout --detach "$sha"

cd "$WT"
bun install --frozen-lockfile

if bun run deploy:beta; then
  printf '%s\n' "$sha" >"$STATE/deployed-sha"
  echo "$(date -Is) beta deploy ok sha=$sha" >>"$STATE/deploys.log"
else
  echo "$(date -Is) beta deploy FAILED sha=$sha (see deploy:beta output above for the rollback command)" >>"$STATE/deploys.log"
  exit 1
fi
