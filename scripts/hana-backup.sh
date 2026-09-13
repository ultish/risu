#!/usr/bin/env bash
# On hana-server: snapshot sqlite (WAL-safe) and rsync unique copies to the Mac.
#
# Live DB on hana is ~/risu-data/risu.db (volume for the container). The Mac
# archive is ~/Documents/Finances/risu-backups. If the Mac is asleep, snapshots
# stay in ~/risu-backups and the next daily timer retries the push.
set -euo pipefail

DB="${RISU_DB:-${HOME}/risu-data/risu.db}"
DEST="${BACKUP_DIR:-${HOME}/risu-backups}"
MAC_TARGETS="${BACKUP_MAC_TARGETS:-jxhui@macbook jxhui@jimmys-macbook-pro-16}"
MAC_DIR="${BACKUP_MAC_DIR:-Documents/Finances/risu-backups}"
IDENTITY="${BACKUP_SSH_IDENTITY:-${HOME}/.ssh/id_ed25519_cryptotax}"
KEEP="${BACKUP_KEEP:-30}"
STATE="${DEST}/.last-pushed-hash"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST"

hash="$(
  python3 "${SCRIPT_DIR}/backup-sqlite.py" \
    --db "$DB" \
    --dest "$DEST" \
    --prefix risu \
    --keep "$KEEP"
)"

if [[ -z "$hash" ]]; then
  echo "no snapshot hash; nothing to push"
  exit 0
fi

if [[ -f "$STATE" ]] && [[ "$(cat "$STATE")" == "$hash" ]]; then
  echo "already pushed ${hash:0:12}; skip rsync"
  exit 0
fi

ssh_opts=(-o BatchMode=yes -o ConnectTimeout=10 -o IdentitiesOnly=yes)
if [[ -f "$IDENTITY" ]]; then
  ssh_opts+=(-i "$IDENTITY")
fi

pushed=0
for mac in $MAC_TARGETS; do
  echo "push ${hash:0:12} -> ${mac}:${MAC_DIR}/"
  if rsync -az -e "ssh ${ssh_opts[*]}" \
    --include='LATEST' \
    --include='latest.db' \
    --include='risu-*.db' \
    --exclude='*' \
    "${DEST}/" \
    "${mac}:${MAC_DIR}/"; then
    printf '%s\n' "$hash" >"$STATE"
    echo "pushed via ${mac}"
    pushed=1
    break
  fi
  echo "unreachable: ${mac}" >&2
done

if [[ "$pushed" -ne 1 ]]; then
  echo "Mac unreachable on LAN and Tailscale; snapshot kept at ${DEST} (will retry)" >&2
  exit 0
fi
