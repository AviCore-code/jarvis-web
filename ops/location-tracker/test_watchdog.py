#!/usr/bin/env python3
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
WATCHDOG = HERE / "location-api-watchdog.sh"


class WatchdogTests(unittest.TestCase):
    def test_rejects_unrelated_healthy_http_service(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake_bin = Path(tmp)
            commands = {
                "curl": "#!/bin/sh\nprintf '%s\\n' '{\"status\":\"ok\",\"service\":\"unrelated\"}'\n",
                "pgrep": "#!/bin/sh\nexit 1\n",
                "setsid": "#!/bin/sh\nexit 0\n",
                "sleep": "#!/bin/sh\nexit 0\n",
            }
            for name, content in commands.items():
                path = fake_bin / name
                path.write_text(content)
                path.chmod(0o755)
            env = os.environ.copy()
            env["PATH"] = f"{fake_bin}:{env['PATH']}"
            result = subprocess.run(
                ["bash", str(WATCHDOG)],
                env=env,
                capture_output=True,
                text=True,
                timeout=5,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("restart FAILED", result.stdout)


if __name__ == "__main__":
    unittest.main()
