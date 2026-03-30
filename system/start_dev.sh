#!/usr/bin/env bash

# Exit on error
set -e

# Resolve to the system/ directory regardless of where this script is invoked
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR"

echo "=== CSA.IBKR System Launch ==="
echo "Working directory: $SCRIPT_DIR"
echo ""

# --- Phase 1: TeaVM Build (optional, expected to partially fail) ---
echo "[1/3] Running TeaVM Pipeline (Java -> JS)..."
if command -v gradle &> /dev/null; then
    (cd "$SCRIPT_DIR" && gradle build) || echo "⚠  Gradle build encountered errors (expected for Vert.x translation) — Continuing..."
else
    echo "⚠  Gradle not found — skipping build step."
fi

# --- Phase 2: Static CDN Server ---
# Serve from the repo root (parent of system/) so index.html is accessible
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "[2/3] Starting SFTi Static CDN Server on port 8080 (0.0.0.0)..."
python3 -m http.server 8080 --bind 0.0.0.0 --directory "$REPO_ROOT" > "$LOG_DIR/cdn.log" 2>&1 &
STATIC_PID=$!

# --- Phase 3: DevBridge Telemetry Server ---
echo "[3/3] Starting SFTi DevBridge on port 8765 (0.0.0.0)..."

# Activate venv if it exists
VENV_PATH="$SCRIPT_DIR/DevBridge/.venv/bin/activate"
if [ -f "$VENV_PATH" ]; then
    source "$VENV_PATH"
fi

python3 "$SCRIPT_DIR/DevBridge/ai.server/server.py" > "$LOG_DIR/devbridge.log" 2>&1 &
DEVBRIDGE_PID=$!

# --- Cleanup trap ---
function cleanup {
    echo ""
    echo "Shutting down servers..."
    kill $STATIC_PID 2>/dev/null
    kill $DEVBRIDGE_PID 2>/dev/null
    echo "Done."
    exit
}

trap cleanup EXIT INT TERM

sleep 2

# --- Summary ---
LAN_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "==========================================="
echo "🟢 Servers are running."
echo "🔗 PWA Base URL:   http://$LAN_IP:8080"
echo "🛠  DevBridge:      http://$LAN_IP:8765"
echo ""
echo "📱 iPhone URL:"
echo "   http://$LAN_IP:8080/index.html?devbridge=http://$LAN_IP:8765"
echo "==========================================="
echo ""
echo "📂 Logs:"
echo "   CDN:       $LOG_DIR/cdn.log"
echo "   DevBridge: $LOG_DIR/devbridge.log"
echo ""
echo "Press Ctrl+C to stop."
wait
