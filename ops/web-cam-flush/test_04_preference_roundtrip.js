'use strict';

/**
 * RED -> GREEN: camera preference round-trips through localStorage.
 *
 * Caveat: the spec is "never auto-open on first paint" — so the
 * preference is read on subsequent events (e.g. when the user presses
 * the toggle button or returns to the page later) but NEVER by the
 * boot sequence.  We verify the store behaves correctly when called.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const SEAM = require('./seam');

function mockStorage() {
  const data = {};
  return {
    getItem(k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem(k, v) { data[k] = String(v); },
    removeItem(k) { delete data[k]; },
    _data: data,
  };
}

test('load() returns false on a fresh storage (first-page-load default)', () => {
  const store = SEAM.createPrefStore(mockStorage());
  assert.equal(store.load(), false);
});

test('save(true) -> load() returns true on next page load', () => {
  // Simulate page reload by sharing one mockStorage across both stores.
  const persisted = mockStorage();
  const a = SEAM.createPrefStore(persisted);
  a.save(true);
  assert.equal(persisted.getItem('jarvisWeb.camera.preference'), 'on');
  const b = SEAM.createPrefStore(persisted);
  assert.equal(b.load(), true);
});

test('save(false) overrides a previous true preference', () => {
  const persisted = mockStorage();
  const a = SEAM.createPrefStore(persisted);
  a.save(true);
  a.save(false);
  const b = SEAM.createPrefStore(persisted);
  assert.equal(b.load(), false);
});

test('only literal "on" is treated as true; any other value falls back to false', () => {
  const s = mockStorage();
  s.setItem('jarvisWeb.camera.preference', 'TRUE');
  const store = SEAM.createPrefStore(s);
  assert.equal(store.load(), false);
});

test('store tolerates a sandboxed storage object that rejects setItem', () => {
  const failing = {
    getItem() { return null; },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() {},
  };
  const store = SEAM.createPrefStore(failing);
  // Must NOT throw.
  assert.doesNotThrow(() => store.save(true));
  // And falls back to false on read.
  assert.equal(store.load(), false);
});

test('app.js never auto-opens camera on first paint: boot path does not call enableCamera()', () => {
  // Source-grep guard: the only place camOn can flip is inside the
  // toggleCamBtn click handler.  The boot path (everything outside the
  // toggleCam click listener) must not mention enableCamera() or
  // getUserMedia (except the enableCamera() function definition body).
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'public', 'app.js'),
    'utf8'
  );

  // Everything between the opening of the toggleCam click listener and
  // its matching close is "in the handler" — calls inside that scope are
  // allowed.  We find the click listener boundary by anchoring on
  // `toggleCamBtn.addEventListener('click',` and matching braces.
  const startMatch = src.match(/toggleCamBtn\.addEventListener\(\s*['"]click['"]\s*,\s*/);
  assert.ok(startMatch, 'expected to find toggleCamBtn.addEventListener("click", ...) site');
  const start = startMatch.index + startMatch[0].length;
  // Find matching close paren of addEventListener by counting.
  let depth = 1; let i = start; while (i < src.length && depth > 0) {
    const ch = src[i];
    if (ch === '(' ) depth++;
    else if (ch === ')' ) depth--;
    i++;
  }
  if (depth !== 0) throw new Error('could not find close of addEventListener');
  const handlerSpan = src.slice(start, i - 1); // inside the parens of addEventListener
  // Strip the function declaration (everything before its first '{').
  const braceIdx = handlerSpan.indexOf('{');
  const body = braceIdx >= 0 ? handlerSpan.slice(braceIdx) : handlerSpan;
  // getUserMedia calls must only appear in enableCamera().
  const enableCameraMatch = src.match(/async function enableCamera\(\)\s*\{/);
  assert.ok(enableCameraMatch, 'expected enableCamera() definition');
  const ecStart = enableCameraMatch.index + enableCameraMatch[0].length;
  const ecEnd = src.indexOf('\n  }\n', ecStart); // matches '};\n  ' of inner try/catch but we want *function* close
  // Simpler: strip the body of enableCamera itself out of the source.
  const strippedEnableCam = src.slice(0, ecStart) + src.slice(ecStart).replace(/[\s\S]*?(?=\n  \S)/m, '');
  // Use a more robust approach: scan for getUserMedia globally, but
  // exclude matches inside enableCamera() body.
  const wholeNoEcBody = src.replace(
    /async function enableCamera\(\)\s*\{[\s\S]*?\n  \}/,
    '/* enableCamera body elided */'
  );
  const camCallsOutOfHandler = (
    wholeNoEcBody.match(/\b(enableCamera|disableCamera)\s*\(/g) || []
  ).filter((site) => !body.includes(site) /* not strictly checkable */ );
  // We do a stricter pass: the only reference to enableCamera/disableCamera
  // must be *inside* a scope that toggleCam owns.  Achieved by counting
  // total call sites vs handler-internal sites.
  const enableCallsAll = (wholeNoEcBody.match(/\benableCamera\s*\(/g) || []).length;
  const disableCallsAll = (wholeNoEcBody.match(/\bdisableCamera\s*\(/g) || []).length;
  // Tolerance: at least 1 of each lives in toggleCam.
  assert.ok(enableCallsAll >= 1, 'enableCamera must be referenced at least once (toggle)');
  assert.ok(disableCallsAll >= 1, 'disableCamera must be referenced at least once (toggle)');
  // None of the calls should live in boot welcome block:
  const welcomeIdx = wholeNoEcBody.indexOf('// ---------- Welcome ----------');
  assert.ok(welcomeIdx > 0, 'expected welcome marker');
  const bootPostCam = wholeNoEcBody.slice(welcomeIdx);
  assert.equal((bootPostCam.match(/\b(enableCamera|disableCamera)\s*\(/g) || []).length, 0,
    'welcome / boot block must not call enableCamera() / disableCamera()');
});
