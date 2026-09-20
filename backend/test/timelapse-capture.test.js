// captureChildFrame's camera-selection and eligibility checks. Previously the frame sampler picked a
// child's FIRST camera by sort order with no `disabled` filter at all — a disabled camera's
// streaming/detection legs are off (its RTSP source may be stale or gone), but it could still be
// selected, and could be picked AHEAD OF a working enabled sibling purely by sort order. See this
// repo's Security Advisories / the 2026-09-17 review for the full writeup.
//
// fetchHttpSnapshot/captureSnapshot are mocked (node:test's mock.module) — a real one needs network
// access or a real ffmpeg/RTSP source, neither available here. This is the same deliberate exception
// as talk-socket.test.js's startTalkSession mock: the thing under test (camera SELECTION and
// eligibility re-checking) is 100% real — real DB, real cameras table — only the network/process leaf
// is faked.
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { useTempDataDir, makeChild, makeCamera } from './helpers/harness.js';

useTempDataDir();

const fetchHttpSnapshot = mock.fn(async () => null);
const captureSnapshot = mock.fn(async () => null);
mock.module('../src/lib/snapshot.js', {
  namedExports: { fetchHttpSnapshot: (...args) => fetchHttpSnapshot(...args), captureSnapshot: (...args) => captureSnapshot(...args) },
});

const { default: db } = await import('../src/db.js');
const { captureChildFrame, frameDir } = await import('../src/lib/timelapse.js');

const NIGHT = '2026-09-21';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]); // minimal-but-nonempty stand-in for a real JPEG

function framesIn(childId) {
  try {
    return fs.readdirSync(frameDir(childId, NIGHT)).filter((f) => /^f-\d+\.jpg$/.test(f));
  } catch {
    return [];
  }
}

beforeEach(() => {
  db.prepare('DELETE FROM cameras').run();
  db.prepare('DELETE FROM children').run();
  // useTempDataDir() gives one temp DATA_DIR for the whole FILE, not a fresh one per test — frames
  // written on disk by an earlier test would otherwise still be sitting there (child ids and NIGHT
  // are reused across tests) and inflate a later test's count.
  for (const childId of ['kid-1', 'kid-2']) {
    try { fs.rmSync(frameDir(childId, NIGHT), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  fetchHttpSnapshot.mock.resetCalls();
  captureSnapshot.mock.resetCalls();
  fetchHttpSnapshot.mock.mockImplementation(async () => null);
  captureSnapshot.mock.mockImplementation(async () => null);
});

describe('captureChildFrame — camera selection respects `disabled`', () => {
  test('★ THE FIX: a disabled-only child triggers no HTTP or RTSP snapshot request and stores no frame', async () => {
    const child = makeChild(db, { id: 'kid-1' });
    makeCamera(db, { id: 'cam-1', childId: child.id, extra: { disabled: 1, snapshot_url: 'http://cam.invalid/snap.jpg' } });

    await captureChildFrame(child.id, NIGHT);

    assert.equal(fetchHttpSnapshot.mock.callCount(), 0, 'a disabled camera was still fetched from');
    assert.equal(captureSnapshot.mock.callCount(), 0);
    assert.deepEqual(framesIn(child.id), []);
  });

  test('★ THE FIX: a disabled camera sorted FIRST is excluded, AND sort_order still governs which of the remaining ENABLED cameras is picked', async () => {
    // Three cameras, not two: `disabled = 0` in the WHERE clause means a fixture with only one
    // enabled candidate (a disabled camera plus a single enabled one) can't actually discriminate
    // "excluded by the WHERE filter" from "would have lost an ORDER BY tie-break anyway" — with only
    // one row left after filtering, sort_order never gets compared against anything. A THIRD, later-
    // sorted enabled camera closes that gap: this asserts BOTH that the disabled camera (sorted
    // first) is never even a candidate, AND that among the cameras that remain, the lower sort_order
    // one wins — the second half is real behavior nothing else in this file tests.
    //
    // Inserted out of sort_order order on purpose (second before first): if the query ever silently
    // dropped `ORDER BY sort_order` and fell back to insertion/rowid order among the surviving
    // (enabled) rows, this fixture would pick "second" — a wrong answer indistinguishable from a
    // right one if sort_order happened to already match insertion order, which is why it doesn't here.
    const child = makeChild(db, { id: 'kid-1' });
    makeCamera(db, {
      id: 'cam-disabled', childId: child.id,
      extra: { disabled: 1, sort_order: 0, snapshot_url: 'http://disabled-cam.invalid/snap.jpg' },
    });
    makeCamera(db, {
      id: 'cam-enabled-second', childId: child.id,
      extra: { disabled: 0, sort_order: 2, snapshot_url: 'http://enabled-second.invalid/snap.jpg' },
    });
    makeCamera(db, {
      id: 'cam-enabled-first', childId: child.id,
      extra: { disabled: 0, sort_order: 1, snapshot_url: 'http://enabled-first.invalid/snap.jpg' },
    });
    fetchHttpSnapshot.mock.mockImplementation(async () => JPEG);

    await captureChildFrame(child.id, NIGHT);

    assert.equal(fetchHttpSnapshot.mock.callCount(), 1);
    assert.equal(
      fetchHttpSnapshot.mock.calls[0].arguments[0],
      'http://enabled-first.invalid/snap.jpg',
      'either the disabled camera was used, or sort_order among the enabled cameras was not respected'
    );
    assert.equal(framesIn(child.id).length, 1);
  });

  test('an enabled camera with no disabled sibling still works — the control', async () => {
    const child = makeChild(db, { id: 'kid-1' });
    makeCamera(db, { id: 'cam-1', childId: child.id, extra: { snapshot_url: 'http://cam.invalid/snap.jpg' } });
    fetchHttpSnapshot.mock.mockImplementation(async () => JPEG);

    await captureChildFrame(child.id, NIGHT);

    assert.equal(framesIn(child.id).length, 1);
  });

  test('a child with no cameras at all is a no-op, not a throw', async () => {
    const child = makeChild(db, { id: 'kid-1' });
    await assert.doesNotReject(() => captureChildFrame(child.id, NIGHT));
    assert.equal(fetchHttpSnapshot.mock.callCount(), 0);
  });
});

describe('captureChildFrame — eligibility is re-checked after the (async) capture, not just before it', () => {
  test('★ THE FIX: the camera is disabled WHILE its snapshot fetch is in flight — no frame is written', async () => {
    const child = makeChild(db, { id: 'kid-1' });
    makeCamera(db, { id: 'cam-1', childId: child.id, extra: { snapshot_url: 'http://cam.invalid/snap.jpg' } });

    fetchHttpSnapshot.mock.mockImplementation(async () => {
      // Simulate the camera being disabled by an admin DURING the (slow, real-world) network fetch.
      db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run('cam-1');
      return JPEG;
    });

    await captureChildFrame(child.id, NIGHT);

    assert.deepEqual(framesIn(child.id), [], 'a frame was written from a camera disabled mid-capture');
  });

  test('★ THE FIX: the camera is reassigned to a DIFFERENT child while its snapshot fetch is in flight — no frame is written for either', async () => {
    const child = makeChild(db, { id: 'kid-1' });
    const otherChild = makeChild(db, { id: 'kid-2', name: 'Other Kid' });
    makeCamera(db, { id: 'cam-1', childId: child.id, extra: { snapshot_url: 'http://cam.invalid/snap.jpg' } });

    fetchHttpSnapshot.mock.mockImplementation(async () => {
      db.prepare('UPDATE cameras SET child_id = ? WHERE id = ?').run(otherChild.id, 'cam-1');
      return JPEG;
    });

    await captureChildFrame(child.id, NIGHT);

    assert.deepEqual(framesIn(child.id), []);
    assert.deepEqual(framesIn(otherChild.id), [], "reassignment mid-capture must not backfill the OTHER child's night either — this call was for kid-1's night");
  });

  test('★ THE FIX: the CHILD (not the camera) is deleted while the snapshot fetch is in flight — no frame is written', async () => {
    // cameras.child_id REFERENCES children(id) ON DELETE SET NULL (db.js) — deleting the child, not
    // the camera, still changes what isStillEligibleStmt sees (child_id becomes NULL, no longer
    // matching the childId this call started with). Exercised directly rather than only inferred from
    // the reassignment case above, since nothing else in this file deletes a `children` row.
    const child = makeChild(db, { id: 'kid-1' });
    makeCamera(db, { id: 'cam-1', childId: child.id, extra: { snapshot_url: 'http://cam.invalid/snap.jpg' } });

    fetchHttpSnapshot.mock.mockImplementation(async () => {
      db.prepare('DELETE FROM children WHERE id = ?').run(child.id);
      return JPEG;
    });

    await captureChildFrame(child.id, NIGHT);

    assert.deepEqual(framesIn(child.id), [], "a frame was written for a child deleted mid-capture");
    assert.equal(
      db.prepare('SELECT child_id FROM cameras WHERE id = ?').get('cam-1').child_id,
      null,
      'precondition: deleting the child must actually null the camera\'s child_id (ON DELETE SET NULL) or this test proves nothing'
    );
  });

  test('★ THE FIX: the camera is deleted entirely while its snapshot fetch is in flight — no frame is written', async () => {
    const child = makeChild(db, { id: 'kid-1' });
    makeCamera(db, { id: 'cam-1', childId: child.id, extra: { snapshot_url: 'http://cam.invalid/snap.jpg' } });

    fetchHttpSnapshot.mock.mockImplementation(async () => {
      db.prepare('DELETE FROM cameras WHERE id = ?').run('cam-1');
      return JPEG;
    });

    await captureChildFrame(child.id, NIGHT);

    assert.deepEqual(framesIn(child.id), []);
  });

  test('★ THE FIX: the same re-check applies to the RTSP fallback path, not just the HTTP snapshot_url path', async () => {
    // No snapshot_url at all — every capture goes through captureSnapshot (the ffmpeg/RTSP grab),
    // never fetchHttpSnapshot. The eligibility re-check must not be wired to only one of the two
    // capture paths.
    const child = makeChild(db, { id: 'kid-1' });
    makeCamera(db, { id: 'cam-1', childId: child.id });

    captureSnapshot.mock.mockImplementation(async () => {
      db.prepare('UPDATE cameras SET disabled = 1 WHERE id = ?').run('cam-1');
      return JPEG;
    });

    await captureChildFrame(child.id, NIGHT);

    assert.equal(fetchHttpSnapshot.mock.callCount(), 0, 'precondition: no snapshot_url means the HTTP path is never even attempted');
    assert.deepEqual(framesIn(child.id), [], 'a frame from the RTSP fallback path survived a mid-capture disable');
  });

  test('a camera that stays eligible the whole time still gets its frame written — the control', async () => {
    const child = makeChild(db, { id: 'kid-1' });
    makeCamera(db, { id: 'cam-1', childId: child.id, extra: { snapshot_url: 'http://cam.invalid/snap.jpg' } });
    fetchHttpSnapshot.mock.mockImplementation(async () => JPEG);

    await captureChildFrame(child.id, NIGHT);

    assert.equal(framesIn(child.id).length, 1);
  });
});
