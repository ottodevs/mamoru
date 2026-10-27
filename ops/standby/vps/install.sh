#!/usr/bin/env bash
# Installs the cold standby on the edge VPS (otto/mamoru#237). Run as root from a checkout of ops/standby:
#   sudo ./vps/install.sh <lady upload public key file> <age recipient file>
# Idempotent. Adds two users and a few files; touches nothing the VPS already runs (the hs.ot2.me edge).
set -euo pipefail
cd "$(dirname "$0")/.."
upload_pub="${1:?lady upload public key file}"
recipient_file="${2:?age recipient file}"
bun_version=1.3.13   # baseline build: this VPS has no AVX2
cloudflared_version=2026.2.0

# Exactly one line each: a second line in the .pub would become an unrestricted key for mamoru-standby.
[ "$(wc -l <"$upload_pub")" -le 1 ] && grep -Eq '^ssh-ed25519 [A-Za-z0-9+/=]+( [^ ]+)?$' "$upload_pub" \
  || { echo "$upload_pub is not one ed25519 public key" >&2; exit 1; }
[ "$(wc -l <"$recipient_file")" -le 1 ] && grep -Eq '^age1[0-9a-z]{58}$' "$recipient_file" \
  || { echo "$recipient_file is not one age recipient" >&2; exit 1; }

apt-get install -y -qq age jq zstd curl unzip >/dev/null

id mamoru-standby >/dev/null 2>&1 || useradd --system --home-dir /var/lib/mamoru-standby --create-home --shell /bin/bash mamoru-standby
id mamoru-op >/dev/null 2>&1 || useradd --system --home-dir /srv/mamoru-op --create-home --shell /usr/sbin/nologin mamoru-op
install -d -o mamoru-standby -g mamoru-standby -m 700 /var/lib/mamoru-standby /var/lib/mamoru-standby/inbox /var/lib/mamoru-standby/.ssh
install -d -o root -g root -m 755 /var/lib/mamoru-failover
install -d -o root -g root -m 700 /var/lib/mamoru-failover/installed /var/lib/mamoru-failover/handback
install -d -o mamoru-op -g mamoru-op -m 700 /srv/mamoru-op /srv/mamoru-op/code
install -d -m 755 /etc/mamoru-standby /usr/local/lib/mamoru-standby
install -m 644 "$recipient_file" /etc/mamoru-standby/recipient

install -m 755 receive.sh /usr/local/lib/mamoru-standby/receive.sh
install -m 750 failover.sh /usr/local/sbin/mamoru-failover
printf 'restrict,command="/usr/local/lib/mamoru-standby/receive.sh" %s\n' "$(cat "$upload_pub")" \
  >/var/lib/mamoru-standby/.ssh/authorized_keys
chown mamoru-standby:mamoru-standby /var/lib/mamoru-standby/.ssh/authorized_keys
chmod 600 /var/lib/mamoru-standby/.ssh/authorized_keys

# sshd here allows keys only (network-contract, 25-oct). If AllowUsers is set, add mamoru-standby to it.
if sshd -T 2>/dev/null | grep -qi '^allowusers '; then
  echo "sshd has AllowUsers: add mamoru-standby there by hand" >&2
fi

if [ "$(/usr/local/bin/bun --version 2>/dev/null)" != "$bun_version" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/bun-linux-x64-baseline.zip" "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/bun-linux-x64-baseline.zip"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://github.com/oven-sh/bun/releases/download/bun-v$bun_version/SHASUMS256.txt"
  (cd "$tmp" && grep ' bun-linux-x64-baseline.zip$' SHASUMS256.txt | sha256sum -c --quiet)
  unzip -q -o "$tmp/bun-linux-x64-baseline.zip" -d "$tmp" && install -m 755 "$tmp/bun-linux-x64-baseline/bun" /usr/local/bin/bun
  rm -rf "$tmp"
fi
if ! /usr/local/bin/cloudflared --version 2>/dev/null | grep -q "$cloudflared_version"; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/cloudflared" "https://github.com/cloudflare/cloudflared/releases/download/$cloudflared_version/cloudflared-linux-amd64"
  # GitHub's own sha256 of the release asset (same origin as the file: it guards transport and mirrors, not GitHub).
  want="$(curl -fsSL "https://api.github.com/repos/cloudflare/cloudflared/releases/tags/$cloudflared_version" \
    | jq -r '.assets[] | select(.name == "cloudflared-linux-amd64") | .digest' | sed 's/^sha256://')"
  [[ $want =~ ^[0-9a-f]{64}$ ]] || { echo "no sha256 published for cloudflared $cloudflared_version" >&2; exit 1; }
  echo "$want  $tmp/cloudflared" | sha256sum -c --quiet
  install -m 755 "$tmp/cloudflared" /usr/local/bin/cloudflared
  rm -rf "$tmp"
fi

install -m 644 vps/mamoru-standby-operator@.service vps/mamoru-standby-tunnel@.service /etc/systemd/system/
systemctl daemon-reload
echo "installed: bun $(/usr/local/bin/bun --version), $(/usr/local/bin/cloudflared --version | head -1)"
