#!/usr/bin/env bash
# Remove the supervisor service and (optionally) its installation directory.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/vite-dev-remote}"
UNIT_NAME="vite-dev-remote-supervisor.service"
USER_UNIT_DIR="$HOME/.config/systemd/user"

systemctl --user stop "$UNIT_NAME" || true
systemctl --user disable "$UNIT_NAME" || true
rm -f "$USER_UNIT_DIR/$UNIT_NAME"
systemctl --user daemon-reload

if [[ "${PURGE:-0}" == "1" ]]; then
  echo "PURGE=1 — removing $INSTALL_DIR"
  rm -rf "$INSTALL_DIR"
fi

echo "uninstalled. checked-out repo (if any) at REPO_DIR was NOT removed — delete manually if desired."
