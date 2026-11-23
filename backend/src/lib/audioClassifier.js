import path from 'node:path';
import { Worker } from 'node:worker_threads';
import db from '../db.js';
import { logger } from './logger.js';
import { spawnChild } from './childEnv.js';
import { getEventClipFile, setAudioLabel } from './detectionEvents.js';

const MAX_AUDIO_BYTES = 90 * 16000 * 4; // #1159: 90 s, well above a 20-33 s alert clip; bounds memory on malformed media.
const JOB_DEADLINE_MS = 60000; // #1159: a stalled decode or worker must release the single lane.
const IDLE_MS = 60000; // #1159: loaded WASM uses about 250-315 MB; release it between alert bursts.
const MAX_WAITING = 8; // #1159: old alerts lose value before current ones; keep one worker's queue bounded.

export function decodeAlertClip(file, { spawnMedia = spawnChild, maxBytes = MAX_AUDIO_BYTES, deadlineMs = JOB_DEADLINE_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnMedia('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (err) => { if (settled) return; settled = true; clearTimeout(deadline); child.kill('SIGKILL'); reject(err); };
    const deadline = setTimeout(() => fail(new Error('audio decode deadline')), deadlineMs);
    deadline.unref();
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) return fail(new Error('audio decode size cap'));
      chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(deadline);
      if (settled) return;
      settled = true;
      if (code !== 0 || bytes === 0 || bytes % 4 !== 0) return reject(new Error(`audio decode failed (${code})`));
      const buffer = Buffer.concat(chunks);
      resolve(new Float32Array(buffer.buffer, buffer.byteOffset, bytes / 4).slice());
    });
  });
}

export function createAudioClassifier({ decoder = decodeAlertClip, scorer, maxWaiting = MAX_WAITING,
  workerDeadlineMs = JOB_DEADLINE_MS, idleMs = IDLE_MS,
  workerFactory = (url) => new Worker(url) } = {}) {
  const queue = [];
  let busy = false;
  let current = null;
  let idleTimer;
  let disabled = false;
  let nextId = 0;
  const log = (e) => logger.error(`[audio] ${e?.message || e}`);
  const stopWorker = () => {
    clearTimeout(idleTimer);
    const old = current;
    current = null;
    return old?.worker.terminate() || Promise.resolve();
  };
  const score = scorer || ((samples) => new Promise((resolve, reject) => {
    if (!current) {
      const worker = workerFactory(new URL('./audioClassifierWorker.js', import.meta.url));
      const entry = { worker, pending: new Map() };
      current = entry;
      worker.on('message', ({ id, result, error }) => {
        const job = entry.pending.get(id);
        if (!job) return;
        entry.pending.delete(id);
        error ? job.reject(new Error(error)) : job.resolve(result);
      });
      const failed = (err) => {
        if (current === entry) current = null;
        for (const job of entry.pending.values()) job.reject(err);
        entry.pending.clear();
      };
      worker.on('error', failed);
      worker.on('exit', () => failed(new Error('audio worker stopped')));
      worker.unref();
    }
    const id = ++nextId;
    current.pending.set(id, { resolve, reject });
    current.worker.ref();
    current.worker.postMessage({ id, samples }, [samples.buffer]);
  }));
  async function run() {
    if (busy || !queue.length) return;
    busy = true;
    clearTimeout(idleTimer);
    const job = queue.shift();
    try {
      if (db.prepare("SELECT classify_alert_audio FROM settings WHERE id = 'app'").get()?.classify_alert_audio === 0 || disabled) return;
      const jailed = getEventClipFile(job.eventId);
      if (!jailed) return;
      const samples = await decoder(path.join(jailed.root, jailed.path));
      let deadline;
      let result;
      try {
        result = await Promise.race([score(samples), new Promise((_, reject) => {
          deadline = setTimeout(() => { void stopWorker(); reject(new Error('audio worker deadline')); }, workerDeadlineMs);
        })]).finally(() => clearTimeout(deadline));
      } catch (e) {
        // A model/class-map/runtime failure cannot be repaired by another clip. A deadline or
        // dead worker can: terminate it and let the next alert start a fresh worker.
        if (!/audio worker deadline|audio worker stopped/.test(e.message)) disabled = true;
        throw e;
      }
      if (!['cry', 'cough', 'voice', 'other'].includes(result?.label) || !Number.isFinite(result.score)) throw new Error('invalid audio verdict');
      // The switch or retention may change while FFmpeg/WASM works. Do not write a late label
      // after analysis was turned off or its clip was removed.
      if (db.prepare("SELECT classify_alert_audio FROM settings WHERE id = 'app'").get()?.classify_alert_audio !== 0 &&
          getEventClipFile(job.eventId)) setAudioLabel(job.eventId, result.label, result.score);
    } catch (e) {
      log(e);
    } finally {
      job.resolve();
      busy = false;
      if (queue.length) void run();
      else if (current) { current.worker.unref(); idleTimer = setTimeout(() => { void stopWorker(); }, idleMs); idleTimer.unref(); }
    }
  }
  return {
    classify: (eventId) => new Promise((resolve) => {
      // A motion or other alert can also carry a clip (detect_record_clips). Its audio feeds neither the sleep rule nor
      // a badge (sound alerts only), and it must not take one of the 8 waiting slots a sound clip would then lose
      // (code review of #1160).
      if (db.prepare('SELECT type FROM detection_events WHERE id = ?').get(eventId)?.type !== 'sound') return resolve();
      if (queue.length >= maxWaiting) { queue.shift().resolve(); logger.error('[audio] queue full; oldest alert dropped'); }
      queue.push({ eventId, resolve });
      void run();
    }),
    stop: async () => { while (queue.length) queue.shift().resolve(); await stopWorker(); },
    stats: () => ({ queued: queue.length, busy, disabled, worker: !!current }),
  };
}

let classifier;
export function initAudioClassifier() { classifier ??= createAudioClassifier(); return classifier; }
export function classifyAlertClip(eventId) { return initAudioClassifier().classify(eventId); }
export function stopAudioClassifier() { return classifier?.stop() || Promise.resolve(); }
