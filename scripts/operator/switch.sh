#!/usr/bin/env bash
# Move the live operator (real funds) to one reviewed commit, the only way any session should do it.
#
# Usage: scripts/operator/switch.sh <40-char sha on origin/main> [--check]
#   MAMORU_ACTOR="who" names the caller in the log. --check runs every check and stops before touching the operator.
#
# - One switch at a time on this machine (flock): two sessions cannot move the operator under each other.
# - The sha must be a full commit id, signed (G), and on origin/main.
# - Says which environment variables the new code reads that the old one did not, and whether the env file sets them.
# - Restarts the unit and waits for it to come up with every active account's loop started; if it does not within
#   HEALTH_SECS, puts the previous sha back and restarts it (rollback), then exits non-zero.
# - Every switch, rollback included, is appended to the deploy log; a worktree moved outside this script is reported.
set -euo pipefail

target="${1:?usage: scripts/operator/switch.sh <40-char sha> [--check]}"
check_only="${2:-}"
[[ "$target" =~ ^[0-9a-f]{40}$ ]] || { echo "the sha must be a full 40-character commit id" >&2; exit 1; }

op_dir="${MAMORU_OPERATOR_DIR:-$HOME/.cursor/worktrees/mamoru/op}"
unit="${MAMORU_OPERATOR_UNIT:-mamoru-operator}"
env_file="${MAMORU_OPERATOR_ENV:-$HOME/.config/mamoru-operator/env}"
state_dir="${MAMORU_OPERATOR_STATE_DIR:-$HOME/.local/state/mamoru-operator}"
log="$state_dir/deploys.log"
health_secs="${HEALTH_SECS:-90}"
actor="${MAMORU_ACTOR:-$USER}"

lock="${XDG_RUNTIME_DIR:-/tmp}/mamoru-operator-switch.lock"
exec 9>"$lock"
flock -n 9 || { echo "another operator switch is running (lock $lock)" >&2; exit 1; }

git -C "$op_dir" fetch -q origin main
git -C "$op_dir" cat-file -e "$target^{commit}" 2>/dev/null || { echo "$target is not a commit here" >&2; exit 1; }
git -C "$op_dir" merge-base --is-ancestor "$target" origin/main || { echo "$target is not on origin/main" >&2; exit 1; }
[ "$(git -C "$op_dir" log -1 --format=%G? "$target")" = "G" ] || { echo "$target is not signed with a good signature" >&2; exit 1; }
[ -z "$(git -C "$op_dir" status --porcelain)" ] || { echo "$op_dir has local changes: refusing" >&2; exit 1; }

prev="$(git -C "$op_dir" rev-parse HEAD)"
[ "$prev" != "$target" ] || { echo "the operator already runs $target"; exit 0; }

# Someone moved the worktree without this script: say so (the log is how sessions see each other's switches).
last="$( { tail -n 1 "$log" 2>/dev/null || true; } | awk -F' \\| ' '{print $4}' | awk '{print $NF}')"
if [ -n "$last" ] && [ "$last" != "$prev" ]; then
  echo "note: the deploy log's last switch went to ${last:0:7}, but the worktree is at ${prev:0:7} (moved outside switch.sh)"
fi

# Environment the new code reads that the old did not: named, with whether the env file sets it (names only).
reads() { git -C "$op_dir" grep -h -o 'process\.env\.[A-Z0-9_]*' "$1" -- apps/mamoru-operator/src | sed 's/process\.env\.//' | sort -u; }
new_vars="$(comm -13 <(reads "$prev") <(reads "$target"))"
if [ -n "$new_vars" ]; then
  echo "environment read by ${target:0:7} and not by ${prev:0:7}:"
  while read -r v; do
    if grep -q "^$v=" "$env_file" 2>/dev/null; then echo "  $v (set in $(basename "$env_file"))"; else echo "  $v (not set)"; fi
  done <<<"$new_vars"
fi

active="$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(sum(1 for a in d['accounts'].values() if a.get('active')))" "$state_dir/accounts.json")"

# Healthy: the unit is active, has not restarted on its own since `since`, and every active account's loop started.
healthy() {
  local since="$1" restarts="$2"
  for _ in $(seq 1 "$health_secs"); do
    if systemctl --user is-active -q "$unit" && [ "$(systemctl --user show "$unit" -p NRestarts --value)" = "$restarts" ]; then
      local loops
      loops="$(journalctl --user -u "$unit" --since "$since" -o cat --no-pager | grep -c 'loop started' || true)"
      [ "$loops" -ge "$active" ] && return 0
    fi
    sleep 1
  done
  return 1
}

run_at() {
  git -C "$op_dir" checkout -q --detach "$1"
  (cd "$op_dir" && bun install --frozen-lockfile >/dev/null)
  systemctl --user reset-failed "$unit" 2>/dev/null || true
  local since; since="$(date '+%Y-%m-%d %H:%M:%S')"
  systemctl --user restart "$unit"
  sleep 2
  healthy "$since" "$(systemctl --user show "$unit" -p NRestarts --value)"
}

entry() { echo "$(date -Is) | $actor | $1 | $prev -> $2" >>"$log"; }

if [ "$check_only" = "--check" ]; then
  echo "check only: would switch $unit ${prev:0:7} -> ${target:0:7}, expecting $active loops"
  exit 0
fi
echo "switching $unit: ${prev:0:7} -> ${target:0:7} ($active active accounts)"
if run_at "$target"; then
  entry ok "$target"
  echo "ok: $unit runs ${target:0:7} with $active loops started"
  exit 0
fi

echo "the operator did not come up healthy on ${target:0:7}; rolling back to ${prev:0:7}" >&2
journalctl --user -u "$unit" -n 15 -o cat --no-pager >&2 || true
if run_at "$prev"; then
  entry "ROLLBACK ($target unhealthy)" "$prev"
  echo "rolled back: $unit runs ${prev:0:7} again" >&2
else
  entry "ROLLBACK FAILED ($target unhealthy, $prev too)" "$prev"
  echo "ROLLBACK FAILED: $unit is not healthy on ${prev:0:7} either. Look now." >&2
fi
exit 1
