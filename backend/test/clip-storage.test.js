// Clip storage: the startup guard, the free-space floor, and the retention sweeper.
//
// ★ WHY THIS FILE EXISTS. `lib/clipStorage.js` had NO test file at all, and was not in `test:core`'s
// coverage-include list either — so its absence did not even show up as a number. Issue #263's single
// most alarming finding came from here: **adding an early `return` to `sweepClips()` left the entire
// 389-test suite green**. The retention sweeper is the only thing standing between a baby monitor and
// a full disk, and it could have been deleted outright without a single test noticing.
//
// The sweeper is also the piece with the most ways to be subtly wrong rather than absent: two
// independent bounds (age and total size), each disabled by 0, applied in a fixed order, with the
// size pass walking oldest-first and stopping the moment it is under the cap. Every one of those is
// pinned below against a mutant that changes it — see scripts/mutants.json.
//
// ⚠️ NOTHING HERE MAY DEPEND ON THE MACHINE IT RUNS ON. Two of this module's decisions are about the
// host — is CLIPS_DIR on a real mount, is there disk free — and read naively they give a different
// answer on Windows, on a Linux CI runner and on Unraid. Both are injected here instead (`mounts`,
// `free`), so each branch is exercised on every machine. That seam exists for this reason and the
// source says so.
import { test, before, after, beforeEach, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const ev = await import('../src/lib/detectionEvents.js');
const {
  checkClipStorage, clipStorageReady, isOnRealMount, readMounts, freeBytes, hasMinFreeSpace,
  MIN_FREE_BYTES, clipStorageStats, sweepClips, startClipStorage, stopClipStorage,
} = await import('../src/lib/clipStorage.js');

const ABS = path.resolve(CLIPS_DIR);

// /proc/mounts format: "<device> <mountpoint> <fstype> <options> 0 0", one per line.
//
// ⚠️ TWO SETS OF FIXTURES, ON PURPOSE. The parsing is POSIX by nature — it reads a Linux kernel file
// and joins with "/" — so the tests OF the parser use POSIX paths (`POSIX_*`) and would be nonsense
// written any other way. The tests of `checkClipStorage` have to talk about the REAL CLIPS_DIR, which
// on a Windows dev machine is a `C:\...` path; those use `MOUNTED`/`UNMAPPED`, which name that path
// EXACTLY rather than as a parent directory, because an exact match is the one comparison that behaves
// identically under both separators. Mixing the two is what makes this file pass on Linux and fail on
// Windows (it did, first time).
const POSIX_MOUNTED = 'proc /proc proc rw 0 0\n/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /recordings xfs rw 0 0\n';
const POSIX_UNMAPPED = 'proc /proc proc rw 0 0\n/dev/sda1 / ext4 rw 0 0\n';

// CLIPS_DIR mapped as its own mountpoint — the healthy production shape, a bind mount or a volume.
const MOUNTED = `proc /proc proc rw 0 0\n/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${ABS} xfs rw 0 0\n`;
// The same host WITHOUT that mapping, so nothing in the list contains CLIPS_DIR.
const UNMAPPED = 'proc /proc proc rw 0 0\n/dev/sda1 / ext4 rw 0 0\n';

// Bring the module into its "storage is fine" state, which is what gates capture and the sweeper.
const makeReady = () => checkClipStorage({ mounts: MOUNTED });

function makeClip(name, { bytes = 1000, ageDays = 0 } = {}) {
  const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
  const rel = path.join('cam-1', name);
  fs.mkdirSync(path.join(ABS, 'cam-1'), { recursive: true });
  fs.writeFileSync(path.join(ABS, rel), 'x');
  ev.setClipReady(id, rel, 5, bytes);
  if (ageDays) {
    db.prepare("UPDATE detection_events SET created_at = datetime('now', ?) WHERE id = ?")
      .run(`-${ageDays} days`, id);
  }
  return { id, rel, abs: path.join(ABS, rel) };
}

// An on-demand recording. Its own table, never touched by clip retention — `started_at` is NOT NULL
// and the id autoincrements, so both are supplied by the schema's rules rather than invented here.
const makeRecording = (status, bytes) =>
  db.prepare("INSERT INTO recordings (camera_id, status, started_at, bytes) VALUES ('cam-1', ?, datetime('now'), ?)")
    .run(status, bytes);

const setRetention = (days, maxGb) =>
  db.prepare('UPDATE settings SET clip_retention_days = ?, clip_retention_max_gb = ? WHERE id = ?')
    .run(days, maxGb, 'app');

const liveClipIds = () =>
  db.prepare('SELECT id FROM detection_events WHERE clip_path IS NOT NULL ORDER BY id').all().map((r) => r.id);

before(() => { fs.mkdirSync(ABS, { recursive: true }); });

after(() => {
  stopClipStorage();
  db.close();
  cleanupTempDataDirs();
});

beforeEach(() => {
  db.prepare('DELETE FROM detection_events').run();
  db.prepare('DELETE FROM recordings').run();
  fs.rmSync(path.join(ABS, 'cam-1'), { recursive: true, force: true });
  setRetention(14, 5);
  makeReady();
});

// --- the /proc/mounts reading ------------------------------------------------------------------

describe('is CLIPS_DIR on a real mount, or on the container overlay?', () => {
  test('a directory that IS its own mountpoint counts as mapped', () => {
    assert.equal(isOnRealMount('/recordings', POSIX_MOUNTED), true);
  });

  test('a directory INSIDE a mountpoint counts too — a subdirectory of /recordings is still mapped', () => {
    assert.equal(isOnRealMount('/recordings/clips', POSIX_MOUNTED), true);
  });

  test('★ falling under "/" alone means the ephemeral layer, and is refused', () => {
    // The case the whole guard exists for: clips written here vanish when the container is recreated
    // and bloat the image in the meantime, and neither is visible until it has already happened.
    assert.equal(isOnRealMount('/app/data/clips', POSIX_UNMAPPED), false);
  });

  test('★ the DEEPEST containing mountpoint wins, not the first or the last', () => {
    // "/" contains everything, so a scan that took the first (or any) match would call every path
    // unmapped. Ordered with "/" LAST so a "take the last match" implementation fails here too.
    const mounts = '/dev/sdb1 /recordings xfs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n';
    assert.equal(isOnRealMount('/recordings/clips', mounts), true, 'a deeper mountpoint was ignored in favour of "/"');
  });

  test('★ a mountpoint that merely shares a prefix does not count', () => {
    // "/recordings" is not a parent of "/recordingsX/clips", and treating it as one reports an
    // UNMAPPED path as mapped — the guard failing open, which is the direction that hurts.
    //
    // ⚠️ The separator is what makes the difference, so the fixture has to be arranged so nothing else
    // decides the answer. "/" is deliberately absent from this mounts list: with it present the answer
    // is `false` either way (via `deepest === '/'`), and the test passes without discriminating —
    // which is exactly how it was written first, and mutation testing caught it.
    const mounts = '/dev/sdb1 /recordings xfs rw 0 0\n';
    assert.equal(isOnRealMount('/recordingsX/clips', mounts), false, 'a prefix match was treated as containment');
    // The control, on the same mounts list: a path genuinely inside it IS mapped.
    assert.equal(isOnRealMount('/recordings/clips', mounts), true);
  });

  test('/proc/mounts escapes spaces as \\040, and they are decoded', () => {
    const spaced = '/mnt/my disk/clips';
    assert.equal(isOnRealMount(spaced, '/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\n'), true);
    // ...and the raw, undecoded form must NOT match, or the decode is doing nothing.
    assert.equal(isOnRealMount('/mnt/my\\040disk/clips', '/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /mnt/my\\040disk xfs rw 0 0\n'), false);
  });

  test('blank and malformed lines are skipped rather than throwing', () => {
    assert.equal(isOnRealMount('/recordings', '\n\nnotalineactually\n/dev/sdb1 /recordings xfs rw 0 0\n\n'), true);
  });

  test('no mounts file at all means "cannot check" — and must not block recording', () => {
    // The dev-machine case. Failing closed here would make the app unusable outside a Linux container.
    assert.equal(isOnRealMount('/recordings', null), true);
  });

  test('readMounts returns the file on Linux and null everywhere else — never throws', () => {
    // Whatever machine this runs on, exactly one of the two is true, and neither is an error. This is
    // the ONE assertion in the file that is allowed to be host-dependent, because it is about the host.
    const m = readMounts();
    assert.ok(m === null || typeof m === 'string', `readMounts returned ${typeof m}`);
    if (m !== null) assert.match(m, /\//, 'a /proc/mounts with no mountpoints in it');
  });
});

// --- the startup guard -------------------------------------------------------------------------

describe('the startup guard decides whether recording runs at all', () => {
  test('a writable, mapped directory is OK, and the directory is created if missing', () => {
    fs.rmSync(ABS, { recursive: true, force: true });
    const st = checkClipStorage({ mounts: MOUNTED });
    assert.deepEqual(st, { ok: true, path: ABS, writable: true, onMount: true, reason: 'ok' });
    assert.equal(fs.existsSync(ABS), true, 'CLIPS_DIR was not created');
    assert.equal(clipStorageReady(), true);
  });

  test('the write probe leaves nothing behind', () => {
    makeReady();
    assert.equal(fs.existsSync(path.join(ABS, '.write-test')), false, 'the probe file was not cleaned up');
  });

  test('★ writable but NOT mapped is refused, and says why', () => {
    const st = checkClipStorage({ mounts: UNMAPPED });
    assert.equal(st.ok, false);
    assert.equal(st.writable, true, 'the directory really was writable — that is not the complaint');
    assert.equal(st.onMount, false);
    assert.equal(st.reason, 'unmapped container path');
    assert.equal(clipStorageReady(), false, 'capture would still be allowed to run');
  });

  test('★ an unwritable path is refused before the mount question is even asked', () => {
    // Made unwritable portably: a FILE where the directory should be, so mkdirSync throws on every OS.
    // chmod would be a no-op on Windows and this branch would go untested on a dev machine.
    fs.rmSync(ABS, { recursive: true, force: true });
    fs.writeFileSync(ABS, 'not a directory');
    try {
      const st = checkClipStorage({ mounts: MOUNTED });
      assert.equal(st.ok, false);
      assert.equal(st.writable, false);
      assert.equal(st.reason, 'not writable');
      assert.equal(st.onMount, false, 'an unwritable path must not claim to be on a mount');
    } finally {
      fs.rmSync(ABS, { force: true });
      fs.mkdirSync(ABS, { recursive: true });
    }
  });

  test('the status is REPLACED on each check, so a failure can be recovered from', () => {
    checkClipStorage({ mounts: UNMAPPED });
    assert.equal(clipStorageReady(), false);
    checkClipStorage({ mounts: MOUNTED });
    assert.equal(clipStorageReady(), true, 'fixing the mapping and re-checking did not clear the failure');
  });
});

// --- free space --------------------------------------------------------------------------------

describe('the free-space floor', () => {
  test('the floor is 500 MB', () => {
    // Pinned, because it is the number that decides whether recording is allowed to be the thing that
    // fills a disk. A clip is a few MB; this is deliberately far above one clip.
    assert.equal(MIN_FREE_BYTES, 500 * 1024 * 1024);
  });

  test('★ exactly at the floor is enough; one byte under is not', () => {
    assert.equal(hasMinFreeSpace(MIN_FREE_BYTES), true, 'the bound must be inclusive');
    assert.equal(hasMinFreeSpace(MIN_FREE_BYTES - 1), false, 'one byte under the floor was accepted');
    assert.equal(hasMinFreeSpace(0), false, 'a full disk was accepted');
  });

  test('freeBytes reports a real number for a real directory', () => {
    const n = freeBytes();
    assert.ok(Number.isFinite(n) && n > 0, `freeBytes returned ${n}`);
  });

  test('★ an unmeasurable volume reads as Infinity — a probe failure must not block recording', () => {
    // Deliberately fails OPEN, unlike the mount guard: a statfs that cannot answer is not evidence of
    // a full disk, and silently refusing to record would be far worse than recording onto a disk that
    // turns out to be fine.
    fs.rmSync(ABS, { recursive: true, force: true });
    try {
      assert.equal(freeBytes(), Infinity);
      assert.equal(hasMinFreeSpace(), true);
    } finally {
      fs.mkdirSync(ABS, { recursive: true });
    }
  });
});

// --- the stats block the Settings screen reads --------------------------------------------------

describe('clipStorageStats', () => {
  test('reports clip totals, retention, and the guard status together', () => {
    makeClip('a.mp4', { bytes: 1000 });
    makeClip('b.mp4', { bytes: 2000 });
    setRetention(7, 3);
    const s = clipStorageStats();
    assert.equal(s.clipCount, 2);
    assert.equal(s.usedBytes, 3000);
    assert.equal(s.days, 7);
    assert.equal(s.maxGb, 3);
    assert.equal(s.ok, true);
    assert.equal(s.path, ABS);
    assert.ok(Number.isFinite(s.freeBytes) || s.freeBytes === Infinity);
  });

  test('★ on-demand recordings are counted SEPARATELY, not folded into the clip total', () => {
    // They live in their own table and are never swept by clip retention, so reporting them together
    // would tell an admin that raising the clip cap will reclaim space it cannot touch.
    makeClip('a.mp4', { bytes: 1000 });
    makeRecording('ready', 9999);
    const s = clipStorageStats();
    assert.equal(s.clipCount, 1);
    assert.equal(s.usedBytes, 1000, 'a manual recording was counted as a detection clip');
    assert.equal(s.recordingCount, 1);
    assert.equal(s.recordingBytes, 9999);
  });

  test('an unfinished recording is not counted as used storage', () => {
    makeRecording('recording', 5);
    const s = clipStorageStats();
    assert.equal(s.recordingCount, 0);
    assert.equal(s.recordingBytes, 0, 'in-progress bytes must not appear as used storage');
  });

  test('★ retention falls back to 14 days / 5 GB with no settings row at all', () => {
    // Not decorative: without the fallback, `days` and `maxGb` would be NaN, `days > 0` and
    // `maxGb > 0` would both be false, and retention would be SILENTLY DISABLED — the same outcome as
    // the sweeper being a no-op, arriving from a different direction.
    //
    // The row is deleted rather than NULLed because both columns are `INTEGER NOT NULL`, so a NULL
    // cannot reach this code from the database at all. A missing row can: it is what every install
    // looks like for the instant between creating the table and seeding it, and `.get('app') || {}`
    // is the line that handles it.
    const saved = db.prepare('SELECT * FROM settings WHERE id = ?').get('app');
    db.prepare('DELETE FROM settings WHERE id = ?').run('app');
    try {
      const s = clipStorageStats();
      assert.equal(s.days, 14);
      assert.equal(s.maxGb, 5);
    } finally {
      const cols = Object.keys(saved);
      db.prepare(
        `INSERT INTO settings (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      ).run(...cols.map((c) => saved[c]));
    }
  });
});

// --- the retention sweeper ----------------------------------------------------------------------

describe('★ sweepClips — the retention sweeper', () => {
  test('★★ it actually deletes something (the mutant that survived a 389-test suite)', () => {
    // Issue #263's headline: `sweepClips() { return; }` was green across the whole suite. This is the
    // test that fails for it. Both halves asserted — the row's clip columns cleared AND the file gone —
    // because a sweeper that clears rows without unlinking leaves the disk filling up invisibly.
    const old = makeClip('old.mp4', { ageDays: 40 });
    setRetention(14, 0);
    sweepClips();
    assert.deepEqual(liveClipIds(), [], 'nothing was swept');
    assert.equal(fs.existsSync(old.abs), false, 'the row was cleared but the file was left on disk');
  });

  test('the alert row and its snapshot survive — only the video goes', () => {
    const c = makeClip('old.mp4', { ageDays: 40 });
    ev.saveEventSnapshot(c.id, Buffer.from('jpeg'));
    setRetention(14, 0);
    sweepClips();
    const row = db.prepare('SELECT * FROM detection_events WHERE id = ?').get(c.id);
    assert.ok(row, 'the sweep deleted the alert itself');
    assert.equal(row.snapshot, 1, 'the sweep took the snapshot with it');
    assert.equal(row.clip_path, null);
  });

  test('★ a clip INSIDE the retention window is left alone', () => {
    // The control. Without it a sweeper that deletes everything passes the test above.
    const fresh = makeClip('fresh.mp4', { ageDays: 1 });
    const old = makeClip('old.mp4', { ageDays: 40 });
    setRetention(14, 0);
    sweepClips();
    assert.deepEqual(liveClipIds(), [fresh.id], 'the wrong clips were swept');
    assert.equal(fs.existsSync(fresh.abs), true);
    assert.equal(fs.existsSync(old.abs), false);
  });

  test('★ 0 days means KEEP FOREVER, not delete everything', () => {
    // The documented meaning of 0, and the direction that would be catastrophic to get backwards: an
    // admin turning age-retention "off" would erase every clip they have.
    const c = makeClip('ancient.mp4', { ageDays: 900 });
    setRetention(0, 0);
    sweepClips();
    assert.deepEqual(liveClipIds(), [c.id], '0 days deleted clips instead of keeping them');
    assert.equal(fs.existsSync(c.abs), true);
  });

  test('★ the size cap deletes OLDEST first, and stops as soon as it is under', () => {
    // Three clips of 0.4 GB against a 1 GB cap: 1.2 GB total, so exactly ONE must go — the oldest.
    // Deleting two would satisfy "under the cap" as well, which is why the survivors are named rather
    // than counted.
    const a = makeClip('a.mp4', { bytes: 0.4 * 1024 ** 3 });
    const b = makeClip('b.mp4', { bytes: 0.4 * 1024 ** 3 });
    const c = makeClip('c.mp4', { bytes: 0.4 * 1024 ** 3 });
    setRetention(0, 1);
    sweepClips();
    assert.deepEqual(liveClipIds(), [b.id, c.id], 'the size cap did not delete exactly the oldest one');
    assert.equal(fs.existsSync(a.abs), false);
    assert.equal(fs.existsSync(c.abs), true);
  });

  test('★ under the cap, the size pass deletes nothing at all', () => {
    const a = makeClip('a.mp4', { bytes: 0.4 * 1024 ** 3 });
    setRetention(0, 5);
    sweepClips();
    assert.deepEqual(liveClipIds(), [a.id]);
  });

  test('exactly ON the cap is not over it', () => {
    // A store sitting exactly at the limit must be left alone, or every sweep deletes a clip forever.
    const a = makeClip('a.mp4', { bytes: 1024 ** 3 });
    setRetention(0, 1);
    sweepClips();
    assert.deepEqual(liveClipIds(), [a.id], 'a total exactly equal to the cap was treated as over it');
  });

  test('★ and the pass STOPS the moment it lands exactly on the cap', () => {
    // ⚠️ The boundary that actually matters is `if (bytes <= cap) break`, not the `bytes > cap` gate
    // above it — the gate is a fast path, and flipping it to `>=` changes nothing because the break
    // fires immediately. Mutation testing is what made that distinction visible; the `>=` mutant is
    // recorded as a known-equivalent one in scripts/mutants.json for the same reason.
    //
    // Sized so the running total lands EXACTLY on the cap after one deletion: two 0.5 GiB clips
    // against a 1 GiB cap... which is not over. So: three, against a 1 GiB cap, leaves 1.0 GiB exactly.
    const a = makeClip('a.mp4', { bytes: 0.5 * 1024 ** 3 });
    const b = makeClip('b.mp4', { bytes: 0.5 * 1024 ** 3 });
    const c = makeClip('c.mp4', { bytes: 0.5 * 1024 ** 3 });
    setRetention(0, 1);
    sweepClips();
    assert.deepEqual(
      liveClipIds(), [b.id, c.id],
      'the size pass did not stop when the total reached the cap exactly — it kept deleting'
    );
    assert.equal(fs.existsSync(a.abs), false);
  });

  test('★ 0 GB means no size cap, not a cap of zero', () => {
    const a = makeClip('a.mp4', { bytes: 50 * 1024 ** 3 });
    setRetention(0, 0);
    sweepClips();
    assert.deepEqual(liveClipIds(), [a.id], '0 GB was read as a zero-byte cap and deleted everything');
  });

  test('both bounds apply in one sweep: age first, then size on what is left', () => {
    const old = makeClip('old.mp4', { bytes: 0.1 * 1024 ** 3, ageDays: 40 });
    const big1 = makeClip('big1.mp4', { bytes: 0.7 * 1024 ** 3 });
    const big2 = makeClip('big2.mp4', { bytes: 0.7 * 1024 ** 3 });
    setRetention(14, 1); // 1.4 GB survives the age pass, against a 1 GB cap
    sweepClips();
    assert.deepEqual(liveClipIds(), [big2.id], 'age + size together did not leave exactly the newest');
    assert.equal(fs.existsSync(old.abs), false);
  });

  test('★ the age pass runs FIRST — running the size pass first deletes the wrong clips', () => {
    // ⚠️ THE ORDER IS LOAD-BEARING and the test above does not prove it: there the expired clip also
    // had the lowest id, so age-order and id-order coincided and swapping the two blocks changed
    // nothing. Adversarial review found that; a second reviewer traced the same swap and concluded it
    // was an EQUIVALENT mutation. It is not, and this is the fixture that separates them — measured,
    // not argued.
    //
    // Three 0.4 GiB clips against a 1 GiB cap, with the EXPIRED one written LAST so it has the highest
    // id. The size pass walks by id (oldest row first); the age pass goes by created_at. Here they
    // point in opposite directions:
    //   age first: c goes (expired) -> 0.8 GiB, under the cap, size pass does nothing -> {a, b}
    //   size first: 1.2 GiB is over, so a goes (lowest id) -> 0.8 GiB, break; then c goes -> {b}
    // Deleting `a` is the harm: a clip inside its retention window, removed to make room for one that
    // was about to be deleted anyway.
    const a = makeClip('a.mp4', { bytes: 0.4 * 1024 ** 3 });
    const b = makeClip('b.mp4', { bytes: 0.4 * 1024 ** 3 });
    const c = makeClip('c.mp4', { bytes: 0.4 * 1024 ** 3, ageDays: 40 });
    setRetention(14, 1);
    sweepClips();
    assert.deepEqual(
      liveClipIds(), [a.id, b.id],
      'the size cap deleted a clip inside its retention window — the age pass must run first'
    );
    assert.equal(fs.existsSync(c.abs), false, 'the expired clip survived');
  });

  test('a clip with no recorded size still counts as swept and does not wedge the loop', () => {
    // `bytes -= c.clip_bytes || 0` — a NULL size subtracts nothing, so the loop must still terminate
    // by running out of clips rather than by getting under the cap.
    const a = makeClip('a.mp4', { bytes: 2 * 1024 ** 3 });
    const b = makeClip('b.mp4', { bytes: 2 * 1024 ** 3 });
    db.prepare('UPDATE detection_events SET clip_bytes = NULL WHERE id = ?').run(a.id);
    setRetention(0, 1);
    sweepClips();
    assert.equal(liveClipIds().length, 0, 'a NULL clip size stopped the size pass early');
    assert.ok(!fs.existsSync(a.abs) && !fs.existsSync(b.abs));
  });

  test('★ the sweep does nothing while storage is not OK', () => {
    // Not an optimisation: with an unmapped or unwritable CLIPS_DIR the files are not where the rows
    // say they are, so sweeping would clear rows and orphan whatever IS on disk.
    const old = makeClip('old.mp4', { ageDays: 40 });
    checkClipStorage({ mounts: UNMAPPED });
    setRetention(14, 5);
    sweepClips();
    assert.deepEqual(liveClipIds(), [old.id], 'the sweeper ran with storage in a failed state');
    assert.equal(fs.existsSync(old.abs), true);
  });

  test('a pending clip is not eligible for either bound', () => {
    // Only READY clips have a file to delete; a pending one is mid-capture and its row must survive.
    const id = ev.recordDetectionEvent('cam-1', 'Nursery', ev.ALERT.MOTION);
    ev.markClipPending(id);
    db.prepare("UPDATE detection_events SET created_at = datetime('now', '-40 days') WHERE id = ?").run(id);
    setRetention(14, 5);
    sweepClips();
    assert.equal(
      db.prepare('SELECT clip_status FROM detection_events WHERE id = ?').get(id).clip_status,
      'pending',
      'an in-flight capture was swept out from under itself'
    );
  });

  test('a sweep with nothing to do is a quiet no-op', () => {
    setRetention(14, 5);
    sweepClips();
    assert.deepEqual(liveClipIds(), []);
  });
});

// --- lifecycle -----------------------------------------------------------------------------------

describe('start/stop', () => {
  test('starting runs the guard and sweeps immediately — it does not wait 15 minutes', () => {
    // The first sweep after a restart is the one that matters: a container that was down overnight
    // comes back with a backlog, and waiting a quarter of an hour to notice is how a disk fills.
    const old = makeClip('old.mp4', { ageDays: 40 });
    setRetention(14, 5);
    startClipStorage({ mounts: MOUNTED });
    try {
      assert.deepEqual(liveClipIds(), [], 'startup did not sweep');
      assert.equal(fs.existsSync(old.abs), false);
    } finally {
      stopClipStorage();
    }
  });

  test('★ start honours the storage guard — an unmapped CLIPS_DIR means it does not sweep', () => {
    // ⚠️ THIS TEST EXISTS BECAUSE ITS ABSENCE SHIPPED A HOST-DEPENDENT SUITE, in the very PR whose
    // subject is host-dependent suites. `startClipStorage` re-runs the guard, and it originally did so
    // with no `mounts` seam — so it read the REAL /proc/mounts and silently overwrote whatever the
    // `beforeEach` had set up. On Windows there is no such file, the check is skipped, storage stays
    // OK and the four tests around this one passed. On Linux CI a temp directory sits under "/", so
    // CLIPS_DIR reads as the container overlay, storage goes not-OK and the sweep declines: all four
    // failed. Caught by CI, not by me.
    //
    // It discriminates on BOTH platforms, which is the property that matters: without the seam, the
    // UNMAPPED argument below is ignored and a Windows run would report ready and sweep.
    const old = makeClip('old.mp4', { ageDays: 40 });
    setRetention(14, 5);
    startClipStorage({ mounts: UNMAPPED });
    try {
      assert.equal(clipStorageReady(), false, 'the guard was not re-run with the mounts it was given');
      assert.deepEqual(liveClipIds(), [old.id], 'startup swept with storage in a failed state');
      assert.equal(fs.existsSync(old.abs), true);
    } finally {
      stopClipStorage();
      makeReady();
    }
  });

  test('start is idempotent, and stop leaves nothing to hold the process open', () => {
    startClipStorage({ mounts: MOUNTED });
    startClipStorage({ mounts: MOUNTED }); // must not stack a second interval
    stopClipStorage();
    stopClipStorage(); // idempotent, and safe when never started
    assert.ok(true, 'no throw');
  });

  test('★ the interval keeps sweeping — a backlog that arrives later is still collected', (t) => {
    // The 15-minute tick, exercised with mocked timers rather than left to run in production only.
    // It matters on its own: the startup sweep handles the backlog that existed at boot, and this is
    // what handles everything after it, on a container that stays up for weeks.
    t.mock.timers.enable({ apis: ['setInterval'] });
    setRetention(14, 5);
    startClipStorage({ mounts: MOUNTED }); // nothing to sweep yet
    try {
      const old = makeClip('later.mp4', { ageDays: 40 });
      assert.deepEqual(liveClipIds(), [old.id], 'precondition: the clip is still here before the tick');
      t.mock.timers.tick(15 * 60 * 1000);
      assert.deepEqual(liveClipIds(), [], 'the periodic sweep did not run');
      assert.equal(fs.existsSync(old.abs), false);
    } finally {
      stopClipStorage();
    }
  });

  test('★ a sweep that throws is logged and the timer KEEPS RUNNING', (t) => {
    // A repeating job that dies on one bad tick is an outage in slow motion: retention silently stops
    // and the disk fills over days, with nothing to see. Asserted in both places it can throw — the
    // startup sweep and a later tick — because they are separate try/catch blocks and only one of them
    // would be exercised by a test that checked once.
    t.mock.timers.enable({ apis: ['setInterval'] });
    const old = makeClip('old.mp4', { ageDays: 40 });
    setRetention(14, 5);
    // Break the sweep from underneath: getRetention's SELECT can no longer be prepared.
    db.exec('ALTER TABLE settings RENAME TO settings_hidden');
    try {
      startClipStorage({ mounts: MOUNTED }); // the initial sweep throws...
      t.mock.timers.tick(15 * 60 * 1000); // ...and so does the first tick
      assert.deepEqual(liveClipIds(), [old.id], 'precondition: nothing could have been swept');

      // Put it back and prove the timer is still alive — this is the half that matters.
      db.exec('ALTER TABLE settings_hidden RENAME TO settings');
      t.mock.timers.tick(15 * 60 * 1000);
      assert.deepEqual(liveClipIds(), [], 'the sweeper gave up after one failed tick');
    } finally {
      stopClipStorage();
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings_hidden'").get()) {
        db.exec('ALTER TABLE settings_hidden RENAME TO settings');
      }
    }
  });

  test('★ stop then start really does restart the sweep', () => {
    // `startClipStorage` guards on `if (!sweepTimer)`, so a stop that cleared the interval without
    // nulling the handle would make every later start a silent no-op — the timer gone and nothing
    // reporting it. Observed through behaviour: the restarted module must sweep again.
    startClipStorage({ mounts: MOUNTED });
    stopClipStorage();
    const old = makeClip('old.mp4', { ageDays: 40 });
    setRetention(14, 5);
    startClipStorage({ mounts: MOUNTED });
    try {
      assert.deepEqual(liveClipIds(), [], 'the module did not sweep after being restarted');
    } finally {
      stopClipStorage();
    }
  });
});
