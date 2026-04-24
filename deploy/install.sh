#!/usr/bin/env bash
# Install vite-dev-remote-supervisor as a systemd --user service.
# Idempotent: re-running upgrades the binary and restarts the service.
set -euo pipefail

INSTALL_DIR="${INSTALL_DIR:-$HOME/vite-dev-remote}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_NAME="vite-dev-remote-supervisor.service"
USER_UNIT_DIR="$HOME/.config/systemd/user"

echo "==> Installing supervisor into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
rsync -a --delete \
  --exclude='node_modules/.cache' \
  "$REPO_ROOT/supervisor/" "$INSTALL_DIR/"

echo "==> Building"
(
  cd "$INSTALL_DIR"
  npm install --omit=dev --prefer-offline
  npm install --include=dev --prefer-offline
  # pnpm for tracked repos: systemd user units often lack a global pnpm on PATH
  command -v corepack >/dev/null 2>&1 && corepack enable && corepack prepare pnpm@latest --activate || true
  npx tsc -p tsconfig.json
)

echo "==> Installing systemd unit"
mkdir -p "$USER_UNIT_DIR"
sed "s|/opt/vite-dev-remote|$INSTALL_DIR|g" \
  "$REPO_ROOT/deploy/$UNIT_NAME" > "$USER_UNIT_DIR/$UNIT_NAME"

echo "==> Enabling lingering so the user service runs without an active login"
loginctl enable-linger "$USER" || \
  echo "  (skipped — needs sudo; run: sudo loginctl enable-linger $USER)"

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

echo
echo "Status:"
systemctl --user status --no-pager "$UNIT_NAME" | head -15 || true

echo
echo "Logs:  journalctl --user -u $UNIT_NAME -f"
echo "Stop:  systemctl --user stop $UNIT_NAME"
echo "Edit:  systemctl --user edit $UNIT_NAME"
