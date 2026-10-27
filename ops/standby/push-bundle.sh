#!/usr/bin/env bash
# Cold standby, lady side (otto/mamoru#237). Every 5 min (mamoru-standby-push.timer) this packs what the operators
# need to run somewhere else — their state dirs, their env files, the unit environment, the sha each one runs and
# whether it is running — encrypts it with age to the standby key and sends it to the edge VPS. The identity that
# decrypts it lives on lady and ghost3 only, never on the VPS. The code of each running sha goes once, as its own
# encrypted archive. Never prints a secret.
#
# The upload key is restricted on the VPS to receive.sh (put / status), so this host cannot run anything else there.
# The newest bundle on the VPS is also lady's heartbeat, and its "active" flags tell failover.sh whether lady still
# runs its operators.
set -euo pipefail
export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:$PATH"
umask 077

conf="$HOME/.config/mamoru-standby"
st="$HOME/.local/state/mamoru-standby"
host="${MAMORU_STANDBY_HOST:-mamoru-standby@23.94.151.198}"
key="${MAMORU_STANDBY_KEY:-$HOME/.ssh/mamoru-standby}"
units=(mamoru-operator mamoru-operator-monad)

recipient="$(tr -d '[:space:]' <"$conf/recipient")"
[[ $recipient =~ ^age1[0-9a-z]{58}$ ]] || { echo "$conf/recipient is not one age public key" >&2; exit 1; }
ssh_vps() { timeout 300 ssh -i "$key" -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3 -o IdentitiesOnly=yes "$host" "$@"; }
# Seals stdin into a file and uploads it with its sha256, which receive.sh checks before keeping it.
send() {
  local name="$1" file="$work/$1"
  age -r "$recipient" >"$file"
  ssh_vps put "$name" "$(sha256sum "$file" | cut -d' ' -f1)" <"$file" >/dev/null
}

mkdir -p "$st"
# One push at a time; fence-watch.sh standdown takes the same lock so its bundle is the last one.
exec 9>"$st/push.lock"
flock -w 120 9 || { echo "another push holds the lock" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bundle"
meta_units='{}'

for unit in "${units[@]}"; do
  workdir="$(systemctl --user show "$unit" -p WorkingDirectory --value)"
  [ -n "$workdir" ] && [ -d "$workdir" ] || { echo "$unit: no WorkingDirectory, skipped" >&2; continue; }
  active="$(systemctl --user show "$unit" -p ActiveState --value)"
  # The VPS runs `bun run operator`; a unit that runs anything else is not something it can stand in for.
  argv="$(systemctl --user show "$unit" -p ExecStart --value | sed -n 's/.*argv\[\]=\([^;]*\);.*/\1/p' | head -1)"
  [[ $argv =~ /bun\ run\ operator\ *$ ]] || { echo "$unit: ExecStart is not 'bun run operator'; bundle aborted" >&2; exit 1; }
  # Environment= tokens, checked one by one: NAME=value without spaces or quotes, or the bundle is not sent.
  state_dir="$HOME/.local/state/mamoru-operator"; env_file="$HOME/.config/mamoru-operator/env"
  : >"$work/env-$unit"
  for tok in $(systemctl --user show "$unit" -p Environment --value); do
    [[ $tok =~ ^[A-Z0-9_]+=[^\"\'\ ]*$ ]] || { echo "$unit: Environment token not understood; bundle aborted" >&2; exit 1; }
    case "$tok" in
      MAMORU_OPERATOR_STATE_DIR=*) state_dir="${tok#*=}" ;;
      MAMORU_OPERATOR_ENV=*) env_file="${tok#*=}" ;;
      *) echo "$tok" >>"$work/env-$unit" ;;
    esac
  done
  [ -d "$state_dir" ] || { echo "$unit: state dir $state_dir missing; bundle aborted" >&2; exit 1; }
  [ -f "$env_file" ] || { echo "$unit: env file missing; bundle aborted" >&2; exit 1; }
  [ -z "$(git -C "$workdir" status --porcelain --untracked-files=no)" ] || { echo "$unit: $workdir has local changes; the VPS would run other code; bundle aborted" >&2; exit 1; }
  sha="$(git -C "$workdir" rev-parse HEAD)"

  dest="$work/bundle/$unit"
  mkdir -p "$dest/state"
  # Live files only: no .bak copies, no logs. A JSON file caught mid-write is read again once.
  tar -C "$state_dir" --exclude='*.bak*' --exclude='*.log' -cf - . | tar -C "$dest/state" -xf -
  [ -n "$(ls -A "$dest/state")" ] || { echo "$unit: empty state; bundle aborted" >&2; exit 1; }
  while IFS= read -r -d '' f; do
    if ! jq -e . "$f" >/dev/null 2>&1; then
      sleep 2; cp -p "$state_dir/${f#"$dest/state/"}" "$f"
      jq -e . "$f" >/dev/null 2>&1 || { echo "$unit: ${f##*/} is not valid JSON twice; bundle aborted" >&2; exit 1; }
    fi
  done < <(find "$dest/state" -type f -name '*.json' -print0)
  cp -p "$env_file" "$dest/env"
  mv "$work/env-$unit" "$dest/unit-environment"

  meta_units="$(jq -c --arg u "$unit" --arg sha "$sha" --arg active "$active" '. + {($u): {sha: $sha, active: $active}}' <<<"$meta_units")"

  # The code of this sha, once per sha (the VPS keeps every code archive).
  if ! grep -qx "$sha" "$st/code-pushed" 2>/dev/null; then
    git -C "$workdir" archive --format=tar "$sha" | zstd -q -19 | send "code-$sha.tar.zst.age"
    echo "$sha" >>"$st/code-pushed"
  fi
done

[ "$meta_units" != '{}' ] || { echo "no operator unit found, nothing sent" >&2; exit 1; }
# Units lady stood down for a failover (fence-watch.sh standdown): the ones the VPS is to start.
standdown='[]'
[ -f "$st/fenced" ] && standdown="$(jq -R . <"$st/fenced" | jq -sc 'map(select(length > 0))')"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
jq -n --arg ts "$ts" --arg host "$(hostname)" --argjson units "$meta_units" --argjson standdown "$standdown" \
  '{createdAt: $ts, host: $host, units: $units, standdown: $standdown}' >"$work/bundle/meta.json"

tar -C "$work/bundle" -cf - . | zstd -q -10 | send "state-$ts.tar.zst.age"
echo "$ts" >"$st/last-push"
