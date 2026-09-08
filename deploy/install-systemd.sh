#!/usr/bin/env bash
# Builds the frontend, then installs/updates the rcflower systemd units from
# this repo checkout and (re)starts them. Safe to re-run -- this IS the deploy
# step after `git pull`, or after editing a unit file in deploy/systemd/.
#
# Usage: ./deploy/install-systemd.sh [--no-build]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UNITS_DIR="$SCRIPT_DIR/systemd"
UNITS=(rcflower-backend.service rcflower-detect.service)
BUN="${BUN:-$HOME/.bun/bin/bun}"

if [[ "${1:-}" != "--no-build" ]]; then
  # The backend unit runs in prod mode and serves frontend/dist; there is no
  # Vite process on the Pi, so the static build has to happen here.
  echo "Building frontend -> frontend/dist"
  (cd "$REPO_ROOT/frontend" && npm ci --silent && "$BUN" run build)
  (cd "$REPO_ROOT/backend" && "$BUN" install --silent)
fi

for unit in "${UNITS[@]}"; do
  echo "Installing $unit -> /etc/systemd/system/$unit"
  sudo install -m 644 "$UNITS_DIR/$unit" "/etc/systemd/system/$unit"
done

sudo systemctl daemon-reload
sudo systemctl enable "${UNITS[@]}"
sudo systemctl restart "${UNITS[@]}"

echo
sudo systemctl --no-pager --lines=0 status "${UNITS[@]}"
