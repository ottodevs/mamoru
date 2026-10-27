#!/usr/bin/env bash
# Cold standby, VPS side (otto/mamoru#237): installed as /usr/local/sbin/mamoru-failover, run as root by Ot from
# ghost3 with the age identity on stdin. The identity is read into memory and never written to this disk.
#
#   mamoru-failover status
#   mamoru-failover drill                        < keys.txt   decrypt the newest bundle, install its code, start nothing,
#                                                             then erase the decrypted state
#   mamoru-failover activate [--confirm-lady-down] < keys.txt
#   mamoru-failover handback                                  stop the operators here, seal their state for lady
#   mamoru-failover clear                                     drop the fence once lady has the handback state
#
# Safety: lady's heartbeat is the newest bundle in the inbox (pushed every 5 min). If it is fresh, lady is alive,
# so activate first asks lady to stand down (fence "pending"; lady's fence-watch stops its operators, pushes a last
# bundle and acknowledges) and only then starts here. If the heartbeat is stale, lady cannot be asked, so activate
# needs --confirm-lady-down: Ot says lady's operators are not running. See ops/standby/README.md.
set -euo pipefail
umask 077

base=/var/lib/mamoru-standby
inbox="$base/inbox"
fence=/var/lib/mamoru-failover/fence
srv=/srv/mamoru-op
recipient_file=/etc/mamoru-standby/recipient
heartbeat_fresh_s=600
standdown_wait_s=240
units=(mamoru-operator mamoru-operator-monad)

say() { printf '%s\n' "$*" >&2; }
die() { say "mamoru-failover: $*"; exit 1; }
now_ts() { date -u +%Y%m%dT%H%M%SZ; }
newest_state() { ls -1t "$inbox"/state-*.tar.zst.age 2>/dev/null | head -1; }
age_s() { echo $(( $(date +%s) - $(stat -c %Y "$1") )); }
op_units() { for u in "${units[@]}"; do echo "mamoru-standby-operator@$u" "mamoru-standby-tunnel@$u"; done; }

read_identity() {
  [ -t 0 ] && die "pipe the age identity on stdin (ssh root@vps mamoru-failover $1 < ~/.config/sops/age/keys.txt)"
  identity="$(cat)"
  grep -q '^AGE-SECRET-KEY-' <<<"$identity" || die "stdin holds no age identity"
}
open_bundle() { age -d -i <(printf '%s\n' "$identity") "$1" | zstd -dq; }

# Decrypts the newest state bundle and the code of every sha it names into $1 (state) and $srv/code (code, kept per
# sha so a later activate does not wait for bun install). Prints the bundle path.
prepare() {
  local dest="$1" bundle sha
  bundle="$(newest_state)"; [ -n "$bundle" ] || die "no state bundle in $inbox"
  rm -rf "$dest"; install -d -o mamoru-op -g mamoru-op -m 700 "$dest"
  # prepare runs inside an `if`, where errexit is off: every step checks itself.
  open_bundle "$bundle" | tar -C "$dest" -xf - || die "cannot decrypt or unpack $bundle (wrong identity?)"
  jq -e '.units | length > 0' "$dest/meta.json" >/dev/null || die "bundle $bundle has no units"
  for u in $(jq -r '.units | keys[]' "$dest/meta.json"); do
    [ -f "$dest/$u/env" ] && [ -d "$dest/$u/state" ] || die "bundle $bundle: $u has no env or state"
    for f in "$dest/$u/state"/*.json; do [ -e "$f" ] || continue; jq -e . "$f" >/dev/null || die "bundle: $f is not JSON"; done
    sha="$(jq -r --arg u "$u" '.units[$u].sha' "$dest/meta.json")"
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "bundle: $u has no sha"
    if [ ! -f "$srv/code/$sha/.installed" ]; then
      [ -f "$inbox/code-$sha.tar.zst.age" ] || die "no code archive for $sha in $inbox"
      rm -rf "$srv/code/$sha"; install -d -o mamoru-op -g mamoru-op -m 700 "$srv/code/$sha"
      open_bundle "$inbox/code-$sha.tar.zst.age" | tar -C "$srv/code/$sha" -xf - || die "cannot unpack the code of $sha"
      chown -R mamoru-op:mamoru-op "$srv/code/$sha" || die "chown $sha"
      (cd "$srv/code/$sha" && runuser -u mamoru-op -- env HOME="$srv" bun install --frozen-lockfile >/dev/null) || die "bun install failed for $sha"
      touch "$srv/code/$sha/.installed" || die "mark $sha installed"
    fi
  done
  chown -R mamoru-op:mamoru-op "$dest" || die "chown $dest"
  echo "$bundle"
}

# Unit environment for one operator: what lady's unit set (MAMORU_LIVE, …) with the two paths moved here.
write_unit_env() {
  local run="$1" u="$2" sha port
  sha="$(jq -r --arg u "$u" '.units[$u].sha' "$run/meta.json")"
  ln -sfn "$srv/code/$sha" "$srv/current-$u"
  {
    tr ' ' '\n' <"$run/$u/unit-environment" | grep -E '^[A-Z0-9_]+=' \
      | grep -v -E '^(MAMORU_OPERATOR_ENV|MAMORU_OPERATOR_STATE_DIR)=' | grep -v '=<env file>$' || true
    echo "MAMORU_OPERATOR_ENV=$run/$u/env"
    echo "MAMORU_OPERATOR_STATE_DIR=$run/$u/state"
  } >"$run/$u/unit.env"
  port="$(sed -n 's/^PORT=//p' "$run/$u/env" | tail -1)"
  echo "PORT=${port:-8787}" >"$run/$u/port.env"
  chown mamoru-op:mamoru-op "$run/$u/unit.env" "$run/$u/port.env"
}

case "${1:-}" in
  status)
    if [ -f "$fence" ]; then echo "fence $(cat "$fence")"; else echo "fence none"; fi
    b="$(newest_state)"; [ -n "$b" ] && echo "newest bundle $(basename "$b"), $(age_s "$b") s old" || echo "no bundle"
    for u in $(op_units); do printf '%s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"; done
    ;;

  drill)
    read_identity drill
    bundle="$(prepare "$srv/drill")"
    say "drill ok: $(basename "$bundle") decrypts, its JSON parses, every unit has env + state, code installed for:"
    jq -r '.units | to_entries[] | "  \(.key) \(.value.sha[:7]) (lady: \(.value.active))"' "$srv/drill/meta.json" >&2
    find "$srv/drill" -type f -exec shred -u {} + ; rm -rf "$srv/drill"
    say "decrypted state erased; nothing was started"
    ;;

  activate)
    confirm=0; [ "${2:-}" = "--confirm-lady-down" ] && confirm=1
    read_identity activate
    [ -f "$fence" ] && grep -q '^active' "$fence" && die "already active ($(cat "$fence"))"
    b="$(newest_state)"; [ -n "$b" ] || die "no state bundle: nothing to run"
    hb="$(age_s "$b")"
    if [ "$hb" -lt "$heartbeat_fresh_s" ]; then
      ts="$(now_ts)"; rm -f "$inbox/lady-stopped"
      echo "pending $ts" >"$fence"; chmod 644 "$fence"
      say "lady's heartbeat is ${hb}s old: lady is alive. Asked it to stand down; waiting up to ${standdown_wait_s}s…"
      for _ in $(seq 1 $((standdown_wait_s / 5))); do
        [ -f "$inbox/lady-stopped" ] && [[ "$(cat "$inbox/lady-stopped")" > "$ts" || "$(cat "$inbox/lady-stopped")" == "$ts" ]] && break
        sleep 5
      done
      if ! [ -f "$inbox/lady-stopped" ]; then
        rm -f "$fence"
        die "lady did not stand down in ${standdown_wait_s}s; fence removed, nothing started. Look at lady first."
      fi
      say "lady stopped its operators at $(cat "$inbox/lady-stopped") and sent its last bundle"
    else
      [ "$confirm" = 1 ] || die "lady's heartbeat is ${hb}s old, so lady cannot be asked to stand down. Check that lady's operators are not running, then run again with --confirm-lady-down."
      say "lady's heartbeat is ${hb}s old; going ahead on --confirm-lady-down. Actions lady took after that bundle are not in this state."
    fi
    if ! bundle="$(prepare "$srv/run")"; then
      rm -f "$fence"; rm -rf "$srv/run"
      die "could not prepare the state; fence removed, nothing started. If lady stood down, start its operators again there (systemctl --user start mamoru-operator mamoru-operator-monad)."
    fi
    echo "active $(now_ts)" >"$fence"; chmod 644 "$fence"
    say "running state from $(basename "$bundle")"
    for u in $(jq -r '.units | keys[]' "$srv/run/meta.json"); do
      write_unit_env "$srv/run" "$u"
      systemctl start "mamoru-standby-operator@$u" "mamoru-standby-tunnel@$u"
    done
    sleep 20
    for u in $(jq -r '.units | keys[]' "$srv/run/meta.json"); do
      port="$(sed -n 's/^PORT=//p' "$srv/run/$u/port.env")"
      health="$(curl -fsS --max-time 5 "http://127.0.0.1:$port/health" 2>/dev/null || echo "no answer")"
      url="$(journalctl -u "mamoru-standby-tunnel@$u" --no-pager -o cat | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1)"
      say "$u: port $port, health: $health"
      say "  tunnel: ${url:-not up yet (journalctl -u mamoru-standby-tunnel@$u)}"
    done
    say "Point the Worker at these URLs from a machine with wrangler (prod and beta), unless the named tunnel (#206) already serves them:"
    say "  printf %s <base url> | bunx wrangler secret put OPERATOR_URL; …--env beta; OPERATOR_URL_143 for Monad on beta"
    ;;

  handback)
    [ -f "$fence" ] || die "no fence: nothing to hand back"
    for u in $(op_units); do systemctl stop "$u" 2>/dev/null || true; done
    [ -d "$srv/run" ] || die "no running state in $srv/run"
    recipient="$(tr -d '[:space:]' <"$recipient_file")"
    ts="$(now_ts)"; install -d -m 700 /var/lib/mamoru-failover/handback
    out="/var/lib/mamoru-failover/handback/handback-$ts.tar.zst.age"
    tar -C "$srv/run" --exclude='*/unit.env' --exclude='*/port.env' -cf - . | zstd -q -10 | age -r "$recipient" >"$out"
    find "$srv/run" -type f -exec shred -u {} + ; rm -rf "$srv/run"
    say "operators stopped here, state sealed for lady: $out"
    say "on lady: scp root@<vps>:$out . ; restore it (README), then: ssh root@<vps> mamoru-failover clear"
    ;;

  clear)
    for u in $(op_units); do systemctl is-active --quiet "$u" && die "$u still runs here; handback first"; done
    [ -d "$srv/run" ] && die "$srv/run still holds state; handback first"
    rm -f "$fence" "$inbox/lady-stopped"
    say "fence cleared: lady's operators may start"
    ;;

  *) sed -n '2,16p' "$0" >&2; exit 2 ;;
esac
