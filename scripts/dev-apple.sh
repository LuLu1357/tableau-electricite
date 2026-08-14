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
CLEANUP_RUNNING=0
CLEANUP_DONE=0
NODE_PID=""
SWIFT_PID=""

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-tests) NO_TESTS=1; shift ;;
    --e2e) E2E=1; shift ;;
    -p|--port) TABLEAU_PORT="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

terminate_pid() {
  local name="$1"
  local pid="$2"

  if [[ -z "$pid" ]]; then
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  echo "[tableau] Stopping ${name} PID $pid"
  kill -TERM "$pid" 2>/dev/null || true

  for _ in {1..10}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.2
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi

  wait "$pid" 2>/dev/null || true
  return 0
}

cleanup() {
  local rc="${1:-0}"

  if [[ "${CLEANUP_DONE:-0}" == "1" ]]; then
    return 0
  fi

  CLEANUP_DONE=1
  CLEANUP_RUNNING=1
  trap - EXIT INT TERM

  echo "[tableau] Cleaning up..."

  terminate_pid "Node" "$NODE_PID" || true
  terminate_pid "Swift" "$SWIFT_PID" || true

  if command -v lsof >/dev/null; then
    if lsof -nP -iTCP:"$TABLEAU_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "[tableau] Port $TABLEAU_PORT still open after cleanup"
    fi
  fi

  return "$rc"
}

trap 'exit 130' INT
trap 'exit 143' TERM
trap 'rc=$?; trap - EXIT INT TERM; cleanup "$rc"; exit "$rc"' EXIT

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
  existing_pid=$(netstat -vanp tcp | awk '/\.'"$TABLEAU_PORT"'/ {print $9}' | sed 's/,.*//' | tr -d '\n' || true)
fi

if [[ -n "$existing_pid" ]]; then
  cmd=$(ps -p "$existing_pid" -o args= || true)
  cwd=$(lsof -p "$existing_pid" 2>/dev/null | awk '$4=="cwd" {print $9; exit}' || true)
  if [[ -n "$cwd" ]] && { [[ "$cwd" == "$REPO_ROOT" ]] || [[ "$cwd" == "$REPO_ROOT"/* ]]; }; then
    echo "[tableau] Found existing project process on port $TABLEAU_PORT (pid $existing_pid). Stopping it..."
    kill -TERM "$existing_pid" 2>/dev/null || true
    for _ in {1..10}; do
      if ! lsof -nP -iTCP:"$TABLEAU_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
        break
      fi
      sleep 0.2
    done
    if lsof -nP -iTCP:"$TABLEAU_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      kill -KILL "$existing_pid" 2>/dev/null || true
    fi
    if lsof -nP -iTCP:"$TABLEAU_PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
      echo "[tableau] Port still in use after forced termination"; exit 1
    fi
  else
    echo "[tableau] Port $TABLEAU_PORT used by another process."
    echo "[tableau] Use TABLEAU_PORT=YYYY."
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

# Start node server directly, without npm wrapper.
TABLEAU_PORT="$TABLEAU_PORT" node server/mcp-server.js &
NODE_PID=$!
echo "[tableau] Node PID: $NODE_PID"
NODE_CMD=$(ps -p "$NODE_PID" -o args= 2>/dev/null || true)
if [[ "$NODE_CMD" != "node server/mcp-server.js" ]]; then
  echo "[tableau] Unexpected Node process for PID $NODE_PID: $NODE_CMD"
  cleanup 1
  exit 1
fi

echo "[tableau] Waiting for health check at http://127.0.0.1:$TABLEAU_PORT/api/health"
for i in {1..30}; do
  if command -v curl >/dev/null; then
    if curl -s -f "http://127.0.0.1:$TABLEAU_PORT/api/health" >/dev/null 2>&1; then
      echo "[tableau] Health check OK"
      break
    fi
  else
    if command -v nc >/dev/null; then
      if nc -z 127.0.0.1 "$TABLEAU_PORT"; then
        echo "[tableau] Port open (nc)"
        break
      fi
    fi
  fi
  sleep 1
done

if ! (curl -s -f "http://127.0.0.1:$TABLEAU_PORT/api/health" >/dev/null 2>&1); then
  echo "[tableau] Health check failed after waiting"
  cleanup 1
  exit 1
fi

echo "[tableau] Manual TCC reset if the mic prompt is missing: tccutil reset Microphone com.tableauelectricite.dev"

echo "[tableau] Lancement TableauElectricite…"
cd swift-app

BUILD_DIR=".build/debug"
if [[ -d ".build/release" ]]; then BUILD_DIR=".build/release"; fi
BIN_PATH="$BUILD_DIR/TableauElectricite"
if [[ ! -f "$BIN_PATH" ]]; then
  echo "[tableau] Built executable not found at $BIN_PATH. Attempting swift build..."
  swift build || { echo "[tableau] swift build failed"; cleanup 1; exit 1; }
  BUILD_DIR=".build/debug"
  if [[ -d ".build/release" ]]; then BUILD_DIR=".build/release"; fi
  BIN_PATH="$BUILD_DIR/TableauElectricite"
fi

APP_BUNDLE="$PWD/.build/TableauElectriciteDev.app"
CONTENTS="$APP_BUNDLE/Contents"
rm -rf "$APP_BUNDLE"
mkdir -p "$CONTENTS/MacOS"

if [[ ! -f "Resources/Info.plist" ]]; then
  echo "[tableau] Missing Resources/Info.plist"
  cleanup 1
  exit 1
fi
cp "Resources/Info.plist" "$CONTENTS/Info.plist"

cp "$BIN_PATH" "$CONTENTS/MacOS/TableauElectricite"
chmod +x "$CONTENTS/MacOS/TableauElectricite"

plutil -lint "$CONTENTS/Info.plist" || { echo "[tableau] Invalid Info.plist in bundle"; cleanup 1; exit 1; }

for key in \
  "CFBundleIdentifier" \
  "CFBundleExecutable" \
  "CFBundlePackageType" \
  "NSMicrophoneUsageDescription"; do
  value=$( /usr/libexec/PlistBuddy -c "Print :$key" "$CONTENTS/Info.plist" 2>/dev/null || true )
  echo "[tableau] $key = ${value:-<missing>}"
  if [[ -z "$value" ]]; then
    echo "[tableau] Missing required plist key: $key"
    cleanup 1
    exit 1
  fi
done

if [[ ! -x "$CONTENTS/MacOS/TableauElectricite" ]]; then
  echo "[tableau] Built binary is not executable inside bundle"
  cleanup 1
  exit 1
fi

TABLEAU_PORT="$TABLEAU_PORT" "$CONTENTS/MacOS/TableauElectricite" &
SWIFT_PID=$!
echo "[tableau] Swift PID: $SWIFT_PID"

if wait "$SWIFT_PID"; then
  EXIT_CODE=0
else
  EXIT_CODE=$?
fi

exit "$EXIT_CODE"
