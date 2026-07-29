#!/bin/bash
# ---------------------------------------------------------------
#  StudioPilot Bridge launcher (macOS / Linux)
#  Double-click on macOS (or run: bash MacOS_Start.command).
#  It finds Python, makes sure `websockets` is installed and
#  starts the bridge.
# ---------------------------------------------------------------
cd "$(dirname "$0")" || exit 1
mkdir -p logs

echo "[StudioPilot] Starting bridge..."

# ---- find a Python interpreter ----------------------------------------
PY=""
for cand in python3 python python3.13 python3.12 python3.11 python3.10 python3.9; do
  if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; done
done
# also check the common Homebrew / Xcode CLT locations on macOS
if [ -z "$PY" ]; then
  for cand in /opt/homebrew/bin/python3 /usr/local/bin/python3 /usr/bin/python3; do
    if [ -x "$cand" ]; then PY="$cand"; break; fi
  done
fi

if [ -z "$PY" ]; then
  echo
  echo "[StudioPilot] ERROR: Python was not found."
  echo "Install Python 3.9+ from https://www.python.org/downloads/ then run this file again."
  echo
  read -r -p "Press Enter to close..."
  exit 1
fi

# ---- make sure the websockets package is available ---------------------
if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
  echo "[StudioPilot] Installing the 'websockets' package (first run only)..."
  "$PY" -m pip install --user websockets >>logs/start.log 2>&1 || \
    "$PY" -m pip install --user --break-system-packages websockets >>logs/start.log 2>&1
  if ! "$PY" -c "import websockets" >/dev/null 2>&1; then
    echo
    echo "[StudioPilot] ERROR: could not install 'websockets'."
    echo "Check your internet connection, or run:"
    echo "   $PY -m pip install --user websockets"
    echo "See logs/start.log for details."
    echo
    read -r -p "Press Enter to close..."
    exit 1
  fi
fi

# ---- free the ports from a previous bridge ------------------------------
if [ -f logs/bridge.pid ]; then
  OLD=$(cat logs/bridge.pid 2>/dev/null)
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    if ps -p "$OLD" -o command= 2>/dev/null | grep -q bridge.py; then
      echo "[StudioPilot] A previous bridge (pid $OLD) is still running - stopping it."
      kill "$OLD" 2>/dev/null
      sleep 1
    fi
  fi
fi

# ---- run ------------------------------------------------------------------
echo "[StudioPilot] Bridge starting - keep this window open."
echo "[StudioPilot] Log: $(pwd)/logs/bridge.log"
echo
"$PY" bridge.py
echo
echo "[StudioPilot] Bridge exited."
read -r -p "Press Enter to close..."
