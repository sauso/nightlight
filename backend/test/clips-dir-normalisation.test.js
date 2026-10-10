// CLIPS_DIR is normalised once, where it is read (#545).
//
// The bug: `CLIPS_DIR=/recordings/` (trailing slash) or a relative value left the raw string in place,
// and four containment guards compared `path.resolve(CLIPS_DIR, rel)` against `CLIPS_DIR + path.sep`.
// Clips were written (path.join) but never served, and `unlinkClip` returned silently so retention
// cleared the rows and left the files on disk.
//
// Why a child process per case: CLIPS_DIR is a module-level constant, so each spelling needs a fresh
// module graph — exactly how the bug was reproduced. The probe (helpers/clips-dir-probe.mjs) uses the
// real modules and schema and reports what the serving and deleting guards did.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, 'helpers', 'clips-dir-probe.mjs');
const { resolveClipsDir } = await import('../src/lib/clipRecorder.js');

const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

// Run the probe with a given raw CLIPS_DIR. `makeValue(base)` receives a fresh temp dir and returns the
// env value, so a case can spell the same directory with or without a trailing separator, or relative.
function probe(makeValue) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-clipsdir-')));
  tmpDirs.push(base);
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...process.env, DATA_DIR: dataDir, JWT_SECRET: 'test-secret-not-used-anywhere-real' };
  const value = makeValue(base);
  if (value === undefined) delete env.CLIPS_DIR; else env.CLIPS_DIR = value;
  const r = spawnSync(process.execPath, [PROBE], { cwd: base, env, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `probe failed: ${r.stderr}`);
  const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('PROBE '));
  assert.ok(line, `probe printed no result: ${r.stdout}${r.stderr}`);
  return { base, out: JSON.parse(line.slice('PROBE '.length)) };
}

function assertServedAndDeleted(out) {
  assert.equal(out.servedClip, true, 'alert clip was not served');
  assert.equal(out.servedRecording, true, 'recording was not served');
  assert.equal(out.servedTimelapse, true, 'timelapse was not served');
  assert.equal(out.deleted, true);
  assert.equal(out.clipFileGoneAfterDelete, true, 'deleteClipForEvent left the file on disk (orphaned)');
  // Deleting one clip must not touch the neighbouring kinds sharing the directory.
  assert.equal(out.recFileStillThere, true);
  assert.equal(out.tlFileStillThere, true);
}

function assertTraversalRefused(out) {
  assert.equal(out.evilClip, null, 'traversal row was served for an alert clip');
  assert.equal(out.evilRecording, null, 'traversal row was served for a recording');
  assert.equal(out.evilTimelapse, null, 'traversal row was served for a timelapse');
  assert.equal(out.outsideSurvivedDelete, true, 'a traversal row deleted a file outside CLIPS_DIR');
}

test('★ a CLIPS_DIR with a trailing slash serves and deletes clips (#545)', () => {
  const { base, out } = probe((b) => path.join(b, 'recs') + '/');
  assert.equal(out.clipsDir, path.join(base, 'recs'), 'the exported CLIPS_DIR keeps its trailing slash');
  assertServedAndDeleted(out);
});

test('★ a RELATIVE CLIPS_DIR serves and deletes clips (#545)', () => {
  const { base, out } = probe(() => 'recs-rel');
  assert.equal(out.clipsDir, path.join(base, 'recs-rel'), 'a relative CLIPS_DIR is resolved against the cwd');
  assertServedAndDeleted(out);
});

test('the control: a plain absolute CLIPS_DIR serves and deletes (and the default does too)', () => {
  assertServedAndDeleted(probe((b) => path.join(b, 'recs')).out);
  assertServedAndDeleted(probe(() => undefined).out);
});

test('a blank (whitespace-only) CLIPS_DIR means "unset" and uses the default (#545)', () => {
  const { base, out } = probe(() => '   ');
  assert.equal(out.clipsDir, path.join(base, 'data', 'clips'));
  assertServedAndDeleted(out);
});

test('★ path traversal is still refused after normalisation, for every spelling', () => {
  for (const make of [
    (b) => path.join(b, 'recs'),
    (b) => path.join(b, 'recs') + '/',
    (b) => path.join(b, 'recs') + '/./',
    () => 'recs-rel',
  ]) {
    assertTraversalRefused(probe(make).out);
  }
});

test('resolveClipsDir: strips trailing separators, resolves relatives, defaults under the data dir', () => {
  const abs = path.resolve('some', 'recordings');
  assert.equal(resolveClipsDir(abs + path.sep, '/d'), abs);
  assert.equal(resolveClipsDir(abs + '/', '/d'), abs, '"/" is a separator on every platform');
  assert.equal(resolveClipsDir(abs + path.sep + path.sep, '/d'), abs);
  assert.equal(resolveClipsDir(path.join('some', 'recordings'), '/d'), abs);
  assert.equal(resolveClipsDir(`  ${abs}  `, '/d'), abs, 'surrounding whitespace is ignored');
  assert.equal(resolveClipsDir(undefined, '/d'), path.resolve('/d', 'clips'));
  assert.equal(resolveClipsDir('', '/d'), path.resolve('/d', 'clips'), 'an empty compose default means "unset"');
  assert.equal(resolveClipsDir('   ', '/d'), path.resolve('/d', 'clips'));
});

test('resolveClipsDir never returns a trailing separator (the property every guard relies on)', () => {
  for (const raw of ['/a/b/', '/a/b//', '/a/b/.', '/a/b/../b/', 'rel/', undefined, '']) {
    const got = resolveClipsDir(raw, '/data');
    assert.equal(got, path.resolve(got), 'not a fixed point of path.resolve');
    assert.ok(!got.endsWith(path.sep) || got === path.parse(got).root, `trailing separator in ${got}`);
  }
});
