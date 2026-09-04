#!/usr/bin/env bash
# Installs/updates the rcflower systemd units from this repo checkout and
# (re)starts them. Safe to re-run -- e.g. after `git pull`, or after editing
# a unit file in deploy/systemd/ -- to pick up changes.
#
# Usage: ./deploy/install-systemd.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNITS_DIR="$SCRIPT_DIR/systemd"
UNITS=(rcflower-backend.service rcflower-detect.service)

for unit in "${UNITS[@]}"; do
  echo "Installing $unit -> /etc/systemd/system/$unit"
  sudo install -m 644 "$UNITS_DIR/$unit" "/etc/systemd/system/$unit"
done

sudo systemctl daemon-reload
sudo systemctl enable "${UNITS[@]}"
sudo systemctl restart "${UNITS[@]}"

echo
sudo systemctl --no-pager --lines=0 status "${UNITS[@]}"
