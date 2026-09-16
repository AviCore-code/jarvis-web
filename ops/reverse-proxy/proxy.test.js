'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { routeFor } = require('./proxy');

test('routes and strips /location prefix', () => {
  assert.deepEqual(routeFor('/location/healthz'), {
    target: 'http://127.0.0.1:8787',
    path: '/healthz',
  });
  assert.deepEqual(routeFor('/location/api/location?fresh=1'), {
    target: 'http://127.0.0.1:8787',
    path: '/api/location?fresh=1',
  });
  assert.deepEqual(routeFor('/location'), {
    target: 'http://127.0.0.1:8787',
    path: '/',
  });
  assert.deepEqual(routeFor('/location?fresh=1'), {
    target: 'http://127.0.0.1:8787',
    path: '/?fresh=1',
  });
});

test('preserves existing routes without rewriting paths', () => {
  assert.deepEqual(routeFor('/line/webhook'), {
    target: 'http://127.0.0.1:8646',
    path: '/line/webhook',
  });
  assert.deepEqual(routeFor('/mission/api/system'), {
    target: 'http://127.0.0.1:3010',
    path: '/mission/api/system',
  });
  assert.deepEqual(routeFor('/'), {
    target: 'http://127.0.0.1:3001',
    path: '/',
  });
});
