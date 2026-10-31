#!/usr/bin/env bash
# Cold standby, VPS side (otto/mamoru#237): installed as /usr/local/sbin/mamoru-failover, run as root by Ot from
# ghost3 with the standby age identity on stdin (~/.config/mamoru-standby/identity, a key for this and nothing
# else). The identity stays in memory; it is never written to this disk.
#
#   mamoru-failover status
#   mamoru-failover drill                                         < identity   decrypt, check, install the code,
#                                                                              start nothing, shred the state
#   mamoru-failover activate [--confirm-lady-down] [--accept-old] < identity
#   mamoru-failover handback                                      stop the operators here, seal their state for lady
#   mamoru-failover clear [--discard]                             drop the fence once lady has the hand-back state
#
# Never two operators. activate starts only when the newest bundle says lady stood down (fence-watch.sh standdown:
# its operators stopped, a local fence kept there), or, when lady has been silent for 10 min, on
# --confirm-lady-down: Ot's word that lady's operators are not running. lady fails closed: while this fence is set,
# or while lady cannot read it, its operators do not start. Every bundle is signed by lady's signing key; anything
# else in the inbox is ignored. See ops/standby/README.md.
set -euo pipefail
umask 077
trap '' HUP PIPE   # a dropped ssh session does not stop a failover half way
cd /               # commands run as mamoru-op must not inherit root's cwd

inbox=/var/lib/mamoru-standby/inbox
fdir=/var/lib/mamoru-failover
fence="$fdir/fence"
srv=/srv/mamoru-op
recipient_file=/etc/mamoru-standby/recipient
signers=/etc/mamoru-standby/allowed_signers
heartbeat_fresh_s=600
max_age_s=3600
unit_re='^mamoru-operator(-monad)?$'

say() { printf '%s\n' "$*" >&2 || true; logger -t mamoru-failover -- "$*" || true; }
die() { say "mamoru-failover: $*"; exit 1; }
now_ts() { date -u +%Y%m%dT%H%M%SZ; }
std_units() { for u in mamoru-operator mamoru-operator-monad; do echo "mamoru-standby-operator@$u" "mamoru-standby-tunnel@$u"; done; }
set_fence() { local t; t="$(mktemp "$fdir/.fence.XXXXXX")"; echo "$1" >"$t"; chmod 644 "$t"; mv "$t" "$fence"; }
as_op() { runuser -u mamoru-op -- "$@"; }
# Everything under $srv belongs to mamoru-op (the operator's own user): root never creates, chowns, reads or
# deletes there by path; it acts as mamoru-op, so a link planted there cannot point root anywhere.
wipe() { as_op find "$1" -type f -exec shred -fu {} + 2>/dev/null || true; as_op rm -rf "$1" 2>/dev/null || true; }

# A file of the inbox is usable only through its manifest ("<name> <sha256> <unix time>") signed by lady. Prints
# "<sha256> <time>" of a verified manifest of $1, nothing otherwise. The manifest is copied before it is checked, so
# the mamoru-standby account cannot swap it between the check and the use.
manifest_of() {
  local f="$1" t out="" n sum when
  t="$(mktemp -d "$fdir/tmp.XXXXXX")"
  if cp "$inbox/$f.manifest" "$t/m" 2>/dev/null && cp "$inbox/$f.manifest.sig" "$t/s" 2>/dev/null \
    && ssh-keygen -Y verify -f "$signers" -I lady -n mamoru-standby -s "$t/s" <"$t/m" >/dev/null 2>&1 \
    && read -r n sum when <"$t/m" && [ "$n" = "$f" ] && [[ $sum =~ ^[0-9a-f]{64}$ && $when =~ ^[0-9]{10}$ ]] \
    && [ "$when" -le $(( $(date +%s) + 300 )) ]; then   # a time ahead of this clock would stay "newest" for ever
    out="$sum $when"
  fi
  rm -rf "$t"
  if [ -n "$out" ]; then echo "$out"; fi
}
# Newest state bundle by the time lady signed into its manifest. Prints "<name> <sha256> <time>".
newest_state() {
  local m f v
  find "$inbox" -maxdepth 1 -name 'state-*.tar.zst.age.manifest' -printf '%f\n' | while read -r m; do
    f="${m%.manifest}"; v="$(manifest_of "$f")"
    # Only a bundle whose ciphertext is here and matches counts (unpack checks it again on a copy).
    if [ -n "$v" ] && [ -f "$inbox/$f" ] && [ "$(sha256sum <"$inbox/$f" | cut -d' ' -f1)" = "${v%% *}" ]; then echo "$f $v"; fi
  done | sort -k3,3nr | awk 'NR == 1'   # awk reads it all: SIGPIPE is ignored here, so head would make sort fail loudly
}
signed_age_s() { echo $(( $(date +%s) - $1 )); }

read_identity() {
  [ -t 0 ] && die "pipe the standby identity on stdin (ssh root@vps mamoru-failover $1 < ~/.config/mamoru-standby/identity)"
  identity="$(cat)"
  [ "$(grep -c '^AGE-SECRET-KEY-' <<<"$identity")" = 1 ] || die "stdin must hold exactly one age identity"
}

# Decrypts inbox file $1, whose verified manifest says sha256 $3, into $2 (created by mamoru-op). The ciphertext is
# copied into a root-only directory and checked there; the plain tar stays there; only regular files and
# directories are accepted; tar runs as mamoru-op reading it from a descriptor root opened.
unpack() {
  local src="$1" dest="$2" want="$3" tmpd listing
  tmpd="$(mktemp -d "$fdir/tmp.XXXXXX")"
  if ! cp "$inbox/$src" "$tmpd/c" || [ "$(sha256sum "$tmpd/c" | cut -d' ' -f1)" != "$want" ]; then
    rm -rf "$tmpd"; say "$src does not match its signed manifest"; return 1
  fi
  age -d -i <(printf '%s\n' "$identity") "$tmpd/c" | zstd -dq >"$tmpd/plain" || { shred -u "$tmpd/plain"; rm -rf "$tmpd"; return 1; }
  listing="$(tar -tvf "$tmpd/plain")" || { shred -u "$tmpd/plain"; rm -rf "$tmpd"; return 1; }
  if [ -z "$listing" ] || [ -n "$(cut -c1 <<<"$listing" | grep -v '^[-d]$' || true)" ]; then
    shred -u "$tmpd/plain"; rm -rf "$tmpd"; say "$src is empty or holds a link or device"; return 1
  fi
  as_op tar --no-same-owner --no-same-permissions -C "$dest" -xf - <"$tmpd/plain" || { shred -u "$tmpd/plain"; rm -rf "$tmpd"; return 1; }
  shred -u "$tmpd/plain"; rm -rf "$tmpd"
}
meta() { as_op cat "$1/meta.json"; }

# Decrypts bundle $1 into $2 and installs the code of every sha it names (cached per sha). Every step checks
# itself: this runs where errexit may be off.
prepare() {
  local bundle="$1" want="$2" dest="$3" u sha code
  wipe "$dest"; as_op mkdir -m 700 "$dest" || return 1
  unpack "$bundle" "$dest" "$want" || { say "cannot verify, decrypt or unpack $bundle"; return 1; }
  [ "$(meta "$dest" | jq -r '.name // empty')" = "$bundle" ] || { say "$bundle: its signed content names another bundle"; return 1; }
  meta "$dest" | jq -e '.units | length > 0' >/dev/null || { say "$bundle has no units"; return 1; }
  for u in $(meta "$dest" | jq -r '.units | keys[]'); do
    [[ $u =~ $unit_re ]] || { say "$bundle names an unknown unit"; return 1; }
    as_op bash -c '[ -f "$1/env" ] && [ -n "$(ls -A "$1/state")" ] && find "$1/state" -type f -name "*.json" -exec jq -e . {} + >/dev/null' _ "$dest/$u" \
      || { say "$bundle: $u has no env, an empty state or a JSON file that does not parse"; return 1; }
    sha="$(meta "$dest" | jq -r --arg u "$u" '.units[$u].sha')"
    [[ $sha =~ ^[0-9a-f]{40}$ ]] || { say "$bundle: $u has no sha"; return 1; }
    [ -f "$fdir/installed/$sha" ] && continue
    code="$(manifest_of "code-$sha.tar.zst.age")"
    [ -n "$code" ] || { say "no signed code archive for $sha"; return 1; }
    wipe "$srv/code/$sha"; as_op mkdir -p -m 700 "$srv/code/$sha" || return 1
    unpack "code-$sha.tar.zst.age" "$srv/code/$sha" "${code%% *}" || { say "cannot verify or unpack the code of $sha"; return 1; }
    (cd "$srv/code/$sha" && as_op env HOME="$srv" bun install --frozen-lockfile >/dev/null) || { say "bun install failed for $sha"; return 1; }
    touch "$fdir/installed/$sha" || return 1
  done
}

# Unit environment, written by root into its own directory from files read as mamoru-op.
write_unit_env() {
  local run="$1" u="$2" sha port
  sha="$(meta "$run" | jq -r --arg u "$u" '.units[$u].sha')"
  # Root's directory, traversable so the unit (User=mamoru-op) can chdir through current-<unit>; the env files
  # inside stay 0600 (systemd reads EnvironmentFile as root).
  install -d -m 755 "$fdir/units"
  ln -sfn "$srv/code/$sha" "$fdir/units/current-$u"
  {
    as_op cat "$run/$u/unit-environment" | grep -E '^[A-Z0-9_]+=[^ ]*$' || true
    echo "MAMORU_OPERATOR_ENV=$run/$u/env"
    echo "MAMORU_OPERATOR_STATE_DIR=$run/$u/state"
    echo "MAMORU_GIT_SHA=$sha"   # a code archive has no .git: without it /metrics says "unknown" (#249)
  } >"$fdir/units/$u.env"
  port="$(as_op cat "$run/$u/env" | sed -n 's/^PORT=\([0-9]\{2,5\}\)$/\1/p' | tail -1)"
  echo "PORT=${port:-8787}" >"$fdir/units/$u.port"
}

if [ "${1:-}" != status ]; then
  exec 8>"$fdir/lock"; flock -n 8 || die "another mamoru-failover is running"
  # A run killed mid-unpack can leave a plain tar behind; holding the lock, none of these is in use.
  for d in "$fdir"/tmp.*; do [ -d "$d" ] && { shred -u "$d"/* 2>/dev/null || true; rm -rf "$d"; }; done
fi

case "${1:-}" in
  status)
    if [ -f "$fence" ]; then echo "fence $(cat "$fence")"; else echo "fence none"; fi
    read -r b _ when <<<"$(newest_state)" || true
    if [ -n "${b:-}" ]; then echo "newest signed bundle $b, signed $(signed_age_s "$when") s ago"; else echo "no signed bundle"; fi
    for u in $(std_units); do printf '%s %s\n' "$u" "$(systemctl is-active "$u" 2>/dev/null || true)"; done
    ;;

  drill)
    [ -f "$fence" ] && die "fence set: no drill during a failover"
    read_identity drill
    read -r b want when <<<"$(newest_state)" || true
    [ -n "${b:-}" ] || die "no signed state bundle in $inbox"
    hb="$(signed_age_s "$when")"
    trap 'wipe "$srv/drill"' EXIT
    prepare "$b" "$want" "$srv/drill" || die "drill failed on $b (decrypted state erased)"
    say "drill ok: $b (${hb}s old) is signed, decrypts, every unit has env and state, its JSON parses, code installed:"
    meta "$srv/drill" | jq -r '.units | to_entries[] | "  \(.key) \(.value.sha[:7]) (lady: \(.value.active), \(.value.enabled // "?"))"' >&2 || true
    [ "$hb" -lt "$heartbeat_fresh_s" ] || say "WARNING: the newest bundle is ${hb}s old: lady's push is failing (journalctl --user -u mamoru-standby-push on lady)"
    say "nothing was started; decrypted state erased"
    ;;

  activate)
    confirm=0; accept_old=0
    for a in "${@:2}"; do case "$a" in --confirm-lady-down) confirm=1 ;; --accept-old) accept_old=1 ;; *) die "unknown flag $a" ;; esac; done
    read_identity activate
    [ -f "$fence" ] && die "fence already set ($(cat "$fence"))"
    for u in $(std_units); do systemctl is-active --quiet "$u" && die "$u already runs"; done
    read -r b want when <<<"$(newest_state)" || true
    [ -n "${b:-}" ] || die "no signed state bundle: nothing to run"
    hb="$(signed_age_s "$when")"
    # Never older than what ran here last: a replayed bundle cannot roll the state back.
    last="$(cat "$fdir/last-run" 2>/dev/null || echo 0)"
    [ "$when" -gt "$last" ] || die "the newest signed bundle ($b) is not newer than the state this VPS last ran; lady has not pushed since the hand back"
    [ "$hb" -lt "$max_age_s" ] || [ "$accept_old" = 1 ] \
      || die "the newest bundle is ${hb}s old: running it would replay old session and relayer state. --accept-old only if nothing newer exists anywhere."
    trap 'wipe "$srv/run"' EXIT
    prepare "$b" "$want" "$srv/run" || die "could not prepare $b; nothing started, decrypted state erased"
    m="$(meta "$srv/run")"
    if [ "$hb" -lt "$heartbeat_fresh_s" ]; then
      # lady is alive: it must have stood down, and the bundle names what it stopped.
      jq -e '[.units[] | select(.active != "inactive" and .active != "failed")] | length == 0' <<<"$m" >/dev/null \
        || die "lady is up (bundle ${hb}s old) and its operators are not stopped. On lady: ~/.local/share/mamoru-standby/fence-watch.sh standdown, then run this again."
      mapfile -t start < <(jq -r '.standdown[]' <<<"$m")
      [ "${#start[@]}" -gt 0 ] || die "lady's operators are stopped but not by standdown; run standdown on lady so it keeps a fence"
    else
      [ "$confirm" = 1 ] || die "lady has been silent for ${hb}s. Check that its operators are not running, then run again with --confirm-lady-down."
      # What lady stood down for, or else what was meant to run there: enabled units that were up or crashing.
      mapfile -t start < <(jq -r 'if (.standdown | length) > 0 then .standdown[]
        else .units | to_entries[] | select(.value.enabled == "enabled" and (.value.active == "active" or .value.active == "activating" or .value.active == "failed")) | .key end' <<<"$m")
      [ "${#start[@]}" -gt 0 ] || die "the last bundle names no operator that lady was running"
      say "lady silent for ${hb}s; going ahead on --confirm-lady-down. What lady did after $b is not in this state."
    fi
    for u in "${start[@]}"; do [[ $u =~ $unit_re ]] || die "unknown unit $u"; done
    set_fence "active $(now_ts) $b"
    echo "$when" >"$fdir/last-run"
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
    say "Point the Worker at these URLs from a machine with wrangler (OPERATOR_URL on prod and beta, OPERATOR_URL_143 on beta): op.mamoru.lol and op-monad.mamoru.lol (#206) end on lady."
    ;;

  handback)
    [ -f "$fence" ] || die "no fence: nothing to hand back"
    for u in $(std_units); do systemctl stop "$u" 2>/dev/null || true; done
    for u in $(std_units); do systemctl is-active --quiet "$u" && die "$u did not stop; nothing sealed"; done
    [ -d "$srv/run" ] || die "no running state in $srv/run"
    recipient="$(tr -d '[:space:]' <"$recipient_file")"
    out="$fdir/handback/handback-$(now_ts).tar.zst.age"
    as_op tar -C "$srv/run" -cf - . | zstd -q -10 | age -r "$recipient" >"$out" || die "sealing failed; state left in $srv/run"
    [ "$(head -c 21 "$out")" = "age-encryption.org/v1" ] || die "sealed file looks wrong; state left in $srv/run"
    wipe "$srv/run"
    echo "$out" >"$fdir/handback/LATEST"
    say "operators stopped here, state sealed for lady: $out"
    say "Next (README, Hand back): copy it to lady, restore it, then: mamoru-failover clear"
    ;;

  clear)
    for u in $(std_units); do systemctl is-active --quiet "$u" && die "$u still runs here; handback first"; done
    [ -e "$srv/run" ] && die "$srv/run still holds state; handback first"
    if [ "${2:-}" != "--discard" ]; then
      [ -f "$fdir/handback/LATEST" ] && [ "$(cat "$fdir/handback/LATEST")" -nt "$fence" ] \
        || die "no hand-back newer than the fence. Hand back first, or --discard if this failover never ran an operator."
    fi
    rm -f "$fence"
    say "fence cleared: on lady, after restoring the state, fence-watch.sh resume"
    ;;

  *) sed -n '2,18p' "$0" >&2; exit 2 ;;
esac
