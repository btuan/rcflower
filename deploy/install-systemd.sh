#!/usr/bin/env bash
# Builds the frontend, then installs/updates the rcflower systemd units from
# this repo checkout and (re)starts them. Safe to re-run -- this IS the deploy
# step after `git pull`, or after editing a unit file in deploy/systemd/.
#
# Usage: ./deploy/install-systemd.sh [--no-build]
# Env overrides: BUN, UV (paths to the executables).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
UNITS_DIR="$SCRIPT_DIR/systemd"
UNITS=(rcflower-backend.service rcflower-detect.service)
BUN="${BUN:-$HOME/.bun/bin/bun}"
UV="${UV:-$HOME/.local/bin/uv}"
SERVICE_USER="$(id -un)"

if [[ "$SERVICE_USER" == "root" ]]; then
  echo "Run this as the (non-root) user that should own the services; it uses sudo itself." >&2
  exit 1
fi

# Fail up front, listing everything that's missing, rather than crashing
# halfway through the deploy. bun is always needed (the backend unit runs it);
# npm only for the frontend build.
missing=()
[[ -x "$BUN" ]] || missing+=("bun (not executable at $BUN; set BUN=/path/to/bun)")
[[ -x "$UV" ]] || missing+=("uv (not executable at $UV; set UV=/path/to/uv)")
if [[ "${1:-}" != "--no-build" ]]; then
  command -v npm >/dev/null || missing+=("npm (not on PATH)")
fi
if (( ${#missing[@]} )); then
  echo "Missing prerequisites:" >&2
  printf '  - %s\n' "${missing[@]}" >&2
  exit 1
fi

if [[ "${1:-}" != "--no-build" ]]; then
  # The backend unit runs in prod mode and serves frontend/dist; there is no
  # Vite process on the device, so the static build has to happen here.
  #
  # `npm ci` wipes node_modules and reinstalls everything (several minutes on
  # the Uno Q), so skip it when package-lock.json is unchanged since the last
  # successful install. The hash is stored inside node_modules, so deleting
  # node_modules forces a reinstall.
  FRONTEND_DIR="$REPO_ROOT/frontend"
  LOCK_STAMP="$FRONTEND_DIR/node_modules/.package-lock.sha256"
  lock_hash="$(sha256sum "$FRONTEND_DIR/package-lock.json" | cut -d' ' -f1)"
  if [[ -f "$LOCK_STAMP" && "$(cat "$LOCK_STAMP")" == "$lock_hash" ]]; then
    echo "Frontend dependencies up to date (package-lock.json unchanged); skipping npm ci"
  else
    echo "Installing frontend dependencies (npm ci; can take several minutes on slow devices)..."
    (cd "$FRONTEND_DIR" && npm ci --no-audit --no-fund)
    echo "$lock_hash" > "$LOCK_STAMP"
  fi
  echo "Building frontend -> frontend/dist"
  (cd "$FRONTEND_DIR" && "$BUN" run build)
  (cd "$REPO_ROOT/backend" && "$BUN" install --silent)
fi

echo "Syncing Python runtime dependencies via uv (no dev group: torch etc.)"
(cd "$REPO_ROOT/python" && "$UV" sync --locked --no-dev)

# Units are templates (deploy/systemd/*.service.in): fill in the user, repo
# location and tool dirs for whichever machine this is, so nothing is
# hardcoded to a particular account.
RENDERED_DIR="$(mktemp -d)"
trap 'rm -rf "$RENDERED_DIR"' EXIT
for unit in "${UNITS[@]}"; do
  sed -e "s|@USER@|$SERVICE_USER|g" \
      -e "s|@REPO_ROOT@|$REPO_ROOT|g" \
      -e "s|@BUN_DIR@|$(dirname "$BUN")|g" \
      -e "s|@UV_DIR@|$(dirname "$UV")|g" \
      "$UNITS_DIR/$unit.in" > "$RENDERED_DIR/$unit"
  echo "Installing $unit (User=$SERVICE_USER) -> /etc/systemd/system/$unit"
  sudo install -m 644 "$RENDERED_DIR/$unit" "/etc/systemd/system/$unit"
done

sudo systemctl daemon-reload
sudo systemctl enable "${UNITS[@]}"
sudo systemctl restart "${UNITS[@]}"

echo
sudo systemctl --no-pager --lines=0 status "${UNITS[@]}"
