/**
 * Tiny path-based reverse proxy so a single ngrok static domain
 * (free-plan limit: 1 reserved domain) can serve BOTH:
 *   - LINE webhook           -> /line/*      -> 127.0.0.1:8646 (Hermes gateway)
 *   - Jarvis Mission Control -> /mission/*   -> 127.0.0.1:3010
 *   - Jarvis Location API    -> /location/*  -> 127.0.0.1:8787 (prefix stripped)
 *   - Jarvis Web app         -> everything else -> 127.0.0.1:3001 (jarvis-web)
 */
'use strict';
const http = require('http');
const httpProxy = require('http-proxy');

const PORT = process.env.PROXY_PORT || 8000;
const LINE_TARGET = 'http://127.0.0.1:8646';
const MISSION_TARGET = 'http://127.0.0.1:3010';
const JARVIS_WEB_TARGET = 'http://127.0.0.1:3001';
const WIKI_UPLOAD_TARGET = 'http://127.0.0.1:8721';
const AVICORE_KNOWLEDGE_TARGET = 'http://127.0.0.1:8731';
const LOCATION_TARGET = 'http://127.0.0.1:8787';

const proxy = httpProxy.createProxyServer({ ws: true });

proxy.on('error', (err, req, res) => {
  console.error('[proxy] error:', err.message);
  if (res && res.writeHead && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway');
  }
});

function routeFor(url) {
  if (url === '/location' || url.startsWith('/location?')) {
    const suffix = url.slice('/location'.length);
    return { target: LOCATION_TARGET, path: suffix ? `/${suffix}` : '/' };
  }
  if (url.startsWith('/location/')) {
    return { target: LOCATION_TARGET, path: url.slice('/location'.length) };
  }
  if (url.startsWith('/line/')) return { target: LINE_TARGET, path: url };
  if (url === '/mission' || url.startsWith('/mission/')) return { target: MISSION_TARGET, path: url };
  if (url === '/wiki-upload' || url.startsWith('/wiki-upload/')) return { target: WIKI_UPLOAD_TARGET, path: url };
  if (url === '/avicore-knowledge' || url.startsWith('/avicore-knowledge/')) {
    return { target: AVICORE_KNOWLEDGE_TARGET, path: url };
  }
  return { target: JARVIS_WEB_TARGET, path: url };
}

function forward(req, res) {
  const route = routeFor(req.url);
  req.url = route.path;
  proxy.web(req, res, { target: route.target });
}

const server = http.createServer((req, res) => {
  if (req.url === '/_proxy_health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'jarvis-reverse-proxy' }));
    return;
  }
  forward(req, res);
});

// WebSocket upgrade support (not currently used, but future-proof)
server.on('upgrade', (req, socket, head) => {
  const route = routeFor(req.url);
  req.url = route.path;
  proxy.ws(req, socket, head, { target: route.target });
});

function start() {
  return server.listen(PORT, '127.0.0.1', () => {
    console.log(`[proxy] listening on http://127.0.0.1:${PORT}`);
    console.log(`[proxy] /line/*     -> ${LINE_TARGET}`);
    console.log(`[proxy] /mission/*  -> ${MISSION_TARGET}`);
    console.log(`[proxy] /location/* -> ${LOCATION_TARGET} (prefix stripped)`);
    console.log(`[proxy] /avicore-knowledge/* -> ${AVICORE_KNOWLEDGE_TARGET}`);
    console.log(`[proxy] /*          -> ${JARVIS_WEB_TARGET}`);
  });
}

if (require.main === module) start();

module.exports = { routeFor, start };
