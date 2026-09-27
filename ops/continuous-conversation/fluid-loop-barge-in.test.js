'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.resolve(__dirname, '../../public/index.html');
const source = fs.readFileSync(htmlPath, 'utf8');

function functionBody(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);

  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

test('completed TTS returns to Listening when the microphone remains active', () => {
  const body = functionBody('playNextTts');
  const emptyQueueBranch = body.slice(0, body.indexOf('return;') + 'return;'.length);
  assert.match(
    emptyQueueBranch,
    /setState\(micStream\s*\?\s*['"]listening['"]\s*:\s*['"]standby['"]\)/,
    'empty TTS queue currently ends in STANDBY, breaking Listening → Transcribing → Thinking → Speaking → Listening',
  );
});

test('barge-in aborts in-flight api/speak generation, not only local playback', () => {
  const playBody = functionBody('playNextTts');
  const interruptBody = functionBody('interruptSpeaking');

  assert.match(playBody, /AbortController/, 'api/speak has no AbortController');
  assert.match(playBody, /signal\s*:/, 'api/speak fetch has no abort signal');
  assert.match(interruptBody, /\.abort\s*\(/, 'barge-in does not abort the active api/speak request');
});

test('barge-in invalidates the old chat stream so old speech cannot be re-enqueued', () => {
  const submitBody = functionBody('submitMessage');
  const interruptBody = functionBody('interruptSpeaking');

  const hasChatAbort = /AbortController/.test(submitBody) &&
    /signal\s*:/.test(submitBody) &&
    /\.abort\s*\(/.test(interruptBody);
  const hasRequestEpoch = /(chatGeneration|responseGeneration|requestGeneration|conversationGeneration)/.test(submitBody) &&
    /(chatGeneration|responseGeneration|requestGeneration|conversationGeneration)/.test(interruptBody);

  assert.ok(
    hasChatAbort || hasRequestEpoch,
    'the old SSE chat stream can continue calling enqueueTts() after barge-in, allowing interrupted audio to return',
  );
});

test('speaking-state VAD routes sustained user speech into interruption handling', () => {
  assert.match(
    source,
    /currentState\s*===\s*['"]speaking['"][\s\S]{0,180}rms\s*>\s*VAD_THRESHOLD\s*\*\s*2[\s\S]{0,120}interruptSpeaking\(\)/,
  );
  const interruptBody = functionBody('interruptSpeaking');
  assert.match(interruptBody, /jarvisAudio\.pause\(\)/);
  assert.match(interruptBody, /ttsQueue\s*=\s*\[\]/);
  assert.match(interruptBody, /setState\(['"]listening['"]\)/);
});
