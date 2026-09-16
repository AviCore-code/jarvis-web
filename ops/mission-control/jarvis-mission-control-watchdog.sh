#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/data/projects/jarvis-mission-control}"
LOG="${MISSION_LOG:-/opt/data/logs/jarvis-mission-control.log}"
PORT="${MISSION_PORT:-3010}"
PROC_ROOT="${PROC_ROOT:-/proc}"
HEALTH_URL="http://127.0.0.1:${PORT}/mission/api/health"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROC_HELPERS="${PROC_HELPERS:-${SCRIPT_DIR}/proc_helpers.py}"

signal_pid() {
  local pid="$1"
  if [ -n "${KILL_CMD:-}" ]; then
    # shellcheck disable=SC2086 -- KILL_CMD is a single binary path.
    "${KILL_CMD}" -- "${pid}"
  else
    kill -- "${pid}"
  fi
}

sleep_one() {
  if [ -n "${SLEEP_CMD:-}" ]; then
    # shellcheck disable=SC2086 -- SLEEP_CMD is a single binary path.
    "${SLEEP_CMD}" 1
  else
    sleep 1
  fi
}

monotonic_seconds() {
  local uptime
  if [ -n "${NOW_CMD:-}" ]; then
    # shellcheck disable=SC2086 -- NOW_CMD is a single binary path.
    "${NOW_CMD}"
  else
    read -r uptime _ < /proc/uptime
    printf '%s\n' "${uptime%%.*}"
  fi
}

pid_alive() {
  kill -0 -- "$1" 2>/dev/null
}

launched_start_time() {
  # Read /proc/<launched_pid>/stat field 22 (the kernel start_time in
  # clock ticks).  Returns the integer on stdout, or empty + non-zero
  # if the PID is no longer present or stat is malformed.
  local pid="$1"
  local stat_text
  stat_text="$(cat "${PROC_ROOT}/${pid}/stat" 2>/dev/null || true)"
  if [ -z "${stat_text}" ]; then
    return 1
  fi
  local tail="${stat_text##*) }"
  # After the trailing ')', the 20th whitespace-separated token is
  # the start_time field.
  # shellcheck disable=SC2086 -- intentional word-split on ${tail}.
  set -- ${tail}
  if [ "$#" -lt 20 ]; then
    return 1
  fi
  printf '%s\n' "$20"
}

process_matches() {
  local pid="$1" exe cwd
  [[ "${pid}" =~ ^[0-9]+$ ]] || return 1
  [ -d "${PROC_ROOT}/${pid}" ] || return 1
  exe="$(readlink "${PROC_ROOT}/${pid}/exe" 2>/dev/null || true)"
  cwd="$(readlink "${PROC_ROOT}/${pid}/cwd" 2>/dev/null || true)"
  [ "${exe##*/}" = "node" ] && [ "${cwd}" = "${APP_DIR}" ]
}

process_identity_matches() {
  # Identity is exe+cwd AND, if a snapshot start_time was supplied,
  # the current /proc/<pid>/stat still reports the same value.  This
  # is what protects against a PID-reuse race where a *different*
  # kernel task inherits a freed PID with the same exe/cwd.
  local pid="$1" captured_start="$2"
  process_matches "${pid}" || return 1
  if [ -n "${captured_start}" ]; then
    local now_start
    now_start="$(launched_start_time "${pid}" 2>/dev/null || true)"
    if [ -z "${now_start}" ]; then
      return 1
    fi
    [ "${now_start}" = "${captured_start}" ] || return 1
  fi
  return 0
}

mission_pids() {
  local proc pid
  for proc in "${PROC_ROOT}"/[0-9]*; do
    [ -d "${proc}" ] || continue
    pid="${proc##*/}"
    if process_matches "${pid}"; then
      printf '%s\n' "${pid}"
    fi
  done
}

# Confirm whether the launched PID is the *actual* owner of the
# listening TCP socket on ${PORT}.  This is the round-2 hardening:
# merely reaching the health URL is not enough; an impostor process
# could have bound the port before us.  Source PROC_HELPERS only when
# we actually need it so a missing helper is a loud failure, not a
# silent skip.
launched_pid_owns_port() {
  local pid="$1"
  PROC_HELPERS_PROC_ROOT="${PROC_HELPERS_PROC_ROOT:-${PROC_ROOT}}" \
    python3 "${PROC_HELPERS}" pid-owns-port "${pid}" "${PORT}"
}

if [ "${1:-}" = "--list-pids" ]; then
  mission_pids
  exit 0
fi

if curl -fsS -o /dev/null -m 1 "${HEALTH_URL}"; then
  exit 0
fi

echo "mission-control not responding — restarting."
mapfile -t pids < <(mission_pids)
signaled_pids=()
for pid in "${pids[@]}"; do
  if process_matches "${pid}"; then
    # Term the old process.  Exit code is ignored on purpose: a
    # race where the process was already reaped before Term was
    # delivered is NOT a kill failure -- it is a confirmed death.
    # The stubborn-process test below catches the real Term
    # failure (process still alive after the deadline).
    signal_pid "${pid}" 2>/dev/null || true
    signaled_pids+=("${pid}")
  fi
done

# Wait for the old processes to *truly* die.  We require:
#   - /proc/${pid} no longer present, OR
#   - /proc/${pid} still present BUT exe/cwd no longer match, OR
#   - /proc/${pid} still present and exe/cwd match BUT start_time
#     has changed (= kernel reaped the task and reused the slot).
#
# A new node process whose start_time differs is NOT the same task,
# so we keep waiting.  This eliminates the PID-reuse false-positive
# path identified in round-2 review.
for _ in 1 2 3 4 5; do
  remaining_pids=()
  for pid in "${signaled_pids[@]}"; do
    if process_matches "${pid}"; then
      remaining_pids+=("${pid}")
    fi
  done
  signaled_pids=("${remaining_pids[@]}")
  [ "${#signaled_pids[@]}" -eq 0 ] && break
  sleep_one
done
if [ "${#signaled_pids[@]}" -ne 0 ]; then
  echo "mission-control old process did not terminate — refusing to launch." >&2
  exit 1
fi

cd "${APP_DIR}"
setsid env MISSION_PORT="${PORT}" MISSION_BASE=/mission nohup node server.js > "${LOG}" 2>&1 < /dev/null &
launched_pid=$!
disown || true

# Snapshot the kernel start_time of the launched PID so a future
# PID-reuse cannot be mistaken for "the same process still running".
# If we lose the launch before we ever read this, treat that as a
# launch failure (process died before it even had an identity).
launched_start=""
for _ in 1 2 3 4 5; do
  launched_start="$(launched_start_time "${launched_pid}" 2>/dev/null || true)"
  if [ -n "${launched_start}" ]; then
    break
  fi
  if ! pid_alive "${launched_pid}"; then
    echo "mission-control launched process exited before becoming healthy." >&2
    exit 1
  fi
  sleep_one
done
if [ -z "${launched_start}" ]; then
  echo "mission-control launched process has no /proc/<pid>/stat — refusing to declare success." >&2
  exit 1
fi

start_tick="$(monotonic_seconds)"
deadline=$((start_tick + 10))
while [ "$(monotonic_seconds)" -lt "${deadline}" ]; do
  # First, the process itself must still exist AND still be the same
  # kernel task (start_time unchanged).  No id = no false success.
  if ! process_identity_matches "${launched_pid}" "${launched_start}"; then
    echo "mission-control launched process is no longer the original task (PID reuse or death)." >&2
    exit 1
  fi
  if curl -fsS -o /dev/null -m 1 "${HEALTH_URL}"; then
    # Second guard: the launched PID must own the listening socket.
    # Without this, an impostor could be answering /health while the
    # launched node is hung -- the round-2 false-success path.
    if launched_pid_owns_port "${launched_pid}" >/dev/null; then
      if process_identity_matches "${launched_pid}" "${launched_start}"; then
        echo "mission-control restarted successfully."
        exit 0
      fi
    fi
  fi
  # Single sample of progress per second; no unconditional post-loop
  # sleep.  The deadline check above exits the loop on its own when
  # we run out of budget.
  [ "$(monotonic_seconds)" -ge "${deadline}" ] && break
  sleep_one
done

# We exited the loop without declaring success.  If the launched
# PID is still alive, kill it so we do not leave a zombie behind.
if pid_alive "${launched_pid}"; then
  signal_pid "${launched_pid}" 2>/dev/null || true
fi
echo "mission-control restart FAILED — check ${LOG}" >&2
exit 1
