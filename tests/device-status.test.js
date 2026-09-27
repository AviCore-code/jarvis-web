const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const checks = [
  ['mic status element', /id=["']micStatus["']/],
  ['speaker status element', /id=["']speakerStatus["']/],
  ['mic updater', /function setMicIndicator\s*\(/],
  ['speaker updater', /function setSpeakerIndicator\s*\(/],
  ['mic stream success ON', /setMicIndicator\s*\(true\)/],
  ['mic failure OFF', /setMicIndicator\s*\(false/],
  ['mic track ended handling', /addEventListener\s*\(\s*["']ended["'][\s\S]{0,240}setMicIndicator\s*\(false/],
  ['speaker playing ON', /addEventListener\s*\(\s*["']playing["'][\s\S]{0,240}setSpeakerIndicator\s*\(true/],
  ['speaker pause OFF', /addEventListener\s*\(\s*["']pause["'][\s\S]{0,240}setSpeakerIndicator\s*\(false/],
  ['speaker ended OFF', /addEventListener\s*\(\s*["']ended["'][\s\S]{0,240}setSpeakerIndicator\s*\(false/],
  ['speaker error OFF', /addEventListener\s*\(\s*["']error["'][\s\S]{0,240}setSpeakerIndicator\s*\(false/]
];
let failed = 0;
for (const [name, re] of checks) {
  const ok = re.test(html);
  console.log((ok ? 'PASS ' : 'FAIL ') + name);
  if (!ok) failed++;
}
console.log('RESULT ' + (checks.length - failed) + '/' + checks.length + ' passed');
process.exit(failed ? 1 : 0);
