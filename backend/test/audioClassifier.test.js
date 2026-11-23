import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-audio-'));
process.env.DATA_DIR = temp;
const { default: db } = await import('../src/db.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { createAudioClassifier, decodeAlertClip } = await import('../src/lib/audioClassifier.js');
const { AUDIO_CLASSES, classIndices, labelScores } = await import('../src/lib/audioClassifierWorker.js');

before(() => { fs.mkdirSync(path.join(CLIPS_DIR, 'cam'), { recursive: true }); });
beforeEach(() => {
  db.prepare('DELETE FROM detection_events').run();
  db.prepare("UPDATE settings SET classify_alert_audio = 1 WHERE id = 'app'").run();
});
after(() => { db.close(); fs.rmSync(temp, { recursive: true, force: true }); });

function event(rel = 'cam/clip.mp4', type = 'sound') {
  const id = db.prepare(`INSERT INTO detection_events
    (camera_id, camera_name, type, clip_status, clip_path) VALUES ('cam', 'Test', ?, 'ready', ?)`).run(type, rel).lastInsertRowid;
  return Number(id);
}
const file = () => path.join(CLIPS_DIR, 'cam', 'clip.mp4');

test('#1159: class membership is found by name, and a missing name disables scoring', () => {
  const names = Object.values(AUDIO_CLASSES).flat();
  const csv = 'index,mid,display_name\n' + names.map((name, i) => `${i},/m/${i},"${name}"`).join('\n');
  const groups = classIndices(csv);
  assert.equal(groups.cry.length, 4);
  assert.equal(groups.voice.length, 10);
  assert.throws(() => classIndices(csv.replace('Whimper', 'Whimper renamed')), /missing audio class/);
});

test('#1159: cry and cough include the 0.30 boundary, talking needs 0.50; other stores the strongest group score', () => {
  const groups = { cry: [0], cough: [1], voice: [2] };
  assert.deepEqual(labelScores([0.30, 0.8, 0.9], [1, 3], groups), { label: 'cry', score: 0.30 });
  assert.deepEqual(labelScores([0.29, 0.30, 0.8], [1, 3], groups), { label: 'cough', score: 0.30 });
  assert.deepEqual(labelScores([0.29, 0.29, 0.50], [1, 3], groups), { label: 'voice', score: 0.50 });
  // A speech score between 0.30 and 0.50 is a clip the owner heard as fan static: no "Talking" label.
  assert.deepEqual(labelScores([0.12, 0.27, 0.49], [1, 3], groups), { label: 'other', score: 0.49 });
  assert.deepEqual(labelScores([0.12, 0.27, 0.24], [1, 3], groups), { label: 'other', score: 0.27 });
});

test('#1159: a ready jailed clip gets a label; off and escaped paths write nothing', async () => {
  fs.writeFileSync(file(), 'clip');
  const classifier = createAudioClassifier({ decoder: async () => new Float32Array([0]),
    scorer: async () => ({ label: 'cry', score: 0.9 }) });
  const first = event();
  await classifier.classify(first);
  assert.deepEqual(db.prepare('SELECT audio_label, audio_score FROM detection_events WHERE id = ?').get(first),
    { audio_label: 'cry', audio_score: 0.9 });
  db.prepare("UPDATE settings SET classify_alert_audio = 0 WHERE id = 'app'").run();
  const off = event();
  await classifier.classify(off);
  assert.equal(db.prepare('SELECT audio_label FROM detection_events WHERE id = ?').get(off).audio_label, null);
  db.prepare("UPDATE settings SET classify_alert_audio = 1 WHERE id = 'app'").run();
  fs.writeFileSync(path.join(temp, 'outside.mp4'), 'outside the clip jail');
  const escaped = event('../outside.mp4');
  await classifier.classify(escaped);
  assert.equal(db.prepare('SELECT audio_label FROM detection_events WHERE id = ?').get(escaped).audio_label, null);
  await classifier.stop();
});

test('#1159: a motion alert clip is not analysed and takes no queue slot', async () => {
  fs.writeFileSync(file(), 'clip');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scored = [];
  const classifier = createAudioClassifier({ decoder: async () => new Float32Array([0]), maxWaiting: 1,
    scorer: async () => { scored.push(1); await gate; return { label: 'cry', score: 0.9 }; } });
  const running = classifier.classify(event());
  const waitingId = event();
  const waiting = classifier.classify(waitingId);
  const motionId = event('cam/clip.mp4', 'motion');
  await classifier.classify(motionId); // resolves at once: not queued, and it did not push the waiting sound clip out
  assert.equal(db.prepare('SELECT audio_label FROM detection_events WHERE id = ?').get(motionId).audio_label, null);
  release();
  await Promise.all([running, waiting]);
  assert.equal(db.prepare('SELECT audio_label FROM detection_events WHERE id = ?').get(waitingId).audio_label, 'cry');
  assert.equal(scored.length, 2);
  await classifier.stop();
});

test('#1159: scorer errors resolve the caller without a label', async () => {
  fs.writeFileSync(file(), 'clip');
  const id = event();
  const classifier = createAudioClassifier({ decoder: async () => new Float32Array([0]),
    scorer: async () => { throw new Error('model failed'); } });
  await assert.doesNotReject(classifier.classify(id));
  assert.equal(db.prepare('SELECT audio_label FROM detection_events WHERE id = ?').get(id).audio_label, null);
  assert.equal(classifier.stats().disabled, true);
  await classifier.stop();
});

test('#1159: a full queue drops its oldest waiting alert', async () => {
  fs.writeFileSync(file(), 'clip');
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const classifier = createAudioClassifier({ decoder: async () => new Float32Array([0]), maxWaiting: 1,
    scorer: async () => { await gate; return { label: 'other', score: 0.1 }; } });
  const first = classifier.classify(event());
  const droppedId = event();
  const dropped = classifier.classify(droppedId);
  const last = classifier.classify(event());
  await dropped;
  assert.equal(db.prepare('SELECT audio_label FROM detection_events WHERE id = ?').get(droppedId).audio_label, null);
  release();
  await Promise.all([first, last]);
  await classifier.stop();
});

test('#1159: switching off during scoring prevents a late label write', async () => {
  fs.writeFileSync(file(), 'clip');
  const id = event();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const classifier = createAudioClassifier({ decoder: async () => new Float32Array([0]),
    scorer: async () => { await gate; return { label: 'cry', score: 0.9 }; } });
  const finished = classifier.classify(id);
  await new Promise((resolve) => setImmediate(resolve));
  db.prepare("UPDATE settings SET classify_alert_audio = 0 WHERE id = 'app'").run();
  release();
  await finished;
  assert.equal(db.prepare('SELECT audio_label FROM detection_events WHERE id = ?').get(id).audio_label, null);
  await classifier.stop();
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', -1); };
  return child;
}

test('#1159: decoder kills a clip beyond the byte cap and at its wall deadline', async () => {
  const huge = fakeChild();
  const over = decodeAlertClip('ignored', { spawnMedia: () => huge, maxBytes: 8 });
  huge.stdout.write(Buffer.alloc(12));
  await assert.rejects(over, /size cap/);
  assert.equal(huge.killed, true);
  const slow = fakeChild();
  await assert.rejects(decodeAlertClip('ignored', { spawnMedia: () => slow, deadlineMs: 5 }), /deadline/);
  assert.equal(slow.killed, true);
});

test('#1159: a stalled worker is killed and an idle worker is released', async () => {
  fs.writeFileSync(file(), 'clip');
  const workers = [];
  const workerFactory = () => {
    const w = new EventEmitter();
    w.ref = () => {};
    w.unref = () => {};
    w.terminated = false;
    w.terminate = async () => { w.terminated = true; w.emit('exit', 0); };
    w.postMessage = ({ id }) => { if (workers.length > 1) queueMicrotask(() => w.emit('message', { id, result: { label: 'cry', score: 0.8 } })); };
    workers.push(w);
    return w;
  };
  const classifier = createAudioClassifier({ decoder: async () => new Float32Array([0]),
    workerFactory, workerDeadlineMs: 5, idleMs: 5 });
  await classifier.classify(event());
  assert.equal(workers[0].terminated, true);
  await classifier.classify(event());
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(workers[1].terminated, true);
  await classifier.stop();
});
