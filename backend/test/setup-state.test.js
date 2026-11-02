import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { createSetupState } = await import('../src/lib/setupState.js');
const CAMERA = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let now;
let setup;
const child = () => db.prepare("INSERT INTO children (id, name) VALUES ('child', 'a child')").run();
const camera = (id = CAMERA) => db.prepare('INSERT INTO cameras (id, name, rtsp_url, child_id, mediamtx_path) VALUES (?, ?, ?, ?, ?)')
  .run(id, 'a camera', 'rtsp://user:secret@camera/stream', 'child', `path_${id}`);
const row = () => db.prepare("SELECT * FROM setup_state WHERE id = 'app'").get();

beforeEach(() => {
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  db.prepare("UPDATE setup_state SET status = 'not_started', active_step = 'welcome', row_version = 0, completed_at = NULL WHERE id = 'app'").run();
  now = Date.UTC(2026, 0, 1);
  setup = createSetupState({ db, clock: () => now });
});
after(() => { db.close(); cleanupTempDataDirs(); });

test('two fresh boots create one not_started row and the settings seed does not classify it as legacy', async () => {
  // WHY: file-existence classification fails when the second process opens the file first.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-fresh-'));
  const script = `
    const { parentPort, workerData } = require('node:worker_threads');
    process.env.DATA_DIR = workerData.dir;
    parentPort.once('message', async () => {
      const { default: db } = await import(workerData.moduleUrl);
      parentPort.postMessage(db.prepare("SELECT status FROM setup_state WHERE id = 'app'").get().status);
      db.close();
    });
  `;
  const workers = [0, 1].map(() => new Worker(script, { eval: true, workerData: {
    dir, moduleUrl: new URL('../src/db.js', import.meta.url).href,
  } }));
  try {
    const results = workers.map((worker) => new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => { if (code) reject(new Error(`setup worker exited ${code}`)); });
    }));
    await Promise.all(workers.map((worker) => new Promise((resolve) => worker.once('online', resolve))));
    for (const worker of workers) worker.postMessage('go');
    assert.deepEqual(await Promise.all(results), ['not_started', 'not_started']);
    const check = new Database(path.join(dir, 'private', 'babymonitor.db'));
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM setup_state').get().n, 1);
    check.close();
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('old rows and demo mode each classify as legacy, and a later boot preserves the decision', async () => {
  // WHY: restored settings-only and unclaimed old installations must not be redirected.
  const original = process.env.DATA_DIR;
  for (const variant of ['settings-default', 'settings-custom', 'users', 'children', 'cameras', 'demo']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-legacy-'));
    const file = path.join(dir, 'private', 'babymonitor.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await db.backup(file);
    const fixture = new Database(file);
    fixture.exec('DROP TABLE setup_state');
    fixture.exec('DELETE FROM cameras; DELETE FROM children; DELETE FROM users; DELETE FROM settings');
    if (variant === 'settings-default') fixture.exec("INSERT INTO settings (id) VALUES ('app')");
    if (variant === 'settings-custom') fixture.exec("INSERT INTO settings (id, app_name) VALUES ('app', 'Custom')");
    if (variant === 'users') fixture.exec("INSERT INTO users (id, username, password_hash) VALUES ('u', 'user', 'hash')");
    if (variant === 'children') fixture.exec("INSERT INTO children (id, name) VALUES ('c', 'a child')");
    if (variant === 'cameras') fixture.exec("INSERT INTO cameras (id, name, rtsp_url, mediamtx_path) VALUES ('cam', 'a camera', 'rtsp://camera', 'cam')");
    fixture.close();
    process.env.DATA_DIR = dir;
    if (variant === 'demo') process.env.DEMO_MODE = 'true';
    try {
      const first = (await import(`../src/db.js?setup-legacy-${variant}`)).default;
      assert.equal(first.prepare("SELECT status FROM setup_state WHERE id = 'app'").get().status, 'legacy_completed', variant);
      first.close();
      const second = (await import(`../src/db.js?setup-legacy-${variant}-again`)).default;
      assert.equal(second.prepare('SELECT COUNT(*) AS n FROM setup_state').get().n, 1);
      assert.equal(second.prepare("SELECT status FROM setup_state WHERE id = 'app'").get().status, 'legacy_completed');
      second.close();
    } finally { delete process.env.DEMO_MODE; process.env.DATA_DIR = original; fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('progress is versioned and cannot move a terminal state backwards', () => {
  // WHY: two open admin tabs must not silently overwrite one another's place.
  const first = setup.advance('children', 0, 'session-a');
  assert.equal(first.status, 'in_progress');
  assert.equal(first.rowVersion, 1);
  assert.throws(() => setup.advance('camera', 0, 'session-a'), (e) => e.status === 409);
  assert.throws(() => setup.advance('unknown', 1, 'session-a'), (e) => e.status === 400);
  assert.deepEqual(setup.complete(true, 'session-a'), { status: 'completed_limited' });
  assert.throws(() => setup.advance('welcome', row().row_version, 'session-a'), (e) => e.status === 409);
  assert.deepEqual(setup.complete(true, 'session-a'), { status: 'completed_limited' });
});

test('attestation is session and camera bound, one-shot, and expires after ten minutes', () => {
  // WHY: a guessed test id, another browser or another camera must not establish readiness.
  child(); camera(); camera(OTHER);
  const { testId } = setup.startTest(CAMERA, 'session-a');
  assert.throws(() => setup.confirm(crypto.randomUUID(), CAMERA, 'session-a'), (e) => e.status === 409);
  assert.throws(() => setup.confirm(testId, OTHER, 'session-a'), (e) => e.status === 409);
  assert.throws(() => setup.confirm(testId, CAMERA, 'session-b'), (e) => e.status === 409);
  assert.deepEqual(setup.confirm(testId, CAMERA, 'session-a'), { ok: true });
  assert.throws(() => setup.confirm(testId, CAMERA, 'session-a'), (e) => e.status === 409);
  assert.equal(setup.read('session-a').readiness.ready, true);
  assert.equal(setup.read('session-b').readiness.playbackAttested, false);
  now += 10 * 60_000;
  assert.equal(setup.read('session-a').readiness.playbackAttested, false);
});

test('camera edit, reassignment, disablement and deletion revoke a confirmed proof', () => {
  // WHY: proof from an earlier stream must not complete a changed camera setup.
  for (const change of [
    () => db.prepare("UPDATE cameras SET rtsp_url = 'rtsp://another' WHERE id = ?").run(CAMERA),
    () => db.prepare("UPDATE cameras SET sub_rtsp_url = 'rtsp://substream' WHERE id = ?").run(CAMERA),
    () => db.prepare("UPDATE cameras SET child_id = NULL WHERE id = ?").run(CAMERA),
    () => db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAMERA),
    () => db.prepare('DELETE FROM cameras WHERE id = ?').run(CAMERA),
  ]) {
    db.prepare('DELETE FROM cameras').run();
    db.prepare('DELETE FROM children').run();
    child(); camera();
    const { testId } = setup.startTest(CAMERA, 'session-a');
    setup.confirm(testId, CAMERA, 'session-a');
    assert.equal(setup.read('session-a').readiness.ready, true);
    change();
    assert.equal(setup.read('session-a').readiness.ready, false);
    assert.throws(() => setup.complete(false, 'session-a'), (e) => e.code === 'NOT_READY');
  }
});

test('changed, reassigned, disabled and deleted cameras refuse confirmation before it is consumed', () => {
  // WHY: the test id is bound to the exact camera playback inputs at test creation.
  for (const change of [
    () => db.prepare("UPDATE cameras SET rtsp_url = 'rtsp://changed' WHERE id = ?").run(CAMERA),
    () => db.prepare("UPDATE cameras SET sub_rtsp_url = 'rtsp://changed-sub' WHERE id = ?").run(CAMERA),
    () => db.prepare('UPDATE cameras SET child_id = NULL WHERE id = ?').run(CAMERA),
    () => db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run(CAMERA),
    () => db.prepare('DELETE FROM cameras WHERE id = ?').run(CAMERA),
  ]) {
    db.prepare('DELETE FROM cameras').run();
    db.prepare('DELETE FROM children').run();
    child(); camera();
    const { testId } = setup.startTest(CAMERA, 'session-a');
    change();
    assert.throws(() => setup.confirm(testId, CAMERA, 'session-a'), (e) => e.status === 409);
  }
});

test('legacy review stays unchanged until a valid test upgrades it to completed', () => {
  // WHY: visiting diagnostics must not erase a pre-existing install's legacy classification.
  db.prepare("UPDATE setup_state SET status = 'legacy_completed', active_step = 'review' WHERE id = 'app'").run();
  assert.deepEqual(setup.complete(true, 'session-a'), { status: 'legacy_completed' });
  assert.throws(() => setup.advance('welcome', 0, 'session-a'), (e) => e.status === 409);
  assert.equal(row().status, 'legacy_completed');
  child(); camera();
  const { testId } = setup.startTest(CAMERA, 'session-a');
  setup.confirm(testId, CAMERA, 'session-a');
  assert.deepEqual(setup.complete(false, 'session-a'), { status: 'completed' });
});

test('proof cap evicts oldest, restart loses proof, and limited may later become completed', () => {
  // WHY: a long-running server must bound proof memory; a restart requires a fresh browser test.
  child(); camera();
  const ids = Array.from({ length: 17 }, () => setup.startTest(CAMERA, 'session-a').testId);
  assert.throws(() => setup.confirm(ids[0], CAMERA, 'session-a'), (e) => e.status === 409);
  assert.deepEqual(setup.complete(true, 'session-a'), { status: 'completed_limited' });
  setup.confirm(ids[16], CAMERA, 'session-a');
  assert.deepEqual(setup.complete(false, 'session-a'), { status: 'completed' });
  assert.deepEqual(setup.complete(true, 'session-a'), { status: 'completed' });
  assert.equal(createSetupState({ db, clock: () => now }).read('session-a').readiness.playbackAttested, false);
});
