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
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { reconcileStaleRecordings, stopAllRecordings } = await import('../src/lib/recordings.js');

function insertRecording({ id, status, path = null, kind = 'manual' }) {
  db.prepare(
    `INSERT INTO recordings (id, camera_id, child_id, status, started_at, kind, path)
     VALUES (@id, 'cam-1', 'kid-1', @status, datetime('now'), @kind, @path)`
  ).run({ id, status, kind, path });
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

  test('it leaves finished recordings completely alone', () => {
    // The fixture is hostile on purpose: if the sweep were written as a blanket UPDATE, these would be
    // destroyed — a ready recording turned into a failed one is worse than the bug being fixed.
    insertRecording({ id: 102, status: 'ready', path: 'cam-1/rec-102.mp4' });
    insertRecording({ id: 103, status: 'failed' });
    insertRecording({ id: 104, status: 'pending' });

    assert.equal(reconcileStaleRecordings(), 1, 'it touched more rows than the one pending recording');
    assert.equal(statusOf(102).status, 'ready');
    assert.equal(statusOf(102).path, 'cam-1/rec-102.mp4', 'a finished recording lost its file path');
    assert.equal(statusOf(103).status, 'failed');
    assert.equal(statusOf(104).status, 'failed');
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
    await assert.doesNotReject(() => stopAllRecordings({ budgetMs: 50 }));
    await assert.doesNotReject(() => stopAllRecordings());
  });
});
