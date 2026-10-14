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
import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, makeChild, makeCamera, signToken, mountRouter, call,
} from './helpers/harness.js';

const dataDir = useTempDataDir();

// A stand-in MediaMTX that answers at once (see camera-delete-observation.test.js).
const mediamtx = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
await new Promise((r) => mediamtx.listen(0, '127.0.0.1', r));
process.env.MEDIAMTX_API = `http://127.0.0.1:${mediamtx.address().port}`;

const { default: db } = await import('../src/db.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { default: childrenRouter } = await import('../src/routes/children.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');

// Where a table's id-named snapshot JPEGs live. Only the DIRECTORY is spelled out; which tables have a
// snapshot is read from the schema, and a table with a `snapshot` column missing from this map fails below.
const SNAPSHOT_DIRS = {
  bed_transitions: path.join(dataDir, 'transition-snapshots'),
  detection_events: path.join(dataDir, 'detection-snapshots'),
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
  await childServer?.close();
  await cameraServer?.close();
  await new Promise((r) => mediamtx.close(r));
  cleanupTempDataDirs();
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
    const gone = seedEntity('child', 'child-gone');
    const kept = seedEntity('child', 'child-kept');

    // Anti-vacuous: every referencing column really got a row before we delete, files really exist.
    for (const [k, n] of Object.entries(gone.counts)) assert.ok(n >= 1, `fixture put nothing in ${k}`);
    assert.ok(referencing('child').length >= 4, 'schema discovery found suspiciously few tables');
    for (const f of gone.files) assert.ok(fs.existsSync(f), `fixture file missing: ${f}`);

    // The child's camera(s), read before they are unassigned.
    const camIds = db.prepare("SELECT id FROM cameras WHERE child_id = 'child-gone'").all().map((r) => r.id);
    assert.ok(camIds.length >= 1);
    const keptCamIds = db.prepare("SELECT id FROM cameras WHERE child_id = 'child-kept'").all().map((r) => r.id);
    const keptCamCounts = keptCamIds.map((c) => countsFor('camera', c));

    const res = await delChild('child-gone');
    assert.equal(res.status, 204);

    for (const [k, n] of Object.entries(countsFor('child', 'child-gone'))) assert.equal(n, 0, `${k} still names the deleted child`);
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
    assert.deepEqual(countsFor('child', 'child-kept'), kept.counts, 'a row of ANOTHER child was deleted');
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
  });
});

describe('deleting a camera deletes everything for it', () => {
  test('after DELETE, no row in ANY table that references the camera, and none of its files, remain; the control camera is untouched', async () => {
    const gone = seedEntity('camera', 'cam-gone');
    const kept = seedEntity('camera', 'cam-kept');
    for (const [k, n] of Object.entries(gone.counts)) assert.ok(n >= 1, `fixture put nothing in ${k}`);
    assert.ok(referencing('camera').length >= 7, 'schema discovery found suspiciously few tables');
    for (const f of gone.files) assert.ok(fs.existsSync(f), `fixture file missing: ${f}`);

    const res = await delCamera('cam-gone');
    assert.equal(res.status, 204);

    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cameras WHERE id = 'cam-gone'").get().n, 0);
    for (const [k, n] of Object.entries(countsFor('camera', 'cam-gone'))) assert.equal(n, 0, `${k} still names the deleted camera`);
    for (const f of gone.files) assert.ok(!fs.existsSync(f), `file survived the camera: ${f}`);
    assert.ok(!fs.existsSync(path.join(CLIPS_DIR, 'cam-gone')), 'per-camera clip dir left behind');
    assert.ok(!fs.existsSync(path.join(CLIPS_DIR, '.ring', 'cam-gone')), 'segment ring left behind');

    assert.deepEqual(countsFor('camera', 'cam-kept'), kept.counts, 'a row of ANOTHER camera was deleted');
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
  beforeEach(() => {
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-victim-'));
    victims = {
      sibling: writeFile(path.join(dataDir, 'victim-sibling.txt')),   // DATA_DIR/victim, one `..` out of clips
      absolute: writeFile(path.join(outsideDir, 'victim-absolute.txt')),
      viaLink: writeFile(path.join(outsideDir, 'victim-link', 'victim-via-link.txt')),
      aDir: writeFile(path.join(CLIPS_DIR, 'keep-me-dir', 'inner.txt')),
    };
    fs.symlinkSync(path.join(outsideDir, 'victim-link'), path.join(CLIPS_DIR, 'escape-link'));
  });
  afterEach(() => {
    fs.rmSync(outsideDir, { recursive: true, force: true });
    fs.rmSync(path.join(CLIPS_DIR, 'escape-link'), { force: true });
    fs.rmSync(path.join(CLIPS_DIR, 'keep-me-dir'), { recursive: true, force: true });
  });

  const hostilePaths = () => [
    path.relative(CLIPS_DIR, victims.sibling),                  // ../victim-sibling.txt
    victims.absolute,                                           // /tmp/.../victim-absolute.txt
    'escape-link/victim-via-link.txt',                          // a symlinked directory inside the clips dir
    'keep-me-dir',                                              // a directory, not a file: must never be removed recursively
    '.', '', './',                                              // the clips dir itself
    'x/../../victim-sibling.txt',                               // normalises out
  ];

  test('child delete: recordings, timelapses and wake clips with hostile paths are skipped, their rows still deleted', async () => {
    makeChild(db, { id: 'child-h' });
    for (const p of hostilePaths()) {
      db.prepare("INSERT INTO recordings (camera_id, child_id, started_at, path, thumb_path) VALUES ('c', 'child-h', 'now', ?, ?)").run(p, p);
      db.prepare("INSERT INTO timelapses (child_id, night_date, path, thumb_path) VALUES ('child-h', ?, ?, ?)").run(uniq('n'), p, p);
    }
    assert.equal((await delChild('child-h')).status, 204);
    for (const [name, f] of Object.entries(victims)) assert.ok(fs.existsSync(f), `${name} was deleted through a stored path: ${f}`);
    assert.ok(fs.existsSync(CLIPS_DIR));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE child_id = 'child-h'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM timelapses WHERE child_id = 'child-h'").get().n, 0);
  });

  test('camera delete: alert clips and recordings with hostile paths are skipped, their rows still deleted', async () => {
    makeCamera(db, { id: 'cam-h' });
    for (const p of hostilePaths()) {
      db.prepare("INSERT INTO detection_events (camera_id, camera_name, type, clip_path, clip_status) VALUES ('cam-h','n','motion',?, 'ready')").run(p);
      db.prepare("INSERT INTO recordings (camera_id, started_at, path, thumb_path) VALUES ('cam-h', 'now', ?, ?)").run(p, p);
    }
    assert.equal((await delCamera('cam-h')).status, 204);
    for (const [name, f] of Object.entries(victims)) assert.ok(fs.existsSync(f), `${name} was deleted through a stored path: ${f}`);
    assert.ok(fs.existsSync(CLIPS_DIR));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM detection_events WHERE camera_id = 'cam-h'").get().n, 0);
  });

  test('an id that is not one safe path segment never reaches a directory removal', async () => {
    // A child id comes from the URL, and %2F decodes to a slash, so `..%2F.ring` arrives as `../.ring`.
    // Joined under clips/timelapse/ that is clips/.ring: INSIDE the clips dir, so the containment check
    // alone would let it through and wipe every camera's segment ring. Only the one-safe-segment check
    // stops it. (Plain `..` would resolve to the clips dir itself and be caught by containment, which is
    // why this id is the one worth testing.)
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
      const id = db.prepare("INSERT INTO recordings (camera_id, child_id, started_at, path) VALUES (?, ?, 'now', ?)")
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
    assert.equal(res.status, 500);
    assert.equal(typeof res.body.error, 'string');
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
    assert.equal(res.status, 500);
    assert.equal(typeof res.body.error, 'string');
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
});
