#!/usr/bin/env bash
# OnFailure of mamoru-standby-push / -fence (otto/mamoru#237): say so in ops-mamoru as mamorusan, since a push that
# keeps failing leaves the VPS with an old state and nothing else would notice. Never prints the token.
set -euo pipefail
export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$USER/bin:/run/current-system/sw/bin:$PATH"
unit="${1:?unit}"
f="$HOME/.config/mamoru-app/mattermost.env"
url="$(sed -n 's/^MATTERMOST_URL=//p' "$f")"; tok="$(sed -n 's/^MATTERMOST_BOT_TOKEN=//p' "$f")"
chan="$(cat "$HOME/.config/mamoru-standby/alert-channel")"
last="$(journalctl --user -u "$unit" -n 3 --no-pager -o cat | tail -1 | cut -c1-200)"
jq -n --arg c "$chan" --arg m ":warning: Mamoru standby: \`$unit\` failed on $(hostname): $last" '{channel_id: $c, message: $m}' \
  | curl -fsS --max-time 10 -X POST -H "Authorization: Bearer $tok" -H 'content-type: application/json' "$url/api/v4/posts" -d @- >/dev/null
