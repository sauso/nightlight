import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve(import.meta.dirname, '..', 'src');
const source = (p) => fs.readFileSync(path.join(src, p), 'utf8');

test('#506 raw ESPHome tables cannot enter the existing sleep or camera sample readers', () => {
  for (const file of ['lib/sleepAnalysis.js', 'lib/sensorSampler.js', 'routes/children.js']) {
    assert.doesNotMatch(source(file), /\besphome_/i, `${file} reads raw ESPHome history`);
  }
});

test('#506 adapter is the only client import and no source sends device controls', async () => {
  const files = ['lib/esphomeTransport.js', 'lib/esphomeManager.js', 'routes/esphome.js'];
  assert.match(source(files[0]), /from 'esphome-client'/);
  for (const file of files) {
    const code = source(file);
    if (file !== files[0]) assert.doesNotMatch(code, /from ['"]esphome-client['"]/, `${file} bypasses the adapter`);
    assert.doesNotMatch(code, /\.\s*(?:command|commandAndAwait|send\w*Command)\s*\(/,
      `${file} sends device controls`);
  }
  const exports = Object.keys(await import('../src/lib/esphomeTransport.js'));
  assert.deepEqual(exports.sort(), ['classifyEsphomeError', 'esphomeError', 'openDevice',
    'publicEsphomeEntity', 'validEsphomeKey'].sort());
});

test('#506 connection work starts only after the server listens and boot completes', () => {
  const index = source('index.js');
  const callback = index.indexOf('app.listen(PORT, () => {');
  const boot = index.indexOf('markBootComplete();', callback);
  const refresh = index.indexOf('refreshEsphome();', callback);
  assert.ok(callback >= 0 && callback < boot && boot < refresh);
  assert.ok(index.indexOf('stopEsphome();', index.indexOf('async function shutdown()')) > 0);
  assert.match(source('lib/entityPurge.js'), /reconcileEsphomeChildDeletion\(childId\)/);
});
