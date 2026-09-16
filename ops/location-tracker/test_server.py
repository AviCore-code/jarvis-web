#!/usr/bin/env python3
import importlib.util
import http.client
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("location_server", HERE / "server.py")
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load location server module")
server = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(server)


class LocationApiSecurityTests(unittest.TestCase):
    def test_host_environment_cannot_override_loopback(self):
        with tempfile.TemporaryDirectory() as tmp:
            token_path = Path(tmp) / "token.txt"
            token_path.write_text("LOCATION_API_TOKEN=" + "x" * 32 + "\n")
            env = os.environ.copy()
            env["HOST"] = "0.0.0.0"
            env["LOCATION_API_TOKEN_PATH"] = str(token_path)
            result = subprocess.run(
                [sys.executable, "-c", "import server; print(server.HOST)"],
                cwd=HERE,
                env=env,
                capture_output=True,
                text=True,
                check=True,
            )
        self.assertEqual(result.stdout.strip(), "127.0.0.1")

    def test_empty_token_fails_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            token_path = Path(tmp) / "token.txt"
            token_path.write_text("LOCATION_API_TOKEN=\n")
            original = server.TOKEN_PATH
            server.TOKEN_PATH = str(token_path)
            try:
                with self.assertRaisesRegex(RuntimeError, "at least 32 bytes"):
                    server.load_token()
            finally:
                server.TOKEN_PATH = original

    def test_short_token_fails_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            token_path = Path(tmp) / "token.txt"
            token_path.write_text("LOCATION_API_TOKEN=too-short\n")
            original = server.TOKEN_PATH
            server.TOKEN_PATH = str(token_path)
            try:
                with self.assertRaisesRegex(RuntimeError, "at least 32 bytes"):
                    server.load_token()
            finally:
                server.TOKEN_PATH = original

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.TOKEN = b"test-token-that-is-at-least-32-bytes"
        server.CACHE_PATH = str(Path(cls.tmp.name) / "location-cache.json")
        cls.httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.tmp.cleanup()

    def request(self, path, *, data=None, token="test-token-that-is-at-least-32-bytes", method=None, include_headers=False):
        headers = {}
        if token is not None:
            headers["Authorization"] = f"Bearer {token}"
        if data is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request(method or ("POST" if data is not None else "GET"), path, body=data, headers=headers)
        response = connection.getresponse()
        try:
            result = (response.status, json.loads(response.read()))
            if include_headers:
                return (*result, dict(response.getheaders()))
            return result
        finally:
            connection.close()

    def test_health_response_identifies_location_service(self):
        status, body = self.request("/healthz", token=None)
        self.assertEqual(status, 200)
        self.assertEqual(body["service"], "jarvis-location-api")

    def test_rejects_missing_bearer_token(self):
        status, body = self.request("/api/location", token=None)
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "Unauthorized"})

    def test_rejects_wrong_bearer_token(self):
        status, body = self.request("/api/location", token="nope")
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "Unauthorized"})

    def test_authenticated_read_returns_cached_point(self):
        payload = json.dumps({"lat": 13.7563, "lon": 100.5018}).encode()
        post_status, _ = self.request("/api/location", data=payload)
        self.assertEqual(post_status, 200)
        get_status, get_body = self.request("/api/location")
        self.assertEqual(get_status, 200)
        self.assertEqual(get_body["point"]["lat"], 13.7563)
        self.assertEqual(get_body["point"]["lon"], 100.5018)

    def test_rejects_lat_lon_out_of_range(self):
        too_high = json.dumps({"lat": 91, "lon": 0}).encode()
        too_low = json.dumps({"lat": -91, "lon": 0}).encode()
        too_east = json.dumps({"lat": 0, "lon": 181}).encode()
        too_west = json.dumps({"lat": 0, "lon": -181}).encode()
        for payload in (too_high, too_low, too_east, too_west):
            status, body = self.request("/api/location", data=payload)
            self.assertEqual(status, 400)
            self.assertEqual(body, {"error": "lat/lon out of range"})

    def test_rejects_missing_lat_lon(self):
        payload = json.dumps({"source": "tasker"}).encode()
        status, body = self.request("/api/location", data=payload)
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "lat and lon (numeric) required"})

    def test_rejects_missing_or_wrong_bearer_token(self):
        status, body = self.request("/api/location", token="wrong")
        self.assertEqual(status, 401)
        self.assertEqual(body, {"error": "Unauthorized"})

    def test_unsupported_method_returns_sanitized_json_405(self):
        status, body, headers = self.request(
            "/api/location", method="PUT", include_headers=True
        )
        self.assertEqual(status, 405)
        self.assertEqual(body, {"error": "method not allowed"})
        self.assertEqual(headers.get("Allow"), "GET, POST")
        self.assertEqual(headers.get("Content-Type"), "application/json")

    def test_error_response_hides_runtime_version(self):
        _, _, headers = self.request(
            "/api/location", method="PUT", include_headers=True
        )
        server_header = headers.get("Server", "")
        self.assertNotIn("BaseHTTP", server_header)
        self.assertNotIn("Python", server_header)

    def test_bad_json_does_not_leak_parser_details(self):
        status, body = self.request("/api/location", data=b"{")
        self.assertEqual(status, 400)
        self.assertEqual(body, {"error": "bad json"})

    def test_location_post_does_not_send_coordinates_to_weather_service(self):
        with mock.patch("urllib.request.urlopen") as urlopen:
            payload = json.dumps({"lat": 13.7563, "lon": 100.5018}).encode()
            status, _ = self.request("/api/location", data=payload)
        self.assertEqual(status, 200)
        urlopen.assert_not_called()

    def test_cache_persist_failure_returns_sanitized_503(self):
        original = server.persist_cache
        server.persist_cache = lambda: (_ for _ in ()).throw(OSError("secret path"))
        try:
            payload = json.dumps({"lat": 13.7563, "lon": 100.5018}).encode()
            status, body = self.request("/api/location", data=payload)
        finally:
            server.persist_cache = original
        self.assertEqual(status, 503)
        self.assertEqual(body, {"error": "location unavailable"})
        self.assertNotIn("ok", body)

    def test_location_cache_is_owner_only(self):
        payload = json.dumps({"lat": 13.7563, "lon": 100.5018}).encode()
        status, body = self.request("/api/location", data=payload)
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        mode = stat.S_IMODE(os.stat(server.CACHE_PATH).st_mode)
        self.assertEqual(mode, 0o600)


if __name__ == "__main__":
    unittest.main()
