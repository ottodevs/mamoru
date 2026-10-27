#!/usr/bin/env bash
# Cold standby fence, lady side (otto/mamoru#237). Two operators on the same accounts corrupt the session keys'
# use and the relayer nonce, so lady's operators must never run while the VPS runs them.
#
#   fence-watch.sh pre     ExecStartPre of each operator unit: refuse to start while the VPS holds a fence.
#   fence-watch.sh watch   every minute (mamoru-standby-fence.timer): if the VPS holds a fence, stop lady's operators
#                          and acknowledge, so a failover started while lady is alive but unreachable from the
#                          Worker (the tunnel died, as on 24-oct) waits for lady to stand down.
#
# When the VPS cannot be reached the answer is "no fence" (the operator keeps running or starts): failover.sh only
# fences after lady's heartbeat is gone or after this script acknowledged, so a VPS that lady cannot reach has not
# taken over unless Ot confirmed lady is down (failover.sh --confirm-lady-down), which the runbook pairs with
# disabling these units on lady before it comes back.
set -euo pipefail
export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:$PATH"

host="${MAMORU_STANDBY_HOST:-mamoru-standby@23.94.151.198}"
key="${MAMORU_STANDBY_KEY:-$HOME/.ssh/mamoru-standby}"
units=(mamoru-operator mamoru-operator-monad)

status="$(ssh -i "$key" -o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes "$host" status 2>/dev/null || echo "unreachable")"

case "${1:-}" in
  pre)
    case "$status" in
      "fence active"*|"fence pending"*)
        echo "refusing to start: the standby VPS holds the operator ($status). Hand back first (ops/standby/README.md)." >&2
        exit 1 ;;
      unreachable) echo "standby VPS unreachable; starting without the fence check" >&2 ;;
    esac
    ;;
  watch)
    case "$status" in
      "fence active"*|"fence pending"*)
        stopped=1
        for u in "${units[@]}"; do
          if systemctl --user is-active --quiet "$u"; then
            echo "fence on the VPS ($status): stopping $u"
            systemctl --user stop "$u" || stopped=0
          fi
        done
        # Only a pending fence waits for an answer; an active one just keeps lady's operators down.
        if [ "$stopped" = 1 ] && [[ $status == "fence pending"* ]]; then
          # The last state lady wrote goes over before the acknowledgement, so the VPS starts from it.
          "$(dirname "$0")/push-bundle.sh"
          ssh -i "$key" -o BatchMode=yes -o ConnectTimeout=8 -o IdentitiesOnly=yes "$host" ack "$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null
        fi
        ;;
    esac
    ;;
  *) echo "usage: fence-watch.sh pre|watch" >&2; exit 2 ;;
esac
