'use strict';

/**
 * RED -> GREEN: vision REPLY branch must auto-release the camera.
 *
 * Before the patch, /opt/data/projects/jarvis-web/public/app.js's
 * askVisionBtn handler at the `if (data.reply)` branch only adds a
 * message, sets pendingListenAfterVision, and (possibly) speaks.  It
 * never releases the camera, never touches toggleCamBtn.dataset, and
 * never saves the camera preference.
 *
 * The seam (./seam.js) is exercised for the *behavioral contract*.
 * The app.js file is grep-checked for the *wiring* — we accept either a
 * direct disableCamera() call or a wrapper that triggers release
 * (camAutoRelease) since the helper is the actual production wiring.
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
      _set: new Set(),
      add(c)    { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c){ return this._set.has(c); },
    },
  };
}

test('app.js vision REPLY branch now releases the camera and sets up mirror guard', () => {
  const src = readApp();
  const replyBranch = src.match(/if \(data\.reply\) \{[\s\S]*?\n\s*\}\s*else/);
  assert.ok(replyBranch, 'expected to find the if (data.reply) branch in app.js');
  const body = replyBranch[0];
  // RED before patch (assert fails — these tokens do not exist in body):
  assert.ok(/\b(disableCamera|camAutoRelease)\s*\(/.test(body),
    'reply branch must call a camera-release trigger (disableCamera() or camAutoRelease())');
  assert.ok(/\.dataset\.autoReleasing/.test(src),
    'toggleCamBtn.dataset.autoReleasing must be referenced somewhere in app.js');
});

test('seam onVisionSettled("reply") calls disableCamera() exactly once and saves pref=false', () => {
  let calls = 0;
  let saved = [];
  const btn = fakeBtn();
  const ctl = SEAM.buildVisionController({
    getToggleBtn: () => btn,
    isCamOn: () => true,
    disableCamera: () => { calls++; },
    savePref: (v, r) => { saved.push([v, r]); },
  });
  const result = ctl.onVisionSettled('reply');
  assert.equal(result.released, true);
  assert.equal(result.reason, 'reply');
  assert.equal(calls, 1);
  assert.deepEqual(saved, [[false, 'reply']]);
  assert.ok(
    btn.dataset.autoReleasing === 'true' || btn.dataset.autoReleasing === 'reply',
    'mirror-guard flag must be set during release'
  );
});

test('seam onVisionSettled is a no-op when camera was already off', () => {
  let calls = 0;
  const btn = fakeBtn();
  const ctl = SEAM.buildVisionController({
    getToggleBtn: () => btn,
    isCamOn: () => false,
    disableCamera: () => { calls++; },
    savePref: () => {},
  });
  const r = ctl.onVisionSettled('reply');
  assert.equal(r.skipped, 'cam-already-off');
  assert.equal(calls, 0);
});

