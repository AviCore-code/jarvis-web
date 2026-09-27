const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const htmlPath = fs.existsSync(__dirname + '/index.html')
  ? __dirname + '/index.html'
  : __dirname + '/../public/index.html';
const html = fs.readFileSync(htmlPath, 'utf8');

test('voice-only UI removes all visible text-chat controls', () => {
  assert.doesNotMatch(html, /id="toggleChatPanel"/);
  assert.doesNotMatch(html, /class="panel chat-panel"/);
  assert.doesNotMatch(html, /id="chatForm"/);
  assert.doesNotMatch(html, /id="chatInput"/);
  assert.doesNotMatch(html, />TEXT ON</);
  assert.doesNotMatch(html, />\s*CONVERSATION\s*</);
});

test('voice-only UI retains a non-visual live region for accessibility and streaming internals', () => {
  assert.match(html, /id="chatLog"[^>]*class="sr-only"[^>]*aria-live="polite"/);
});

test('main layout is explicitly voice-only', () => {
  assert.match(html, /<main class="grid voice-only">/);
  assert.match(html, /\.grid\.voice-only\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
});
