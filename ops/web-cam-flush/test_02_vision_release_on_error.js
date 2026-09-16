'use strict';

/**
 * RED -> GREEN: vision ERROR branch (catch / data.error) must auto-release.
 *
 * The patch must call disableCamera() and reset the toggle dataset
 * flag in BOTH the inner error branch (the `else` when data.reply is
 * missing) AND the outer try/catch (network failure).  The current
 * file ships neither.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_PATH = path.resolve(__dirname, '..', '..', 'public', 'app.js');
const SEAM = require('./seam');

function readApp() { return fs.readFileSync(APP_PATH, 'utf8'); }

function fakeBtn() {
  const ds = {};
  return {
    dataset: ds,
    classList: {
      _set: new Set(['active']),
      add(c)    { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c){ return this._set.has(c); },
    },
  };
}

test('app.js vision ERROR else-branch now releases the camera', () => {
  const src = readApp();
  const m = src.match(/else \{\s*addMessage\('system', 'เกิดข้อผิดพลาด:[\s\S]*?\}\s*else\s*catch/);
  if (!m) {
    // fallback: less strict; still match the else branch body
    const m2 = src.match(/else \{\s*addMessage\('system', 'เกิดข้อผิดพลาด:[\s\S]*?\n\s*\}/);
    assert.ok(m2, 'expected the inner error else-branch to be present');
    assert.ok(/\b(camAutoRelease|disableCamera)\s*\(/.test(m2[0]),
      'inner error branch must trigger camera release (camAutoRelease() or disableCamera())');
    return;
  }
  assert.ok(/\b(camAutoRelease|disableCamera)\s*\(/.test(m[0]),
    'inner error branch must trigger camera release');
});

test('app.js outer catch block now releases the camera', () => {
  const src = readApp();
  const m = src.match(/catch \(err\) \{\s*addMessage\('system', 'เชื่อมต่อไม่สำเร็จ:[\s\S]*?\n\s*\}/);
  assert.ok(m, 'expected the outer catch block to be present');
  assert.ok(/\b(camAutoRelease|disableCamera)\s*\(/.test(m[0]),
    'outer catch must trigger camera release');
});

test('seam onVisionSettled("error") calls disableCamera() and is idempotent', () => {
  let calls = 0;
  const btn = fakeBtn();
  const ctl = SEAM.buildVisionController({
    getToggleBtn: () => btn,
    isCamOn: () => true,
    disableCamera: () => { calls++; },
    savePref: () => {},
  });
  const r1 = ctl.onVisionSettled('error');
  const r2 = ctl.onVisionSettled('error'); // second call during same in-flight
  assert.equal(r1.released, true);
  assert.equal(r2.skipped, 'already-releasing');
  assert.equal(calls, 1);
});

test('seam clears mirror-guard flag asynchronously after release', async () => {
  const btn = fakeBtn();
  const ctl = SEAM.buildVisionController({
    getToggleBtn: () => btn,
    isCamOn: () => true,
    disableCamera: () => {},
    savePref: () => {},
  });
  ctl.onVisionSettled('error');
  assert.ok(typeof btn.dataset.autoReleasing === 'string' && btn.dataset.autoReleasing.length,
    'flag set synchronously');
  // Flush microtask queue
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(btn.dataset.autoReleasing, undefined,
    'flag cleared after microtask');
  assert.equal(ctl._inFlight(), false);
});
