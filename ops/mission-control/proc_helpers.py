#!/usr/bin/env python3
"""Process / socket introspection helpers for the Mission Control watchdog.

These are run by ``jarvis-mission-control-watchdog.sh`` via ``python3`` and
must stay free of third-party dependencies: stdlib only.

Two interfaces are exposed because the round-2 review identified false
success paths in the prior version:

* :func:`pid_owns_port` -- proves the launched PID owns the listening TCP
  socket by joining the kernel's inode table (/proc/net/tcp) with the
  per-process fd table (/proc/<pid>/fd/*).  ``lsof`` is not assumed.

* :func:`pid_start_time` -- reads field 22 after ``comm`` of
  /proc/<pid>/stat, the kernel clock-tick start stamp.  This is the only
  authoritative way to distinguish "PID still alive" from "PID was reaped
  and the slot reused by a different task with the same exe/cwd".

Both functions accept ``proc_root`` so the watchdog tests can drive them
against a mocked /proc fixture.
"""

from __future__ import annotations

import os
import re
import sys
from typing import Iterable, Optional


def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return None


def pid_start_time(pid: int, proc_root: str = "/proc") -> Optional[int]:
    """Return the kernel clock-tick ``start_time`` of ``pid`` or ``None``.

    The 22nd field of ``/proc/<pid>/stat`` (counting from 1) is the
    ``start_time`` in clock ticks since boot.  It only changes for the
    underlying task, never just because of a PID being reaped; if a
    different task reuses the same PID it will see a different value.
    """
    text = _read_text(os.path.join(proc_root, str(int(pid)), "stat"))
    if text is None:
        return None
    # /proc/<pid>/stat has the form: "PID (comm) S ..."  -- comm may
    # contain spaces or even ')', so split from the right.
    last_paren = text.rfind(")")
    if last_paren < 0:
        return None
    tail = text[last_paren + 1 :].strip().split()
    if len(tail) < 20:  # need at least 20 fields after the trailing ')'
        return None
    # After the '('...')', field index 19 (the 20th post-paren field)
    # is the original 22nd stat field: ``start_time``.
    try:
        return int(tail[19])
    except ValueError:
        return None


def _pid_socket_inodes(pid: int, proc_root: str) -> Iterable[int]:
    """Yield socket inodes referenced by /proc/<pid>/fd/* symlinks.

    Each entry looks like ``socket:[12345]``; we extract the integer.
    """
    fd_dir = os.path.join(proc_root, str(int(pid)), "fd")
    try:
        entries = os.listdir(fd_dir)
    except (FileNotFoundError, NotADirectoryError, PermissionError):
        return
    for entry in entries:
        try:
            target = os.readlink(os.path.join(fd_dir, entry))
        except OSError:
            continue
        m = re.match(r"socket:\[(\d+)\]", target)
        if m:
            yield int(m.group(1))


def _listening_inodes_for_port(port: int, proc_root: str = "/proc") -> Iterable[int]:
    """Yield inodes that hold a LISTEN socket on ``port`` from /proc/net/tcp.

    Only the LISTEN state (st == 0A hex) is reported, and only entries
    whose local address has the requested port.  IPv6 is intentionally
    skipped here because the watchdog listens on 127.0.0.1:port via TCP4;
    the upstream script can be extended to consult /proc/net/tcp6 later.
    """
    port_hex = "{:X}".format(int(port) & 0xFFFF)
    for path in (os.path.join(proc_root, "net", "tcp"),):
        text = _read_text(path)
        if text is None:
            continue
        # Skip the header line (the column names with 'sl').
        for line in text.splitlines():
            if not line or line.lstrip().startswith("sl"):
                continue
            cols = line.split()
            if len(cols) < 10:
                continue
            local = cols[1]
            state = cols[3]
            if ":" not in local:
                continue
            addr, lp = local.split(":", 1)
            if lp.upper() != port_hex:
                continue
            if state.upper() != "0A":
                continue
            # Canonical /proc/net/tcp inode column is col 9 (0-indexed).
            # Fall back to the last integer > 0 if col 9 is not the
            # canonical pattern, so the parser works with stripped
            # test fixtures that omit the queue/stat columns.
            inode = None
            for c in (cols[9], cols[-1] if len(cols) > 9 else None):
                if c is None:
                    continue
                try:
                    inode = int(c)
                except ValueError:
                    inode = None
                    continue
                if inode >= 0:
                    break
            if inode is None:
                continue
            # 'addr' is little-endian hex; treat specially:
            # 00000000 -> 0.0.0.0 (we accept), but we already key off the
            # port so any local IP works here.
            try:
                yield int(inode)
            except ValueError:
                continue


def pid_owns_port(
    pid: int, port: int, proc_root: str = "/proc"
) -> bool:
    """Return True iff ``pid`` is the owner of a LISTEN socket on ``port``.

    Combines /proc/net/tcp (which inodes are listening on the port) with
    /proc/<pid>/fd (which inodes are open in this process).  False on
    any I/O error or missing process -- never raises.
    """
    try:
        pid_i = int(pid)
        port_i = int(port)
    except (TypeError, ValueError):
        return False
    owned_inodes = set(_pid_socket_inodes(pid_i, proc_root))
    if not owned_inodes:
        return False
    listening = set(_listening_inodes_for_port(port_i, proc_root))
    if not listening:
        return False
    return bool(owned_inodes & listening)


def main(argv: Optional[list] = None) -> int:
    """Tiny CLI to allow shell-side calls without extra deps.

    Usage:
        python3 proc_helpers.py pid-start-time <pid>
        python3 proc_helpers.py pid-owns-port <pid> <port>

    Honors PROC_HELPERS_NET_TCP_OVERRIDE for tests so that mocked
    /proc/net/tcp content can be supplied as a file path.
    """
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        return 2
    cmd, rest = args[0], args[1:]
    proc_root_override = os.environ.get("PROC_HELPERS_PROC_ROOT")
    net_tcp_override = os.environ.get("PROC_HELPERS_NET_TCP_OVERRIDE")
    pr = proc_root_override or "/proc"
    if cmd == "pid-start-time":
        if len(rest) != 1:
            print("usage: pid-start-time <pid>", file=sys.stderr)
            return 2
        st = pid_start_time(int(rest[0]), proc_root=pr)
        if st is None:
            return 1
        print(st)
        return 0
    if cmd == "pid-owns-port":
        if len(rest) != 2:
            print("usage: pid-owns-port <pid> <port>", file=sys.stderr)
            return 2
        # We let the test override the /proc/net/tcp content via a
        # fixture file; this gives shell-driven tests a hook without
        # requiring the tests to monkey-patch python.
        if net_tcp_override:
            try:
                overlay = open(net_tcp_override, "r").read()
            except OSError as exc:
                print(f"override-read-failed: {exc}", file=sys.stderr)
                return 1
            # Use a sandbox where we serve the fixture as /proc/net/tcp.
            # Easiest: use _listening_inodes_for_port command but swap
            # the proc_root to a temporary one holding only net/tcp.
            sandbox = _NetSandbox(pr, overlay)
            try:
                result = sandbox.pid_owns(int(rest[0]), int(rest[1]))
            finally:
                sandbox.cleanup()
            print("yes" if result else "no")
            return 0 if result else 1
        result = pid_owns_port(int(rest[0]), int(rest[1]), proc_root=pr)
        print("yes" if result else "no")
        return 0 if result else 1
    print(f"unknown subcommand: {cmd}", file=sys.stderr)
    return 2


class _NetSandbox:
    """Tiny /proc sandbox that overlays net/tcp with fixture content.

    This is invoked only from the CLI path with
    PROC_HELPERS_NET_TCP_OVERRIDE; the in-process API does not need it.
    """

    def __init__(self, proc_root: str, tcp_text: str) -> None:
        import tempfile

        self._proc_root = tempfile.mkdtemp(prefix="proc-helpers-")
        os.makedirs(os.path.join(self._proc_root, "net"), exist_ok=True)
        with open(os.path.join(self._proc_root, "net", "tcp"), "w") as fh:
            fh.write(tcp_text)
        # Expose the real /proc/<pid> entries by symlinking each pid
        # directory we know about, so pid_owns_port sees real fd tables.
        try:
            for entry in os.listdir(proc_root):
                if entry.isdigit():
                    os.symlink(
                        os.path.join(proc_root, entry),
                        os.path.join(self._proc_root, entry),
                    )
        except OSError:
            pass

    def pid_owns(self, pid: int, port: int) -> bool:
        return pid_owns_port(pid, port, proc_root=self._proc_root)

    def cleanup(self) -> None:
        import shutil

        shutil.rmtree(self._proc_root, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
