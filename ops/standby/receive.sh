#!/usr/bin/env bash
# Cold standby, VPS side (otto/mamoru#237): the forced command of lady's upload key in
# ~mamoru-standby/.ssh/authorized_keys ("restrict,command=\"/usr/local/lib/mamoru-standby/receive.sh\" ssh-ed25519 …").
# lady can only do two things here:
#   put <name> <sha256>   store stdin as inbox/<name> if it is an age file with that sha256 (the content is opaque)
#   status                print the fence: "fence none" or "fence active <ts>"
# It cannot read a bundle back, list the inbox, or change the fence, which is root's (/var/lib/mamoru-failover).
set -euo pipefail
umask 077

inbox=/var/lib/mamoru-standby/inbox
fence=/var/lib/mamoru-failover/fence
keep_state=288                 # one day of 5-minute bundles; code archives are all kept (failover needs any sha)
max_bytes=$((512 * 1024 * 1024))

read -r verb name sum extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[ -z "${extra:-}" ] || { echo "refused: too many words" >&2; exit 2; }

case "$verb" in
  put)
    [[ ${name:-} =~ ^(state-[0-9]{8}T[0-9]{6}Z|code-[0-9a-f]{40})\.tar\.zst\.age$ ]] || { echo "refused: bad name" >&2; exit 2; }
    [[ ${sum:-} =~ ^[0-9a-f]{64}$ ]] || { echo "refused: bad sha256" >&2; exit 2; }
    tmp="$(mktemp "$inbox/.incoming.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    head -c $((max_bytes + 1)) >"$tmp"
    [ "$(stat -c %s "$tmp")" -le "$max_bytes" ] || { echo "refused: over $max_bytes bytes" >&2; exit 2; }
    [ "$(head -c 21 "$tmp")" = "age-encryption.org/v1" ] || { echo "refused: not an age file" >&2; exit 2; }
    # A dropped connection leaves a short file: only the exact upload is kept.
    [ "$(sha256sum "$tmp" | cut -d' ' -f1)" = "$sum" ] || { echo "refused: sha256 mismatch (truncated upload?)" >&2; exit 2; }
    mv "$tmp" "$inbox/$name"
    trap - EXIT
    find "$inbox" -maxdepth 1 -name 'state-*.tar.zst.age' -printf '%f\n' | sort -r | tail -n +$((keep_state + 1)) \
      | while read -r old; do rm -f "$inbox/$old"; done
    echo "stored $name"
    ;;
  status)
    if [ -f "$fence" ]; then
      f="$(cat "$fence")" || { echo "fence unreadable"; exit 0; }
      echo "fence $f"
    else
      echo "fence none"
    fi
    ;;
  *)
    echo "refused: put <name> <sha256> | status" >&2; exit 2 ;;
esac
