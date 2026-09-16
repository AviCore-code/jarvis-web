#!/bin/bash
# location-tracker-run.sh — start the location-tracker service with proper env
set -e

APP_DIR="/opt/data/projects/location-tracker"
TOKEN_FILE="${APP_DIR}/.api-token.txt"
PORT="${LOCATION_TRACKER_PORT:-8787}"

if [ ! -s "$TOKEN_FILE" ]; then
  echo "missing $TOKEN_FILE" >&2
  exit 1
fi

export LOCATION_API_TOKEN_PATH="$TOKEN_FILE"
export PORT

exec python3 "${APP_DIR}/server.py"
