#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "  Skill Panel - building macOS app / DMG..."
echo

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[ERROR] macOS packages must be built on a Mac."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found."
  exit 1
fi

if ! command -v rustc >/dev/null 2>&1; then
  echo "[ERROR] Rust not found. Install: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

if ! xcode-select -p >/dev/null 2>&1; then
  echo "[ERROR] Xcode Command Line Tools missing. Run: xcode-select --install"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "Installing npm dependencies..."
  npm install
fi

npm run build:mac

echo
echo "  Done. Outputs:"
echo "  src-tauri/target/release/bundle/dmg/"
echo "  src-tauri/target/release/bundle/macos/"
ls -1 src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null || true
ls -1 src-tauri/target/release/bundle/macos/*.app 2>/dev/null || true
echo
echo "  Open the .dmg and drag Skill Panel to Applications."
echo
