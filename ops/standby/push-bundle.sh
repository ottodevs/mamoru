#!/usr/bin/env bash
# Cold standby, lady side (otto/mamoru#237). Every 5 min (mamoru-standby-push.timer) this packs what the operators
# need to run somewhere else — their state dirs, their env files, the unit environment and the sha each one runs —
# encrypts it with age to Ot's key and sends it to the edge VPS. The VPS never holds the identity that decrypts it
# (that lives on lady and ghost3 only), so a copy of the VPS disk reveals nothing. The code of each running sha goes
# once, as its own encrypted archive. Never prints a secret.
#
# The upload key is restricted on the VPS to receive.sh (put / status / ack), so this host cannot run anything else
# there. A bundle that reaches the VPS is also lady's heartbeat: failover.sh reads its age to tell "lady is up but
# unreachable" from "lady is down".
set -euo pipefail
export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:$PATH"
umask 077

host="${MAMORU_STANDBY_HOST:-mamoru-standby@23.94.151.198}"
key="${MAMORU_STANDBY_KEY:-$HOME/.ssh/mamoru-standby}"
recipient_file="${MAMORU_STANDBY_RECIPIENT:-$HOME/.config/mamoru-standby/recipient}"
state_root="$HOME/.local/state/mamoru-standby"
units=(mamoru-operator mamoru-operator-monad)

recipient="$(tr -d '[:space:]' <"$recipient_file")"
[[ $recipient =~ ^age1[0-9a-z]{58}$ ]] || { echo "recipient in $recipient_file is not an age public key" >&2; exit 1; }
ssh_vps() { ssh -i "$key" -o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes "$host" "$@"; }
seal() { age -r "$recipient"; }

mkdir -p "$state_root"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bundle"
meta_units='{}'

for unit in "${units[@]}"; do
  props="$(systemctl --user show "$unit" -p WorkingDirectory -p Environment -p ActiveState)"
  workdir="$(sed -n 's/^WorkingDirectory=//p' <<<"$props")"
  active="$(sed -n 's/^ActiveState=//p' <<<"$props")"
  [ -n "$workdir" ] && [ -d "$workdir" ] || { echo "$unit: no WorkingDirectory, skipped" >&2; continue; }
  # The unit's Environment= names where state and env live; defaults are the ones main.ts uses.
  env_line="$(sed -n 's/^Environment=//p' <<<"$props")"
  state_dir="$(grep -o 'MAMORU_OPERATOR_STATE_DIR=[^ ]*' <<<"$env_line" | cut -d= -f2- || true)"
  env_file="$(grep -o 'MAMORU_OPERATOR_ENV=[^ ]*' <<<"$env_line" | cut -d= -f2- || true)"
  state_dir="${state_dir:-$HOME/.local/state/mamoru-operator}"
  env_file="${env_file:-$HOME/.config/mamoru-operator/env}"
  sha="$(git -C "$workdir" rev-parse HEAD)"

  dest="$work/bundle/$unit"
  mkdir -p "$dest/state"
  # Live files only: no .bak copies, no log. A JSON file caught mid-write is read again once.
  while IFS= read -r -d '' f; do
    name="$(basename "$f")"
    cp -p "$f" "$dest/state/$name"
    if [[ $name == *.json ]] && ! jq -e . "$dest/state/$name" >/dev/null 2>&1; then
      sleep 2; cp -p "$f" "$dest/state/$name"
      jq -e . "$dest/state/$name" >/dev/null 2>&1 || { echo "$unit: $name is not valid JSON twice, bundle aborted" >&2; exit 1; }
    fi
  done < <(find "$state_dir" -maxdepth 1 -type f ! -name '*.bak*' ! -name '*.log' -print0)
  cp -p "$env_file" "$dest/env"
  # Environment= of the unit without values that look secret (the env file carries those).
  sed -E 's/(SECRET|KEY|TOKEN|PASSWORD)([A-Z_]*)=[^ ]*/\1\2=<env file>/g' <<<"$env_line" >"$dest/unit-environment"

  meta_units="$(jq -c --arg u "$unit" --arg sha "$sha" --arg active "$active" \
    '. + {($u): {sha: $sha, active: $active}}' <<<"$meta_units")"

  # The code of this sha, once per sha (a git archive of a commit is identical on every run).
  if ! grep -qx "$sha" "$state_root/code-pushed" 2>/dev/null; then
    git -C "$workdir" archive --format=tar "$sha" | zstd -q -19 | seal | ssh_vps put "code-$sha.tar.zst.age"
    echo "$sha" >>"$state_root/code-pushed"
  fi
done

[ "$meta_units" != '{}' ] || { echo "no operator unit found, nothing sent" >&2; exit 1; }
ts="$(date -u +%Y%m%dT%H%M%SZ)"
jq -n --arg ts "$ts" --arg host "$(hostname)" --argjson units "$meta_units" \
  '{createdAt: $ts, host: $host, units: $units}' >"$work/bundle/meta.json"

tar -C "$work/bundle" -cf - . | zstd -q -10 | seal | ssh_vps put "state-$ts.tar.zst.age"
echo "$ts" >"$state_root/last-push"
