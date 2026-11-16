import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// index.js starts the app on import. #751 checks its boot evidence through source tokens instead.
test('boot logs Node version and architecture once before media startup', () => {
  const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const lines = source.split(/\r?\n/);
  const bootLines = lines.filter((line) => line.includes('[boot]'));
  assert.equal(bootLines.length, 1);
  for (const token of ['logger.info', 'process.version', 'process.arch']) {
    assert.ok(bootLines[0].includes(token), `boot line needs ${token}`);
  }
  assert.ok(source.indexOf(bootLines[0]) < source.indexOf('startMediaMTX(mediamtxConfigPath)'));
});
