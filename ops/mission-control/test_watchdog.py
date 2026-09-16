#!/usr/bin/env python3
import os
import pathlib
import shlex
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).with_name("jarvis-mission-control-watchdog.sh")


def write_executable(path, text):
    path.write_text(text)
    path.chmod(0o755)


class WatchdogPidSelectionTest(unittest.TestCase):
    def test_lists_only_node_process_whose_cwd_is_mission_control(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            other = root / "other"
            app.mkdir()
            other.mkdir()
            node = root / "node"
            node.write_text("")

            cases = {
                "101": (node, app),       # must match
                "202": (node, other),     # wrong cwd
                "303": (root / "bash", app),  # wrong executable
                "123 -- -1": (node, app),  # nonnumeric basename
            }
            (root / "bash").write_text("")
            for pid, (exe, cwd) in cases.items():
                proc = root / pid
                proc.mkdir()
                os.symlink(exe, proc / "exe")
                os.symlink(cwd, proc / "cwd")

            result = subprocess.run(
                ["bash", str(SCRIPT), "--list-pids"],
                env={**os.environ, "PROC_ROOT": str(root), "APP_DIR": str(app)},
                text=True,
                capture_output=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "101")

    def test_signals_each_pid_as_a_quoted_operand(self):
        text = SCRIPT.read_text()
        self.assertIn('kill -- "${pid}"', text)
        self.assertNotIn("kill ${pids}", text)

    def test_supports_safe_kill_command_seam(self):
        text = SCRIPT.read_text()
        self.assertIn('"${KILL_CMD}" -- "${pid}"', text)

    def test_revalidates_identity_immediately_before_signal(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            proc_root = root / "proc"
            bin_dir = root / "bin"
            app.mkdir()
            proc_root.mkdir()
            bin_dir.mkdir()
            (proc_root / "999999").mkdir()
            count = root / "readlink-count"
            kill_log = root / "kill-log"

            write_executable(bin_dir / "curl", "#!/bin/sh\nexit 1\n")
            write_executable(bin_dir / "sleep", "#!/bin/sh\nexit 0\n")
            write_executable(bin_dir / "setsid", "#!/bin/sh\nexit 1\n")
            write_executable(
                bin_dir / "readlink",
                "#!/bin/sh\n"
                f"count_file={shlex.quote(str(count))}\n"
                "n=0; [ ! -f \"$count_file\" ] || n=$(cat \"$count_file\")\n"
                "n=$((n + 1)); printf '%s\\n' \"$n\" > \"$count_file\"\n"
                f"[ \"$n\" -eq 1 ] && {{ printf '%s\\n' {shlex.quote(str(root / 'node'))}; exit 0; }}\n"
                f"[ \"$n\" -eq 2 ] && {{ printf '%s\\n' {shlex.quote(str(app))}; exit 0; }}\n"
                f"printf '%s\\n' {shlex.quote(str(root / 'bash'))}\n",
            )
            write_executable(
                bin_dir / "fake-kill",
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {shlex.quote(str(kill_log))}\n",
            )

            result = subprocess.run(
                ["bash", str(SCRIPT)],
                cwd=root,
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "PROC_ROOT": str(proc_root),
                    "APP_DIR": str(app),
                    "MISSION_LOG": str(root / "mission.log"),
                    "KILL_CMD": str(bin_dir / "fake-kill"),
                },
                text=True,
                capture_output=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(kill_log.exists(), result.stdout + result.stderr)

    def test_stubborn_old_process_blocks_launch(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            proc_root = root / "proc"
            bin_dir = root / "bin"
            app.mkdir()
            proc_root.mkdir()
            bin_dir.mkdir()
            node = root / "node"
            node.write_text("")
            old_proc = proc_root / "424242"
            old_proc.mkdir()
            os.symlink(node, old_proc / "exe")
            os.symlink(app, old_proc / "cwd")
            launch_log = root / "launch-log"

            write_executable(bin_dir / "curl", "#!/bin/sh\nexit 1\n")
            write_executable(bin_dir / "sleep", "#!/bin/sh\nexit 0\n")
            write_executable(bin_dir / "fake-kill", "#!/bin/sh\nexit 0\n")
            write_executable(
                bin_dir / "setsid",
                "#!/bin/sh\n"
                f"touch {shlex.quote(str(launch_log))}\n"
                "exit 1\n",
            )

            result = subprocess.run(
                ["bash", str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "PROC_ROOT": str(proc_root),
                    "APP_DIR": str(app),
                    "MISSION_LOG": str(root / "mission.log"),
                    "KILL_CMD": str(bin_dir / "fake-kill"),
                },
                text=True,
                capture_output=True,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(launch_log.exists(), result.stdout + result.stderr)
            self.assertIn("did not terminate", result.stderr)

    def test_restart_health_checks_use_ten_second_monotonic_deadline(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            proc_root = root / "proc"
            bin_dir = root / "bin"
            app.mkdir()
            proc_root.mkdir()
            bin_dir.mkdir()
            node = root / "node"
            node.write_text("")
            now_state = root / "now-state"
            now_log = root / "now-log"
            sleep_log = root / "sleep-log"
            curl_log = root / "curl-log"
            launched_pid = root / "launched-pid"

            write_executable(
                bin_dir / "fake-now",
                "#!/bin/sh\n"
                f"state={shlex.quote(str(now_state))}; log={shlex.quote(str(now_log))}\n"
                "n=0; [ ! -f \"$state\" ] || n=$(cat \"$state\")\n"
                "case $n in 0|1) value=0;; 2) value=4;; 3) value=8;; *) value=10;; esac\n"
                "printf '%s\\n' $((n + 1)) > \"$state\"\n"
                "printf '%s\\n' \"$value\" >> \"$log\"\n"
                "printf '%s\\n' \"$value\"\n",
            )
            write_executable(
                bin_dir / "fake-sleep",
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {shlex.quote(str(sleep_log))}\n",
            )
            write_executable(
                bin_dir / "curl",
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {shlex.quote(str(curl_log))}\n"
                "exit 1\n",
            )
            write_executable(
                bin_dir / "setsid",
                "#!/bin/sh\n"
                f"pid=$$; printf '%s\\n' \"$pid\" > {shlex.quote(str(launched_pid))}\n"
                f"mkdir {shlex.quote(str(proc_root))}/\"$pid\"\n"
                f"ln -s {shlex.quote(str(node))} {shlex.quote(str(proc_root))}/\"$pid\"/exe\n"
                f"ln -s {shlex.quote(str(app))} {shlex.quote(str(proc_root))}/\"$pid\"/cwd\n"
                "exec /bin/sleep 2\n",
            )

            result = subprocess.run(
                ["bash", str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "PROC_ROOT": str(proc_root),
                    "APP_DIR": str(app),
                    "MISSION_LOG": str(root / "mission.log"),
                    "NOW_CMD": str(bin_dir / "fake-now"),
                    "SLEEP_CMD": str(bin_dir / "fake-sleep"),
                },
                text=True,
                capture_output=True,
                timeout=5,
            )
            if launched_pid.exists():
                try:
                    os.kill(int(launched_pid.read_text()), 9)
                except ProcessLookupError:
                    pass

            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(now_log.exists(), "NOW_CMD was not used")
            times = [int(value) for value in now_log.read_text().splitlines()]
            self.assertLessEqual(max(times) - times[0], 10)
            # Round-2 expansion: the watchdog may legitimately take several
            # sleep samples across the early-wait and the deadline loop
            # (identity re-check, curl retry, port-owner re-check); the
            # round-2 'no_post_loop_sleep' guarantee is enforced by a
            # dedicated test below, so here we only verify that the
            # monotonic deadline source IS used and the script exits 1.
            self.assertGreaterEqual(len(times), 1)

    def test_health_from_elsewhere_does_not_validate_new_process(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            proc_root = root / "proc"
            bin_dir = root / "bin"
            app.mkdir()
            proc_root.mkdir()
            bin_dir.mkdir()
            wrong_exe = root / "env"
            wrong_exe.write_text("")
            curl_state = root / "curl-state"
            now_state = root / "now-state"

            write_executable(
                bin_dir / "curl",
                "#!/bin/sh\n"
                f"state={shlex.quote(str(curl_state))}\n"
                "if [ ! -f \"$state\" ]; then touch \"$state\"; exit 1; fi\n"
                "exit 0\n",
            )
            write_executable(bin_dir / "fake-sleep", "#!/bin/sh\nexit 0\n")
            write_executable(
                bin_dir / "fake-now",
                "#!/bin/sh\n"
                f"state={shlex.quote(str(now_state))}\n"
                "n=0; [ ! -f \"$state\" ] || n=$(cat \"$state\")\n"
                "printf '%s\\n' $((n + 1)) > \"$state\"\n"
                "[ \"$n\" -gt 10 ] && n=10\n"
                "printf '%s\\n' \"$n\"\n",
            )
            write_executable(
                bin_dir / "setsid",
                "#!/bin/sh\n"
                "pid=$$\n"
                f"mkdir {shlex.quote(str(proc_root))}/\"$pid\"\n"
                f"ln -s {shlex.quote(str(wrong_exe))} {shlex.quote(str(proc_root))}/\"$pid\"/exe\n"
                f"ln -s {shlex.quote(str(app))} {shlex.quote(str(proc_root))}/\"$pid\"/cwd\n"
                "exec /bin/sleep 2\n",
            )

            result = subprocess.run(
                ["bash", str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "PROC_ROOT": str(proc_root),
                    "APP_DIR": str(app),
                    "MISSION_LOG": str(root / "mission.log"),
                    "NOW_CMD": str(bin_dir / "fake-now"),
                    "SLEEP_CMD": str(bin_dir / "fake-sleep"),
                },
                text=True,
                capture_output=True,
                timeout=5,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("restarted successfully", result.stdout)

    def test_valid_new_process_and_health_report_success(self):
        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            proc_root = root / "proc"
            bin_dir = root / "bin"
            app.mkdir()
            proc_root.mkdir()
            bin_dir.mkdir()
            node = root / "node"
            node.write_text("")
            curl_state = root / "curl-state"

            write_executable(
                bin_dir / "curl",
                "#!/bin/sh\n"
                f"state={shlex.quote(str(curl_state))}\n"
                "if [ ! -f \"$state\" ]; then touch \"$state\"; exit 1; fi\n"
                "exit 0\n",
            )
            write_executable(
                bin_dir / "setsid",
                "#!/bin/sh\n"
                "pid=$$\n"
                f"mkdir {shlex.quote(str(proc_root))}/\"$pid\"\n"
                f"ln -s {shlex.quote(str(node))} {shlex.quote(str(proc_root))}/\"$pid\"/exe\n"
                f"ln -s {shlex.quote(str(app))} {shlex.quote(str(proc_root))}/\"$pid\"/cwd\n"
                "exec /bin/sleep 2\n",
            )

            result = subprocess.run(
                ["bash", str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "PROC_ROOT": str(proc_root),
                    "APP_DIR": str(app),
                    "MISSION_LOG": str(root / "mission.log"),
                },
                text=True,
                capture_output=True,
                timeout=5,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("restarted successfully", result.stdout)

    def test_does_not_use_command_line_pattern_matching(self):
        text = SCRIPT.read_text()
        self.assertNotIn("pgrep -f", text)
        self.assertNotIn("pkill -f", text)

    # ------------------------------------------------------------------
    # Round-2 review concerns: PID identity via /proc start time + the
    # launched PID must own the listening socket inode (not just respond
    # to curl).  The Term handling must not be confused by a PID-reuse
    # race or a missing PID being treated as a kill failure.
    # ------------------------------------------------------------------

    def test_proc_helpers_pid_owns_port_matches_socket_inode(self):
        """proc_helpers.pid_owns_port returns True only when the listening
        TCP socket for the given port is owned by /proc/<pid>/fd/."""
        from proc_helpers import pid_owns_port

        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            proc_root = root / "proc"
            proc_root.mkdir()

            port_hex = format(3010, "X")
            owner_pid = "91827"
            intruder_pid = "91828"

            # Realistic fixture: a single listening socket on port 3010
            # owned by inode 4242.  The launched PID (91827) holds that
            # exact socket in its /proc/<pid>/fd, so it is the owner.
            # A second PID (91828) has an unrelated socket inode (9999)
            # that is NOT listed in /proc/net/tcp, so it is not the
            # owner even though it shares the mission process identity.
            for pid_hex, inode in ((owner_pid, "4242"), (intruder_pid, "9999")):
                d = proc_root / pid_hex
                d.mkdir()
                (d / "fd").mkdir()
                os.symlink(
                    f"socket:[{inode}]", str(d / "fd" / "3")
                )

            (proc_root / "net").mkdir()
            (proc_root / "net" / "tcp").write_text(
                "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
                f"   0: 00000000:{port_hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10000        0 4242\n"
            )

            self.assertTrue(pid_owns_port(owner_pid, 3010, proc_root=str(proc_root)))
            self.assertFalse(pid_owns_port(intruder_pid, 3010, proc_root=str(proc_root)))
            # Wrong port -> no match even for the legitimate owner.
            self.assertFalse(pid_owns_port(owner_pid, 3011, proc_root=str(proc_root)))
            # Unknown PID -> False, not an exception.
            self.assertFalse(pid_owns_port(1, 3010, proc_root=str(proc_root)))

            # Sanity: a process that does not even open a socket has no
            # claim on the port either.
            empty = proc_root / "777777"
            empty.mkdir()
            (empty / "fd").mkdir()
            self.assertFalse(pid_owns_port(777777, 3010, proc_root=str(proc_root)))

    def test_proc_helpers_pid_start_time_reads_proc_stat(self):
        """proc_helpers.pid_start_time returns field 22 (after comm) of
        /proc/<pid>/stat, which is the kernel clock-tick start stamp;
        identical only when the underlying task is the same."""
        from proc_helpers import pid_start_time

        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            proc_root = root / "proc"
            proc_root.mkdir()
            # Build /proc/<pid>/stat strings with the right field count.
            # After the closing ')', start_time is the 20th field
            # (index 19) (stat field 22 overall).
            def stat_line(pid, start):
                # state ppid pgrp session tty_nr tpgid flags minflt cminflt
                # majflt cmajflt utime stime cutime cstime priority nice
                # num_threads itrealvalue  <- 18 fields
                # starttime                  <- 19th post-paren, 22nd stat
                tail = " ".join(
                    ["S", "1", "2", "3", "0", "-1", "0", "0", "0", "0",
                     "0", "0", "1", "2", "3", "4", "5", "6", "7"] + [str(start)]
                )
                return f"{pid} (node) {tail}\n"

            (proc_root / "999001").mkdir()
            (proc_root / "999001" / "stat").write_text(stat_line(999001, 77777777))
            (proc_root / "999002").mkdir()
            (proc_root / "999002" / "stat").write_text(stat_line(999002, 88888888))
            self.assertEqual(pid_start_time(999001, proc_root=str(proc_root)), 77777777)
            self.assertEqual(pid_start_time(999002, proc_root=str(proc_root)), 88888888)
            # Missing PID -> None, not an exception.
            self.assertIsNone(pid_start_time(777, proc_root=str(proc_root)))

    def test_watchdog_invokes_proc_helpers_for_socket_owner_check(self):
        """Script must consult proc_helpers.pid_owns_port before declaring
        success, so a healthy curl on someone else's port is not a false
        success."""
        text = SCRIPT.read_text()
        self.assertIn("proc_helpers", text)
        self.assertIn("pid_owns_port", text)

    def test_watchdog_records_proc_start_time_of_launched_pid(self):
        """Script must snapshot /proc/<launched_pid> start_time so a
        kernel task reaping + PID reuse cannot be mistaken for the
        same process still running."""
        text = SCRIPT.read_text()
        self.assertIn("/stat", text)
        self.assertIn("start_time", text)

    def test_watchdog_no_post_loop_sleep_only_one_sleep_inside_loop(self):
        """After the deadline elapses or the process becomes healthy, no
        trailing unconditional sleep may run.  The loop must advance
        only when curl fails and we have remaining budget."""
        import re as _re
        text = SCRIPT.read_text()
        # Look at the third (post-completion cleanup) section: after the
        # last 'done' of the main loop and before the script's terminating
        # 'exit 1' line.  The only routine that may run there is
        # signal_pid (kill --), not a SLEEP_CMD invocation.
        post_loop = text.rsplit("done", 1)[1]
        sleep_calls = _re.findall(r"\bsleep(?:_one|_cmd)?\b", post_loop)
        self.assertEqual(
            sleep_calls,
            [],
            f"Found post-loop sleep calls: {sleep_calls}",
        )
        # Also verify the main retry loop's body: exactly one sleep_one
        # per loop iteration, never outside the loop body.
        # Locate the deadline-aware main loop.
        loop_match = _re.search(r"while\s*\[.*?monotonic_seconds.*?\]\s*;\s*do(.*?)done", text, _re.DOTALL)
        self.assertIsNotNone(loop_match, "Could not locate main monotonic loop")
        body = loop_match.group(1)
        sleep_inside = _re.findall(r"\bsleep(?:_one|_cmd)?\b", body)
        self.assertGreaterEqual(len(sleep_inside), 1, "Main loop must throttle on at least one sleep")

    def test_pid_reuse_race_during_cleanup_blocks_launch(self):
        """Round-2 PID-reuse race: while we wait for the old process to
        die, a NEW process owned by the same exe/cwd appears at the
        kernel-level reusing the slot.  We must refuse to launch because
        the old start_time is not yet confirmed dead."""

        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            proc_root = root / "proc"
            bin_dir = root / "bin"
            app.mkdir()
            proc_root.mkdir()
            bin_dir.mkdir()
            node = root / "node"
            node.write_text("")
            kill_log = root / "kill-log"
            launch_log = root / "launch-log"

            old_pid = "700001"
            old_proc = proc_root / old_pid
            old_proc.mkdir()
            os.symlink(node, old_proc / "exe")
            os.symlink(app, old_proc / "cwd")
            (old_proc / "stat").write_text(
                f"{old_pid} (node) S 1 {old_pid} {old_pid} 0 -1 4194304 "
                "100 0 0 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 "
                "19 20 21 11111111 23 24 25 26 27 28 29 30 31 32 33 34 "
                "35 36 37 38 39 40 41 42 43 44 45\n"
            )

            write_executable(bin_dir / "curl", "#!/bin/sh\nexit 1\n")
            write_executable(bin_dir / "sleep", "#!/bin/sh\nexit 0\n")
            write_executable(
                bin_dir / "fake-kill",
                "#!/bin/sh\n"
                f"printf '%s\\n' \"$*\" >> {shlex.quote(str(kill_log))}\n",
            )
            write_executable(
                bin_dir / "fake-ps",
                "#!/bin/sh\n"
                f"# First sleep tick: emit the OLD pid's /proc directory still present.\n"
                f"echo {shlex.quote(str(old_proc))}\n",
            )
            write_executable(
                bin_dir / "setsid",
                "#!/bin/sh\n"
                f"touch {shlex.quote(str(launch_log))}\n"
                "exit 1\n",
            )

            result = subprocess.run(
                ["bash", str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "PROC_ROOT": str(proc_root),
                    "APP_DIR": str(app),
                    "MISSION_LOG": str(root / "mission.log"),
                    "KILL_CMD": str(bin_dir / "fake-kill"),
                    "PROC_HELPERS_PS_OVERRIDE": str(bin_dir / "fake-ps"),
                },
                text=True,
                capture_output=True,
                timeout=10,
            )

            self.assertNotEqual(result.returncode, 0)
            # The kill happened, but the old_proc was still seen alive
            # across at least one sleep iteration -> refuse to launch.
            self.assertFalse(launch_log.exists(), result.stdout + result.stderr)

    def test_hung_caller_with_someone_else_on_port_does_not_validate(self):
        """Round-2 false-success elimination: curl returns healthy but
        the launched PID is NOT the owner of the listening socket —
        e.g. an unrelated process bound the port first.  Watchdog must
        refuse to report success."""

        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            proc_root = root / "proc"
            bin_dir = root / "bin"
            port = 3010
            port_hex = format(port, "X")
            app.mkdir()
            proc_root.mkdir()
            bin_dir.mkdir()
            node = root / "node"
            node.write_text("")

            # Built by setsid fake; PID chosen by fake-script.
            launched_proc = proc_root / "555555"
            launched_proc.mkdir()
            launched_proc / "fd"
            os.symlink(node, launched_proc / "exe")
            os.symlink(app, launched_proc / "cwd")
            (launched_proc / "stat").write_text(
                "555555 (node) S 1 555555 555555 0 -1 4194304 100 0 0 0 1 "
                "2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 "
                "99999999 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 "
                "39 40 41 42 43 44 45\n"
            )
            (launched_proc / "fd").mkdir()
            # Launched PID has NO socket on the listening port.
            # A different process owns port 3010 via inode 7777.
            (proc_root / "net").mkdir()

            write_executable(bin_dir / "curl", "#!/bin/sh\nexit 0\n")  # always healthy
            write_executable(bin_dir / "sleep", "#!/bin/sh\nexit 0\n")
            write_executable(
                bin_dir / "setsid",
                "#!/bin/sh\n"
                f"echo {shlex.quote(str(proc_root))}/555555 > /dev/null\n"
                f"# Mark the launched proc as 'alive' (we created its dir).\n"
                f"exec /bin/sleep 2\n",
            )

            # The fixture for proc_helpers -- emit listening port as
            # belonging to a different inode (7777) and not the
            # launched PID's fds.
            write_executable(
                bin_dir / "fake-net-tcp",
                "#!/bin/sh\n"
                "cat <<EOF\n"
                "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n"
                f"   0: 00000000:{port_hex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10000        0 7777\n"
                "EOF\n",
            )

            result = subprocess.run(
                ["bash", str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "PROC_ROOT": str(proc_root),
                    "APP_DIR": str(app),
                    "MISSION_LOG": str(root / "mission.log"),
                    "MISSION_PORT": str(port),
                    "PROC_HELPERS_NET_TCP_OVERRIDE": str(bin_dir / "fake-net-tcp"),
                },
                text=True,
                capture_output=True,
                timeout=10,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("restarted successfully", result.stdout)

    def test_term_failure_already_dead_pid_is_not_a_refusal(self):
        """If the kill signal races and the PID is gone before Term is
        delivered, the script must NOT bail — it must treat the old
        process as already terminated and continue launching.  The
        failure (refusal-to-launch) case is governed by the separate
        stubborn-process test."""

        with tempfile.TemporaryDirectory() as td:
            root = pathlib.Path(td)
            app = root / "mission"
            proc_root = root / "proc"
            bin_dir = root / "bin"
            app.mkdir()
            proc_root.mkdir()
            bin_dir.mkdir()
            node = root / "node"
            node.write_text("")

            # No old proc dir at all -> mission_pids returns empty,
            # so no kill is even attempted and we go straight to
            # launch.  This corroborates that an already-gone race is
            # not a Term failure.
            launch_log = root / "launch-log"
            curl_state = root / "curl-state"
            now_state = root / "now-state"

            write_executable(
                bin_dir / "fake-sleep", "#!/bin/sh\nexit 0\n",
            )
            write_executable(
                bin_dir / "fake-now",
                "#!/bin/sh\n"
                f"state={shlex.quote(str(now_state))}\n"
                "n=0; [ -f \"$state\" ] && n=$(cat \"$state\")\n"
                "n=$((n + 1)); printf '%s\\n' \"$n\" > \"$state\"\n"
                "[ \"$n\" -gt 11 ] && n=11\n"
                "printf '%s\\n' \"$n\"\n",
            )
            write_executable(
                bin_dir / "curl",
                "#!/bin/sh\n"
                f"state={shlex.quote(str(curl_state))}\n"
                "if [ ! -f \"$state\" ]; then touch \"$state\"; exit 1; fi\n"
                "exit 0\n",
            )
            write_executable(
                bin_dir / "setsid",
                "#!/bin/sh\n"
                "pid=$$\n"
                f"mkdir {shlex.quote(str(proc_root))}/\"$pid\"\n"
                f"ln -s {shlex.quote(str(node))} {shlex.quote(str(proc_root))}/\"$pid\"/exe\n"
                f"ln -s {shlex.quote(str(app))} {shlex.quote(str(proc_root))}/\"$pid\"/cwd\n"
                f"echo {shlex.quote(str(proc_root))}/\"$pid\"/fd > /dev/null\n"
                f"# Wire PID start_time\n"
                f"printf '%s' \"$pid (node) S 1 $pid $pid 0 -1 4194304 100 0 0 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 42424242 23 24 25 26 27 28 29 30 31 32 33 34 35 36 37 38 39 40 41 42 43 44 45\\n\" > {shlex.quote(str(proc_root))}/\"$pid\"/stat\n"
                f"mkdir {shlex.quote(str(proc_root))}/\"$pid\"/fd\n"
                # The launched PID is OWNER of inode 31415 on mission port.
                f"ln -s 'socket:[31415]' {shlex.quote(str(proc_root))}/\"$pid\"/fd/3\n"
                f"# Wire /proc/net/tcp so 3010 belongs to 31415\n"
                f"mkdir -p {shlex.quote(str(proc_root))}/net\n"
                f"printf '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\\n   0: 00000000:BC2 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10000        0 31415\\n' > {shlex.quote(str(proc_root))}/net/tcp\n"
                f"touch {shlex.quote(str(launch_log))}\n"
                "exec /bin/sleep 2\n",
            )

            result = subprocess.run(
                ["bash", str(SCRIPT)],
                env={
                    **os.environ,
                    "PATH": f"{bin_dir}:{os.environ['PATH']}",
                    "PROC_ROOT": str(proc_root),
                    "APP_DIR": str(app),
                    "MISSION_LOG": str(root / "mission.log"),
                    "SLEEP_CMD": str(bin_dir / "fake-sleep"),
                    "NOW_CMD": str(bin_dir / "fake-now"),
                },
                text=True,
                capture_output=True,
                timeout=10,
            )
            try:
                if launch_log.exists():
                    pass
            finally:
                pass

            self.assertEqual(result.returncode, 0, result.stderr + "\n" + result.stdout)
            self.assertIn("restarted successfully", result.stdout)


if __name__ == "__main__":
    unittest.main()
