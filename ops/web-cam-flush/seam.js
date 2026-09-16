'use strict';

/**
 * Camera auto-release seam for jarvis-web/public/app.js.
 *
 * This module is a *behavioral spec* — its implementation IS the contract
 * the tests assert, AND app.js must inline the equivalent logic so the
 * browser-bundled app behaves identically without depending on this module.
 *
 * Visiting this file is fine in tests; it MUST NOT be bundled by app.js
 * (app.js lives in the browser, no module loader).
 *
 * Three exports:
 *   - createPrefStore(localStorage)         -> {load, save}
 *       Persists "did the user explicitly enable the camera in this
 *       browser session across reloads?". Default false on a fresh page.
 *       Never auto-restores on FIRST paint: caller decides when to call
 *       load() (e.g. on a subsequent user gesture, never on boot).
 *
 *   - buildVisionController(deps)           -> {onVisionSettled, isAutoReleasing,
 *                                                markAutoReleasing, clearAutoReleasing}
 *       When a vision snapshot settles (reply OR error), auto-release
 *       the camera: stop tracks, null srcObject, CAM OFF chip,
 *       placeholder visible, active class removed. While releasing,
 *       dataset.autoReleasing = "true" so the mirror-guard on the CAM
 *       toggle button queues a user click instead of racing.
 *
 *   - createCamClickQueue(deps)             -> {handleClick, flushPending}
 *       Wraps the existing toggle behavior with a deferred-intent queue
 *       that respects dataset.autoReleasing.
 */

// ---------- Preference store ---------------------------------------------

function createPrefStore(localStorage) {
  // localStorage may be undefined in tests; provide a no-op fallback so we
  // never throw on first paint.
  const store = localStorage || {
    _data: {},
    getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
    setItem(k, v) { this._data[k] = String(v); },
    removeItem(k) { delete this._data[k]; },
  };
  const KEY = 'jarvisWeb.camera.preference'; // values: 'on' | 'off'
  return {
    load() {
      const v = store.getItem(KEY);
      return v === 'on'; // explicit; missing/anything else = false
    },
    save(wantsOn) {
      try { store.setItem(KEY, wantsOn ? 'on' : 'off'); }
      catch (_) { /* quota / disabled — silently ignore */ }
    },
    _peek() { return store.getItem(KEY); },
  };
}

// ---------- Auto-release vision controller --------------------------------
//
// Deps:
//   getToggleBtn()       -> HTMLElement-or-shim with a .dataset map
//   isCamOn()            -> bool
//   disableCamera(reason)-> () => void, idempotent
//   savePref(false,reason)-> () => void (we always set false on auto-release)
//
// All side effects go through deps; the factory itself does no DOM I/O
// outside setting/clearing the mirror-guard flag on the toggle button.

function buildVisionController(deps) {
  const { getToggleBtn, isCamOn, disableCamera, savePref } = deps;

  function markAutoReleasing(reason) {
    if (typeof reason === 'string' && reason) {
      try { getToggleBtn().dataset.autoReleasing = reason; }
      catch (_) { /* dataset not writable in some shims — ignore */ }
    } else {
      try { getToggleBtn().dataset.autoReleasing = 'true'; }
      catch (_) { /* ignore */ }
    }
  }
  function clearAutoReleasing() {
    try { delete getToggleBtn().dataset.autoReleasing; }
    catch (_) { /* ignore */ }
  }
  let inFlight = false;

  function onVisionSettled(reason) {
    if (!isCamOn()) return { skipped: 'cam-already-off', reason };
    if (inFlight) return { skipped: 'already-releasing', reason };
    inFlight = true;
    markAutoReleasing(reason);
    let disableErr = null;
    try {
      disableCamera(reason);
      try { savePref(false, reason); } catch (_) { /* pref persistence is best-effort */ }
    } catch (err) {
      disableErr = err;
    } finally {
      // Synchronous callers (e.g. a queued click handler firing on the
      // same tick) must see the flag set.  We clear it via a microtask
      // so any deferred intent queued by the mirror guard can drain
      // safely after the auto-release finishes.
      if (typeof queueMicrotask === 'function') {
        queueMicrotask(() => {
          clearAutoReleasing();
          inFlight = false;
        });
      } else {
        Promise.resolve().then(() => {
          clearAutoReleasing();
          inFlight = false;
        });
      }
    }
    return { released: true, reason, error: disableErr ? String(disableErr) : null };
  }

  function isAutoReleasing() {
    try {
      return getToggleBtn().dataset.autoReleasing === 'true' ||
        typeof getToggleBtn().dataset.autoReleasing === 'string';
    } catch (_) { return inFlight; }
  }

  return {
    onVisionSettled,
    isAutoReleasing,
    markAutoReleasing,
    clearAutoReleasing,
    _inFlight: () => inFlight,
  };
}

// ---------- Mirror-guard click queue --------------------------------------
//
// Deps:
//   getToggleBtn()        -> button shim with .dataset
//   readCamOn()           -> () => bool
//   baseToggle()          -> the original camOn ? disableCamera() : enableCamera()
//                           (we only queue; the caller decides what to do)
//
// Behavior:
//   - If dataset.autoReleasing is truthy at click time: remember the
//     user's *intent* ("on" if cam is currently off, "off" if cam is
//     currently on) and do NOT call baseToggle. Flush after the guard
//     clears via flushPending(), which the controller -> mirror-guard
//     callback invokes.
//   - Otherwise: call baseToggle and then drain the queue.

function createCamClickQueue(deps) {
  const { getToggleBtn, readCamOn, baseToggle, applyIntent } = deps;
  let pending = null; // 'on' | 'off' | null

  function intentForCurrent() {
    return readCamOn() ? 'off' : 'on';
  }

  function handleClick() {
    let flag;
    try { flag = getToggleBtn().dataset.autoReleasing; } catch (_) { flag = undefined; }
    if (flag) {
      pending = intentForCurrent();
      return { queued: pending };
    }
    baseToggle();
    return flushPending();
  }

  function flushPending() {
    if (!pending) return { flushed: null };
    const intent = pending;
    pending = null;
    if (typeof applyIntent === 'function') applyIntent(intent);
    return { flushed: intent };
  }

  function peekPending() { return pending; }

  return { handleClick, flushPending, peekPending };
}

module.exports = {
  createPrefStore,
  buildVisionController,
  createCamClickQueue,
};
