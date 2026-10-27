#!/usr/bin/env bash
# Cold standby fence, lady side (otto/mamoru#237). Two operators on the same accounts corrupt the session keys'
# use and the relayer nonce, so lady's operators must never run while the VPS runs them. This side fails closed.
#
#   fence-watch.sh pre <unit>   ExecStartPre of each operator unit. Starts only on an exact "fence none" from the
#                               VPS and no local fence. VPS unreachable: refuse (retried for a minute; the watch
#                               starts the unit once the VPS answers), unless ~/.local/state/mamoru-standby/
#                               allow-unreachable exists (the coordinator's override, removed after use).
#   fence-watch.sh watch        every minute (mamoru-standby-fence.timer). "fence active": stop lady's operators and
#                               keep a local fence, so a reboot or a hand start cannot bring them back even when the
#                               VPS is unreachable. Exact "fence none": start the units `pre` refused only for an
#                               unreachable VPS.
#   fence-watch.sh standdown    by hand before a failover while lady is up: stop the operators, keep a local fence
#                               naming them, push the last bundle. failover.sh then starts exactly those units.
#   fence-watch.sh resume       by hand after the hand-back state is restored: needs "fence none", drops the local
#                               fence and starts the units it named.
set -euo pipefail
export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:$PATH"

st="$HOME/.local/state/mamoru-standby"
host="${MAMORU_STANDBY_HOST:-mamoru-standby@23.94.151.198}"
key="${MAMORU_STANDBY_KEY:-$HOME/.ssh/mamoru-standby}"
units=(mamoru-operator mamoru-operator-monad)
mkdir -p "$st"

vps_status() {
  timeout 20 ssh -i "$key" -o BatchMode=yes -o ConnectTimeout=8 -o ServerAliveInterval=5 -o ServerAliveCountMax=2 \
    -o IdentitiesOnly=yes "$host" status 2>/dev/null || echo "unreachable"
}
stop_all() {
  local u
  for u in "${units[@]}"; do systemctl --user stop "$u" || true; done
  for u in "${units[@]}"; do
    case "$(systemctl --user show "$u" -p ActiveState --value)" in inactive|failed) ;; *) echo "$u did not stop" >&2; return 1 ;; esac
  done
}
running_units() { local u; for u in "${units[@]}"; do systemctl --user is-active --quiet "$u" && echo "$u"; done; true; }

case "${1:-}" in
  pre)
    unit="${2:?unit name}"
    [ -f "$st/fenced" ] && { echo "refusing to start $unit: local fence ($st/fenced). After the hand back: fence-watch.sh resume" >&2; exit 1; }
    for _ in 1 2 3; do
      s="$(vps_status)"
      case "$s" in
        "fence none") rm -f "$st/blocked-$unit"; exit 0 ;;
        "fence active"*) printf '%s\n' "${units[@]}" >"$st/fenced"; echo "refusing to start $unit: the VPS runs the operator ($s)" >&2; exit 1 ;;
      esac
      sleep 5
    done
    if [ -f "$st/allow-unreachable" ]; then
      echo "standby VPS unreachable ($s); starting $unit on the coordinator's override" >&2; exit 0
    fi
    touch "$st/blocked-$unit"
    echo "refusing to start $unit: the standby VPS does not answer ($s), so it cannot say it is not running the operator. The fence watch starts $unit when it answers; override: touch $st/allow-unreachable" >&2
    exit 1
    ;;
  watch)
    s="$(vps_status)"
    case "$s" in
      "fence active"*)
        [ -f "$st/fenced" ] || running_units >"$st/fenced"
        [ -s "$st/fenced" ] || printf '%s\n' "${units[@]}" >"$st/fenced"
        if [ -n "$(running_units)" ]; then echo "the VPS runs the operator ($s): stopping lady's"; stop_all; fi
        ;;
      "fence none")
        [ -f "$st/fenced" ] && exit 0
        for u in "${units[@]}"; do
          if [ -f "$st/blocked-$u" ]; then
            echo "the VPS answers 'fence none': starting $u, refused earlier while it was unreachable"
            rm -f "$st/blocked-$u"; systemctl --user reset-failed "$u" || true; systemctl --user start "$u" || true
          fi
        done
        ;;
    esac
    ;;
  standdown)
    s="$(vps_status)"
    [ "$s" = "fence none" ] || { echo "the VPS says '$s'; standdown is for a VPS that is not running yet" >&2; exit 1; }
    exec 9>"$st/push.lock"; flock -w 300 9 || { echo "a push holds the lock" >&2; exit 1; }
    run="$(running_units)"
    [ -n "$run" ] || { echo "no operator is running on lady: nothing to stand down" >&2; exit 1; }
    printf '%s\n' "$run" >"$st/fenced"
    stop_all
    flock -u 9
    "$(dirname "$(readlink -f "$0")")/push-bundle.sh"
    echo "stood down: $(tr '\n' ' ' <"$st/fenced")— last bundle sent. On ghost3: ssh root@23.94.151.198 mamoru-failover activate < ~/.config/mamoru-standby/identity"
    ;;
  resume)
    s="$(vps_status)"
    [ "$s" = "fence none" ] || { echo "the VPS says '$s'; hand back and clear there first" >&2; exit 1; }
    [ -f "$st/fenced" ] || { echo "no local fence" >&2; exit 1; }
    mapfile -t back <"$st/fenced"
    rm -f "$st/fenced" "$st"/blocked-*
    for u in "${back[@]}"; do [ -n "$u" ] && systemctl --user reset-failed "$u" 2>/dev/null; [ -n "$u" ] && systemctl --user start "$u"; done
    echo "resumed: ${back[*]}"
    ;;
  *) sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
