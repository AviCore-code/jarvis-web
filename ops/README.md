# Jarvis VPS Operations

Version: `1.0.1`

This directory contains deployable, secret-free source for services running on the Hostinger VPS.

## Location tracker

- `location-tracker/server.py` — bearer-authenticated location ingest/read API bound to `127.0.0.1:8787`.
  - Endpoints: `POST /api/location` (auth), `GET /api/location` (auth), `GET /healthz` (public).
  - `HOST` is hard-coded; it cannot be overridden by environment variables.
  - `Content-Type` is `application/json` for every response, and the `Server` header does not leak `BaseHTTP` / `Python` versions.
- `location-tracker/run.sh` — starts the API on `127.0.0.1:8787` only.
- `location-tracker/location-api-watchdog.sh` — restarts the API and checks the public route; the local health probe now requires the response to contain `service: jarvis-location-api` so an unrelated 200 on the port cannot satisfy the watchdog.
- Runtime token is stored separately at `/opt/data/projects/location-tracker/.api-token.txt` with mode `0600`; it must never be committed.
- Runtime location cache is stored separately at `/opt/data/home/.hermes/state/location-cache.json` with mode `0600`; it must never be committed.
- Token startup check rejects empty or shorter-than-32-byte tokens with `RuntimeError`; the test suite uses a 41-byte fake token.

### Privacy statement

- The location API stores ONLY `{lat, lon, accuracy, source, timestamp}` per request; no device id, IMEI, name, Telegram user, or other identifiers are ever recorded.
- The location API binds exclusively to `127.0.0.1`; it is reachable from the public Internet only through the shared ngrok reverse proxy on `https://itunes-unboxed-upstroke.ngrok-free.dev/location/*`.
- **The location API does NOT call any third-party weather service.** In particular, it never sends the user's GPS coordinates to `api.open-meteo.com` or any other host. Weather lookups (when explicitly requested by the user) must be performed separately at city level and may not use the precise coordinates stored in this cache.
- Cache persistence failures do not silently report success; the API returns a sanitised `503 {"error":"location unavailable"}` instead of `200 ok`.

## Shared reverse proxy

- `reverse-proxy/proxy.js` — path router on `127.0.0.1:8000`.
- `reverse-proxy/proxy.test.js` — route-regression tests (including the `/location?fresh=1` query-string path).
- Existing `/line/*`, `/mission/*`, `/wiki-upload/*`, `/avicore-knowledge/*`, and default Jarvis Web routes are preserved.

## Tests

```bash
npm ci
npm test
```

Expected: 19 tests pass (2 Node route tests + 17 Python API/security tests, including the watchdog test).

## Deployment

Deployment is intentionally performed by copying reviewed files to the rootless runtime directories, then restarting only the affected process. Secrets, Cloudflare certificates, browser profiles, ngrok credentials, cache files, and real location data are excluded from Git. `node_modules/` and `__pycache__/` directories are excluded via `.gitignore`.
