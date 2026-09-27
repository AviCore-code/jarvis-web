const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const checks = [
  ['local-only name key', /KNOWN_NAME_KEY\s*=\s*['"]jarvis\.knownName['"]/],
  ['known name getter', /function getKnownName\s*\(/],
  ['known name saver', /function rememberKnownName\s*\(/],
  ['name learned from user text', /rememberNameFromText\s*\(text\)/],
  ['default greeting', /สวัสดีครับ วันนี้มีอะไรให้รับใช้ครับ/],
  ['named greeting', /สวัสดีครับคุณ/],
  ['startup once guard', /startupGreetingStarted/],
  ['deferred greeting state', /startupGreetingPending/],
  ['autoplay rejection handling', /NotAllowedError/],
  ['gesture retry', /retryStartupGreeting/],
  ['mic initialization guard', /micInitPending/],
  ['boot does not request mic', /function boot\s*\(\)[\s\S]{0,260}(?!initMic\s*\()/],
];
let failed = 0;
for (const [name, re] of checks) {
  const ok = re.test(html);
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (!ok) failed++;
}
console.log('RESULT ' + (checks.length - failed) + '/' + checks.length + ' passed');
process.exit(failed ? 1 : 0);
