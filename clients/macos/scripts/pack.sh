#!/usr/bin/env bash
# Private build only. Never publish, launch, install, or select a public CLI.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

case "${1:-}" in
  --help|-h)
    echo "Usage: VELLUM_PRIVATE_CLI_ENTRY=/absolute/runtime/cli/src/index.ts bun run pack"
    echo "Builds into dist-private. Requires installed locked dependencies; never launches or publishes."
    exit 0 ;;
esac
[ "$#" -eq 0 ] || { echo "ERROR: pack takes no flags; launch/publication are disabled" >&2; exit 1; }
case "${VELLUM_PRIVATE_CLI_ENTRY:-}" in
  /*) [ -f "$VELLUM_PRIVATE_CLI_ENTRY" ] || { echo "ERROR: private CLI entry is missing" >&2; exit 1; } ;;
  *) echo "ERROR: VELLUM_PRIVATE_CLI_ENTRY must be an existing absolute CLI entry" >&2; exit 1 ;;
esac
export VELLUM_ENVIRONMENT="${VELLUM_ENVIRONMENT:-production}"
export ELECTRON_TARGET_ARCH="${ELECTRON_TARGET_ARCH:-arm64}"
case "$ELECTRON_TARGET_ARCH" in
  arm64) BUN_ARCH=aarch64 ;;
  x64) BUN_ARCH=x64 ;;
  *) echo "ERROR: architecture must be arm64 or x64" >&2; exit 1 ;;
esac
unset CSC_LINK CSC_KEY_PASSWORD CSC_NAME APPLE_SIGNING_IDENTITY VELLUM_MAC_PROVISIONING_PROFILE
export CSC_IDENTITY_AUTO_DISCOVERY=false VELLUM_HELPER_SIGN_IDENTITY=-
export VITE_PLATFORM_MODE=false SENTRY_UPLOAD_SOURCE_MAPS=false
cd "$APP_DIR"
bash scripts/fetch-bun.sh --arch "$BUN_ARCH"
bash scripts/generate-icon.sh
bash scripts/build-mac-helper.sh
bash scripts/build-notifier.sh
bun run build:web
bun run build
electron-builder --config electron-builder.config.cjs --dir --publish never
