#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "  Skill Panel - starting..."
echo "  Press Ctrl+C to stop."
echo

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Please install Node.js first."
  exit 1
fi

if ! command -v rustc >/dev/null 2>&1; then
  echo "[ERROR] Rust not found. Install via: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
  exit 1
fi

if [[ "$(uname -s)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
  echo "[ERROR] Xcode Command Line Tools missing. Run: xcode-select --install"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "First run: installing dependencies..."
  npm install
fi

npm run tauri dev
