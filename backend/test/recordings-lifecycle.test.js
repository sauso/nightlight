// lib/recordings.js — pressing Record, pressing Stop, and the wake clips that record themselves.
//
// ★ WHY THIS FILE EXISTS. The module sat at 71.6% lines with `startRecording` and `stopRecording`
// reached by nothing: the four existing suites cover the shutdown ARITHMETIC (recordings-shutdown),
// the ring holds (ring-holds) and which rows are listable (recordings-visibility), and all three
// avoid the two functions a user actually triggers. Issue #263's mutation run found 48 of 54 clip
// mutants surviving, and this is where most of them lived — including the wake-clip retention sweeper,
// which could be turned into a no-op with the suite still green.
//
// ⚠️ PATH IS EMPTIED BEFORE ANY IMPORT, same as clip-capture/clip-recorder. `startRecording` needs a
// segmenter to exist, and a segmenter spawns ffmpeg; with a real one present the tests would depend on
// the machine and leave a relaunching process behind. See spawn-failure.test.js's header.
//
// ⚠️ WHAT IS NOT HERE: the SUCCESS branch of `stopRecording` and of `captureWakeClip` — the blocks that
// write `status='ready'` with a path and a duration. Both only run when `extractClip` returns, which
// needs a real encoder. e2e/playwright/tests/10-clip-lifecycle.spec.js covers them against the real
// image. Everything else, including both failure branches, is below.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs, makeChild, makeCamera } from './helpers/harness.js';

const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { CLIPS_DIR, startSegmenter, stopSegmenter, stopAllSegmenters } = await import('../src/lib/clipRecorder.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');
const { holdOwners, RING_OWNER } = await import('../src/lib/ringHolds.js');
const {
  startRecording, stopRecording, stopAllRecordings, stopAllRecordingsForShutdown,
  isRecording, recordingState, reconcileStaleRecordings,
  getOndemandSettings, getWakeClipSettings, captureWakeClip, listChildWakeClips, pruneWakeClips,
  wakeClipStats, listChildRecordings,
} = await import('../src/lib/recordings.js');

const ABS = path.resolve(CLIPS_DIR);
const CHILD = 'kid-1';
const CAM = 'cam-1';
const MOUNTED = `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${ABS} xfs rw 0 0\n`;

const camera = () => db.prepare('SELECT * FROM cameras WHERE id = ?').get(CAM);
const rowOf = (id) => db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
const setSettings = (cols) => {
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE settings SET ${k} = ? WHERE id = ?`).run(v, 'app');
};

// A segmenter with one usable, already-closed segment — enough for `startRecording` to accept and for
// `extractClip` to get past selection before it fails at the (absent) encoder.
function armRing() {
  startSegmenter(CAM, 'testcam');
  const dir = path.join(ABS, '.ring', CAM);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'seg-fixture.mkv');
  fs.writeFileSync(p, 'segment');
  const t = new Date(Date.now() - 3000);
  fs.utimesSync(p, t, t);
}

before(() => {
  fs.mkdirSync(ABS, { recursive: true });
  makeChild(db, { id: CHILD, name: 'Kid' });
  makeCamera(db, { id: CAM, name: 'Nursery', childId: CHILD });
  // Required: `startRecording` and `captureWakeClip` both consult hasMinFreeSpace(), and the module's
  // status starts as "not checked". Supplied /proc/mounts, for the same host-independence reason as
  // clip-storage.test.js.
  assert.equal(checkClipStorage({ mounts: MOUNTED }).ok, true, 'clip storage did not come up ready');
});

after(async () => {
  await stopRecording(CAM, { settleMs: 0 }).catch(() => {});
  stopAllSegmenters();
  db.close();
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(async () => {
  await stopRecording(CAM, { settleMs: 0 }).catch(() => {});
  stopAllSegmenters();
  db.prepare('DELETE FROM recordings').run();
  fs.rmSync(path.join(ABS, '.ring'), { recursive: true, force: true });
  setSettings({
    ondemand_enabled: 1, ondemand_pre_roll_s: 30, ondemand_max_duration_s: 120,
    wake_clips_enabled: 1, wake_clip_seconds: 30, wake_clip_retention_days: 14,
  });
});

// --- pressing Record --------------------------------------------------------------------------------

describe('★ startRecording refuses for every reason a recording would be empty', () => {
  test('the feature switched off', () => {
    armRing();
    setSettings({ ondemand_enabled: 0 });
    assert.throws(() => startRecording(camera()), /turned off in Settings/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, 0, 'a row was written anyway');
  });

  test('a disabled camera', () => {
    armRing();
    assert.throws(() => startRecording({ ...camera(), disabled: 1 }), /camera is disabled/);
  });

  test('★ no ring — the message has to be actionable, because the user sees it verbatim', () => {
    // Deliberately NOT armed. This is the common real case: the camera is offline, or its segmenter
    // has not come up yet after a restart. "Try again in a moment" is the whole difference between a
    // user waiting ten seconds and a user filing a bug.
    assert.throws(() => startRecording(camera()), /isn’t buffering yet/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, 0);
  });

  test('★ unusable storage is caught UPSTREAM, by there being no ring — not by this function', () => {
    // Worth pinning as a relationship, because it is easy to read `startRecording` and conclude the
    // storage guard is missing. It is not here: `startClipCapture` refuses to start a segmenter when
    // `clipStorageReady()` is false, so a camera whose CLIPS_DIR is unmapped or unwritable never has a
    // ring, and the "isn't buffering yet" guard above is what the user sees. One gate, upstream, in
    // the place that owns the ring's lifecycle.
    //
    // ⚠️ NOT TESTED HERE, and it cannot be: the OTHER guard, `hasMinFreeSpace()`, is called with no
    // argument, so it reads the real volume. There is no way to make a CI runner's disk nearly full,
    // and faking it would mean asserting the fake. The predicate itself is tested from both sides in
    // clip-storage.test.js ("exactly at the floor is enough; one byte under is not"); what is untested
    // is the one line here that calls it.
    checkClipStorage({ mounts: '/dev/sda1 / ext4 rw 0 0\n' }); // CLIPS_DIR now reads as the overlay layer
    try {
      assert.throws(() => startRecording(camera()), /isn’t buffering yet/);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, 0);
    } finally {
      assert.equal(checkClipStorage({ mounts: MOUNTED }).ok, true);
    }
  });
});

describe('★ startRecording, when it does start', () => {
  test('writes a row, holds the ring, and reports itself as recording', () => {
    armRing();
    const st = startRecording(camera(), 'u-admin');
    assert.equal(st.recording, true);
    assert.ok(st.id);
    assert.equal(isRecording(CAM), true);

    const row = rowOf(st.id);
    assert.equal(row.status, 'recording');
    assert.equal(row.child_id, CHILD, 'the recording is not attached to the child whose page shows it');
    assert.equal(row.triggered_by, 'u-admin');
    assert.deepEqual(holdOwners(CAM), [RING_OWNER.ONDEMAND], 'the pre-roll is not protected from pruning');
  });

  test('★ started_at is the first frame of the finished video — pre-roll INCLUDED', () => {
    // Not the button press. The video begins `ondemand_pre_roll_s` earlier, and the timestamp on the
    // card is what a parent matches against what they remember. A 30s default makes this visible.
    armRing();
    const before = Date.now();
    const st = startRecording(camera());
    const startedMs = new Date(`${rowOf(st.id).started_at.replace(' ', 'T')}Z`).getTime();
    const behind = before - startedMs;
    assert.ok(behind >= 29_000 && behind <= 40_000, `started_at is ${Math.round(behind / 1000)}s behind the press, expected ~30s`);
  });

  test('★ a double-tap returns the SAME recording rather than starting a second', () => {
    // Two extractions over one ring at once, and two rows for one press. The button is on a phone
    // screen next to a live video; double-taps are ordinary.
    armRing();
    const first = startRecording(camera());
    const second = startRecording(camera());
    assert.equal(second.id, first.id, 'a second press started a second recording');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, 1);
  });

  test('recordingState says nothing is recording when nothing is', () => {
    assert.deepEqual(recordingState(CAM), { recording: false });
    assert.equal(isRecording(CAM), false);
  });

  test('recordingState reports elapsed time while running', () => {
    armRing();
    const st = startRecording(camera());
    const now = recordingState(CAM);
    assert.equal(now.recording, true);
    assert.equal(now.id, st.id);
    assert.ok(now.elapsed_s >= 0 && now.elapsed_s < 5, `implausible elapsed_s: ${now.elapsed_s}`);
  });
});

// --- pressing Stop ----------------------------------------------------------------------------------

describe('★ stopRecording', () => {
  test('a Stop with nothing recording is a no-op, not an error', async () => {
    assert.equal(await stopRecording(CAM), null);
    assert.equal(await stopRecording('never-existed'), null);
  });

  test('★ a failed cut marks the row failed and NEVER throws', async () => {
    // It runs behind a button and behind a timer. A throw here would surface as a request error the
    // user cannot act on in the first case, and as an unhandled rejection in the second. The row is
    // marked 'failed' precisely so the card can say what happened rather than showing nothing — that
    // is issue #276's whole point.
    armRing();
    const st = startRecording(camera());
    const id = await stopRecording(CAM, { settleMs: 0 });
    assert.equal(id, st.id, 'stopRecording must report which row it finished, even on failure');
    assert.equal(rowOf(id).status, 'failed');
    assert.equal(isRecording(CAM), false, 'the camera is still marked as recording after a stop');
  });

  test('★ the ring hold is released even when the cut fails', async () => {
    // The `finally`. Without it a failed recording keeps the ring growing until the segmenter next
    // restarts — an unbounded directory, produced by the failure path, which is the one that happens
    // when something is already wrong.
    armRing();
    startRecording(camera());
    assert.deepEqual(holdOwners(CAM), [RING_OWNER.ONDEMAND], 'precondition: the hold is in place');
    await stopRecording(CAM, { settleMs: 0 });
    assert.deepEqual(holdOwners(CAM), [], 'the hold outlived a failed recording');
  });

  test('the row passes through pending, and ends with a duration covering pre-roll + the live span', async () => {
    armRing();
    const st = startRecording(camera());
    await stopRecording(CAM, { settleMs: 0 });
    const row = rowOf(st.id);
    assert.ok(row.ended_at, 'ended_at was never written');
    // 30s pre-roll + at least 1s of live span + the tail. Asserted as a floor rather than a value:
    // the exact number depends on how long the test took, and pinning it would be pinning the clock.
    assert.ok(row.duration_s >= 31, `duration_s ${row.duration_s} does not include the pre-roll`);
  });
});

describe('★ the auto-stop cap', () => {
  test('a recording nobody stops ends itself at ondemand_max_duration_s', async (t) => {
    // The cap is the only thing bounding an on-demand recording. Someone presses Record, puts the
    // phone down and the app goes to the background: without this the ring is held open and the
    // recording grows until the container restarts. Driven with mocked timers, then handed back to
    // real ones so the async cut can finish.
    setSettings({ ondemand_max_duration_s: 60 });
    armRing();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const st = startRecording(camera());
    assert.equal(isRecording(CAM), true);

    t.mock.timers.tick(59_000);
    assert.equal(isRecording(CAM), true, 'the recording stopped BEFORE its cap');
    t.mock.timers.tick(2_000); // past 60s — the auto-stop fires
    assert.equal(isRecording(CAM), false, 'the cap passed and the recording was still running');

    // ⚠️ The cut that the auto-stop kicked off now waits out `extractClip`'s settle, and THAT
    // setTimeout is mocked too — so `reset()`ing here would drop it and the promise would never
    // settle, which is exactly how this test failed first time. Let the chain register its timer
    // (setImmediate is not mocked), fire it, and only then hand back real timers.
    await new Promise((r) => setImmediate(r));
    t.mock.timers.tick(10_000);
    await new Promise((r) => setImmediate(r));
    t.mock.timers.reset();

    const until = Date.now() + 10_000;
    while (Date.now() < until && rowOf(st.id).status === 'pending') await new Promise((r) => setTimeout(r, 20));
    assert.equal(rowOf(st.id).status, 'failed', 'the auto-stopped recording never finished being cut');
  });
});

describe('★ stopping everything, on the way down', () => {
  test('stopAllRecordings finishes every in-flight recording', async () => {
    makeCamera(db, { id: 'cam-2', name: 'Second', childId: CHILD });
    armRing();
    startSegmenter('cam-2', 'testcam2');
    const a = startRecording(camera());
    const b = startRecording(db.prepare('SELECT * FROM cameras WHERE id = ?').get('cam-2'));
    await stopAllRecordings({ settleMs: 0 });
    assert.equal(rowOf(a.id).status, 'failed');
    assert.equal(rowOf(b.id).status, 'failed');
    assert.equal(isRecording(CAM), false);
    assert.equal(isRecording('cam-2'), false);
    stopSegmenter('cam-2');
  });

  test('...and with nothing in flight it is a quiet no-op', async () => {
    await stopAllRecordings({ settleMs: 0 });
    await stopAllRecordings({ settleMs: 0, budgetMs: 50 });
    assert.ok(true, 'no throw');
  });

  test('★ the budget RESOLVES rather than rejecting when a cut overruns it', async () => {
    // On the way down, a recording that will not finish must not be what stops shutdown: the row is
    // left live and `reconcileStaleRecordings` marks it failed on the next boot. A rejection here
    // would propagate into shutdown() and skip every teardown after it.
    armRing();
    const st = startRecording(camera());
    // A settle far longer than the budget, so the race is decided by the budget every time. 3s rather
    // than something huge because the abandoned cut keeps sleeping in the background afterwards, and a
    // pending timer holds the whole test FILE open until it fires (issue #278's failure mode, in
    // miniature). 3000 against 20 is margin enough.
    await stopAllRecordings({ settleMs: 3_000, budgetMs: 20 });
    assert.equal(isRecording(CAM), false, 'the camera should already have left the active map');
    assert.equal(rowOf(st.id).status, 'pending', 'precondition: the cut really did overrun');
    assert.equal(reconcileStaleRecordings(), 1, 'the abandoned row is not swept on the next boot');
    assert.equal(rowOf(st.id).status, 'failed');
  });

  test('stopAllRecordingsForShutdown states the shutdown intent in one call', async () => {
    // It is the only caller in index.js, and it exists so the call site does not repeat two constants.
    // Exercised for real, because a wrapper that passed the wrong pair would look identical in review.
    armRing();
    const st = startRecording(camera());
    await stopAllRecordingsForShutdown();
    assert.equal(isRecording(CAM), false);
    assert.ok(['failed', 'pending'].includes(rowOf(st.id).status), `unexpected status ${rowOf(st.id).status}`);
  });
});

// --- boot-time cleanup --------------------------------------------------------------------------------

describe('★ reconcileStaleRecordings — the layer that covers a power cut', () => {
  const insert = (status) =>
    db.prepare("INSERT INTO recordings (camera_id, child_id, status, started_at) VALUES (?,?,?,datetime('now'))")
      .run(CAM, CHILD, status).lastInsertRowid;

  test('BOTH live statuses are swept, not just one', () => {
    // ⚠️ The first version of this swept only 'pending', while its comment claimed to cover a SIGKILL.
    // A container killed mid-recording leaves 'recording', which that sweep skipped on every later
    // boot — the same bug the function exists to fix, one status along. Found by review of #277.
    const recording = insert('recording');
    const pending = insert('pending');
    assert.equal(reconcileStaleRecordings(), 2);
    assert.equal(rowOf(recording).status, 'failed');
    assert.equal(rowOf(pending).status, 'failed');
  });

  test('★ terminal rows are left completely alone', () => {
    const ready = insert('ready');
    const failed = insert('failed');
    assert.equal(reconcileStaleRecordings(), 0, 'a finished recording was swept');
    assert.equal(rowOf(ready).status, 'ready');
    assert.equal(rowOf(failed).status, 'failed');
  });

  test('★ a status invented later is skipped, not clobbered', () => {
    // The query is an ALLOW-LIST of live states, deliberately, so this is a property of the design
    // rather than an accident of the current values.
    const future = insert('uploading');
    assert.equal(reconcileStaleRecordings(), 0);
    assert.equal(rowOf(future).status, 'uploading', 'an unknown status was swept to failed');
  });

  test('and the swept rows then APPEAR on the child’s page', () => {
    // The visible half of #256: the user pressed Record, the button behaved, and then nothing ever
    // showed up. A row marked failed is what turns that silence into an explanation.
    const id = insert('recording');
    reconcileStaleRecordings();
    assert.deepEqual(listChildRecordings(CHILD).map((r) => r.id), [id]);
  });
});

// --- wake clips -----------------------------------------------------------------------------------------

describe('wake-clip settings', () => {
  test('the defaults are on / 30s / 14 days, and come from the settings row', () => {
    assert.deepEqual(getWakeClipSettings(), { enabled: true, clipSeconds: 30, retentionDays: 14 });
    setSettings({ wake_clips_enabled: 0, wake_clip_seconds: 45, wake_clip_retention_days: 7 });
    assert.deepEqual(getWakeClipSettings(), { enabled: false, clipSeconds: 45, retentionDays: 7 });
  });

  test('★ 0 retention days survives the fallback, because 0 MEANS something here', () => {
    // `Number.isFinite(days) && days >= 0` — a `days > 0` test would silently turn "keep forever" into
    // the 14-day default and delete a year of clips somebody chose to keep.
    setSettings({ wake_clip_retention_days: 0 });
    assert.equal(getWakeClipSettings().retentionDays, 0);
  });

  test('a nonsense clip length falls back to 30s rather than becoming NaN', () => {
    setSettings({ wake_clip_seconds: 0 });
    assert.equal(getWakeClipSettings().clipSeconds, 30, '0 seconds would produce an empty clip');
    db.prepare("UPDATE settings SET wake_clip_seconds = 'thirty' WHERE id = ?").run('app');
    assert.equal(getWakeClipSettings().clipSeconds, 30);
  });

  test('on-demand settings fall back the same way', () => {
    db.prepare("UPDATE settings SET ondemand_pre_roll_s = 'lots', ondemand_max_duration_s = 'ages' WHERE id = ?").run('app');
    const s = getOndemandSettings();
    assert.equal(s.preRollSec, 30);
    assert.equal(s.maxDurationSec, 120);
    assert.equal(s.enabled, true);
  });
});

describe('★ captureWakeClip refuses quietly — it runs behind a detector', () => {
  test('returns null rather than throwing when the feature is off', async () => {
    armRing();
    setSettings({ wake_clips_enabled: 0 });
    assert.equal(await captureWakeClip(camera(), Date.now() - 60_000), null);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, 0);
  });

  test('returns null when there is no ring to cut from', async () => {
    assert.equal(await captureWakeClip(camera(), Date.now() - 60_000), null);
  });

  test('★ a failed capture resolves rather than rejecting — a bad clip must not stop the watcher', async () => {
    // It is called from a timer inside the wake watcher. An unhandled rejection there takes wake
    // detection down for every camera, for the rest of the night, silently.
    //
    // ⚠️ THIS TEST'S ONLY REAL ASSERTION IS THAT IT DOES NOT REJECT. It used to end with
    // `if (id != null) assert.equal(rowOf(id).status, 'failed')`, which NEVER RAN: this path always
    // resolves null, so the guard was permanently false and the row's fate went unchecked. The row
    // is now asserted in the test below, which finds it by query instead of by return value.
    armRing();
    assert.equal(await captureWakeClip(camera(), Date.now() - 60_000), null);
  });

  test('★ a capture that fails after the INSERT leaves the row `failed`, never `pending`', async () => {
    // The row is written 'pending' BEFORE the clip is cut, so a failure between the two must move it
    // on. A row stuck 'pending' shows in the UI as a recording forever in progress, and the storage
    // readout counts it.
    //
    // ⚠️ FIND THE ROW BY QUERY, NOT BY RETURN VALUE. captureWakeClip returns null on failure — which
    // is exactly why the previous test could not check this — so a test that starts from the returned
    // id is testing nothing. Deleting the `UPDATE ... status='failed'` line left the whole suite
    // green until this existed.
    armRing();
    setSettings({ wake_clips_enabled: 1 });
    const before = db.prepare("SELECT COALESCE(MAX(id), 0) m FROM recordings WHERE kind = 'wake'").get().m;
    assert.equal(await captureWakeClip(camera(), Date.now() - 60_000), null, 'expected this capture to fail');
    const row = db.prepare("SELECT id, status FROM recordings WHERE kind = 'wake' AND id > ? ORDER BY id DESC LIMIT 1").get(before);
    assert.ok(row, 'no wake row was inserted — the fixture no longer reaches the INSERT, so this test is inert');
    assert.equal(row.status, 'failed', `row ${row.id} was left '${row.status}'`);
  });

  test('★ a throw from the PRE-FLIGHT work also resolves, not just one from the capture', async () => {
    // REGRESSION, issue #309. The JSDoc said "Never throws" and the try opened AFTER the free-space
    // check and the INSERT, so anything that failed in that window — SQLITE_BUSY, a disk error —
    // rejected the promise instead. The one live caller happened to have its own `.catch()`, which is
    // why nothing noticed; the next caller, trusting the JSDoc, would not have had one.
    //
    // A non-finite wakeStartMs reaches `new Date(NaN).toISOString()` in exactly that window and
    // throws RangeError. The specific input matters less than WHERE it throws: the previous test
    // fails inside extractClip, which was always covered.
    armRing();
    setSettings({ wake_clips_enabled: 1 });
    const before = db.prepare('SELECT COUNT(*) n FROM recordings').get().n;
    assert.equal(await captureWakeClip(camera(), NaN), null, 'rejected instead of resolving to null');
    // ⚠️ WHAT THIS DOES *NOT* PROVE, stated so nobody reads more into it. NaN throws at the
    // `new Date(NaN).toISOString()` line, which is BEFORE the INSERT — so "no pending row" here is
    // true of every possible implementation and cannot fail. The stranded-row property is a real one
    // and is asserted by the test above, on a path that actually writes a row. An earlier version
    // of this test asserted it here and called that verification; it was not.
    assert.equal(db.prepare('SELECT COUNT(*) n FROM recordings').get().n, before,
      'the throw happened after a row was written — move the stranded-row assertion here');
  });
});

describe('★ wake-clip retention — the sweeper that runs unattended every night', () => {
  const wakeClip = ({ ageDays = 0, status = 'ready', bytes = 1000 } = {}) => {
    const rel = path.join(CAM, `wake-${Math.random().toString(36).slice(2, 8)}.mp4`);
    fs.mkdirSync(path.join(ABS, CAM), { recursive: true });
    fs.writeFileSync(path.join(ABS, rel), 'clip');
    const id = db
      .prepare(
        `INSERT INTO recordings (camera_id, child_id, status, kind, started_at, bytes, path)
         VALUES (?,?,?, 'wake', datetime('now'), ?, ?)`
      )
      .run(CAM, CHILD, status, bytes, rel).lastInsertRowid;
    if (ageDays) {
      db.prepare("UPDATE recordings SET created_at = datetime('now', ?) WHERE id = ?").run(`-${ageDays} days`, id);
    }
    return { id, abs: path.join(ABS, rel) };
  };

  test('★ it deletes an expired clip — the row AND the file', () => {
    const old = wakeClip({ ageDays: 40 });
    assert.equal(pruneWakeClips(), 1, 'nothing was pruned');
    assert.equal(rowOf(old.id), undefined);
    assert.equal(fs.existsSync(old.abs), false, 'the row went but the file stayed — the disk still fills');
  });

  test('★ and leaves one inside the window — the control', () => {
    const fresh = wakeClip({ ageDays: 1 });
    const old = wakeClip({ ageDays: 40 });
    assert.equal(pruneWakeClips(), 1);
    assert.ok(rowOf(fresh.id), 'a clip inside the retention window was deleted');
    assert.equal(rowOf(old.id), undefined);
  });

  test('★ 0 days means keep forever', () => {
    setSettings({ wake_clip_retention_days: 0 });
    const ancient = wakeClip({ ageDays: 900 });
    assert.equal(pruneWakeClips(), 0);
    assert.ok(rowOf(ancient.id), '0 days deleted clips instead of keeping them');
  });

  test('★ it never touches a MANUAL recording, however old', () => {
    // The difference that people get wrong, and the reason `kind` exists: manual recordings are
    // keepsakes somebody chose to keep and have NO automatic retention at all. A sweeper that took
    // them too would quietly delete the thing the feature exists to preserve.
    const manual = db
      .prepare("INSERT INTO recordings (camera_id, child_id, status, kind, started_at) VALUES (?,?, 'ready', 'manual', datetime('now'))")
      .run(CAM, CHILD).lastInsertRowid;
    db.prepare("UPDATE recordings SET created_at = datetime('now', '-900 days') WHERE id = ?").run(manual);
    wakeClip({ ageDays: 900 });
    assert.equal(pruneWakeClips(), 1, 'exactly the wake clip should have gone');
    assert.ok(rowOf(manual), 'a manual keepsake was swept by wake-clip retention');
  });

  test('a failed wake clip is pruned too — it has a row to clean up even without a file', () => {
    const failed = wakeClip({ ageDays: 40, status: 'failed' });
    assert.equal(pruneWakeClips(), 1);
    assert.equal(rowOf(failed.id), undefined);
  });
});

describe('wake clips on the morning timeline', () => {
  const wakeAt = (startedAtSql, status = 'ready') =>
    db.prepare(
      `INSERT INTO recordings (camera_id, child_id, status, kind, started_at, duration_s, bytes)
       VALUES (?,?,?, 'wake', ?, 30, 500)`
    ).run(CAM, CHILD, status, startedAtSql).lastInsertRowid;

  test('★ only READY clips inside the window, in time order', () => {
    // The timeline renders these as playable evidence beside a wake. A 'pending' or 'failed' row here
    // is a control that does nothing when pressed.
    const early = wakeAt('2026-07-01 20:00:00');
    const late = wakeAt('2026-07-02 03:00:00');
    wakeAt('2026-07-02 03:30:00', 'failed');
    wakeAt('2026-06-30 20:00:00'); // the night before
    const got = listChildWakeClips(CHILD, '2026-07-01 08:00:00', '2026-07-02 08:00:00');
    assert.deepEqual(got.map((r) => r.id), [early, late]);
  });

  test('the window end is exclusive', () => {
    wakeAt('2026-07-02 08:00:00');
    assert.deepEqual(listChildWakeClips(CHILD, '2026-07-01 08:00:00', '2026-07-02 08:00:00'), []);
  });

  test('another child’s clips never appear', () => {
    makeChild(db, { id: 'kid-2', name: 'Other' });
    db.prepare(
      `INSERT INTO recordings (camera_id, child_id, status, kind, started_at) VALUES (?, 'kid-2', 'ready', 'wake', ?)`
    ).run(CAM, '2026-07-01 20:00:00');
    assert.deepEqual(listChildWakeClips(CHILD, '2026-07-01 08:00:00', '2026-07-02 08:00:00'), []);
  });

  test('wakeClipStats counts ready wake clips only, and is zero rather than null when empty', () => {
    assert.deepEqual(wakeClipStats(), { count: 0, bytes: 0 });
    wakeAt('2026-07-01 20:00:00');
    wakeAt('2026-07-01 21:00:00', 'failed');
    assert.deepEqual(wakeClipStats(), { count: 1, bytes: 500 });
  });
});
