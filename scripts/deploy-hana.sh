#!/usr/bin/env bash
# Deploy Risu to a Podman host (default: jimmy@hana-server).
#
# Builds the image on the server (hana is amd64; a Mac is not) and runs it
# as a user Quadlet so it comes back after reboot.
#
# crypto-tax already owns :8787 on hana, so this defaults to :8788.
#
#   ./scripts/deploy-hana.sh
#   ./scripts/deploy-hana.sh --dry-run
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${DEPLOY_HOST:-jimmy@hana-server}"
REMOTE_APP="${DEPLOY_REMOTE_APP:-risu}"
REMOTE_DATA="${DEPLOY_REMOTE_DATA:-risu-data}"
PORT="${DEPLOY_PORT:-8788}"
IMAGE="${DEPLOY_IMAGE:-localhost/risu:latest}"
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--dry-run]

rsync this repo to ${HOST}:~/${REMOTE_APP}, podman build, install a Quadlet
unit, start it on :${PORT}. SQLite lives in ~/${REMOTE_DATA}/risu.db.

Env:
  DEPLOY_HOST          SSH target          (default: jimmy@hana-server)
  DEPLOY_PORT          host port           (default: 8788)
  DEPLOY_REMOTE_APP    remote source dir   (default: risu)
  DEPLOY_REMOTE_DATA   remote sqlite dir   (default: risu-data)
  DEPLOY_IMAGE         image tag           (default: localhost/risu:latest)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

RSYNC_EXCLUDES=(
  --exclude .git
  --exclude .idea
  --exclude .claude
  --exclude .cursor
  --exclude .grok
  --exclude node_modules
  --exclude apps/*/node_modules
  --exclude packages/*/node_modules
  --exclude apps/web/dist
  --exclude apps/api/dist
  --exclude packages/core/dist
  --exclude data
  --exclude tmp
  --exclude coverage
  --exclude .env
  --exclude .env.local
  --exclude '*.db'
  --exclude '*.db-journal'
  --exclude '*.db-wal'
  --exclude '*.db-shm'
  --exclude .DS_Store
)

echo "==> rsync ${ROOT}/ -> ${HOST}:${REMOTE_APP}/"
rsync -az --delete --stats \
  "${RSYNC_EXCLUDES[@]}" \
  "${ROOT}/" \
  "${HOST}:${REMOTE_APP}/"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "==> dry-run: skip build and start"
  ssh -o BatchMode=yes "$HOST" "ls -la ${REMOTE_APP} | head; echo '--- Dockerfile ---'; test -f ${REMOTE_APP}/Dockerfile && echo ok"
  exit 0
fi

echo "==> build + start on ${HOST}"
# shellcheck disable=SC2087
ssh -o BatchMode=yes "$HOST" \
  env PORT="$PORT" IMAGE="$IMAGE" REMOTE_APP="$REMOTE_APP" REMOTE_DATA="$REMOTE_DATA" \
  bash -s <<'REMOTE'
set -euo pipefail

APP="${HOME}/${REMOTE_APP}"
DATA="${HOME}/${REMOTE_DATA}"
QUADLET_DIR="${HOME}/.config/containers/systemd"
UNIT_NAME="risu"

cd "$APP"
mkdir -p "$DATA" "$QUADLET_DIR"

echo "==> podman build ${IMAGE}"
podman build -t "$IMAGE" .

cat >"${QUADLET_DIR}/${UNIT_NAME}.container" <<EOF
[Unit]
Description=risu API + web UI

[Container]
Image=${IMAGE}
ContainerName=risu
Network=host
Volume=${DATA}:/data:Z
Environment=YIELDS_DB_PATH=/data/risu.db
Environment=PORT=${PORT}
Environment=HOST=0.0.0.0
Environment=SERVE_WEB=1
Environment=NODE_ENV=production
Environment=WEB_DIST_PATH=/app/apps/web/dist

[Service]
Restart=always

[Install]
WantedBy=default.target
EOF

if podman container exists risu 2>/dev/null; then
  if ! systemctl --user is-active --quiet risu.service 2>/dev/null; then
    podman stop risu >/dev/null 2>&1 || true
    podman rm risu >/dev/null 2>&1 || true
  fi
fi

# Quadlet generates the unit; do not `enable` (fails: transient or generated).
systemctl --user daemon-reload
systemctl --user restart risu.service

echo "==> wait for /api/health"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

echo
systemctl --user --no-pager --full status risu.service | head -20
echo
podman ps --filter name=risu
echo
if [[ "$ok" -eq 1 ]]; then
  curl -fsS "http://127.0.0.1:${PORT}/api/health"
  echo
else
  echo "health check did not pass; last logs:" >&2
  journalctl --user -u risu.service -n 80 --no-pager >&2 || true
  podman logs risu 2>&1 | tail -80 >&2 || true
  exit 1
fi

linger="$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null || true)"
if [[ "$linger" != "yes" ]]; then
  echo
  echo "Linger is off — the container dies when you log out."
  echo "  sudo loginctl enable-linger $(id -un)"
fi

echo
echo "LAN:       http://risu.hana-server/   (Caddy :80)"
echo "Tailscale: http://hana-server.taile9bee4.ts.net:${PORT}/"
echo "SQLite: ${DATA}/risu.db"
echo
echo "UFW Tailscale only (not LAN, not Anywhere):"
echo "  sudo ufw allow from 100.64.0.0/10 to any port ${PORT} proto tcp comment 'risu tailscale'"
echo "Caddy: http://risu.hana-server { reverse_proxy 127.0.0.1:${PORT} }"
echo "Index: /var/www/hana/index.html"
echo "Mac /etc/hosts: 192.168.50.92 … risu.hana-server"
REMOTE

echo "==> backup timer (hana -> this Mac)"
"${ROOT}/scripts/install-hana-backup.sh"
