#!/usr/bin/env bash
# tailscale-watchdog.sh — keep tailscaled alive in userspace mode, rootless.
# No sudo. No /dev/net/tun. State dir defaults to /home/hermes/.tailscale
# (falls back to /opt/data/.tailscale if /home/hermes does not exist).
set -euo pipefail

STATE_DIR="${TAILSCALE_STATE_DIR:-/home/hermes/.tailscale}"
if [[ ! -d /home/hermes ]]; then
  STATE_DIR="/opt/data/.tailscale"
fi
mkdir -p "${STATE_DIR}"

LOG="${STATE_DIR}/tailscaled.log"
SOCK="${STATE_DIR}/tailscaled.sock"
BIN="/opt/data/bin/tailscaled"
CLI="/opt/data/bin/tailscale"

# Already up?
if pgrep -x tailscaled >/dev/null 2>&1; then
  exit 0
fi

# Launch in userspace mode (no kernel TUN required).
nohup "${BIN}" \
  --state="${STATE_DIR}/tailscaled.state" \
  --statedir="${STATE_DIR}" \
  --tun=userspace-networking \
  --socket="${SOCK}" \
  --verbose=0 \
  >>"${LOG}" 2>&1 &

# Give the daemon a beat to bind the UNIX socket / port.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ -S "${SOCK}" ]; then break; fi
  sleep 1
done

# Sanity check: binary exists and is executable.
test -x "${BIN}" || { echo "tailscaled missing at ${BIN}" >&2; exit 1; }
test -x "${CLI}" || { echo "tailscale cli missing at ${CLI}" >&2; exit 1; }

if [ -S "${SOCK}" ] && pgrep -x tailscaled >/dev/null 2>&1; then
  echo "tailscaled launched (userspace); state=${STATE_DIR}; sock=${SOCK}; pid=$(pgrep -x tailscaled | head -1)"
  exit 0
else
  echo "tailscaled failed to start; tail of log:" >&2
  tail -10 "${LOG}" >&2 || true
  exit 1
fi
