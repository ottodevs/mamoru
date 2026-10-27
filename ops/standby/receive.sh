#!/usr/bin/env bash
# Cold standby, VPS side (otto/mamoru#237): the forced command of lady's upload key in
# ~mamoru-standby/.ssh/authorized_keys ("restrict,command=\"/usr/local/lib/mamoru-standby/receive.sh\" ssh-ed25519 …").
# lady can only do three things here:
#   put <name>   store stdin as inbox/<name> (an age-encrypted bundle; the name is checked, the content is opaque)
#   status       print the fence: "fence none", "fence pending <ts>" or "fence active <ts>"
#   ack <ts>     say lady's operators are stopped, answering a pending fence (fence-watch.sh)
set -euo pipefail
umask 077

base=/var/lib/mamoru-standby
inbox="$base/inbox"
fence=/var/lib/mamoru-failover/fence   # root-owned: the upload key can read it, never change it
keep_state=288                 # one day of 5-minute bundles
keep_code=30                   # a sha stays while a later one is deployed 29 times; lady re-sends after a prune is not automatic

read -r verb arg extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[ -z "${extra:-}" ] || { echo "refused: too many words" >&2; exit 2; }

case "$verb" in
  put)
    [[ $arg =~ ^(state-[0-9]{8}T[0-9]{6}Z|code-[0-9a-f]{40})\.tar\.zst\.age$ ]] || { echo "refused: bad name" >&2; exit 2; }
    mkdir -p "$inbox"
    tmp="$(mktemp "$inbox/.incoming.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    head -c $((512 * 1024 * 1024)) >"$tmp"
    # age's binary header, so a truncated or plain upload is not kept as a bundle.
    [ "$(head -c 21 "$tmp")" = "age-encryption.org/v1" ] || { echo "refused: not an age file" >&2; exit 2; }
    mv "$tmp" "$inbox/$arg"
    trap - EXIT
    ls -1t "$inbox"/state-*.tar.zst.age 2>/dev/null | tail -n +$((keep_state + 1)) | xargs -r rm -f
    ls -1t "$inbox"/code-*.tar.zst.age 2>/dev/null | tail -n +$((keep_code + 1)) | xargs -r rm -f
    echo "stored $arg"
    ;;
  status)
    if [ -f "$fence" ]; then echo "fence $(cat "$fence")"; else echo "fence none"; fi
    ;;
  ack)
    [[ $arg =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "refused: bad timestamp" >&2; exit 2; }
    mkdir -p "$inbox"
    printf '%s\n' "$arg" >"$inbox/lady-stopped"
    echo "ack $arg"
    ;;
  *)
    echo "refused: put <name> | status | ack <ts>" >&2; exit 2 ;;
esac
