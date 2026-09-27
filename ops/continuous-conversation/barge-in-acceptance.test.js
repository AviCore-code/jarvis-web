'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const htmlPath = path.join(__dirname, '..', '..', 'public', 'index.html');
const source = fs.readFileSync(htmlPath, 'utf8');

function functionBody(name, nextMarker) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const end = nextMarker ? source.indexOf(nextMarker, start) : -1;
  assert.notEqual(end, -1, `marker after ${name} must exist`);
  return source.slice(start, end);
}

test('barge-in pauses current audio immediately and invalidates queued TTS', () => {
  const body = functionBody('interruptSpeaking', '// ─── Sentence detection');
  const pauseAt = body.indexOf('jarvisAudio.pause()');
  const clearQueueAt = body.indexOf('ttsQueue = []');
  const invalidateAt = body.indexOf('ttsGeneration++');

  assert.notEqual(pauseAt, -1, 'active audio must be paused');
  assert.notEqual(clearQueueAt, -1, 'pending audio must be discarded');
  assert.notEqual(invalidateAt, -1, 'late TTS responses must be invalidated');
  assert.ok(pauseAt < clearQueueAt, 'audible playback must stop before queue cleanup');
});

test('barge-in invalidates the old chat stream, not only its audio', () => {
  const submitBody = functionBody('submitMessage', '// ─── Voice / VAD');
  const interruptBody = functionBody('interruptSpeaking', '// ─── Sentence detection');

  assert.match(submitBody, /AbortController|chatGeneration|turnGeneration|turnId/,
    'chat stream needs a per-turn invalidation mechanism');
  assert.match(interruptBody, /abort\(|chatGeneration\+\+|turnGeneration\+\+|invalidate.*turn/i,
    'barge-in must invalidate/abort the old response stream');
});

test('speech detected during Speaking both interrupts and starts the new turn', () => {
  const vadStart = source.indexOf('// VAD logic');
  const vadEnd = source.indexOf('function teardownMic', vadStart);
  assert.notEqual(vadStart, -1);
  assert.notEqual(vadEnd, -1);
  const vadBody = source.slice(vadStart, vadEnd);

  assert.match(vadBody, /currentState === ['"]speaking['"][\s\S]*interruptSpeaking\(\)/,
    'speaking-state voice must interrupt playback');
  assert.match(vadBody, /interruptSpeaking\(\)[\s\S]*(startRecording\(stream\)|scheduleBargeInRecording|beginBargeIn)/,
    'the same detection must proceed into recording the new turn');
});

test('completed or failed speaking returns automatically to listening when mic is live', () => {
  const playBody = functionBody('playNextTts', "jarvisAudio.addEventListener('ended'");
  const endedStart = source.indexOf("jarvisAudio.addEventListener('ended'");
  const endedEnd = source.indexOf("jarvisAudio.addEventListener('error'", endedStart);
  const endedBody = source.slice(endedStart, endedEnd);

  assert.match(playBody, /setState\(micStream\s*\?\s*['"]listening['"]\s*:\s*['"]standby['"]\)/,
    'empty TTS queue must resume listening when microphone is available');
  assert.match(endedBody, /playNextTts\(\)/,
    'normal audio completion must drain the queue and reach listening');
});

test('late old-turn chunks cannot enqueue or replay audio after barge-in', () => {
  const submitBody = functionBody('submitMessage', '// ─── Voice / VAD');

  assert.match(submitBody, /(chatGeneration|turnGeneration|turnId)/,
    'stream processing must identify its owning turn');
  assert.match(submitBody, /(generation|turnId)[\s\S]*(return|cancel|ignore)/i,
    'every late stream chunk must be rejected after turn invalidation');
});
