import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// #751, PR #1121 round 1: commented-out boot logging is not runtime evidence.
// index.js starts the app on import, so check its active source tokens instead.
function activeSource(source) {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
}

function bootLines(source) {
  return activeSource(source).split(/\r?\n/).filter((line) => line.includes('[boot]'));
}

test('boot scan ignores line and block comments', () => {
  const commented = `// logger.info(\`[boot] Node \${process.version} (\${process.arch})\`);\n/* logger.info(\`[boot] Node \${process.version} (\${process.arch})\`); */`;
  assert.deepEqual(bootLines(commented), []);
});

test('boot logs Node version and architecture once before media startup', () => {
  const source = activeSource(fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8'));
  const lines = source.split(/\r?\n/).filter((line) => line.includes('[boot]'));
  assert.equal(lines.length, 1);
  for (const [token, pattern] of [
    ['logger.info', /\blogger\s*\.\s*info\s*\(/],
    ['process.version', /\bprocess\s*\.\s*version\b/],
    ['process.arch', /\bprocess\s*\.\s*arch\b/],
  ]) {
    assert.match(lines[0], pattern, `boot line needs ${token}`);
  }
  const mediaStart = /\bstartMediaMTX\s*\(/.exec(source);
  assert.ok(mediaStart, 'media startup call must exist');
  assert.ok(source.indexOf(lines[0]) < mediaStart.index);
});
