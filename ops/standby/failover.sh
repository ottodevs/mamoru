#!/usr/bin/env bash
# Cold standby, VPS side (otto/mamoru#237): installed as /usr/local/sbin/mamoru-failover, run as root by Ot from
# ghost3 with the standby age identity on stdin (~/.config/mamoru-standby/identity, a key for this and nothing
# else). The identity stays in memory; it is never written to this disk.
#
#   mamoru-failover status
#   mamoru-failover drill                          < identity   decrypt the newest bundle, install its code, start
#                                                               nothing, shred the decrypted state
#   mamoru-failover activate [--confirm-lady-down] < identity
#   mamoru-failover handback                                    stop the operators here, seal their state for lady
#   mamoru-failover clear [--discard]                           drop the fence once lady has the hand-back state
#
# Never two operators. activate starts only when the newest bundle says lady's operators are stopped (lady ran
# `fence-watch.sh standdown`, which also keeps a local fence there), or, when lady has been silent for 10 min, on
# --confirm-lady-down: Ot's word that lady's operators are not running. lady fails closed: while this fence is set,
# or while lady cannot read it, its operators do not start. See ops/standby/README.md.
set -euo pipefail
umask 077
trap '' HUP PIPE   # a dropped ssh session does not stop a failover half way

inbox=/var/lib/mamoru-standby/inbox
fdir=/var/lib/mamoru-failover
fence="$fdir/fence"
srv=/srv/mamoru-op
recipient_file=/etc/mamoru-standby/recipient
heartbeat_fresh_s=600
unit_re='^mamoru-operator(-monad)?$'

say() { printf '%s\n' "$*" >&2 || true; logger -t mamoru-failover -- "$*" || true; }
die() { say "mamoru-failover: $*"; exit 1; }
now_ts() { date -u +%Y%m%dT%H%M%SZ; }
newest_state() { find "$inbox" -maxdepth 1 -name 'state-*.tar.zst.age' -printf '%f\n' | sort | tail -1; }
age_s() { echo $(( $(date +%s) - $(stat -c %Y "$1") )); }
std_units() { for u in mamoru-operator mamoru-operator-monad; do echo "mamoru-standby-operator@$u" "mamoru-standby-tunnel@$u"; done; }
set_fence() { local t; t="$(mktemp "$fdir/.fence.XXXXXX")"; echo "$1" >"$t"; chmod 644 "$t"; mv "$t" "$fence"; }
wipe() { [ -e "$1" ] || return 0; find "$1" -type f -exec shred -u {} + 2>/dev/null || true; rm -rf "$1"; }

read_identity() {
  [ -t 0 ] && die "pipe the standby identity on stdin (ssh root@vps mamoru-failover $1 < ~/.config/mamoru-standby/identity)"
  identity="$(cat)"
  [ "$(grep -c '^AGE-SECRET-KEY-' <<<"$identity")" = 1 ] || die "stdin must hold exactly one age identity"
}
open_age() { age -d -i <(printf '%s\n' "$identity") "$1"; }

# Decrypts an age'd tar.zst into $2 as mamoru-op. Only regular files and directories are accepted: no symlink,
# hard link or device can make root (or anyone) write outside $2.
unpack() {
  local src="$1" dest="$2" plain
  plain="$(mktemp "$srv/.plain.XXXXXX")"
  open_age "$src" | zstd -dq >"$plain" || { shred -u "$plain"; return 1; }
  if tar -tvf "$plain" | cut -c1 | grep -qv '^[-d]$'; then shred -u "$plain"; say "$src holds a link or device"; return 1; fi
  chown mamoru-op:mamoru-op "$plain"
  runuser -u mamoru-op -- tar --no-same-owner --no-same-permissions -C "$dest" -xf "$plain" || { shred -u "$plain"; return 1; }
  shred -u "$plain"
}

# Decrypts bundle $1 into $2 and installs the code of every sha it names (cached per sha). Every step checks
# itself: this runs where errexit may be off.
prepare() {
  local bundle="$1" dest="$2" u sha
  wipe "$dest"; install -d -o mamoru-op -g mamoru-op -m 700 "$dest" || return 1
  unpack "$inbox/$bundle" "$dest" || { say "cannot decrypt or unpack $bundle (wrong identity?)"; return 1; }
  jq -e '.units | length > 0' "$dest/meta.json" >/dev/null || { say "$bundle has no units"; return 1; }
  for u in $(jq -r '.units | keys[]' "$dest/meta.json"); do
    [[ $u =~ $unit_re ]] || { say "$bundle names an unknown unit"; return 1; }
    [ -f "$dest/$u/env" ] && [ -n "$(ls -A "$dest/$u/state" 2>/dev/null)" ] || { say "$bundle: $u has no env or an empty state"; return 1; }
    while IFS= read -r -d '' f; do jq -e . "$f" >/dev/null || { say "$bundle: ${f##*/} is not JSON"; return 1; }; done \
      < <(find "$dest/$u/state" -type f -name '*.json' -print0)
    sha="$(jq -r --arg u "$u" '.units[$u].sha' "$dest/meta.json")"
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || { say "$bundle: $u has no sha"; return 1; }
    [ -f "$fdir/installed/$sha" ] && continue
    [ -f "$inbox/code-$sha.tar.zst.age" ] || { say "no code archive for $sha"; return 1; }
    rm -rf "$srv/code/$sha"; install -d -o mamoru-op -g mamoru-op -m 700 "$srv/code/$sha" || return 1
    unpack "$inbox/code-$sha.tar.zst.age" "$srv/code/$sha" || { say "cannot unpack the code of $sha"; return 1; }
    (cd "$srv/code/$sha" && runuser -u mamoru-op -- env HOME="$srv" bun install --frozen-lockfile >/dev/null) \
      || { say "bun install failed for $sha"; return 1; }
    install -d -m 700 "$fdir/installed" && touch "$fdir/installed/$sha" || return 1
  done
}

# Unit environment, written by root into its own directory: lady's Environment= of that unit plus the two paths.
write_unit_env() {
  local run="$1" u="$2" sha port
  sha="$(jq -r --arg u "$u" '.units[$u].sha' "$run/meta.json")"
  # Root's directory, traversable so the unit (User=mamoru-op) can chdir through current-<unit>; the env files
  # inside stay 0600 (systemd reads EnvironmentFile as root).
  install -d -m 755 "$fdir/units"
  ln -sfn "$srv/code/$sha" "$fdir/units/current-$u"
  {
    grep -E '^[A-Z0-9_]+=' "$run/$u/unit-environment" || true
    echo "MAMORU_OPERATOR_ENV=$run/$u/env"
    echo "MAMORU_OPERATOR_STATE_DIR=$run/$u/state"
  } >"$fdir/units/$u.env"
  port="$(sed -n 's/^PORT=\([0-9]\{2,5\}\)$/\1/p' "$run/$u/env" | tail -1)"
  echo "PORT=${port:-8787}" >"$fdir/units/$u.port"
}

case "${1:-}" in
  status)
    if [ -f "$fence" ]; then echo "fence $(cat "$fence")"; else echo "fence none"; fi
    b="$(newest_state)"; [ -n "$b" ] && echo "newest bundle $b, $(age_s "$inbox/$b") s old" || echo "no bundle"
    for u in $(std_units); do printf '%s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"; done
    ;;

  drill)
    read_identity drill
    b="$(newest_state)"; [ -n "$b" ] || die "no state bundle in $inbox"
    trap 'wipe "$srv/drill"' EXIT
    prepare "$b" "$srv/drill" || die "drill failed on $b (decrypted state erased)"
    say "drill ok: $b decrypts, every unit has env and state, its JSON parses, code installed:"
    jq -r '.units | to_entries[] | "  \(.key) \(.value.sha[:7]) (lady: \(.value.active))"' "$srv/drill/meta.json" >&2 || true
    say "nothing was started; decrypted state erased"
    ;;

  activate)
    confirm=0; [ "${2:-}" = "--confirm-lady-down" ] && confirm=1
    read_identity activate
    [ -f "$fence" ] && die "fence already set ($(cat "$fence"))"
    for u in $(std_units); do systemctl is-active --quiet "$u" && die "$u already runs"; done
    b="$(newest_state)"; [ -n "$b" ] || die "no state bundle: nothing to run"
    hb="$(age_s "$inbox/$b")"
    trap 'wipe "$srv/run"' EXIT
    prepare "$b" "$srv/run" || die "could not prepare $b; nothing started, decrypted state erased"
    if [ "$hb" -lt "$heartbeat_fresh_s" ]; then
      # lady is alive: it must have stood down, and the bundle names what it stopped.
      jq -e '[.units[] | select(.active == "active" or .active == "activating" or .active == "reloading")] | length == 0' "$srv/run/meta.json" >/dev/null \
        || die "lady is up (bundle ${hb}s old) and runs its operators. On lady: ~/.local/share/mamoru-standby/fence-watch.sh standdown, then run this again."
      mapfile -t start < <(jq -r '.standdown[]' "$srv/run/meta.json")
      [ "${#start[@]}" -gt 0 ] || die "lady's operators are stopped but not by standdown; run standdown on lady so it keeps a fence"
    else
      [ "$confirm" = 1 ] || die "lady has been silent for ${hb}s. Check that its operators are not running, then run again with --confirm-lady-down."
      mapfile -t start < <(jq -r '.units | to_entries[] | select(.value.active == "active") | .key' "$srv/run/meta.json")
      [ "${#start[@]}" -gt 0 ] || die "the last bundle has no running operator to stand in for"
      say "lady silent for ${hb}s; going ahead on --confirm-lady-down. What lady did after $b is not in this state."
    fi
    for u in "${start[@]}"; do [[ $u =~ $unit_re ]] || die "unknown unit $u"; done
    set_fence "active $(now_ts) $b"
    trap - EXIT
    for u in "${start[@]}"; do
      write_unit_env "$srv/run" "$u"
      systemctl start "mamoru-standby-operator@$u" "mamoru-standby-tunnel@$u"
    done
    say "fence set; started ${start[*]} from $b"
    sleep 20
    for u in "${start[@]}"; do
      port="$(sed -n 's/^PORT=//p' "$fdir/units/$u.port")"
      health="$(curl -fsS --max-time 5 "http://127.0.0.1:$port/health" 2>/dev/null || echo "no answer")"
      url="$(journalctl -u "mamoru-standby-tunnel@$u" --no-pager -o cat 2>/dev/null | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)"
      say "$u: port $port, health: $health"
      say "  tunnel: ${url:-not up yet (journalctl -u mamoru-standby-tunnel@$u)}"
    done
    say "Point the Worker at these URLs from a machine with wrangler (OPERATOR_URL on prod and beta, OPERATOR_URL_143 on beta), unless the named tunnel (#206) serves them."
    ;;

  handback)
    [ -f "$fence" ] || die "no fence: nothing to hand back"
    for u in $(std_units); do systemctl stop "$u" 2>/dev/null || true; done
    for u in $(std_units); do systemctl is-active --quiet "$u" && die "$u did not stop; nothing sealed"; done
    [ -d "$srv/run" ] || die "no running state in $srv/run"
    recipient="$(tr -d '[:space:]' <"$recipient_file")"
    install -d -m 700 "$fdir/handback"
    out="$fdir/handback/handback-$(now_ts).tar.zst.age"
    tar -C "$srv/run" -cf - . | zstd -q -10 | age -r "$recipient" >"$out" || die "sealing failed; state left in $srv/run"
    age_header="$(head -c 21 "$out")"; [ "$age_header" = "age-encryption.org/v1" ] || die "sealed file looks wrong; state left in $srv/run"
    wipe "$srv/run"
    echo "$out" >"$fdir/handback/LATEST"
    say "operators stopped here, state sealed for lady: $out"
    say "Next (README, Hand back): copy it to lady, restore it, then: mamoru-failover clear"
    ;;

  clear)
    for u in $(std_units); do systemctl is-active --quiet "$u" && die "$u still runs here; handback first"; done
    [ -d "$srv/run" ] && die "$srv/run still holds state; handback first"
    if [ "${2:-}" != "--discard" ]; then
      [ -f "$fdir/handback/LATEST" ] && [ "$(cat "$fdir/handback/LATEST")" -nt "$fence" ] \
        || die "no hand-back newer than the fence. Hand back first, or --discard if this failover never ran an operator."
    fi
    rm -f "$fence"
    say "fence cleared: on lady, after restoring the state, fence-watch.sh resume"
    ;;

  *) sed -n '2,16p' "$0" >&2; exit 2 ;;
esac
