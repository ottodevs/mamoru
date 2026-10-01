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

last_deployed=""
if [ -f "$STATE/deployed-sha" ]; then
  last_deployed=$(cat "$STATE/deployed-sha")
fi
if [ "$sha" = "$last_deployed" ]; then
  echo "already deployed $sha"
  exit 0
fi

# A sha that already failed is not retried every tick; only a new push to beta (or an explicit
# MAMORU_BETA_FORCE_RETRY=1) tries it again, so a broken revision does not hammer the Worker.
last_failed=""
if [ -f "$STATE/failed-sha" ]; then
  last_failed=$(cat "$STATE/failed-sha")
fi
if [ "$sha" = "$last_failed" ] && [ "${MAMORU_BETA_FORCE_RETRY:-}" != "1" ]; then
  echo "sha $sha already failed, waiting for origin/beta to move (MAMORU_BETA_FORCE_RETRY=1 to retry anyway)"
  exit 0
fi

# Everything from the checkout on counts as an attempt at this sha: a broken lockfile or a failed
# fetch is recorded like a failed deploy, not retried every tick. deploy:beta gets the polled sha
# and refuses if origin/beta moved meanwhile, so the recorded sha is the one that was tried.
attempt() {
  if [ ! -d "$WT/.git" ]; then
    git clone --branch beta "$REPO_URL" "$WT" || return 1
  fi
  git -C "$WT" fetch origin beta || return 1
  git -C "$WT" checkout --detach "$sha" || return 1
  cd "$WT" || return 1
  bun install --frozen-lockfile || return 1
  bun run deploy:beta -- "$sha"
}

if attempt; then
  printf '%s\n' "$sha" >"$STATE/deployed-sha"
  rm -f "$STATE/failed-sha"
  echo "$(date -Is) beta deploy ok sha=$sha" >>"$STATE/deploys.log"
else
  printf '%s\n' "$sha" >"$STATE/failed-sha"
  echo "$(date -Is) beta deploy FAILED sha=$sha (see deploy:beta output above for the rollback command)" >>"$STATE/deploys.log"
  exit 1
fi
