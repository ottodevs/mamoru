#!/usr/bin/env bash
# OnFailure of mamoru-standby-push / -fence (otto/mamoru#237): say so in ops-mamoru as mamorusan, since a push that
# keeps failing leaves the VPS with an old state and nothing else would notice. A fixed message (no log text), and
# the token goes to curl through a descriptor, never on its command line.
set -euo pipefail
export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:$PATH"
unit="${1:?unit}"
[[ $unit =~ ^mamoru-standby-(push|fence)$ ]] || exit 2
f="$HOME/.config/mamoru-app/mattermost.env"
url="$(sed -n 's/^MATTERMOST_URL=//p' "$f")"
chan="$(cat "$HOME/.config/mamoru-standby/alert-channel")"
jq -n --arg c "$chan" --arg m ":warning: Mamoru standby: \`$unit\` failed on $(hostname). On lady: journalctl --user -u $unit -n 20" \
  '{channel_id: $c, message: $m}' \
  | curl -fsS --max-time 10 -X POST -H @<(printf 'Authorization: Bearer %s\n' "$(sed -n 's/^MATTERMOST_BOT_TOKEN=//p' "$f")") \
      -H 'content-type: application/json' "$url/api/v4/posts" -d @- >/dev/null
