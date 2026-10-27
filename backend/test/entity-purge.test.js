// Deleting a child or a camera deletes EVERYTHING that belongs to it - rows and files (issues #540, #554).
//
// The defect: DELETE /api/children/:id removed the child and its nights (and, since #259, its recordings
// and timelapses); DELETE /api/cameras/:id removed the camera and nothing else. Bed transitions (judged
// ones are exempt from the age prune FOREVER), their snapshot JPEGs, sleep reviews, activity samples,
// alert history with its clips and snapshots, camera events and sensor readings all survived, and the
// snapshots stayed servable by id for any signed-in user.
//
// ★ THE TABLE LIST IS NOT WRITTEN DOWN HERE. The "everything" test finds every table that has a child_id /
// camera_id / primary_camera_id column with PRAGMA, puts a real row (and real files on disk) in each, deletes
// the entity over real HTTP and asks the database and the disk whether anything for it is left. A table
// added to the schema next year is covered the day it is added, or fails the "could not populate" guard
// below until someone teaches this file about it - never silently skipped.
//
// ★ A CONTROL ENTITY is populated identically and must come through untouched, or `DELETE FROM x` without
// its WHERE would pass.
//
// ★ IDS ARE UUIDs wherever a test needs the per-id folders swept: the purge sweeps a folder named by an id only
// for the UUID shape the app mints (#719 review, see idFolders in lib/entityPurge.js).
//
// ★ LINKS. Directory links are made as junctions (`fs.symlinkSync(target, path, 'junction')`): on Windows a
// junction needs no privilege where a symlink does, and on Linux the type is ignored and a symlink is made. If
// the link still cannot be made (EPERM / ENOTSUP), the test SKIPS with the reason, visibly, never passes.
//
// ⚠️ PATH IS EMPTIED before any import, as in recordings-lifecycle.test.js: the recording-guard test starts a
// real on-demand recording, which needs a segmenter, and a segmenter spawns ffmpeg.
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

const emptyBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-nobin-'));
process.env.PATH = emptyBinDir;

const dataDir = useTempDataDir();

// A stand-in MediaMTX that answers at once (see camera-delete-observation.test.js).
// Every request it gets is logged, so a test can see a camera's path being removed and registered again.
const mtxLog = [];
const mediamtx = createServer((req, res) => { mtxLog.push(`${req.method} ${req.url}`); res.setHeader('content-type', 'application/json'); res.end('{}'); });
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { CLIPS_DIR, startSegmenter, stopAllSegmenters, holdRing } = await import('../src/lib/clipRecorder.js');
const { holdOwners, ondemandHoldOwner } = await import('../src/lib/ringHolds.js');
const { checkClipStorage } = await import('../src/lib/clipStorage.js');

// Clip storage marked ready from a supplied mount table (host-independent, as clip-storage.test.js does it), so
// startRecording and startClipCapture accept. With no ffmpeg on PATH a segmenter is registered but never runs.
const readyStorage = () => {
  const abs = path.resolve(CLIPS_DIR);
  fs.mkdirSync(abs, { recursive: true });
  assert.equal(checkClipStorage({ mounts: `/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 ${abs} xfs rw 0 0\n` }).ok, true, 'clip storage did not come up ready');
};
const { recordBedTransition, TRANSITION } = await import('../src/lib/bedTransitions.js');
const { startRecording, stopRecording, isRecording } = await import('../src/lib/recordings.js');
const { default: childrenRouter } = await import('../src/routes/children.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');

// Make a directory link, or skip the test (visibly, with the reason) where the platform will not.
function linkDirOrSkip(t, target, at) {
  try {
    fs.symlinkSync(target, at, 'junction');
    return true;
  } catch (e) {
    if (e.code === 'EPERM' || e.code === 'ENOTSUP') {
      t.skip(`cannot create a directory link here (${e.code}); this test needs one`);
      return false;
    }
    throw e;
  }
}

// Where a table's id-named snapshot JPEGs live. Only the DIRECTORY is spelled out; which tables have a
// snapshot is read from the schema, and a table with a `snapshot` column missing from this map fails below.
// #553 phase 2a: in private/ on this fresh data directory, next to the database.
const SNAPSHOT_DIRS = {
  bed_transitions: path.join(dataDir, 'private', 'transition-snapshots'),
  detection_events: path.join(dataDir, 'private', 'detection-snapshots'),
};

let childServer;
let cameraServer;
let token;
const delChild = (id) => call(`${childServer.url}/api/children/${id}`, { method: 'DELETE', token });
const delCamera = (id) => call(`${cameraServer.url}/api/cameras/${id}`, { method: 'DELETE', token });

before(async () => {
  childServer = await mountRouter('/api/children', childrenRouter);
  cameraServer = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
});
after(async () => {
  stopAllSegmenters();
  await childServer?.close();
  await cameraServer?.close();
  await new Promise((r) => mediamtx.close(r));
  cleanupTempDataDirs();
  try { fs.rmSync(emptyBinDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

// --- schema-driven fixture ---------------------------------------------------------------------

const tables = () => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
  .map(({ name }) => ({ name, cols: db.prepare(`PRAGMA table_info(${name})`).all() }));

// Every (table, column) that points at an entity of this kind.
function referencing(kind) {
  const names = kind === 'child' ? ['child_id'] : ['camera_id', 'primary_camera_id'];
  const out = [];
  for (const t of tables()) for (const c of t.cols) if (names.includes(c.name)) out.push({ table: t.name, col: c.name, cols: t.cols });
  return out;
}

let seq = 0;
const uniq = (p) => `${p}-${++seq}`;

// Fill every NOT NULL column that has no default, so any table can take a row without this file knowing it.
function insertRow(table, cols, given) {
  const row = { ...given };
  for (const c of cols) {
    // A TEXT PRIMARY KEY is not NOT NULL in SQLite (a legacy quirk) and would silently take NULL.
    if (c.name in row || !(c.notnull || c.pk) || c.dflt_value != null) continue;
    if (c.pk && /^INT/i.test(c.type)) continue; // rowid alias
    row[c.name] = /^(INT|REAL)/i.test(c.type) ? 0 : uniq(`${table}-${c.name}`);
  }
  const names = Object.keys(row);
  const info = db.prepare(`INSERT INTO ${table} (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
    .run(...names.map((n) => row[n]));
  return info.lastInsertRowid;
}

function writeFile(abs) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'x');
  return abs;
}

// Put one row, with real files, in every table that references this entity. Returns { files, counts }.
function populate(kind, id, { cameraTablesToo = true } = {}) {
  const files = [];
  const camFiles = []; // a child's camera's own files: the CAMERA's, not the child's
  const refs = referencing(kind);
  for (const { table, col, cols } of refs) {
    const given = { [col]: id };
    for (const c of cols) {
      // mediamtx_path is a stream name, not a file: only these three columns hold paths under CLIPS_DIR.
      if (!/^(path|thumb_path|clip_path)$/.test(c.name)) continue;
      // NOT under the per-entity dir the sweeps remove, so these files can only go if their own row's
      // removal names them (an alert clip's thumbnail is the case a sweep would otherwise hide).
      const rel = `by-${table}/${id}/${uniq(table)}-${c.name}.mp4`;
      files.push(writeFile(path.join(CLIPS_DIR, rel)));
      given[c.name] = rel;
      if (c.name === 'clip_path') files.push(writeFile(path.join(CLIPS_DIR, rel.replace(/\.mp4$/, '.jpg')))); // sibling thumb
    }
    const hasSnapshot = cols.some((c) => c.name === 'snapshot');
    if (hasSnapshot) {
      assert.ok(SNAPSHOT_DIRS[table], `table ${table} has a snapshot column but this test does not know where its JPEGs live`);
      given.snapshot = 1;
    }
    // A child's camera is a row in `cameras` that points at the child: it needs the camera-keyed tables too.
    const rowId = insertRow(table, cols, given);
    if (hasSnapshot) files.push(writeFile(path.join(SNAPSHOT_DIRS[table], `${rowId}.jpg`)));
    if (kind === 'child' && table === 'cameras' && cameraTablesToo) {
      const cam = populate('camera', db.prepare('SELECT id FROM cameras WHERE rowid = ?').get(rowId).id, { cameraTablesToo: false });
      camFiles.push(...cam.files);
    }
  }
  // Strays no row names: the per-camera clip dir, the segment ring, scratch frames, finished timelapses.
  if (kind === 'camera') {
    files.push(writeFile(path.join(CLIPS_DIR, id, 'stray.mp4')));
    files.push(writeFile(path.join(CLIPS_DIR, '.ring', id, 'seg-1.mkv')));
    // The concat lists live in their own app-only folder since #553 phase 2b; a cut a restart killed leaves one behind.
    files.push(writeFile(path.join(CLIPS_DIR, '.concat', id, 'concat-7.txt')));
  } else {
    files.push(writeFile(path.join(CLIPS_DIR, 'timelapse', id, 'stray.mp4')));
    files.push(writeFile(path.join(CLIPS_DIR, '.timelapse-frames', id, '2026-01-01', 'f-1.jpg')));
  }
  return { files, camFiles, counts: countsFor(kind, id) };
}

function countsFor(kind, id) {
  const out = {};
  for (const { table, col } of referencing(kind)) {
    out[`${table}.${col}`] = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(id).n;
  }
  return out;
}

const idOfEach = {};
function seedEntity(kind, id) {
  if (kind === 'child') makeChild(db, { id });
  else makeCamera(db, { id });
  idOfEach[id] = populate(kind, id);
  return idOfEach[id];
}

describe('deleting a child deletes everything for it', () => {
  test('after DELETE, no row in ANY table that references the child, and none of its files, remain; the control child is untouched', async () => {
    const goneId = randomUUID();
    const keptId = randomUUID();
    const gone = seedEntity('child', goneId);
    const kept = seedEntity('child', keptId);
    const goneEsp = db.prepare('SELECT id FROM esphome_entities WHERE child_id = ?').get(goneId).id;
    const keptEsp = db.prepare('SELECT id FROM esphome_entities WHERE child_id = ?').get(keptId).id;
    db.prepare('INSERT INTO esphome_readings (entity_id, bucket, n) VALUES (?, 1, 0), (?, 1, 0)').run(goneEsp, keptEsp);

    // Anti-vacuous: every referencing column really got a row before we delete, files really exist.
    for (const [k, n] of Object.entries(gone.counts)) assert.ok(n >= 1, `fixture put nothing in ${k}`);
    assert.ok(referencing('child').length >= 4, 'schema discovery found suspiciously few tables');
    for (const f of gone.files) assert.ok(fs.existsSync(f), `fixture file missing: ${f}`);

    // The child's camera(s), read before they are unassigned.
    const camIds = db.prepare('SELECT id FROM cameras WHERE child_id = ?').all(goneId).map((r) => r.id);
    assert.ok(camIds.length >= 1);
    const keptCamIds = db.prepare('SELECT id FROM cameras WHERE child_id = ?').all(keptId).map((r) => r.id);
    const keptCamCounts = keptCamIds.map((c) => countsFor('camera', c));

    const res = await delChild(goneId);
    assert.equal(res.status, 204);

    // The child's OWN row: it has no child_id column, so the schema-driven count below cannot see it (#719
    // review: dropping the purge's final `DELETE FROM children` survived every test).
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM children WHERE id = ?').get(goneId).n, 0, 'the child row itself survived');
    assert.ok(db.prepare('SELECT 1 FROM children WHERE id = ?').get(keptId), 'the control child row was deleted');
    for (const [k, n] of Object.entries(countsFor('child', goneId))) assert.equal(n, 0, `${k} still names the deleted child`);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings WHERE entity_id = ?').get(goneEsp).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM esphome_readings WHERE entity_id = ?').get(keptEsp).n, 1);
    for (const f of gone.files) assert.ok(!fs.existsSync(f), `file survived the child: ${f}`);

    // Rows recorded by the child's cameras (the bed they slept in) go too; the cameras themselves stay.
    for (const camId of camIds) {
      assert.ok(db.prepare('SELECT 1 FROM cameras WHERE id = ?').get(camId), 'the camera is hardware and must stay');
      assert.equal(db.prepare('SELECT child_id FROM cameras WHERE id = ?').get(camId).child_id, null);
      for (const t of ['bed_transitions', 'activity_samples']) {
        assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE camera_id = ?`).get(camId).n, 0, `${t} of the child's camera survived`);
      }
      // ...but history that belongs to the CAMERA alone is the camera's, and stays until the camera goes.
      assert.ok(db.prepare('SELECT COUNT(*) AS n FROM detection_events WHERE camera_id = ?').get(camId).n >= 1);
    }

    // Files recorded by the child's cameras: the bed's snapshots go with the child, the camera's own alert
    // clips and recordings stay with the camera.
    const bedSnaps = gone.camFiles.filter((f) => f.startsWith(SNAPSHOT_DIRS.bed_transitions));
    assert.ok(bedSnaps.length >= 1);
    for (const f of bedSnaps) assert.ok(!fs.existsSync(f), `a bed snapshot survived the child: ${f}`);
    for (const f of gone.camFiles.filter((x) => !bedSnaps.includes(x))) assert.ok(fs.existsSync(f), `the camera's own file was deleted with the child: ${f}`);

    // Control.
    assert.deepEqual(countsFor('child', keptId), kept.counts, 'a row of ANOTHER child was deleted');
    // ...including what ITS cameras recorded (bed transitions, activity samples): deleting one child's must
    // not touch another camera's.
    assert.ok(keptCamIds.length >= 1);
    assert.deepEqual(keptCamIds.map((c) => countsFor('camera', c)), keptCamCounts, "a row of ANOTHER child's camera was deleted");
    for (const f of kept.camFiles) assert.ok(fs.existsSync(f), `a file of ANOTHER child's camera was deleted: ${f}`);
    for (const f of kept.files) assert.ok(fs.existsSync(f), `a file of ANOTHER child was deleted: ${f}`);
  });

  test('a snapshot JPEG of a JUDGED transition is removed (the exact case the age prune exempts forever)', async () => {
    makeChild(db, { id: 'child-judged' });
    makeCamera(db, { id: 'cam-judged', childId: 'child-judged' });
    const id = db.prepare("INSERT INTO bed_transitions (camera_id, type, verdict, snapshot) VALUES ('cam-judged','into_bed','correct',1)").run().lastInsertRowid;
    const jpg = writeFile(path.join(SNAPSHOT_DIRS.bed_transitions, `${id}.jpg`));
    assert.equal((await delChild('child-judged')).status, 204);
    assert.ok(!fs.existsSync(jpg));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bed_transitions WHERE id = ?').get(id).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM children WHERE id = 'child-judged'").get().n, 0, 'the child row itself survived');
  });
});

describe('deleting a camera deletes everything for it', () => {
  test('after DELETE, no row in ANY table that references the camera, and none of its files, remain; the control camera is untouched', async () => {
    const goneId = randomUUID();
    const keptId = randomUUID();
    const gone = seedEntity('camera', goneId);
    const kept = seedEntity('camera', keptId);
    for (const [k, n] of Object.entries(gone.counts)) assert.ok(n >= 1, `fixture put nothing in ${k}`);
    assert.ok(referencing('camera').length >= 7, 'schema discovery found suspiciously few tables');
    for (const f of gone.files) assert.ok(fs.existsSync(f), `fixture file missing: ${f}`);

    const res = await delCamera(goneId);
    assert.equal(res.status, 204);

    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cameras WHERE id = ?').get(goneId).n, 0);
    for (const [k, n] of Object.entries(countsFor('camera', goneId))) assert.equal(n, 0, `${k} still names the deleted camera`);
    for (const f of gone.files) assert.ok(!fs.existsSync(f), `file survived the camera: ${f}`);
    assert.ok(!fs.existsSync(path.join(CLIPS_DIR, goneId)), 'per-camera clip dir left behind');
    assert.ok(!fs.existsSync(path.join(CLIPS_DIR, '.ring', goneId)), 'segment ring left behind');

    assert.deepEqual(countsFor('camera', keptId), kept.counts, 'a row of ANOTHER camera was deleted');
    for (const f of kept.files) assert.ok(fs.existsSync(f), `a file of ANOTHER camera was deleted: ${f}`);
  });

  test('a snapshot JPEG of a JUDGED transition is removed with its camera', async () => {
    makeCamera(db, { id: 'cam-judged2' });
    const id = db.prepare("INSERT INTO bed_transitions (camera_id, type, verdict, snapshot) VALUES ('cam-judged2','out_of_bed','wrong',1)").run().lastInsertRowid;
    const jpg = writeFile(path.join(SNAPSHOT_DIRS.bed_transitions, `${id}.jpg`));
    assert.equal((await delCamera('cam-judged2')).status, 204);
    assert.ok(!fs.existsSync(jpg));
  });

  test('a child whose primary camera is deleted no longer names it', async () => {
    makeChild(db, { id: 'child-pc' });
    makeCamera(db, { id: 'cam-pc', childId: 'child-pc' });
    db.prepare("UPDATE children SET primary_camera_id = 'cam-pc' WHERE id = 'child-pc'").run();
    assert.equal((await delCamera('cam-pc')).status, 204);
    assert.equal(db.prepare("SELECT primary_camera_id AS p FROM children WHERE id = 'child-pc'").get().p, null);
  });
});

// --- hostile stored paths ----------------------------------------------------------------------

describe('a stored path cannot make a delete reach outside the clips directory', () => {
  let outsideDir;
  let victims;
  let linkError; // set when this platform refused the directory link: each test then skips, saying so
  beforeEach(() => {
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-victim-'));
    victims = {
      sibling: writeFile(path.join(dataDir, 'victim-sibling.txt')),   // DATA_DIR/victim, one `..` out of clips
      absolute: writeFile(path.join(outsideDir, 'victim-absolute.txt')),
      viaLink: writeFile(path.join(outsideDir, 'victim-link', 'victim-via-link.txt')),
      aDir: writeFile(path.join(CLIPS_DIR, 'keep-me-dir', 'inner.txt')),
    };
    linkError = null;
    try {
      fs.symlinkSync(path.join(outsideDir, 'victim-link'), path.join(CLIPS_DIR, 'escape-link'), 'junction');
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'ENOTSUP') throw e;
      linkError = e.code;
    }
  });
  afterEach(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(path.join(CLIPS_DIR, 'escape-link'), { force: true });
    fs.rmSync(path.join(CLIPS_DIR, 'keep-me-dir'), { recursive: true, force: true });
  });
  const skipIfNoLink = (t) => {
    if (!linkError) return false;
    t.skip(`cannot create a directory link here (${linkError}); this test needs one`);
    return true;
  };

  const hostilePaths = () => [
    path.relative(CLIPS_DIR, victims.sibling),                  // ../victim-sibling.txt
    victims.absolute,                                           // /tmp/.../victim-absolute.txt
    'escape-link/victim-via-link.txt',                          // a symlinked directory inside the clips dir
    'keep-me-dir',                                              // a directory, not a file: must never be removed recursively
    '.', '', './',                                              // the clips dir itself
    'x/../../victim-sibling.txt',                               // normalises out
  ];

  test('child delete: recordings, timelapses and wake clips with hostile paths are skipped, their rows still deleted', async (t) => {
    if (skipIfNoLink(t)) return;
    makeChild(db, { id: 'child-h' });
    // started_at is datetime('now'), NOT the string 'now': scripts/clock-shift.mjs (the future-clock CI job, #570) rewrites
    // every 'now' in an SQL string into two arguments, so a literal 'now' VALUE became "6 values for 5 columns" and the
    // weekly job failed on main from 2026-10-19 (the suite itself was green).
    for (const p of hostilePaths()) {
      db.prepare("INSERT INTO recordings (camera_id, child_id, started_at, path, thumb_path) VALUES ('c', 'child-h', datetime('now'), ?, ?)").run(p, p);
      db.prepare("INSERT INTO timelapses (child_id, night_date, path, thumb_path) VALUES ('child-h', ?, ?, ?)").run(uniq('n'), p, p);
    }
    assert.equal((await delChild('child-h')).status, 204);
    for (const [name, f] of Object.entries(victims)) assert.ok(fs.existsSync(f), `${name} was deleted through a stored path: ${f}`);
    assert.ok(fs.existsSync(CLIPS_DIR));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE child_id = 'child-h'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM timelapses WHERE child_id = 'child-h'").get().n, 0);
  });

  test('camera delete: alert clips and recordings with hostile paths are skipped, their rows still deleted', async (t) => {
    if (skipIfNoLink(t)) return;
    makeCamera(db, { id: 'cam-h' });
    for (const p of hostilePaths()) {
      db.prepare("INSERT INTO detection_events (camera_id, camera_name, type, clip_path, clip_status) VALUES ('cam-h','n','motion',?, 'ready')").run(p);
      db.prepare("INSERT INTO recordings (camera_id, started_at, path, thumb_path) VALUES ('cam-h', datetime('now'), ?, ?)").run(p, p);
    }
    assert.equal((await delCamera('cam-h')).status, 204);
    for (const [name, f] of Object.entries(victims)) assert.ok(fs.existsSync(f), `${name} was deleted through a stored path: ${f}`);
    assert.ok(fs.existsSync(CLIPS_DIR));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM detection_events WHERE camera_id = 'cam-h'").get().n, 0);
  });

  test('an id that is not one safe path segment never reaches a directory removal', async () => {
    // (Needs no link, so it runs even where the link in beforeEach could not be made.)
    // A child id comes from the URL, and %2F decodes to a slash, so `..%2F.ring` arrives as `../.ring`.
    // Joined under clips/timelapse/ that is clips/.ring: INSIDE the clips dir, so the containment check
    // alone would let it through and wipe every camera's segment ring. Only the id check stops it (since the
    // #719 review the UUID-shape rule, which this id fails; before it, a one-safe-segment rule). (Plain `..`
    // would resolve to the clips dir itself and be caught by containment, which is why this id is the one
    // worth testing.)
    //
    // The ids are planted straight into the tables: the app only ever mints UUIDs, but a database can be
    // restored or edited, and the delete must not trust the id it was given to name a directory.
    makeChild(db, { id: '../.ring' });
    makeCamera(db, { id: '../.ring', path: 'path_hostile' });
    const ringFile = writeFile(path.join(CLIPS_DIR, '.ring', 'some-camera', 'seg-1.mkv'));
    const res = await call(`${childServer.url}/api/children/..%2F.ring`, { method: 'DELETE', token });
    assert.equal(res.status, 204);
    assert.ok(fs.existsSync(ringFile), "another camera's ring was removed through a child id");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM children WHERE id = '../.ring'").get().n, 0, 'the row itself is still deleted');
    const cam = await call(`${cameraServer.url}/api/cameras/..%2F.ring`, { method: 'DELETE', token });
    assert.equal(cam.status, 204);
    assert.ok(fs.existsSync(ringFile), "another camera's ring was removed through a camera id");
    assert.ok(fs.existsSync(victims.aDir));
  });
});

// --- failure part-way --------------------------------------------------------------------------

describe('a failure part-way leaves nothing referencing a deleted file, and can be retried', () => {
  // fs.unlinkSync is the real module's property; patching it makes ONE chosen file refuse to go (a real
  // EACCES cannot be provoked portably - root ignores permissions in CI containers). Nothing else mocked.
  const realUnlink = fs.unlinkSync;
  let blocked = null;
  beforeEach(() => {
    blocked = null;
    fs.unlinkSync = (p, ...rest) => {
      if (blocked && String(p) === blocked) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realUnlink(p, ...rest);
    };
  });
  after(() => { fs.unlinkSync = realUnlink; });

  function threeRecordings(owner) {
    const out = [];
    for (const tag of ['a', 'b', 'c']) {
      const rel = `${owner}/${tag}.mp4`;
      const abs = writeFile(path.join(CLIPS_DIR, rel));
      const id = db.prepare("INSERT INTO recordings (camera_id, child_id, started_at, path) VALUES (?, ?, datetime('now'), ?)")
        .run(owner.startsWith('cam') ? owner : 'c', owner.startsWith('child') ? owner : null, rel).lastInsertRowid;
      out.push({ id, abs });
    }
    return out;
  }
  const rowExists = (id) => !!db.prepare('SELECT 1 FROM recordings WHERE id = ?').get(id);

  test('child: the file that cannot be removed stops the delete; the child stays; every surviving row still has its file; a retry finishes', async () => {
    makeChild(db, { id: 'child-f' });
    const [a, b, c] = threeRecordings('child-f');
    blocked = b.abs;
    const res = await delChild('child-f');
    // A 4xx, never a 5xx: Cloudflare strips a 5xx body, and the Remove dialog shows this one (#719 review).
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Could not delete everything for this child \(.*permission denied.*\), so the child was not removed/);
    assert.ok(db.prepare("SELECT 1 FROM children WHERE id = 'child-f'").get(), 'the child must survive a failed delete so it can be retried');
    // The ordering claim: file first, then its row, one at a time.
    assert.ok(!fs.existsSync(a.abs) && !rowExists(a.id), 'a: file and row both gone');
    for (const r of [b, c]) {
      if (rowExists(r.id)) assert.ok(fs.existsSync(r.abs), 'a surviving row names a file that is gone');
    }
    assert.ok(rowExists(b.id) && fs.existsSync(b.abs), 'b: the failing file and its row both stay');
    blocked = null;
    assert.equal((await delChild('child-f')).status, 204, 'retry');
    assert.ok(![a, b, c].some((r) => rowExists(r.id) || fs.existsSync(r.abs)));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM children WHERE id = 'child-f'").get().n, 0);
  });

  test('camera: the same, and the camera row stays until everything else is gone', async () => {
    makeCamera(db, { id: 'cam-f' });
    const [a, b, c] = threeRecordings('cam-f');
    blocked = b.abs;
    const res = await delCamera('cam-f');
    assert.equal(res.status, 409);
    assert.match(res.body.error, /Could not delete everything for this camera \(.*permission denied.*\), so the camera was not removed/);
    assert.ok(db.prepare("SELECT 1 FROM cameras WHERE id = 'cam-f'").get(), 'the camera must survive a failed delete');
    for (const r of [a, b, c]) if (rowExists(r.id)) assert.ok(fs.existsSync(r.abs), 'a surviving row names a file that is gone');
    blocked = null;
    assert.equal((await delCamera('cam-f')).status, 204, 'retry');
    assert.ok(![a, b, c].some((r) => rowExists(r.id) || fs.existsSync(r.abs)));
  });

  test('a file that is already missing is not an error', async () => {
    makeChild(db, { id: 'child-m' });
    const [a, b] = threeRecordings('child-m');
    fs.rmSync(a.abs);
    fs.rmSync(b.abs);
    assert.equal((await delChild('child-m')).status, 204);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE child_id = 'child-m'").get().n, 0);
  });

  // #719 review: both snapshot removals caught EVERY error and carried on (`catch {}` survived), so a photo that
  // could not be deleted lost its row, and the id that names it, while the file stayed.
  test('★ #719 a snapshot photo that cannot be deleted stops the delete, and its row stays to name it', async () => {
    makeCamera(db, { id: 'cam-snapfail' });
    const evId = db.prepare("INSERT INTO detection_events (camera_id, camera_name, type, snapshot) VALUES ('cam-snapfail', 'n', 'motion', 1)").run().lastInsertRowid;
    const evJpg = writeFile(path.join(SNAPSHOT_DIRS.detection_events, `${evId}.jpg`));
    const txId = db.prepare("INSERT INTO bed_transitions (camera_id, type, verdict, snapshot) VALUES ('cam-snapfail', 'into_bed', 'correct', 1)").run().lastInsertRowid;
    const txJpg = writeFile(path.join(SNAPSHOT_DIRS.bed_transitions, `${txId}.jpg`));

    blocked = evJpg; // alerts are purged first
    assert.equal((await delCamera('cam-snapfail')).status, 409);
    assert.ok(db.prepare('SELECT 1 FROM detection_events WHERE id = ?').get(evId), "the alert's row went while its photo stayed");
    assert.ok(fs.existsSync(evJpg));

    blocked = txJpg; // then the judged transition's frame
    assert.equal((await delCamera('cam-snapfail')).status, 409);
    assert.ok(db.prepare('SELECT 1 FROM bed_transitions WHERE id = ?').get(txId), "the transition's row went while its photo stayed");
    assert.ok(fs.existsSync(txJpg));
    assert.ok(db.prepare("SELECT 1 FROM cameras WHERE id = 'cam-snapfail'").get(), 'the camera must survive a failed delete');

    blocked = null;
    assert.equal((await delCamera('cam-snapfail')).status, 204, 'retry');
    assert.ok(!fs.existsSync(evJpg) && !fs.existsSync(txJpg));
  });

  // #719 review: resolving a stored path's folder failed for a reason other than "missing" (EACCES here; ELOOP
  // or EIO the same) and was treated as missing, so the row was deleted and the file stayed.
  test('★ #719 a stored path whose folder cannot be resolved stops the delete, and its row stays', async () => {
    makeChild(db, { id: 'child-rp' });
    const rel = 'child-rp/a.mp4';
    const abs = writeFile(path.join(CLIPS_DIR, rel));
    const recId = db.prepare("INSERT INTO recordings (camera_id, child_id, started_at, path) VALUES ('c', 'child-rp', datetime('now'), ?)").run(rel).lastInsertRowid;
    const realRealpath = fs.realpathSync;
    const unresolvable = path.join(CLIPS_DIR, 'child-rp');
    fs.realpathSync = (p, ...rest) => {
      if (String(p) === unresolvable) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realRealpath(p, ...rest);
    };
    try {
      assert.equal((await delChild('child-rp')).status, 409);
      assert.ok(db.prepare('SELECT 1 FROM recordings WHERE id = ?').get(recId), 'the row went while its file stayed');
      assert.ok(fs.existsSync(abs));
      assert.ok(db.prepare("SELECT 1 FROM children WHERE id = 'child-rp'").get(), 'the child must survive a failed delete');
    } finally {
      fs.realpathSync = realRealpath;
    }
    assert.equal((await delChild('child-rp')).status, 204, 'retry');
    assert.ok(!fs.existsSync(abs));
  });

  // #719 review: the frames folder (a photo of the bed every 2 minutes) was removed by a helper that swallowed
  // every error, so the child was deleted and the frames stayed. fs.rmSync is patched for the same reason as
  // unlinkSync above: a real EACCES is not portable (root ignores permissions in CI).
  test('★ #719 a frames folder that cannot be removed stops the delete, and the child stays', async () => {
    const childId = randomUUID();
    makeChild(db, { id: childId });
    const frame = writeFile(path.join(CLIPS_DIR, '.timelapse-frames', childId, '2026-01-01', 'f-1.jpg'));
    const realRm = fs.rmSync;
    const isFramesDir = (p) => path.basename(String(p)) === childId && path.basename(path.dirname(String(p))) === '.timelapse-frames';
    fs.rmSync = (p, ...rest) => {
      if (isFramesDir(p)) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realRm(p, ...rest);
    };
    try {
      const res = await delChild(childId);
      assert.equal(res.status, 409);
      assert.match(res.body.error, /permission denied/);
      assert.ok(db.prepare('SELECT 1 FROM children WHERE id = ?').get(childId), 'the child was deleted while its frames stayed');
      assert.ok(fs.existsSync(frame));
    } finally {
      fs.rmSync = realRm;
    }
    assert.equal((await delChild(childId)).status, 204, 'retry');
    assert.ok(!fs.existsSync(frame));
  });

  // #719 re-review: the snapshot removals used to ask fs.existsSync first, which answers false for a file it
  // cannot stat, so such a photo counted as missing: its row was deleted and the file stayed. Simulated as the
  // real cause behaves (a folder the app may not search): existsSync false, stat and lstat EACCES, unlink EACCES.
  test('★ #719 a snapshot photo the server cannot even stat stops the delete, and its row stays', async () => {
    makeCamera(db, { id: 'cam-nostat' });
    const evId = db.prepare("INSERT INTO detection_events (camera_id, camera_name, type, snapshot) VALUES ('cam-nostat', 'n', 'motion', 1)").run().lastInsertRowid;
    const evJpg = writeFile(path.join(SNAPSHOT_DIRS.detection_events, `${evId}.jpg`));
    const txId = db.prepare("INSERT INTO bed_transitions (camera_id, type, verdict, snapshot) VALUES ('cam-nostat', 'into_bed', 'wrong', 1)").run().lastInsertRowid;
    const txJpg = writeFile(path.join(SNAPSHOT_DIRS.bed_transitions, `${txId}.jpg`));
    const real = { existsSync: fs.existsSync, statSync: fs.statSync, lstatSync: fs.lstatSync };
    const eacces = () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    let hidden = null;
    fs.existsSync = (p) => (String(p) === hidden ? false : real.existsSync(p));
    fs.statSync = (p, ...r) => { if (String(p) === hidden) throw eacces(); return real.statSync(p, ...r); };
    fs.lstatSync = (p, ...r) => { if (String(p) === hidden) throw eacces(); return real.lstatSync(p, ...r); };
    try {
      hidden = blocked = evJpg; // alerts are purged first
      assert.equal((await delCamera('cam-nostat')).status, 409);
      assert.ok(db.prepare('SELECT 1 FROM detection_events WHERE id = ?').get(evId), "the alert's row went while its photo stayed");
      assert.ok(real.existsSync(evJpg));
      hidden = blocked = txJpg; // the alert's photo can go now, so this pass reaches the transitions
      assert.equal((await delCamera('cam-nostat')).status, 409);
      assert.ok(db.prepare('SELECT 1 FROM bed_transitions WHERE id = ?').get(txId), "the transition's row went while its photo stayed");
      assert.ok(real.existsSync(txJpg));
    } finally {
      Object.assign(fs, real);
      hidden = blocked = null;
    }
    assert.equal((await delCamera('cam-nostat')).status, 204, 'retry');
    assert.ok(!fs.existsSync(evJpg) && !fs.existsSync(txJpg));
  });

  // #719 re-review: the route stops every leg and removes the camera's MediaMTX path before the purge, so a purge
  // that fails part-way used to leave the camera dark until the 5-minute reconcile. Observed at the stand-in
  // MediaMTX: after the path is removed, it is registered again, and the transcoder start asks about its sibling
  // HLS path. (No ffmpeg on PATH here, so the legs themselves cannot be seen running.)
  test('★ #719 a camera delete that fails part-way brings the camera straight back', async () => {
    readyStorage();
    const id = randomUUID();
    makeCamera(db, { id });
    const rel = `fail-${id}/r.mp4`;
    const abs = writeFile(path.join(CLIPS_DIR, rel));
    db.prepare("INSERT INTO recordings (camera_id, started_at, path) VALUES (?, datetime('now'), ?)").run(id, rel);
    blocked = abs;
    const from = mtxLog.length;
    try {
      assert.equal((await delCamera(id)).status, 409);
    } finally {
      blocked = null;
      stopAllSegmenters();
    }
    assert.ok(db.prepare('SELECT 1 FROM cameras WHERE id = ?').get(id), 'the camera must survive a failed delete');
    const seen = mtxLog.slice(from);
    const removed = seen.indexOf(`DELETE /v3/config/paths/delete/path_${id}`);
    assert.ok(removed >= 0, 'the fixture is wrong: the delete never removed the path');
    const after = seen.slice(removed + 1);
    assert.ok(after.includes(`PATCH /v3/config/paths/patch/path_${id}`), 'the failed delete left the camera\'s stream path removed');
    assert.ok(after.includes(`GET /v3/config/paths/get/path_${id}-hls`), 'the failed delete did not restart the camera\'s transcoder');
    assert.equal((await delCamera(id)).status, 204, 'retry');
  });
});

// --- folder sweeps: links and shared folders (#719 review) -------------------------------------------------

describe('★ #719 a folder sweep never follows a link out of the clips folder', () => {
  let outside;
  beforeEach(() => { outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-victim-')); });
  afterEach(() => { fs.rmSync(outside, { recursive: true, force: true }); });

  // For one test, clips/<shared> is a link to `outside`; the real folder is put back afterwards.
  async function withSharedLinkedOut(t, shared, fn) {
    const real = path.join(CLIPS_DIR, shared);
    const aside = `${real}.aside-${++seq}`;
    fs.mkdirSync(CLIPS_DIR, { recursive: true }); // run alone (a name pattern), nothing has made it yet
    if (fs.existsSync(real)) fs.renameSync(real, aside);
    try {
      if (linkDirOrSkip(t, outside, real)) await fn();
    } finally {
      try { fs.unlinkSync(real); } catch (e) { if (e.code !== 'ENOENT') throw e; } // the link itself, never followed
      if (fs.existsSync(aside)) fs.renameSync(aside, real);
    }
  }

  // Each case: the shared folder made a link, the file outside that the old code deleted, and the delete.
  for (const [shared, kind, victimRel] of [
    ['timelapse', 'child', (id) => [id, 'night.mp4']],
    ['.timelapse-frames', 'child', (id) => [id, '2026-01-01', 'f-1.jpg']],
    ['.ring', 'camera', (id) => [id, 'seg-1.mkv']],
  ]) {
    test(`clips/${shared} linked outside: removing a ${kind} refuses with a 409 and deletes nothing`, async (t) => {
      await withSharedLinkedOut(t, shared, async () => {
        const id = randomUUID();
        if (kind === 'child') makeChild(db, { id });
        else makeCamera(db, { id });
        const victim = writeFile(path.join(outside, ...victimRel(id)));
        // A row with a file of its own: the refusal comes BEFORE anything is deleted, not halfway through.
        const recRel = `pre-${id}/r.mp4`;
        const recFile = writeFile(path.join(CLIPS_DIR, recRel));
        db.prepare(`INSERT INTO recordings (camera_id, child_id, started_at, path) VALUES (?, ?, datetime('now'), ?)`)
          .run(kind === 'camera' ? id : 'c', kind === 'child' ? id : null, recRel);

        const res = kind === 'child' ? await delChild(id) : await delCamera(id);
        assert.equal(res.status, 409);
        assert.match(res.body.error, /link to somewhere outside/);
        assert.ok(fs.existsSync(victim), `a file outside the clips folder was deleted through clips/${shared}`);
        const table = kind === 'child' ? 'children' : 'cameras';
        assert.ok(db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id), `the ${kind} must stay so it can be retried`);
        assert.ok(fs.existsSync(recFile), 'the purge deleted a recording before it refused');
      });
    });
  }

  // #719 re-review: found only inside the purge, this refusal came after every leg of the camera was stopped and its
  // stream path removed, and the camera stayed dark until the 5-minute reconcile. The route now runs the same
  // check first. Observed two ways: a hold on its clip ring is still there (stopping the ring clears every hold,
  // and a restart does not bring one back; with no ffmpeg here the ring's own entry cannot be watched, it goes
  // when the spawn fails), and the stand-in MediaMTX was never asked to remove its path.
  test('★ #719 a camera delete refused by the folder check stops nothing first', async (t) => {
    await withSharedLinkedOut(t, '.ring', async () => {
      readyStorage();
      const id = randomUUID();
      makeCamera(db, { id });
      startSegmenter(id, `path_${id}`);
      assert.ok(holdRing(id, 'test-hold', Date.now() - 10_000), 'the fixture could not hold the ring');
      const from = mtxLog.length;
      try {
        const res = await delCamera(id);
        assert.equal(res.status, 409);
        assert.match(res.body.error, /link to somewhere outside/);
        assert.ok(holdOwners(id).includes('test-hold'), "the ring's holds were cleared: it was stopped before the refusal");
        assert.ok(!mtxLog.slice(from).some((l) => l.startsWith('DELETE ')), 'its stream path was removed before the refusal');
      } finally {
        stopAllSegmenters();
      }
    });
  });

  test('the per-id folder ITSELF being a link: the link is removed, what it points at is not', async (t) => {
    const id = randomUUID();
    makeCamera(db, { id });
    const victim = writeFile(path.join(outside, 'seg-1.mkv'));
    fs.mkdirSync(path.join(CLIPS_DIR, '.ring'), { recursive: true });
    const link = path.join(CLIPS_DIR, '.ring', id);
    if (!linkDirOrSkip(t, outside, link)) return;
    assert.equal((await delCamera(id)).status, 204);
    assert.ok(fs.existsSync(victim), 'the sweep followed the link');
    assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' }, 'the link itself was left');
  });
});

describe('★ #719 an id that names a shared folder never sweeps it', () => {
  // Every one passes the old one-safe-segment rule. `transition-snapshots` and `detection-snapshots` live in the
  // data folder by default, not the clips folder; they are planted here because the clips folder is configurable
  // and may be the data folder itself. `.hidden` stands for any leading-dot name.
  const NAMES = ['timelapse', '.ring', '.timelapse-frames', 'transition-snapshots', 'detection-snapshots', '.hidden'];
  test('cameras and children with these ids are deleted, and every shared folder keeps its files', async () => {
    const keep = NAMES.map((n) => writeFile(path.join(CLIPS_DIR, n, 'someone-else', 'keep.bin')));
    for (const id of NAMES) {
      makeCamera(db, { id });
      makeChild(db, { id });
      assert.equal((await delCamera(encodeURIComponent(id))).status, 204, `camera ${id}`);
      assert.equal((await delChild(encodeURIComponent(id))).status, 204, `child ${id}`);
      for (const f of keep) assert.ok(fs.existsSync(f), `removing the camera or child with id ${JSON.stringify(id)} deleted ${f}`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cameras WHERE id = ?').get(id).n, 0, `camera ${id} row`);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM children WHERE id = ?').get(id).n, 0, `child ${id} row`);
    }
  });
});

// --- writers that finish after the delete, and a recording in progress (#719 review) ----------------------

describe('★ #719 a photo that arrives after the delete leaves nothing behind', () => {
  test('a bed-transition frame still being grabbed when its child is removed is deleted on arrival, and never served', async () => {
    // A camera whose snapshot URL answers only when told to, so the grab is in flight across the delete.
    let requested;
    const gotRequest = new Promise((r) => { requested = r; });
    let release;
    const slow = createServer((req, res) => {
      release = () => { res.setHeader('content-type', 'image/jpeg'); res.end(Buffer.from('jpeg-bytes')); };
      requested();
    });
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    // Observe the write so the test knows when the late photo has landed (attachSnapshot is fire-and-forget).
    const realWrite = fs.promises.writeFile;
    let written;
    const wrote = new Promise((r) => { written = r; });
    fs.promises.writeFile = async (...a) => { try { return await realWrite(...a); } finally { written(); } };
    try {
      const childId = randomUUID();
      makeChild(db, { id: childId });
      makeCamera(db, { id: 'cam-slow', childId, extra: { snapshot_url: `http://127.0.0.1:${slow.address().port}/snap.jpg` } });
      const txId = recordBedTransition('cam-slow', TRANSITION.INTO_BED, 0.2);
      await gotRequest;
      assert.equal((await delChild(childId)).status, 204);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bed_transitions WHERE id = ?').get(txId).n, 0);

      release();
      // Bounded, so a grab that fails before writing fails this test instead of hanging the file.
      let timer;
      await Promise.race([wrote, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the late frame was never written: the fixture did not reach the write')), 5000); })]);
      clearTimeout(timer);
      await new Promise((r) => setImmediate(r)); // let attachSnapshot finish what follows its write
      assert.ok(!fs.existsSync(path.join(SNAPSHOT_DIRS.bed_transitions, `${txId}.jpg`)), 'the frame was written back with no row to name it');
      assert.equal((await call(`${cameraServer.url}/api/cameras/bed-transitions/${txId}/snapshot`, { token })).status, 404);
    } finally {
      fs.promises.writeFile = realWrite;
      slow.closeAllConnections?.();
      await new Promise((r) => slow.close(r));
    }
  });

  test('a photo whose row is gone is not served, even while its file is still on disk', async () => {
    // A file left behind before this fix, or by any path not guarded yet. The id names the file, so without the
    // row check it would be served to any signed-in user for good.
    const orphanTx = 990001;
    const orphanEv = 990002;
    writeFile(path.join(SNAPSHOT_DIRS.bed_transitions, `${orphanTx}.jpg`));
    writeFile(path.join(SNAPSHOT_DIRS.detection_events, `${orphanEv}.jpg`));
    assert.equal((await call(`${cameraServer.url}/api/cameras/bed-transitions/${orphanTx}/snapshot`, { token })).status, 404);
    assert.equal((await call(`${cameraServer.url}/api/cameras/alerts/${orphanEv}/snapshot`, { token })).status, 404);
    // Control: with its row, the same kind of file IS served (so the 404s above are not the route being broken).
    const txId = db.prepare("INSERT INTO bed_transitions (camera_id, type, snapshot) VALUES ('cam-x', 'into_bed', 1)").run().lastInsertRowid;
    writeFile(path.join(SNAPSHOT_DIRS.bed_transitions, `${txId}.jpg`));
    assert.equal((await call(`${cameraServer.url}/api/cameras/bed-transitions/${txId}/snapshot`, { token })).status, 200);
    const evId = db.prepare("INSERT INTO detection_events (camera_id, camera_name, type, snapshot) VALUES ('cam-x', 'n', 'motion', 1)").run().lastInsertRowid;
    writeFile(path.join(SNAPSHOT_DIRS.detection_events, `${evId}.jpg`));
    assert.equal((await call(`${cameraServer.url}/api/cameras/alerts/${evId}/snapshot`, { token })).status, 200);
  });
});

describe('★ #719 removing is refused while a recording is in progress', () => {
  test('a camera recording on demand blocks removing it, and its child, with a 409; nothing is deleted', async () => {
    // As recordings-lifecycle.test.js arms it: storage marked ready from a supplied mount table, a segmenter (no
    // ffmpeg on PATH, so it never really runs) and one closed segment for the pre-roll.
    readyStorage();
    const childId = randomUUID();
    const camId = randomUUID();
    makeChild(db, { id: childId });
    makeCamera(db, { id: camId, childId });
    startSegmenter(camId, `path_${camId}`);
    const seg = writeFile(path.join(CLIPS_DIR, '.ring', camId, 'seg-fixture.mkv'));
    const t0 = new Date(Date.now() - 3000);
    fs.utimesSync(seg, t0, t0);
    try {
      startRecording(db.prepare('SELECT * FROM cameras WHERE id = ?').get(camId));
      assert.ok(isRecording(camId), 'the fixture did not start a recording');
      const recId = db.prepare('SELECT id FROM recordings WHERE camera_id = ?').get(camId).id;

      const cam = await delCamera(camId);
      assert.equal(cam.status, 409);
      assert.match(cam.body.error, /Stop the recording first, then remove the camera/);
      const kid = await delChild(childId);
      assert.equal(kid.status, 409);
      assert.match(kid.body.error, /Stop the recording first, then remove the child/);

      assert.ok(db.prepare('SELECT 1 FROM cameras WHERE id = ?').get(camId), 'the camera was deleted');
      assert.ok(db.prepare('SELECT 1 FROM children WHERE id = ?').get(childId), 'the child was deleted');
      assert.ok(db.prepare('SELECT 1 FROM recordings WHERE id = ?').get(recId), 'the recording row was deleted');
      assert.ok(fs.existsSync(seg), 'the segment ring was swept');
      assert.ok(isRecording(camId), 'the refused delete stopped the recording');
      // The refusal comes BEFORE anything is stopped (#719 re-review): with the guard moved below the stops, the
      // checks above still pass, because stopping the ring only drops its registry entry and its holds. The hold
      // is what shows it (the registry entry itself goes anyway here, when the ffmpeg spawn fails).
      assert.ok(holdOwners(camId).includes(ondemandHoldOwner(recId)), "the recording's hold on the ring was cleared before the refusal");
      assert.ok(!mtxLog.some((l) => l === `DELETE /v3/config/paths/delete/path_${camId}`), 'its stream path was removed before the refusal');
    } finally {
      await stopRecording(camId, { settleMs: 0 });
      stopAllSegmenters();
    }
    // Stopped: both can go.
    assert.equal((await delChild(childId)).status, 204);
    assert.equal((await delCamera(camId)).status, 204);
  });
});
