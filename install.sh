#!/usr/bin/env bash
set -e

echo ""
echo "========================================================"
echo "  🚀 Synchronum v1.0.0: One-Click Environment Setup"
echo "========================================================"
echo ""

if ! command -v node &> /dev/null; then
  echo "❌ Node.js is not found in your system PATH!"
  echo "Please install Node.js (v20 or newer) from https://nodejs.org/"
  echo ""
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "📦 Installing Synchronum plugin into Antigravity 2.0..."
node --experimental-sqlite ./dist/cli.js setup

echo ""
echo "========================================================"
echo "  ✅ Installation complete!"
echo "  Restart Antigravity 2.0 or press Ctrl+R"
echo "  The Synchronum dashboard is available in the right pane."
echo "========================================================"
echo ""
