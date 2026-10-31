import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { walkSources, stripCommentsAndStrings } from './helpers/sourceScan.js';

const src = path.resolve(import.meta.dirname, '..', 'src');
const source = (p) => fs.readFileSync(path.join(src, p), 'utf8');

// #506 kept the raw ESPHome history out of every sleep and camera reader. #917 lets exactly ONE module read it for sleep,
// lib/sleepSensor.js (the shadow wake), and only read it. So: every source file that names an ESPHome table is one of
// the files below, each for the reason given, and a NEW file that names one fails here until someone decides what it is.
// Derived from a walk of the whole tree, never from a list of the files that must NOT mention the tables: such a list
// fails open for the file nobody thought of.
const ESPHOME_TABLE_USERS = {
  'db.js': 'the schema',
  'lib/esphomeManager.js': 'collects and prunes the readings (#506)',
  'routes/esphome.js': 'the settings API and the CSV export (#506)',
  'routes/diagnostics.js': 'counts devices, and redacts their keys from the bundle',
  'lib/entityPurge.js': 'deletes a child\'s readings with the child',
  'lib/demoSeed.js': 'wipes them for the public demo',
  'lib/sleepSensor.js': 'the ONE sleep-side reader, SELECT only (#917)',
};

test('#506/#917 only the known files name an ESPHome table; the sleep and camera readers are not among them', () => {
  const users = walkSources(src).filter((f) => /\besphome_/i.test(f.src)).map((f) => f.rel).sort();
  assert.deepEqual(users, Object.keys(ESPHOME_TABLE_USERS).sort());
  for (const file of ['lib/sleepAnalysis.js', 'lib/sensorSampler.js', 'routes/children.js', 'lib/sleepReviews.js']) {
    assert.doesNotMatch(source(file), /\besphome_/i, `${file} reads raw ESPHome history`);
  }
});

test('#917 lib/sleepSensor.js only SELECTs, never writes, and is imported by sleepAnalysis.js alone', () => {
  const code = source('lib/sleepSensor.js');
  // Every SQL string it holds: the ones naming a table. Each must be a SELECT with no write or schema keyword in it.
  const strings = [...code.matchAll(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"/g)].map((m) => m[0]);
  const sql = strings.filter((s) => /\besphome_/i.test(s));
  assert.ok(sql.length >= 2, `precondition: the reader's queries were found (${sql.length})`);
  for (const s of sql) {
    assert.match(s.slice(1), /^\s*SELECT\b/i, `not a SELECT: ${s}`);
    assert.doesNotMatch(s, /\b(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|PRAGMA|VACUUM)\b/i, `writes: ${s}`);
  }
  // better-sqlite3 writes through .run / .exec (and wraps them in .transaction); a reader has no use for any of them.
  assert.doesNotMatch(stripCommentsAndStrings(code), /\.\s*(?:run|exec|transaction)\s*\(/, 'sleepSensor.js calls a write method');
  // It reads the roles through the pure helper, never through the manager (which pulls in the transport and the client).
  const imports = [...code.matchAll(/^\s*import\b[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['../db.js', './esphomeRoles.js']);
  assert.doesNotMatch(source('lib/esphomeRoles.js'), /^\s*import\b/m, 'esphomeRoles.js stays import-free');
  const importers = walkSources(src).filter((f) => /from\s+['"][./]*(?:lib\/)?sleepSensor\.js['"]/.test(f.src)).map((f) => f.rel);
  assert.deepEqual(importers, ['lib/sleepAnalysis.js']);
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
