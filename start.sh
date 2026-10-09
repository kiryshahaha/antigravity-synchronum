#!/usr/bin/env bash
set -e

echo "======================================================="
echo "       Synchronum: Google Antigravity 2.0 Sync         "
echo "======================================================="
echo ""

if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js is not installed!"
    echo "Please install Node.js: https://nodejs.org"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "[*] Installing dependencies..."
    npm install
fi

if [ ! -f "dist/sidecar-server.js" ]; then
    echo "[*] Building project..."
    npm run build
fi

echo "[*] Registering Sidecar in Antigravity..."
SIDECAR_TARGET="$HOME/.gemini/antigravity/sidecars/synchronum"
mkdir -p "$SIDECAR_TARGET"
cp -r sidecar/* "$SIDECAR_TARGET/" 2>/dev/null || true
echo "[✓] Sidecar successfully registered in Antigravity!"

echo ""
echo "[*] Opening Synchronum Dashboard..."
if [[ "$OSTYPE" == "darwin"* ]]; then
    open "http://localhost:42125" || true
else
    xdg-open "http://localhost:42125" 2>/dev/null || true
fi

echo ""
echo "[✓] Synchronum is running at http://localhost:42125"
echo "Press Ctrl+C to stop the server."
echo ""
node --experimental-sqlite ./dist/sidecar-server.js
