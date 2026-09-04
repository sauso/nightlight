// Deleting a child must take its video with it, off the disk as well as out of the database.
//
// The defect (issue #259): DELETE /api/children/:id cleared cameras and sleep_nights and nothing else.
// `timelapses` and `recordings` both carry a child_id and neither was touched, so the rows survived
// pointing at a child that no longer existed — invisible to every listing query, which filters on the
// child — while the FILES stayed on disk forever. Worst for manual recordings, which have no retention
// sweep by design: deleting the child removed the only route to ever reclaiming that space.
//
// ★ THE FILES ARE REALLY WRITTEN AND THEIR ABSENCE IS REALLY CHECKED. A fixture that only inserted
// rows would pass against a fix that deleted rows and leaked every file — which is the half of this
// bug that actually costs a user their disk.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { CLIPS_DIR } = await import('../src/lib/clipRecorder.js');
const { default: childrenRouter } = await import('../src/routes/children.js');

let server;
let token;
const del = (id) => call(`${server.url}/api/children/${id}`, { method: 'DELETE', token });

const framesDir = (childId) => path.join(CLIPS_DIR, '.timelapse-frames', childId);

const KEEP = 'kid-keep';
const GONE = 'kid-gone';

// Absolute paths of every file the fixture writes, so each can be asserted on individually.
const files = {};

function seedChild(childId, tag) {
  db.prepare('INSERT OR REPLACE INTO children (id, name) VALUES (?, ?)').run(childId, `Child ${tag}`);
  const dir = path.join(CLIPS_DIR, childId);
  fs.mkdirSync(dir, { recursive: true });

  const rec = path.join(dir, `${tag}-rec.mp4`);
  const recThumb = path.join(dir, `${tag}-rec.jpg`);
  const tl = path.join(dir, `${tag}-tl.mp4`);
  const tlThumb = path.join(dir, `${tag}-tl.jpg`);
  for (const f of [rec, recThumb, tl, tlThumb]) fs.writeFileSync(f, 'x');

  const rel = (abs) => path.relative(CLIPS_DIR, abs).split(path.sep).join('/');
  const recId = db
    .prepare(
      `INSERT INTO recordings (camera_id, child_id, kind, status, started_at, path, thumb_path)
       VALUES ('cam-1', ?, 'manual', 'ready', '2026-09-04 10:00:00', ?, ?)`
    )
    .run(childId, rel(rec), rel(recThumb)).lastInsertRowid;
  db.prepare(
    `INSERT INTO timelapses (child_id, night_date, path, thumb_path, created_at)
     VALUES (?, '2026-09-03', ?, ?, datetime('now'))`
  ).run(childId, rel(tl), rel(tlThumb));

  // A wake clip: same table, same child_id, no `kind` filter in the route's loop.
  const wake = path.join(dir, `${tag}-wake.mp4`);
  fs.writeFileSync(wake, 'x');
  db.prepare(
    `INSERT INTO recordings (camera_id, child_id, kind, status, started_at, path)
     VALUES ('cam-1', ?, 'wake', 'ready', '2026-09-04 02:00:00', ?)`
  ).run(childId, rel(wake));

  // Frames for a night still in progress — no `timelapses` row exists for these yet.
  const fdir = path.join(framesDir(childId), '2026-09-04');
  fs.mkdirSync(fdir, { recursive: true });
  fs.writeFileSync(path.join(fdir, 'f-1.jpg'), 'x');

  files[tag] = { rec, recThumb, tl, tlThumb, wake };
  return recId;
}

before(async () => {
  server = await mountRouter('/api/children', childrenRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  token = signToken({ sub: admin.id, role: 'admin', sid: makeSession(db, admin.id) });
  seedChild(GONE, 'gone');
  seedChild(KEEP, 'keep');
});

after(async () => {
  if (server) await server.close();
  cleanupTempDataDirs();
});

const countFor = (table, childId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE child_id = ?`).get(childId).n;

describe('DELETE /api/children/:id', () => {
  test('the fixture is real before we start — otherwise this proves nothing', () => {
    // Anti-vacuous. Every assertion below is about things being GONE, and "gone" is indistinguishable
    // from "never there" unless it was there first.
    for (const tag of ['gone', 'keep']) {
      for (const f of Object.values(files[tag])) {
        assert.ok(fs.existsSync(f), `fixture file missing before the test even runs: ${f}`);
      }
    }
    assert.equal(countFor('recordings', GONE), 2, 'expected a manual recording AND a wake clip');
    assert.equal(countFor('timelapses', GONE), 1);
  });

  test('deleting a child removes its recordings and timelapses FROM DISK, not just the rows', async () => {
    const res = await del(GONE);
    assert.equal(res.status, 204);

    assert.equal(countFor('recordings', GONE), 0, 'recording rows survived the child — invisible forever');
    assert.equal(countFor('timelapses', GONE), 0, 'timelapse rows survived the child');

    // ★ The half that actually costs disk. Manual recordings have no retention sweep by design, so a
    // leaked file here is never reclaimed by anything.
    for (const [name, f] of Object.entries(files.gone)) {
      assert.ok(!fs.existsSync(f), `${name} was left on disk with no way left to reach it: ${f}`);
    }
  });

  test('and the child row itself is gone', () => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM children WHERE id = ?').get(GONE).n, 0);
  });

  test('another child keeps everything — this deletes one child, not all media', () => {
    // The control. Without it, a fix that wiped the whole recordings table would pass every case above.
    assert.equal(countFor('recordings', KEEP), 2, 'an unrelated child lost its recordings');
    assert.equal(countFor('timelapses', KEEP), 1, 'an unrelated child lost its timelapses');
    for (const [name, f] of Object.entries(files.keep)) {
      assert.ok(fs.existsSync(f), `an unrelated child's ${name} was deleted from disk: ${f}`);
    }
  });

  test('WAKE clips go too — they share the recordings table, and the docs now say so', () => {
    // ⚠️ THIS PINS A CLAIM THAT WAS FALSE IN A SHIPPED CHANGELOG. The first version of this PR said
    // "alert clips and wake clips are unaffected; they were already swept by normal retention". True
    // of alert clips — detection_events has no child_id at all, they hang off the camera — but FALSE
    // of wake clips: they live in `recordings` with a child_id, and the route's loop has no `kind`
    // filter, so they are deleted identically. Found by adversarial review of #284.
    // The behaviour is right (they are that child's video, and nothing else would ever reclaim them);
    // it was the description that was wrong. Asserted here so the docs and the code cannot drift apart.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE child_id = ? AND kind = 'wake'").get(GONE).n,
      0,
      'a wake clip survived its child'
    );
    assert.ok(!fs.existsSync(files.gone.wake), `the wake clip file was left on disk: ${files.gone.wake}`);
    assert.ok(fs.existsSync(files.keep.wake), 'another child lost its wake clip');
  });

  test('frames for a night still in progress are cleaned up too', () => {
    // ★ A SIBLING THE FIX ORIGINALLY MISSED. Frames are sampled every 2 minutes into
    // .timelapse-frames/<childId>/<nightDate>/ and a `timelapses` row only exists once the night is
    // ASSEMBLED — so deleting a child mid-night left a directory the timelapse loop could not see, and
    // which nothing else ever revisits for a child that no longer exists. Same leak as #259, one
    // directory along. Found by adversarial review of #284.
    assert.ok(!fs.existsSync(framesDir(GONE)), 'in-progress timelapse frames were left on disk');
    assert.ok(fs.existsSync(framesDir(KEEP)), 'another child lost its in-progress frames');
  });

  test('deleting a child with no media at all is still a clean 204', async () => {
    db.prepare('INSERT OR REPLACE INTO children (id, name) VALUES (?, ?)').run('kid-empty', 'Empty');
    const res = await del('kid-empty');
    assert.equal(res.status, 204);
  });
});
