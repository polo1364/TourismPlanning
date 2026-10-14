#!/usr/bin/env bash
# Run via sudo with an allowlisted release archive and a protected environment file.
set -euo pipefail
umask 077
RELEASE=${1:?release timestamp required}
[[ "$RELEASE" =~ ^[0-9]{8}-[0-9]{6}$ ]] || exit 2
[[ "$EUID" == 0 ]] || exit 2
ARCHIVE="/home/ubuntu/roam-release-${RELEASE}.tgz"
ENV_FILE=/home/ubuntu/roam-cloud.env
test -f "$ARCHIVE"
test -f "$ENV_FILE"
STAMP=$(date -u +%Y%m%d-%H%M%S)

# Small VM: a disk-backed safety margin for installation and CLI peaks.
if [[ ! -e /swap-roam ]]; then
  fallocate -l 2G /swap-roam
  chmod 600 /swap-roam
  mkswap /swap-roam >/dev/null
  swapon /swap-roam
  cp -p /etc/fstab "/etc/fstab.bak.roam-${STAMP}"
  printf '\n/swap-roam none swap sw 0 0\n' >> /etc/fstab
fi

if ! command -v caddy >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key -o /tmp/roam-caddy.gpg
  gpg --dearmor --batch -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg /tmp/roam-caddy.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt -o /etc/apt/sources.list.d/caddy-stable.list
  chmod 644 /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

install -d -m 755 /opt/roam/releases /etc/roam
test ! -e "/opt/roam/releases/$RELEASE"
install -d -m 755 "/opt/roam/releases/$RELEASE"
tar -xzf "$ARCHIVE" -C "/opt/roam/releases/$RELEASE" --no-same-owner
chmod -R u=rwX,go=rX "/opt/roam/releases/$RELEASE"
for file in /etc/roam/cloud.env /etc/systemd/system/roam-cloud.service /etc/caddy/Caddyfile; do
  if [[ -f "$file" ]]; then cp -p "$file" "$file.bak.roam-${STAMP}"; fi
done
install -m 600 "$ENV_FILE" /etc/roam/cloud.env
install -m 644 "/opt/roam/releases/$RELEASE/deploy/roam-cloud.service" /etc/systemd/system/roam-cloud.service
install -m 644 "/opt/roam/releases/$RELEASE/deploy/Caddyfile" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
ln -sfn "/opt/roam/releases/$RELEASE" /opt/roam/current
systemctl daemon-reload
systemctl enable roam-cloud caddy
systemctl restart roam-cloud
systemctl reload caddy

# Preserve Oracle's existing rules and metadata protection; open only web ports.
iptables-save > "/etc/roam/iptables.before-${STAMP}"
iptables -C INPUT -p tcp -m multiport --dports 80,443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -m multiport --dports 80,443 -j ACCEPT
if [[ -f /etc/iptables/rules.v4 ]]; then cp -p /etc/iptables/rules.v4 "/etc/iptables/rules.v4.bak.roam-${STAMP}"; fi
install -d -m 755 /etc/iptables
iptables-save > /etc/iptables/rules.v4
systemctl is-active roam-cloud caddy
systemctl is-enabled roam-cloud caddy
echo 'Services installed; HTTPS and real generation still need external verification.'
