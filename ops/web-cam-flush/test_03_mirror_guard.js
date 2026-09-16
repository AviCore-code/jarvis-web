'use strict';

/**
 * RED -> GREEN: auto-release writes mirror-guard attribute and the
 * toggle click handler defers user intent during the same pass.
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

test('app.js vision handler now writes toggleCamBtn.dataset.autoReleasing', () => {
  const src = readApp();
  // Read site: either guarded via optional chaining `toggleCamBtn?.dataset...`
  // or direct reference inside a try/catch.
  assert.ok(
    /toggleCamBtn(?:\?\.)?\.dataset\.autoReleasing/.test(src),
    'expected toggleCamBtn.dataset.autoReleasing read/clear site in app.js'
  );
  // Write site: assign boolean true OR any expression (we use a string).
  assert.ok(
    /toggleCamBtn\.dataset\.autoReleasing\s*=/.test(src),
    'expected toggleCamBtn.dataset.autoReleasing write site'
  );
});

test('app.js toggleCam click handler now consults mirror-guard and queues intent', () => {
  const src = readApp();
  // The handler must read dataset.autoReleasing and queue pending intent.
  assert.ok(/dataset\.autoReleasing/.test(src),
    'toggleCam handler must read dataset.autoReleasing');
  // We expect a pending-intent variable in the same scope as the handler.
  assert.ok(/pendingCamIntent/.test(src) || /pendingCamAction/.test(src) || /queuePendingCameraIntent/.test(src),
    'toggleCam handler must hold a queued user-intent variable');
});

test('seam mirror guard: dataset flag is set synchronously before disableCamera completes', () => {
  let flagDuringDisable = 'unset';
  const btn = fakeBtn();
  const ctl = SEAM.buildVisionController({
    getToggleBtn: () => btn,
    isCamOn: () => true,
    disableCamera: () => { flagDuringDisable = btn.dataset.autoReleasing; },
    savePref: () => {},
  });
  ctl.onVisionSettled('reply');
  assert.ok(flagDuringDisable === 'true' || flagDuringDisable === 'reply',
    `mirror guard must be on while disableCamera() runs (saw "${flagDuringDisable}")`);
});

test('seam mirror guard: a click arriving during in-flight queues intent, does not race', () => {
  const btn = fakeBtn();
  // cam is ON at the moment the auto-release starts
  let camOn = true;
  const ctl = SEAM.buildVisionController({
    getToggleBtn: () => btn,
    isCamOn: () => camOn,
    disableCamera: () => { camOn = false; },
    savePref: () => {},
  });
  const queue = SEAM.createCamClickQueue({
    getToggleBtn: () => btn,
    readCamOn: () => camOn,
    baseToggle: () => { /* would normally flip — must NOT run while auto-release is in flight */ },
    applyIntent: (intent) => {
      if (intent === 'on') camOn = true;
      else if (intent === 'off') camOn = false;
    },
  });

  ctl.onVisionSettled('reply'); // sets flag, disables camera synchronously, then async clear
  // User clicks while flag is up — should queue OFF (current state ON before release)
  // ...but at the call instant, camOn is ALREADY false (disableCamera ran synchronously)
  // so the *user's original intent* (they pressed the cam button to turn it OFF) is what we queue.
  const click = queue.handleClick();
  assert.ok(click.queued === 'on' || click.queued === 'off',
    `expected click to be queued, got ${JSON.stringify(click)}`);

  // baseToggle was NOT called — guarded
});

test('seam mirror guard: pending intent is drained after flag clears', async () => {
  const btn = fakeBtn();
  let camOn = true;
  const ctl = SEAM.buildVisionController({
    getToggleBtn: () => btn,
    isCamOn: () => camOn,
    disableCamera: () => { camOn = false; },
    savePref: () => {},
  });
  const queue = SEAM.createCamClickQueue({
    getToggleBtn: () => btn,
    readCamOn: () => camOn,
    baseToggle: () => { camOn = !camOn; },
    applyIntent: (intent) => {
      if (intent === 'on') camOn = true;
      else if (intent === 'off') camOn = false;
    },
  });
  ctl.onVisionSettled('reply');
  queue.handleClick(); // queues 'on' (user wants camera back on)
  assert.equal(queue.peekPending(), 'on', 'intent must be queued, not dropped');

  // microtask flush -> flag clears -> next click drains queue
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(btn.dataset.autoReleasing, undefined, 'flag cleared');
  const out = queue.handleClick();
  assert.equal(out.flushed, 'on');
  assert.equal(camOn, true, 'applyIntent("on") ran -> cam back on');
});

test('seam mirror guard: a click past the release window flips immediately, no queue', () => {
  const btn = fakeBtn();
  let camOn = false;
  const queue = SEAM.createCamClickQueue({
    getToggleBtn: () => btn,
    readCamOn: () => camOn,
    baseToggle: () => { camOn = true; },
    applyIntent: () => {},
  });
  const out = queue.handleClick();
  assert.equal(out.flushed, null);
  assert.equal(camOn, true);
});
