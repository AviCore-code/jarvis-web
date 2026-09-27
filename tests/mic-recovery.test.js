'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Read local patched file
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// ─── Text window must be absent ───────────────────────────────────────────────
test('no visible text input or chat form in DOM', () => {
  assert.doesNotMatch(html, /id=["']chatInput["']/i, 'chatInput must not exist');
  assert.doesNotMatch(html, /id=["']chatForm["']/i, 'chatForm must not exist');
  assert.doesNotMatch(html, /id=["']chatPanel["']/i, 'chatPanel must not exist');
  assert.doesNotMatch(html, /id=["']toggleChatPanelBtn["']/i, 'toggleChatPanelBtn must not exist');
});

// ─── #enableMicBtn exists ─────────────────────────────────────────────────────
test('dedicated mic recovery button exists in HTML', () => {
  assert.match(html, /id=["']enableMicBtn["']/i,
    'expected #enableMicBtn recovery button in markup');
});

test('mic recovery button has accessible aria-label', () => {
  assert.match(html, /id=["']enableMicBtn["'][^>]*aria-label|aria-label[^>]*id=["']enableMicBtn["']/i,
    'expected aria-label on #enableMicBtn');
});

// ─── mic recovery container exists ───────────────────────────────────────────
test('mic recovery container #micRecovery exists', () => {
  assert.match(html, /id=["']micRecovery["']/i, 'expected #micRecovery container');
});

test('#micRecovery starts hidden (display:none)', () => {
  assert.match(html, /id=["']micRecovery["'][^>]*display\s*:\s*none/i,
    'expected #micRecovery to start with display:none');
});

// ─── showMicRecovery / hideMicRecovery helpers ────────────────────────────────
test('showMicRecovery function is defined', () => {
  assert.match(html, /function\s+showMicRecovery\s*\(/,
    'expected showMicRecovery() function');
});

test('hideMicRecovery function is defined', () => {
  assert.match(html, /function\s+hideMicRecovery\s*\(/,
    'expected hideMicRecovery() function');
});

// ─── enableMicBtn click calls initMic ────────────────────────────────────────
test('enableMicBtn click handler calls initMic()', () => {
  assert.match(html,
    /enableMicBtn[\s\S]{0,200}addEventListener\s*\(\s*['"]click['"][\s\S]{0,300}initMic\s*\(/i,
    'expected enableMicBtn click to call initMic()');
});

// ─── NotAllowedError → no retry button (must open settings) ──────────────────
test('NotAllowedError branch calls showMicRecovery with canRetry=false', () => {
  assert.match(html,
    /NotAllowedError[\s\S]{0,600}showMicRecovery\s*\([^)]*,\s*false\s*\)/i,
    'expected NotAllowedError to call showMicRecovery(..., false)');
});

// ─── recoverable errors → retry button shown ─────────────────────────────────
test('NotFoundError branch calls showMicRecovery with canRetry=true', () => {
  assert.match(html,
    /NotFoundError[\s\S]{0,400}showMicRecovery\s*\([^)]*,\s*true\s*\)/i,
    'expected NotFoundError to call showMicRecovery(..., true)');
});

test('NotReadableError branch calls showMicRecovery with canRetry=true', () => {
  assert.match(html,
    /NotReadableError[\s\S]{0,400}showMicRecovery\s*\([^)]*,\s*true\s*\)/i,
    'expected NotReadableError to call showMicRecovery(..., true)');
});

// ─── success → hideMicRecovery called ────────────────────────────────────────
test('successful getUserMedia calls hideMicRecovery()', () => {
  assert.match(html,
    /setMicIndicator\s*\(\s*true\s*\)[\s\S]{0,100}hideMicRecovery\s*\(\s*\)/i,
    'expected hideMicRecovery() called after successful stream acquisition');
});
