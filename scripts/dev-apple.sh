#!/usr/bin/env bash
set -euo pipefail

# Determine repo root regardless of current dir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Defaults
: "${TABLEAU_PORT:=5859}"
NO_TESTS=0
E2E=0

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-tests) NO_TESTS=1; shift;;
    --e2e) E2E=1; shift;;
    -p|--port) TABLEAU_PORT="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 2;;
  esac
done

echo "[tableau] Repo: $REPO_ROOT"
echo "[tableau] Port : $TABLEAU_PORT"

# Check required tools
command -v npm >/dev/null || { echo "npm not found"; exit 1; }
command -v swift >/dev/null || { echo "swift not found"; exit 1; }
command -v node >/dev/null || { echo "node not found"; exit 1; }

# Check port
existing_pid=""
if command -v lsof >/dev/null; then
  existing_pid=$(lsof -nP -iTCP:"$TABLEAU_PORT" -sTCP:LISTEN -t || true)
else
  # macOS provides lsof usually; fallback to netstat
  existing_pid=$(netstat -vanp tcp | awk '/\.'"$TABLEAU_PORT"'/ {print $9}' | sed 's/,.*//' | tr -d '\n' || true)
fi

if [[ -n "$existing_pid" ]]; then
  # Check if the process is our node or swift (heuristic)
  cmd=$(ps -p "$existing_pid" -o args= || true)
  if echo "$cmd" | grep -q "npm start\|TableauElectricite\|swift run"; then
    echo "[tableau] Found existing project process on port $TABLEAU_PORT (pid $existing_pid). Stopping it..."
    kill "$existing_pid" || true
    # Wait up to 8s
    for i in {1..8}; do
      if ! (lsof -nP -iTCP:"$TABLEAU_PORT" -sTCP:LISTEN -t >/dev/null 2>&1); then
        break
      fi
      sleep 1
    done
    if lsof -nP -iTCP:"$TABLEAU_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "[tableau] Failed to free port $TABLEAU_PORT"; exit 1
    fi
  else
    echo "[tableau] Port $TABLEAU_PORT is in use by another program: $cmd"
    echo "Please choose another port or stop that program."
    exit 1
  fi
fi

# Tests and builds
if [[ "$NO_TESTS" -eq 0 ]]; then
  echo "[tableau] Running npm test"
  npm test || { echo "[tableau] npm test failed"; exit 1; }
  echo "[tableau] npm test OK"

  echo "[tableau] Swift build"
  (cd swift-app && swift build) || { echo "[tableau] swift build failed"; exit 1; }
  echo "[tableau] Swift build OK"
else
  echo "[tableau] Skipping tests/build as requested (--no-tests)"
fi

if [[ "$E2E" -eq 1 ]]; then
  echo "[tableau] Running E2E tests: node test/apple-speech-e2e.js"
  node test/apple-speech-e2e.js || { echo "[tableau] E2E test failed"; exit 1; }
  echo "[tableau] E2E OK"
fi

# Start node server
TABLEAU_PORT="$TABLEAU_PORT" npm start &
NODE_PID=$!
SWIFT_PID=

cleanup() {
  echo "[tableau] Cleaning up..."
  # Kill any process from this repo listening on the port (safe)
  if command -v lsof >/dev/null; then
    for pid in $(lsof -nP -iTCP:"$TABLEAU_PORT" -sTCP:LISTEN -t 2>/dev/null || true); do
      # Verify process belongs to this repo by checking cwd or args
      cmd=$(ps -p "$pid" -o args= 2>/dev/null || true)
      cwd=$(lsof -p "$pid" 2>/dev/null | awk '$4=="cwd" {print $9; exit}') || true
      if echo "$cmd $cwd" | grep -q "$REPO_ROOT"; then
        echo "[tableau] Stopping process $pid on port $TABLEAU_PORT"
        kill "$pid" || true
        wait "$pid" 2>/dev/null || true
      else
        echo "[tableau] Not stopping external process $pid ($cmd)"
      fi
    done
  else
    if [[ -n "$NODE_PID" ]] && kill -0 "$NODE_PID" >/dev/null 2>&1; then
      kill "$NODE_PID" || true
      wait "$NODE_PID" 2>/dev/null || true
    fi
  fi

  if [[ -n "$SWIFT_PID" ]] && kill -0 "$SWIFT_PID" >/dev/null 2>&1; then
    kill "$SWIFT_PID" || true
    wait "$SWIFT_PID" 2>/dev/null || true
  fi
}

# Install trap after cleanup function and var initialization
trap 'cleanup; exit' INT TERM EXIT

# Wait for health
echo "[tableau] Waiting for health check at http://127.0.0.1:$TABLEAU_PORT/api/health"
for i in {1..30}; do
  if command -v curl >/dev/null; then
    if curl -s -f "http://127.0.0.1:$TABLEAU_PORT/api/health" >/dev/null 2>&1; then
      echo "[tableau] Health check OK"
      break
    fi
  else
    # fallback: try nc
    if command -v nc >/dev/null; then
      if nc -z 127.0.0.1 "$TABLEAU_PORT"; then
        echo "[tableau] Port open (nc)"
        break
      fi
    fi
  fi
  sleep 1
done

# If health check never succeeded
if ! (curl -s -f "http://127.0.0.1:$TABLEAU_PORT/api/health" >/dev/null 2>&1); then
  echo "[tableau] Health check failed after waiting"; cleanup; exit 1
fi

# Start Swift app in foreground
echo "[tableau] Lancement TableauElectricite…"
cd swift-app

# Build already performed above; create minimal .app bundle so macOS can honor Info.plist
BUILD_DIR=".build/debug"
if [[ -d ".build/release" ]]; then BUILD_DIR=".build/release"; fi
BIN_PATH="$BUILD_DIR/TableauElectricite"
if [[ ! -f "$BIN_PATH" ]]; then
  echo "[tableau] Built executable not found at $BIN_PATH. Attempting swift build..."
  swift build || { echo "[tableau] swift build failed"; cleanup; exit 1; }
  BUILD_DIR=".build/debug"
  if [[ -d ".build/release" ]]; then BUILD_DIR=".build/release"; fi
  BIN_PATH="$BUILD_DIR/TableauElectricite"
fi

APP_BUNDLE="$PWD/.build/Run.app"
CONTENTS="$APP_BUNDLE/Contents"
mkdir -p "$CONTENTS/MacOS"

# Copy binary into app bundle
cp "$BIN_PATH" "$CONTENTS/MacOS/TableauElectricite"
chmod +x "$CONTENTS/MacOS/TableauElectricite"

# Use provided Info.plist if present, otherwise generate a minimal one with NSMicrophoneUsageDescription
if [[ -f "Resources/Info.plist" ]]; then
  cp "Resources/Info.plist" "$CONTENTS/Info.plist"
else
  cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>TableauElectricite</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>Le Tableau utilise le microphone pour transcrire localement vos dictées scientifiques.</string>
</dict>
</plist>
PLIST
fi

# Run the binary inside the bundle (macOS treats it as an app and will read Info.plist)
TABLEAU_PORT="$TABLEAU_PORT" "$CONTENTS/MacOS/TableauElectricite" &
SWIFT_PID=$!

# Wait for Swift process exit; trap will clean up Node and Swift
wait "$SWIFT_PID"
EXIT_CODE=$?
cleanup
exit "$EXIT_CODE"
