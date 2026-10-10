'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('public/app.js', 'utf8');

test('app.js is utility-only so index.html owns the single media/network controller', () => {
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /getUserMedia\s*\(/);
  assert.doesNotMatch(source, /MediaRecorder/);
  assert.doesNotMatch(source, /addEventListener\s*\(\s*['"](?:click|submit|DOMContentLoaded)/);
});

test('conversation utilities submit ordinary speech when voice-first mode is active', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  const mode = sandbox.window.createConversationMode();
  mode.activate();
  let submitted = '';
  const result = sandbox.window.routeVoiceTranscript(mode, ' วันนี้เหนื่อยนิดหน่อย ', {
    submit(text) { submitted = text; },
    localReply() {},
  });
  assert.equal(result.action, 'submit');
  assert.equal(submitted, 'วันนี้เหนื่อยนิดหน่อย');
});

test('Thai wake phrases reactivate an inactive conversation', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox);
  for (const phrase of ['จาร์วิส สวัสดี', 'จาวิส สวัสดี']) {
    const mode = sandbox.window.createConversationMode();
    let submitted = '';
    const result = sandbox.window.routeVoiceTranscript(mode, phrase, {
      submit(text) { submitted = text; },
      localReply() {},
    });
    assert.equal(result.action, 'submit');
    assert.equal(mode.isActive(), true);
    assert.equal(submitted, 'สวัสดี');
  }
});

test('all inline web API calls remain relative to /jarvis/', () => {
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.doesNotMatch(html, /fetch\(\s*['"]\/api\//);
  assert.match(html, /fetch\(\s*['"]api\/health/);
  assert.match(html, /fetch\(\s*['"]api\/chat/);
  assert.match(html, /fetch\(\s*['"]api\/transcribe/);
  assert.match(html, /fetch\(\s*['"]api\/speak/);
});
