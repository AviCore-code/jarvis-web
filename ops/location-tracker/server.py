#!/usr/bin/env python3
"""
Location ingest API for Jarvis.

Endpoints (plain HTTP, intended to be reverse-proxied through a tunnel):
  POST /api/location       {lat, lon, accuracy?, source?}  → bearer auth
  GET  /api/location       → bearer auth → returns latest cached point + as_of
  GET  /healthz            → public, no auth

Auth: Authorization: Bearer <LOCATION_API_TOKEN>, timing-safe compare.

Privacy:
  - stores ONLY {lat, lon, accuracy, source, timestamp} per request
  - no device id, no IMEI, no name, no Telegram user, nothing else
  - cache is overwritten on each new POST (no historical log)
  - rotation: change token, delete file, restart service

Run:
  cd /opt/data/projects/location-tracker
  TOKEN="$(grep LOCATION_API_TOKEN .api-token.txt | cut -d= -f2)"
  PORT=8787 python3 server.py
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json, os, time, sys, hmac
import threading

HOST = "127.0.0.1"
PORT = int(os.environ.get("PORT", "8787"))
TOKEN_PATH = os.environ.get("LOCATION_API_TOKEN_PATH",
                            "/opt/data/projects/location-tracker/.api-token.txt")
CACHE_PATH = os.environ.get("LOCATION_CACHE_PATH",
                            "/opt/data/home/.hermes/state/location-cache.json")

# in-process cache that survives requests and is persisted for crash recovery
_lock = threading.Lock()
_state = {"point": None, "updated_at": 0}


def load_token() -> bytes:
    with open(TOKEN_PATH, "rb") as f:
        for line in f:
            if line.startswith(b"LOCATION_API_TOKEN="):
                token = line.strip().split(b"=", 1)[1]
                if len(token) < 32:
                    raise RuntimeError("LOCATION_API_TOKEN must be at least 32 bytes")
                return token
    raise RuntimeError("LOCATION_API_TOKEN missing in " + TOKEN_PATH)


TOKEN = load_token()


def timing_safe_eq(a: bytes, b: bytes) -> bool:
    return hmac.compare_digest(a, b)


def check_bearer(header_value: str | None) -> bool:
    if not header_value or not header_value.lower().startswith("bearer "):
        return False
    return timing_safe_eq(header_value[7:].strip().encode(), TOKEN)


def load_cache_from_disk() -> None:
    try:
        with open(CACHE_PATH, "r") as f:
            data = json.load(f)
        with _lock:
            _state["point"] = data.get("point")
            _state["updated_at"] = data.get("updated_at", 0)
    except FileNotFoundError:
        pass
    except Exception as e:
        print(f"[cache] load error: {e}", file=sys.stderr)


def persist_cache() -> None:
    with _lock:
        snapshot = {"point": _state["point"],
                    "updated_at": _state["updated_at"]}
    tmp = CACHE_PATH + ".tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC
    fd = os.open(tmp, flags, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(snapshot, f)
    os.replace(tmp, CACHE_PATH)
    os.chmod(CACHE_PATH, 0o600)


class Handler(BaseHTTPRequestHandler):
    def version_string(self):
        return "location-api"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.address_string(), fmt % args))

    def send_error(self, code, message=None, explain=None):
        if code == 501:
            body = json.dumps({"error": "method not allowed"}).encode("utf-8")
            self.send_response(405)
            self.send_header("Allow", "GET, POST")
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        super().send_error(code, message, explain)

    def do_GET(self):
        if self.path == "/healthz":
            return self._json(200, {
                "status": "ok",
                "service": "jarvis-location-api",
                "ts": int(time.time()),
            })
        if not check_bearer(self.headers.get("Authorization")):
            return self._json(401, {"error": "Unauthorized"})

        with _lock:
            point = _state["point"]
            updated_at = _state["updated_at"]

        if self.path == "/api/location":
            return self._json(200, {"point": point, "as_of": updated_at})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        if not check_bearer(self.headers.get("Authorization")):
            return self._json(401, {"error": "Unauthorized"})
        if self.path != "/api/location":
            return self._json(404, {"error": "not found"})

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length)
            body = json.loads(raw.decode("utf-8"))
        except Exception:
            return self._json(400, {"error": "bad json"})

        try:
            lat = float(body["lat"])
            lon = float(body["lon"])
        except (KeyError, ValueError, TypeError):
            return self._json(400, {"error": "lat and lon (numeric) required"})

        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return self._json(400, {"error": "lat/lon out of range"})

        accuracy = body.get("accuracy")
        source = str(body.get("source", "tasker"))[:32]

        with _lock:
            _state["point"] = {"lat": lat, "lon": lon,
                               "accuracy": accuracy, "source": source}
            _state["updated_at"] = int(time.time())
        try:
            persist_cache()
        except Exception as e:
            print(f"[cache] persist failed: {e}", file=sys.stderr)
            return self._json(503, {"error": "location unavailable"})

        return self._json(200, {
            "ok": True,
            "received": {"lat": lat, "lon": lon, "source": source},
        })

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)


def main():
    load_cache_from_disk()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"location-tracker listening on http://{HOST}:{PORT}", file=sys.stderr)
    print(f"cache: {CACHE_PATH}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.server_close()


if __name__ == "__main__":
    main()
