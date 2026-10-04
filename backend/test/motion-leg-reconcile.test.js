// #353: the REAL reconcile decision for the pixel-diff motion leg, driven through frozen instants.
//
// sleep-sampling-horizon.test.js pins the predicate (childSamplingActiveNow) by assertion. This file pins
// what acts on it: reconcileMotionLeg(cam), the start/stop decision that index.js reconcileCameraPaths runs
// for every camera every 5 minutes (it used to be inline there; index.js spawns MediaMTX and the transcoders
// at import so no test can import it, which is why the decision was extracted to motionDetector.js).
//
// What it proves, for the three kinds of ACTIVITY-ONLY camera (MQTT source, ONVIF source, motion alerts off):
//   * no leg before the lead edge, a leg from exactly the lead edge;
//   * the leg is KEPT, NOT RESTARTED, at 07:06 and 09:59 (a restart resets the bed-transition tracker and its
//     believed-occupied state, which would lose an exit in progress, and isDetecting() alone cannot tell
//     "kept" from "restarted", so the start log line is counted: startMotionDetector writes it on every start);
//   * the leg is torn down after the inference horizon + the reconcile margin, and a reconcile with nothing to
//     do is a no-op;
//   * an ALERTING camera never depends on the sleep gate; an unassigned camera or a tracking-off child stops a
//     running leg.
//
// ⚠️ RED-ON-OLD. With the old predicate (5-minute tail) the 07:06 and 09:59 steps fail by assertion: the
// reconcile finds the leg "no longer wanted" and stops it. The discriminating run is the NEW motionDetector.js
// with the OLD sleepAnalysis.js predicate; the missing export alone (old motionDetector.js) proves nothing.
//
// ⚠️ MEDIAMTX IS DELIBERATELY UNREACHABLE (port 1). startMotionDetector -> launch() claims the detector slot
// synchronously (isDetecting() is true at once) and then polls for a ready stream path forever, every
// readyPollMs; it never reaches the ffmpeg spawn. So a started leg is observable without a camera, a stream
// or an ffmpeg process. PATH is emptied as well, as in children-clip-ring-reconcile.test.js, so that even an
// accidental spawn would fail identically everywhere instead of leaving a real process behind.
// stopAllMotionDetectors() runs after every test: a detector left claimed would keep the process alive.
//
// ⚠️ ONLY Date IS FROZEN (mock.timers apis: ['Date']), never setTimeout/setInterval: the readiness poll uses
// real timers. Always reset in finally.
import { test, before, after, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs, makeChild, makeCamera } from './helpers/harness.js';

const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;
process.env.MEDIAMTX_API = 'http://127.0.0.1:1'; // unreachable: read when mediamtx.js is first imported
useTempDataDir();

const { default: db } = await import('../src/db.js');
const { reconcileMotionLeg, isDetecting, stopAllMotionDetectors, _setReturnTimingForTests, _resetReturnTimingForTests } =
  await import('../src/lib/motionDetector.js');
const { logger } = await import('../src/lib/logger.js');

const KID = 'kid-353';
const MEL = 'Australia/Melbourne';
const Z = (iso) => Date.parse(iso);
const MS = 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Freeze Date at an instant, reconcile once, restore.
async function reconcileAt(utcMs, cam) {
  mock.timers.enable({ apis: ['Date'], now: utcMs });
  try { await reconcileMotionLeg(cam); } finally { mock.timers.reset(); }
}
const camRow = (id) => db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
// Every start of an activity-only leg logs one line naming the camera (startMotionDetector).
const startLines = (name) =>
  logger.getRecent().filter((l) => l.includes(`activity-only motion leg for "${name}"`)).length;

before(() => {
  _setReturnTimingForTests({ readyPollMs: 50 });
  db.prepare(`INSERT INTO settings (id, timezone) VALUES ('app', ?)
              ON CONFLICT(id) DO UPDATE SET timezone = excluded.timezone`).run(MEL);
});

beforeEach(() => {
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  makeChild(db, { id: KID, track: 1, start: '19:00', end: '07:00' });
});

afterEach(async () => {
  await stopAllMotionDetectors();
});

after(async () => {
  await stopAllMotionDetectors();
  _resetReturnTimingForTests();
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// One table of the cameras that are ACTIVITY-ONLY: child-assigned and never the alerting kind
// (motionAlerting needs detect_source 'framediff' AND detect_motion_enabled).
const ACTIVITY_ONLY = [
  { label: 'MQTT source, alerts off', extra: { detect_source: 'mqtt', detect_motion_enabled: 0 } },
  { label: 'ONVIF source, alerts on (the source decides, not the switch)', extra: { detect_source: 'onvif', detect_motion_enabled: 1 } },
  { label: 'frame-diff source, motion alerts off', extra: { detect_source: 'framediff', detect_motion_enabled: 0 } },
];

for (const [i, kind] of ACTIVITY_ONLY.entries()) {
  // Night of 2026-08-27, Melbourne winter (AEST = UTC+10), 19:00-07:00: starts 2026-08-27T09:00Z, ends
  // 2026-08-27T21:00Z. The lead opens 3 real hours before the start (06:00Z = 16:00 local); the inference
  // horizon is end + 3 h = 2026-08-28T00:00Z (10:00 local); the leg is torn down one reconcile margin later.
  test(`#353 ${kind.label}: the leg starts at the lead edge, is KEPT (not restarted) through 07:06 and 09:59, and is stopped after the horizon (kills: reconcile stop/start branch removed, !isDetecting dropped, condition swapped)`, async () => {
    const id = `cam-353-${i}`;
    const name = `Activity Cam ${i}`;
    makeCamera(db, { id, name, childId: KID, extra: kind.extra });
    const cam = camRow(id);

    // 1. Before the lead edge nothing runs; at it the leg starts. 15:59:59.999 local vs 16:00 local.
    await reconcileAt(Z('2026-08-27T06:00:00Z') - MS, cam);
    assert.equal(isDetecting(id), false, 'no leg 1 ms before the 3 h lead opens');
    assert.equal(startLines(name), 0);
    await reconcileAt(Z('2026-08-27T06:00:00Z'), cam);
    assert.equal(isDetecting(id), true, 'the leg starts exactly at the lead edge');
    assert.equal(startLines(name), 1, 'one start');
    // The slot is claimed and the readiness poll keeps running with MediaMTX unreachable: after several poll
    // cycles the leg is still there, so no spawn (and no spawn failure) happened in this test.
    await sleep(160);
    assert.equal(isDetecting(id), true, 'still claimed, still polling: nothing was spawned');

    // 2. KEPT, not restarted, at 07:06 and 09:59 local (21:06Z and 23:59Z on 08-27). Red on the old predicate:
    // the old tail ended at 07:05, so the reconcile would stop the leg here.
    for (const t of ['2026-08-27T21:06:00Z', '2026-08-27T23:59:00Z']) {
      await reconcileAt(Z(t), cam);
      await reconcileAt(Z(t), cam);
      await reconcileAt(Z(t), cam);
      assert.equal(isDetecting(id), true, `${t}: still wanted, so still running`);
      assert.equal(startLines(name), 1, `${t}: three reconciles, still ONE start line (a restart would add one)`);
    }

    // 3. The last millisecond of the tail keeps it; the next one stops it; then a reconcile is a no-op.
    // 2026-08-28T00:05:00Z = 10:05 local = horizon + the 5-minute reconcile margin.
    await reconcileAt(Z('2026-08-28T00:05:00Z') - MS, cam);
    assert.equal(isDetecting(id), true, '1 ms before the tail closes: kept');
    await reconcileAt(Z('2026-08-28T00:05:00Z'), cam);
    assert.equal(isDetecting(id), false, 'torn down at horizon + margin');
    await assert.doesNotReject(reconcileAt(Z('2026-08-28T00:05:00Z'), cam), 'not wanted and not running is a no-op');
    assert.equal(isDetecting(id), false);
    assert.equal(startLines(name), 1, 'and nothing restarted it');
  });
}

// C10: an ALERTING camera is wanted whatever the sleep gate says. motionLegWanted returns true for it BEFORE it
// consults the gate, so a child with tracking off, at a time outside every window, still has its leg.
test('#353 an ALERTING frame-diff camera is started and never stopped by the sleep gate, even for a tracking-off child outside every window (kills: motionLegWanted consults the sleep gate before motionAlerting)', async () => {
  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID);
  makeCamera(db, { id: 'cam-353-alert', name: 'Alert Cam', childId: KID, extra: { detect_source: 'framediff', detect_motion_enabled: 1 } });
  // A control of the same child that is NOT alerting: it must not run, so the gate really is shut here.
  makeCamera(db, { id: 'cam-353-ctl', name: 'Control Cam', childId: KID, extra: { detect_source: 'mqtt', detect_motion_enabled: 0 } });
  const outside = Z('2026-08-28T05:00:00Z'); // 15:00 local: outside every window, tracking off
  await reconcileAt(outside, camRow('cam-353-alert'));
  await reconcileAt(outside, camRow('cam-353-ctl'));
  assert.equal(isDetecting('cam-353-alert'), true, 'the alerting camera runs 24/7');
  assert.equal(isDetecting('cam-353-ctl'), false, 'control: the same child\'s activity-only camera does not');
  // Later reconciles (inside a window, outside it) never stop it. (An alerting leg logs no "activity-only" start
  // line, so "kept, not restarted" cannot be read off the log here: that is asserted on the activity-only legs.)
  for (const t of [Z('2026-08-27T20:00:00Z'), outside, Z('2026-08-28T00:05:00Z')]) {
    await reconcileAt(t, camRow('cam-353-alert'));
    assert.equal(isDetecting('cam-353-alert'), true, `${new Date(t).toISOString()}: still running`);
  }
});

// A running activity-only leg is stopped by the next reconcile once the camera is unassigned or its child stops
// tracking sleep: the decision is "not wanted and running -> stop", whatever made it unwanted.
test('#353 an unassigned camera and a tracking-off child both stop a running activity-only leg (kills: reconcile stop branch removed)', async () => {
  const inside = Z('2026-08-27T21:06:00Z'); // 07:06 local: inside the extended window
  makeCamera(db, { id: 'cam-353-a', name: 'Unassign Cam', childId: KID, extra: { detect_source: 'mqtt', detect_motion_enabled: 0 } });
  makeCamera(db, { id: 'cam-353-b', name: 'Untracked Cam', childId: KID, extra: { detect_source: 'mqtt', detect_motion_enabled: 0 } });
  await reconcileAt(inside, camRow('cam-353-a'));
  await reconcileAt(inside, camRow('cam-353-b'));
  assert.equal(isDetecting('cam-353-a'), true, 'precondition: running');
  assert.equal(isDetecting('cam-353-b'), true, 'precondition: running');

  db.prepare('UPDATE cameras SET child_id = NULL WHERE id = ?').run('cam-353-a');
  await reconcileAt(inside, camRow('cam-353-a'));
  assert.equal(isDetecting('cam-353-a'), false, 'unassigned: stopped');

  db.prepare('UPDATE children SET track_sleep = 0 WHERE id = ?').run(KID);
  await reconcileAt(inside, camRow('cam-353-b'));
  assert.equal(isDetecting('cam-353-b'), false, 'tracking off: stopped');
});

// C11 (S1). STRUCTURAL, and weak by nature: index.js cannot be imported by a test (it spawns MediaMTX and the
// transcoders at load), so this reads its SOURCE TEXT. It cannot prove runtime behaviour; it only stops the call
// site being silently reverted to the inline pair that was untestable (the same honest limit as the clip-ring
// call site beside it). Reads the file the way shutdown-grace-declared.test.js reads a repo file.
test('#353 index.js reconcileCameraPaths calls reconcileMotionLeg and no longer carries the inline start/stop pair (structural; cannot prove runtime behaviour) (kills: index.js call site reverted to the inline form)', () => {
  const src = fs.readFileSync(fileURLToPath(new URL('../src/index.js', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('async function reconcileCameraPaths');
  assert.ok(start >= 0, 'reconcileCameraPaths must exist');
  // the function body runs to the next top-level declaration
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(async function|function|const|let) /);
  const body = rest.slice(0, next >= 0 ? next : undefined);
  assert.ok(body.includes('await reconcileMotionLeg(cam);'), 'reconcileCameraPaths must call reconcileMotionLeg(cam)');
  assert.ok(!src.includes('motionLegWanted(cam) && !isDetecting(cam.id)'), 'the inline start condition must be gone');
  assert.ok(!src.includes('!motionLegWanted(cam) && isDetecting(cam.id)'), 'the inline stop condition must be gone');
  assert.match(src, /import \{[^}]*\breconcileMotionLeg\b[^}]*\} from '\.\/lib\/motionDetector\.js'/, 'and it must be imported');
});
