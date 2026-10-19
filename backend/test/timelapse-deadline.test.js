// #781: drive the real timelapse assembler and shared #773 deadline helper through
// child_process only. The real DB and frame directory show what a failed night keeps.
import { test, before, after, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeChild } from './helpers/harness.js';
import { FakeFfmpeg, UnkillableFfmpeg } from './helpers/fakeFfmpeg.js';

useTempDataDir();
const spawned = [];
let kindFor = () => FakeFfmpeg;
mock.module('node:child_process', {
  exports: {
    spawn(command, args) {
      const proc = new (kindFor(args))(command, args);
      spawned.push(proc);
      return proc;
    },
  },
});

const { default: db } = await import('../src/db.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');
const { assembleTimelapse, frameDir, getTimelapseVideoFile } = await import('../src/lib/timelapse.js');
const CHILD = 'child-781';
const NIGHT = '2026-10-18';
const dir = frameDir(CHILD, NIGHT);
const outFile = path.join(CLIPS_DIR, 'timelapse', CHILD, `${NIGHT}.mp4`);
const thumbFile = path.join(CLIPS_DIR, 'timelapse', CHILD, `${NIGHT}.jpg`);
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(pred) {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await flush();
  }
  assert.fail('expected ffmpeg child did not start');
}
function track(p) {
  const state = { value: 'pending' };
  p.then((value) => { state.value = value; }, () => { state.value = 'rejected'; });
  return state;
}
function row() {
  return db.prepare('SELECT * FROM timelapses WHERE child_id = ? AND night_date = ?').get(CHILD, NIGHT);
}
function assembleProc() { return spawned.find((p) => p.args.at(-1) === outFile); }
function thumbProc() { return spawned.find((p) => p.args.at(-1) === thumbFile); }
function progress(proc, frame) {
  proc.stdout.emit('data', Buffer.from(`frame=${frame}\ntotal_size=0\nout_time_us=${frame * 1000000}\nprogress=continue\n`));
}

before(() => {
  makeChild(db, { id: CHILD });
  checkClipStorage({ mounts: null });
});
after(() => {
  db.close();
  cleanupTempDataDirs();
});
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] });
  spawned.length = 0;
  kindFor = () => FakeFfmpeg;
  db.prepare('DELETE FROM timelapses').run();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(path.dirname(outFile), { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `f-${i}.jpg`), 'frame');
});
afterEach(() => {
  for (const proc of spawned) proc.finish(1);
  mock.timers.reset();
});

test('#781 assembly with no progress is killed, fails its row, and keeps frames', async () => {
  const state = track(assembleTimelapse(CHILD, NIGHT));
  await until(assembleProc);
  const proc = assembleProc();
  fs.writeFileSync(outFile, 'partial video');
  mock.timers.tick(120_000);
  await flush();
  assert.equal(state.value, null, 'assembly must settle at the stall window');
  assert.ok(proc.args.includes('-progress') && proc.args.includes('pipe:1') && proc.args.includes('-nostats'));
  assert.deepEqual(proc.signals, ['SIGKILL']);
  assert.equal(row().status, 'failed');
  assert.equal(getTimelapseVideoFile(row().id), null);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('f-')).length, 30);
  assert.equal(fs.existsSync(path.join(dir, '.seq')), false);
});

test('#781 increasing progress beyond the base window finishes ready', async () => {
  const state = track(assembleTimelapse(CHILD, NIGHT));
  await until(assembleProc);
  const proc = assembleProc();
  for (let frame = 1; frame <= 3; frame++) {
    mock.timers.tick(90_000);
    progress(proc, frame);
  }
  await flush();
  assert.equal(state.value, 'pending');
  assert.deepEqual(proc.signals, []);
  fs.writeFileSync(outFile, 'video');
  proc.finish(0);
  await until(thumbProc);
  thumbProc().finish(0);
  await until(() => state.value !== 'pending');
  assert.equal(row().status, 'ready');
});

test('#781 frozen progress=continue blocks do not extend the stall window', async () => {
  const state = track(assembleTimelapse(CHILD, NIGHT));
  await until(assembleProc);
  const proc = assembleProc();
  for (let i = 0; i < 4; i++) {
    progress(proc, 0);
    mock.timers.tick(30_000);
  }
  await flush();
  assert.equal(state.value, null);
  assert.deepEqual(proc.signals, ['SIGKILL']);
  assert.equal(row().status, 'failed');
});

test('#781 hung thumbnail times out and leaves a ready video without a thumbnail', async () => {
  kindFor = (args) => args.at(-1) === thumbFile ? UnkillableFfmpeg : FakeFfmpeg;
  const state = track(assembleTimelapse(CHILD, NIGHT));
  await until(assembleProc);
  fs.writeFileSync(outFile, 'video');
  assembleProc().finish(0);
  await until(thumbProc);
  fs.writeFileSync(thumbFile, 'partial image');
  mock.timers.tick(120_000);
  await until(() => state.value !== 'pending');
  assert.deepEqual(thumbProc().signals, ['SIGKILL']);
  assert.equal(row().status, 'ready');
  assert.equal(row().thumb_path, null);
  assert.equal(fs.existsSync(thumbFile), false);
});

test('#781 unkillable assembly settles immediately after SIGKILL', async () => {
  kindFor = () => UnkillableFfmpeg;
  const state = track(assembleTimelapse(CHILD, NIGHT));
  await until(assembleProc);
  const proc = assembleProc();
  mock.timers.tick(120_000);
  await flush();
  assert.equal(proc.ended, false);
  assert.deepEqual(proc.signals, ['SIGKILL']);
  assert.equal(state.value, null);
  assert.equal(row().status, 'failed');
});
