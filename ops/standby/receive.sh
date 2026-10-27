#!/usr/bin/env bash
# Cold standby, VPS side (otto/mamoru#237): the forced command of lady's upload key in
# ~mamoru-standby/.ssh/authorized_keys ("restrict,command=\"/usr/local/lib/mamoru-standby/receive.sh\" ssh-ed25519 …").
# lady can only do two things here:
#   put <name> <sha256>   store stdin as inbox/<name> if its sha256 matches. Each bundle F comes as three files:
#                         F (age ciphertext), F.manifest ("F <sha256> <unix time>") and F.manifest.sig (lady's
#                         signing key over the manifest). A signature is kept only if it verifies; a file that a
#                         verified manifest covers is never replaced by other content.
#   status                print the fence: "fence none" or "fence active <ts>"
# It cannot read a file back, list the inbox, or change the fence, which is root's (/var/lib/mamoru-failover).
set -euo pipefail
umask 077

inbox=/var/lib/mamoru-standby/inbox
fence=/var/lib/mamoru-failover/fence
signers=/etc/mamoru-standby/allowed_signers
keep_state=288                 # one day of 5-minute bundles; code archives are all kept (failover needs any sha)
max_bytes=$((512 * 1024 * 1024))
base_re='(state-[0-9]{8}T[0-9]{6}Z|code-[0-9a-f]{40})\.tar\.zst\.age'

read -r verb name sum extra <<<"${SSH_ORIGINAL_COMMAND:-}"
[ -z "${extra:-}" ] || { echo "refused: too many words" >&2; exit 2; }

sha_of() { sha256sum "$1" | cut -d' ' -f1; }
# F is covered: its manifest is signed by lady and names F's exact content.
covered() {
  local f="$1"
  [ -f "$f" ] && [ -f "$f.manifest" ] && [ -f "$f.manifest.sig" ] || return 1
  ssh-keygen -Y verify -f "$signers" -I lady -n mamoru-standby -s "$f.manifest.sig" <"$f.manifest" >/dev/null 2>&1 || return 1
  [ "$(cut -d' ' -f2 "$f.manifest")" = "$(sha_of "$f")" ]
}

case "$verb" in
  put)
    [[ ${name:-} =~ ^${base_re}(\.manifest(\.sig)?)?$ ]] || { echo "refused: bad name" >&2; exit 2; }
    [[ ${sum:-} =~ ^[0-9a-f]{64}$ ]] || { echo "refused: bad sha256" >&2; exit 2; }
    base="${name%.sig}"; base="${base%.manifest}"
    tmp="$(mktemp "$inbox/.incoming.XXXXXX")"
    trap 'rm -f "$tmp"' EXIT
    head -c $((max_bytes + 1)) >"$tmp"
    [ "$(stat -c %s "$tmp")" -le "$max_bytes" ] || { echo "refused: over $max_bytes bytes" >&2; exit 2; }
    # A dropped connection leaves a short file: only the exact upload is kept.
    [ "$(sha_of "$tmp")" = "$sum" ] || { echo "refused: sha256 mismatch (truncated upload?)" >&2; exit 2; }
    # The same content again is a success (a retry after a lost answer), never a wedge.
    if [ -f "$inbox/$name" ] && [ "$(sha_of "$inbox/$name")" = "$sum" ]; then echo "stored $name (unchanged)"; exit 0; fi
    covered "$inbox/$base" && { echo "refused: $base is signed; it is never replaced" >&2; exit 2; }
    case "$name" in
      *.manifest.sig)
        [ -f "$inbox/$base.manifest" ] || { echo "refused: no manifest for this signature" >&2; exit 2; }
        ssh-keygen -Y verify -f "$signers" -I lady -n mamoru-standby -s "$tmp" <"$inbox/$base.manifest" >/dev/null 2>&1 \
          || { echo "refused: signature does not verify" >&2; exit 2; }
        ;;
      *.manifest)
        grep -Eqx "${base//./\\.} [0-9a-f]{64} [0-9]{10}" "$tmp" && [ "$(grep -c '' "$tmp")" -eq 1 ] \
          || { echo "refused: bad manifest" >&2; exit 2; }
        rm -f "$inbox/$base.manifest.sig"
        ;;
      *)
        [ "$(head -c 21 "$tmp")" = "age-encryption.org/v1" ] || { echo "refused: not an age file" >&2; exit 2; }
        rm -f "$inbox/$base.manifest" "$inbox/$base.manifest.sig"   # unsigned leftovers of an earlier try
        ;;
    esac
    mv "$tmp" "$inbox/$name"
    trap - EXIT
    echo "stored $name"
    # Pruning, after a signature completes a state bundle: keep the newest signed ones by their signed time; drop
    # unsigned state files older than an hour (a failed try, or junk), so junk can never push a signed bundle out.
    if [[ $name == state-*.manifest.sig ]]; then
      find "$inbox" -maxdepth 1 -name 'state-*.tar.zst.age.manifest' -printf '%f\n' | while read -r m; do
        f="$inbox/${m%.manifest}"; covered "$f" && echo "$(cut -d' ' -f3 "$f.manifest") $f"
      done | sort -rn | tail -n +$((keep_state + 1)) | while read -r _ f; do rm -f "$f" "$f.manifest" "$f.manifest.sig"; done
      find "$inbox" -maxdepth 1 -name 'state-*.tar.zst.age' -mmin +60 -print | while read -r f; do
        covered "$f" || rm -f "$f" "$f.manifest" "$f.manifest.sig"
      done
    fi
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
