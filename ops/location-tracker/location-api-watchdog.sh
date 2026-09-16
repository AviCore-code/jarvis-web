#!/bin/bash
# location-api-watchdog.sh — keep Location API alive and verify its public route.
# The shared ngrok/proxy watchdogs own ports 4040/8000; this script owns :8787.
# Silent while healthy; stdout only on recovery/failure.
set -u

BASE=/opt/data/projects/location-tracker
LOCAL_HEALTH=http://127.0.0.1:8787/healthz
PUBLIC_HEALTH=https://itunes-unboxed-upstroke.ngrok-free.dev/location/healthz
EXPECTED_SERVICE="jarvis-location-api"

start_api() {
  setsid nohup bash "$BASE/run.sh" > "$BASE/server.log" 2>&1 < /dev/null &
  disown
}

health_check() {
  local url="$1"
  local body
  body="$(curl -fsS -m 4 "$url")" || return 1
  case "$body" in
    *"$EXPECTED_SERVICE"*) return 0 ;;
    *) return 1 ;;
  esac
}

public_check() {
  local url="$1"
  local body
  body="$(curl -fsS -m 12 -H 'ngrok-skip-browser-warning: 1' "$url")" || return 1
  case "$body" in
    *"$EXPECTED_SERVICE"*) return 0 ;;
    *) return 1 ;;
  esac
}

if ! health_check "$LOCAL_HEALTH"; then
  echo "location API down — restarting"
  for pid in $(pgrep -f '^python3 /opt/data/projects/location-tracker/server.py$' || true); do
    kill "$pid" 2>/dev/null || true
  done
  sleep 1
  start_api
  sleep 3
  health_check "$LOCAL_HEALTH" || {
    echo "location API restart FAILED"
    exit 1
  }
fi

if ! public_check "$PUBLIC_HEALTH"; then
  echo "location public route FAILED — check shared proxy/ngrok watchdogs"
  exit 1
fi

exit 0
