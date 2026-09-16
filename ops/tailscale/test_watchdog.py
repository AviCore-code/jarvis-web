#!/usr/bin/env python3
import pathlib
import unittest

WATCHDOG = pathlib.Path(__file__).with_name("tailscale-watchdog.sh")

class WatchdogConfigTest(unittest.TestCase):
    def test_daemon_sets_var_root_for_https_certificates(self):
        text = WATCHDOG.read_text()
        self.assertIn('--statedir="${STATE_DIR}"', text)

if __name__ == "__main__":
    unittest.main()
