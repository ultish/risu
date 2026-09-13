#!/usr/bin/env bash
# Run from the Mac. Sets up hana → Mac sqlite backups for Risu:
#   1. reuse the existing hana → macbook backup key
#   2. daily systemd user timer on hana (snapshot + rsync)
#
# Live sqlite on hana: ~/risu-data/risu.db
# Mac archive:         ~/Documents/Finances/risu-backups
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-jimmy@hana-server}"
REMOTE_APP="${DEPLOY_REMOTE_APP:-risu}"
MAC_USER="${BACKUP_MAC_USER:-jxhui}"
MAC_TS="${BACKUP_MAC_TS:-jimmys-macbook-pro-16}"
MAC_DIR="${BACKUP_MAC_DIR:-Documents/Finances/risu-backups}"
AUTH_KEYS="${HOME}/.ssh/authorized_keys"

echo "==> rsync backup scripts to ${HOST}:${REMOTE_APP}/scripts/"
ssh -o BatchMode=yes "$HOST" "mkdir -p ${REMOTE_APP}/scripts"
rsync -az \
  "${ROOT}/scripts/backup-sqlite.py" \
  "${ROOT}/scripts/hana-backup.sh" \
  "${HOST}:${REMOTE_APP}/scripts/"

echo "==> ensure backup ssh key + macbook alias on hana"
ssh -o BatchMode=yes "$HOST" bash -s <<'REMOTE'
set -euo pipefail
mkdir -p ~/.ssh
chmod 700 ~/.ssh
key="$HOME/.ssh/id_ed25519_cryptotax"
if [[ ! -f "$key" ]]; then
  ssh-keygen -t ed25519 -N "" -f "$key" -C "hana-backup@hana-server"
fi
chmod 600 "$key" "$key.pub"
if [[ ! -f "$HOME/.ssh/config" ]] || ! grep -q '^Host macbook$' "$HOME/.ssh/config"; then
  umask 077
  cat >>~/.ssh/config <<EOF
Host macbook
  HostName 192.168.50.160
  User jxhui
  IdentityFile ~/.ssh/id_ed25519_cryptotax
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new

Host 192.168.50.160 jimmys-macbook-pro-16 jimmys-macbook-pro-16.taile9bee4.ts.net 100.113.170.47
  User jxhui
  IdentityFile ~/.ssh/id_ed25519_cryptotax
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
fi
REMOTE

PUB="$(ssh -o BatchMode=yes "$HOST" 'cat ~/.ssh/id_ed25519_cryptotax.pub')"
if [[ -z "$PUB" ]]; then
  echo "failed to read pubkey from hana" >&2
  exit 1
fi

mkdir -p "$(dirname "$AUTH_KEYS")" "$HOME/$MAC_DIR"
touch "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"

if grep -Fq "$PUB" "$AUTH_KEYS"; then
  echo "==> pubkey already in ${AUTH_KEYS}"
else
  echo "==> authorize hana backup key on this Mac"
  printf 'restrict %s\n' "$PUB" >>"$AUTH_KEYS"
fi

echo "==> test hana -> ${MAC_USER}@macbook (LAN alias)"
ssh -o BatchMode=yes "$HOST" \
  "ssh -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new macbook 'mkdir -p ~/${MAC_DIR} && echo lan-ssh-ok'"
echo "==> Tailscale fallback ${MAC_USER}@${MAC_TS} (optional)"
ssh -o BatchMode=yes "$HOST" \
  "ssh -o BatchMode=yes -o ConnectTimeout=5 -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519_cryptotax ${MAC_USER}@${MAC_TS} 'echo ts-ssh-ok'" \
  || echo "(Tailscale SSH skipped — LAN is enough)"

echo "==> install daily timer on hana"
# shellcheck disable=SC2087
ssh -o BatchMode=yes "$HOST" \
  env REMOTE_APP="$REMOTE_APP" \
  bash -s <<'REMOTE'
set -euo pipefail
APP="${HOME}/${REMOTE_APP}"
UNIT_DIR="${HOME}/.config/systemd/user"
mkdir -p "$UNIT_DIR" "${HOME}/risu-data" "${HOME}/risu-backups"
chmod +x "${APP}/scripts/hana-backup.sh" "${APP}/scripts/backup-sqlite.py"

cat >"${UNIT_DIR}/risu-backup.service" <<EOF
[Unit]
Description=risu sqlite snapshot + push to Mac
After=risu.service

[Service]
Type=oneshot
ExecStart=${APP}/scripts/hana-backup.sh
EOF

# 00:30 UTC so it does not collide with crypto-tax's midnight timer.
cat >"${UNIT_DIR}/risu-backup.timer" <<'EOF'
[Unit]
Description=Daily risu sqlite backup (no-op if unchanged)

[Timer]
OnCalendar=*-*-* 00:30:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now risu-backup.timer
systemctl --user start risu-backup.service
systemctl --user --no-pager --full status risu-backup.timer | head -15
echo
ls -la "${HOME}/risu-backups" 2>/dev/null || true
REMOTE

echo
echo "Timer is daily (~00:30 UTC). Unchanged DB = no new file. Mac asleep = retry next day."
echo "Live sqlite on hana: ~/risu-data/risu.db"
echo "Mac copies:          ~/${MAC_DIR}/"
echo "Hana spool:          ~/risu-backups/"
