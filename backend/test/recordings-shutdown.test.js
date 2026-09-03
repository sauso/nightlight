// A recording interrupted by a restart must not vanish without trace.
//
// The defect (issue #256): `stopAllRecordings()` was the ONLY un-awaited stop in shutdown(), and the
// timings made the loss certain rather than likely — extractClip settles for SEGMENT_SETTLE_MS (5s)
// while stopAllTranscoders bounds the rest of shutdown at 3s, so `process.exit(0)` always won. The
// comment directly above the call promised "Finish any in-flight recording first", which the code did
// not do. The row was then left `{status:'pending', path:null}` forever, and `listChildRecordings`
// filters on `status='ready'` — so the user saw a recording that simply never appeared, with nothing
// explaining why. A container restart is routine; every deploy does one.
//
// Two layers are needed and this file tests both:
//   1. actually try to save it (bounded, best-effort)
//   2. guarantee the row is not left lying (boot sweep) — the layer that covers a SIGKILL or a power
//      cut, where no shutdown handler runs at all
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const {
  reconcileStaleRecordings,
  stopAllRecordings,
  SEGMENT_SETTLE_MS,
  SHUTDOWN_SETTLE_MS,
  SHUTDOWN_BUDGET_MS,
} = await import('../src/lib/recordings.js');
const indexSrc = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

// ⚠️ HOSTILE BY CONSTRUCTION, AND DERIVED FROM THE SCHEMA rather than a list I typed. The first
// version of this fixture set only id/status/kind/path, so a sweep that ALSO nulled thumb_path, bytes,
// duration_s, ended_at, child_id or triggered_by was invisible to it — adversarial review of PR #277
// demonstrated exactly that mutant surviving. A NULL that leaks looks identical to a field correctly
// left alone. Reading the columns from PRAGMA is what makes a column added next year fail this too;
// the same tripwire earned its keep in cameras-assign-exposure.test.js on its first run.
const COLUMNS = db
  .prepare('PRAGMA table_info(recordings)')
  .all()
  .map((c) => c.name)
  .filter((n) => n !== 'id' && n !== 'status');

// Types matter: bytes/duration_s are numeric and the timestamps are text, and a value SQLite rejects
// would leave the very column we are trying to protect unset.
function markerFor(name, id) {
  if (name === 'bytes' || name === 'duration_s') return 1000 + id;
  if (name.endsWith('_at')) return '2026-01-01 00:00:00';
  return `MARKER-${name}-${id}`;
}

function insertRecording({ id, status, kind = 'manual' }) {
  const cols = ['id', 'status', ...COLUMNS];
  const values = { id, status };
  for (const c of COLUMNS) values[c] = c === 'kind' ? kind : markerFor(c, id);
  db.prepare(
    `INSERT INTO recordings (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`
  ).run(values);
  return values;
}

// Re-read every column and prove the sweep changed nothing but status.
function assertOnlyStatusChanged(planted, id) {
  const row = db.prepare('SELECT * FROM recordings WHERE id = ?').get(id);
  for (const c of COLUMNS) {
    assert.equal(row[c], planted[c], `the sweep clobbered column '${c}' on row ${id}`);
  }
}

const statusOf = (id) => db.prepare('SELECT status, path FROM recordings WHERE id = ?').get(id);

before(() => {
  db.prepare('DELETE FROM recordings').run();
});

after(() => {
  cleanupTempDataDirs();
});

describe('reconcileStaleRecordings', () => {
  test('a pending row left by an interrupted shutdown is marked failed', () => {
    // At boot nothing can legitimately be pending: that status exists only between stopRecording
    // updating the row and extractClip finishing, and the in-process `active` map is gone.
    insertRecording({ id: 101, status: 'pending' });
    const changed = reconcileStaleRecordings();

    assert.equal(changed, 1, 'the stale row was not cleaned up');
    assert.equal(statusOf(101).status, 'failed');
  });

  test('a row still marked RECORDING — killed mid-capture — is swept too', () => {
    // ★ The case the first version missed, found by adversarial review of #277. startRecording INSERTs
    // status='recording'; a row only becomes 'pending' inside stopRecording. So the SIGKILL and
    // power-cut scenarios this function's comment claims to cover leave 'recording', not 'pending' —
    // and a sweep that named only 'pending' skipped them on every subsequent boot. Same bug as #256,
    // one status along, and invisible forever because listChildRecordings shows 'ready' only.
    insertRecording({ id: 110, status: 'recording' });
    assert.equal(reconcileStaleRecordings(), 1, 'a recording killed mid-capture was left in limbo');
    assert.equal(statusOf(110).status, 'failed');
  });

  test('it leaves finished recordings completely alone, field by field', () => {
    // If the sweep were a blanket UPDATE these would be destroyed — a ready recording turned into a
    // failed one is worse than the bug being fixed. The row is re-read column by column, because a
    // sweep that also NULLed path/thumb_path/bytes was invisible to the old fixture.
    const ready = insertRecording({ id: 102, status: 'ready' });
    const failed = insertRecording({ id: 103, status: 'failed' });
    insertRecording({ id: 104, status: 'pending' });

    assert.equal(reconcileStaleRecordings(), 1, 'it touched more rows than the one pending recording');
    assert.equal(statusOf(102).status, 'ready');
    assert.equal(statusOf(103).status, 'failed');
    assert.equal(statusOf(104).status, 'failed');
    assertOnlyStatusChanged(ready, 102);
    assertOnlyStatusChanged(failed, 103);
  });

  test('the row it DOES sweep keeps every other field intact', () => {
    // The swept row matters just as much: its started_at, duration and camera are what a future
    // "this recording failed" view would show. Only `status` may change.
    const planted = insertRecording({ id: 107, status: 'pending' });
    assert.equal(reconcileStaleRecordings(), 1);
    assert.equal(statusOf(107).status, 'failed');
    assertOnlyStatusChanged(planted, 107);
  });

  test('it sweeps wake clips too, not just manual recordings', () => {
    // captureWakeClip writes into the same table with kind='wake'. An interrupted one strands a row
    // exactly the same way, and a sweep that filtered on kind would miss half the problem.
    insertRecording({ id: 105, status: 'pending', kind: 'wake' });
    assert.equal(reconcileStaleRecordings(), 1);
    assert.equal(statusOf(105).status, 'failed');
  });

  test('it is idempotent — a second boot changes nothing', () => {
    insertRecording({ id: 106, status: 'pending' });
    assert.equal(reconcileStaleRecordings(), 1);
    assert.equal(reconcileStaleRecordings(), 0, 'it kept rewriting rows it had already cleaned');
  });

  test('a clean database sweeps nothing and does not throw', () => {
    db.prepare('DELETE FROM recordings').run();
    assert.equal(reconcileStaleRecordings(), 0);
  });
});

describe('stopAllRecordings', () => {
  test('with nothing in flight it resolves promptly, budget or not', async () => {
    // Shutdown must not pay the budget when there is nothing to wait for — that would add 6s to every
    // ordinary container stop.
    const startedAt = Date.now();
    await stopAllRecordings({ budgetMs: 6000 });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 1000, `an empty stop took ${elapsed}ms — it is waiting out the budget`);
  });

  test('it resolves rather than rejects, so shutdown always continues', async () => {
    // A rejection here would propagate into shutdown() and skip every stop after it — the transcoders,
    // MediaMTX and MQTT — which is a worse outcome than a lost clip.
    //
    // ⚠️ UNPROVEN FOR THE TIMEOUT BRANCH, and said plainly rather than implied: with nothing in the
    // in-process `active` map the work always wins the race, so the budget's own resolve path is never
    // reached here. Driving it needs a real in-flight recording, which needs a live segmenter and
    // therefore ffmpeg. Review of #277 confirmed a mutant making the timeout REJECT survives this.
    await assert.doesNotReject(() => stopAllRecordings({ budgetMs: 50 }));
    await assert.doesNotReject(() => stopAllRecordings());
  });

  test('the shutdown settle fits inside the shutdown budget', () => {
    // A settle longer than the budget makes the whole save path permanently inert — it would time out
    // before extractClip could even begin, so layer 1 of #256 would silently do nothing while looking
    // present. That mutant (settle 2500 -> 60000) survived the first version of this file.
    assert.ok(
      SHUTDOWN_SETTLE_MS < SHUTDOWN_BUDGET_MS,
      `settle ${SHUTDOWN_SETTLE_MS}ms must leave room inside the ${SHUTDOWN_BUDGET_MS}ms budget`
    );
    // And it must leave enough room to actually extract, not merely to settle.
    assert.ok(SHUTDOWN_BUDGET_MS - SHUTDOWN_SETTLE_MS >= 2000, 'no time left to cut the clip after settling');
    // The shutdown settle is deliberately shorter than the normal one; if that inverts, the shutdown
    // path is slower than the everyday path and the constant has lost its purpose.
    assert.ok(SHUTDOWN_SETTLE_MS < SEGMENT_SETTLE_MS, 'the shutdown settle is no longer the shorter one');
  });

  test('shutdown stays inside Docker’s default 10s stop grace', () => {
    // Arithmetic, because this is not otherwise observable and getting it wrong is a REGRESSION that a
    // green suite would never show. Each detector stop and the transcoder stop are each bounded by a 3s
    // force-kill. Awaiting the recording stop in sequence gave 3+3+6+3 = 15s against a default grace of
    // 10s (docker-compose.yml sets no stop_grace_period, and a hand-rolled `docker run` has none) —
    // where the pre-PR worst case was 9s. Overlapping the recording wait with the detector stops
    // restores that: max(6, 3+3) + 3 = 9s. Found by adversarial review of #277.
    const FORCE_KILL_MS = 3000; // motionDetector.js / soundDetector.js / transcoder.js
    const detectors = FORCE_KILL_MS * 2; // motion + sound (ONVIF is not process-bound)
    const worstCase = Math.max(SHUTDOWN_BUDGET_MS, detectors) + FORCE_KILL_MS;
    assert.ok(worstCase <= 9000, `worst-case shutdown is now ${worstCase}ms — it must not exceed the pre-PR 9000ms`);

    // ...and the code must actually overlap them, not await in place. A source check, because
    // index.js boots the whole app and cannot be unit-tested.
    const started = indexSrc.indexOf('const recordingsFinished = stopAllRecordingsForShutdown();');
    const awaited = indexSrc.indexOf('await recordingsFinished;');
    const clipCapture = indexSrc.indexOf('stopAllClipCapture();');
    assert.ok(started !== -1, 'the recording stop is no longer started before the detector stops');
    assert.ok(awaited > started, 'the recording stop is never awaited — #256 is reintroduced');
    assert.ok(awaited < clipCapture, 'the ring is torn down before the recording finishes cutting from it');
  });
});

describe('index.js wiring', () => {
  // ⚠️ Source-text assertions, and they prove wiring not behaviour. They exist because adversarial
  // review of #277 reintroduced BOTH original defects at the wiring layer with the suite fully green:
  // no test anywhere referenced index.js, so deleting the boot sweep or dropping the await was free.
  test('the boot sweep is called at startup', () => {
    assert.match(indexSrc, /reconcileStaleRecordings\(\);/, 'nothing cleans up stale rows at boot — #256 half-reverted');
  });

  test('the boot sweep runs before cameras are reconciled', () => {
    // Order matters: clean the debris before anything new can start writing rows.
    assert.ok(
      indexSrc.indexOf('reconcileStaleRecordings();') < indexSrc.indexOf('reconcileCameraPaths();'),
      'the sweep runs after camera reconcile'
    );
  });
});
