import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeChild, makeCamera } from './helpers/harness.js';

useTempDataDir();
const { default: db } = await import('../src/db.js');
const { listChildRecordings } = await import('../src/lib/recordings.js');
const CHILD = 'paging-child';
const OTHER = 'other-child';
const CAM = 'paging-camera';

before(() => {
  makeChild(db, { id: CHILD, name: 'A child' });
  makeChild(db, { id: OTHER, name: 'Another child' });
  makeCamera(db, { id: CAM, name: 'Camera', childId: CHILD });
});
after(() => { db.close(); cleanupTempDataDirs(); });
beforeEach(() => db.prepare('DELETE FROM recordings').run());

function insert({ child = CHILD, kind = 'manual', status = 'ready', created = '2026-01-01 00:00:00' } = {}) {
  return Number(db.prepare(
    `INSERT INTO recordings (camera_id, child_id, kind, status, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(CAM, child, kind, status, created, created).lastInsertRowid);
}

const ids = (rows) => rows.map((row) => row.id);
const cursor = (row) => ({ created_at: row.created_at, id: row.id });

test('default call returns the newest 50, and positional limits still work', () => {
  const created = Array.from({ length: 120 }, (_, n) => insert({
    created: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString().slice(0, 19).replace('T', ' '),
  }));
  assert.deepEqual(ids(listChildRecordings(CHILD)), created.slice(-50).reverse());
  assert.deepEqual(ids(listChildRecordings(CHILD, 3)), created.slice(-3).reverse());
  assert.equal(listChildRecordings(CHILD, 0).length, 1);
  assert.equal(listChildRecordings(CHILD, 999).length, 120);
});

test('the library clamps limits to 1 through 200', () => {
  for (let n = 0; n < 210; n++) insert();
  assert.equal(listChildRecordings(CHILD, 0).length, 1);
  assert.equal(listChildRecordings(CHILD, 999).length, 200);
  assert.equal(listChildRecordings(CHILD, { limit: 200 }).length, 200);
});

test('cursor pages cover 120 rows without a gap or overlap', () => {
  const created = Array.from({ length: 120 }, (_, n) => insert({
    created: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString().slice(0, 19).replace('T', ' '),
  }));
  const first = listChildRecordings(CHILD);
  const second = listChildRecordings(CHILD, { before: cursor(first.at(-1)) });
  const third = listChildRecordings(CHILD, { before: cursor(second.at(-1)) });
  assert.deepEqual(ids([...first, ...second, ...third]), created.reverse());
  assert.deepEqual([first.length, second.length, third.length], [50, 50, 20]);
});

test('same-second ties cross page boundaries by descending id, even after the cursor row is deleted', () => {
  // #1112, Codex plan review 2026-11-16: second-resolution timestamps make a total id order essential.
  const created = Array.from({ length: 7 }, () => insert());
  const first = listChildRecordings(CHILD, { limit: 3 });
  const last = cursor(first.at(-1));
  db.prepare('DELETE FROM recordings WHERE id = ?').run(last.id);
  const second = listChildRecordings(CHILD, { limit: 3, before: last });
  const third = listChildRecordings(CHILD, { limit: 3, before: cursor(second.at(-1)) });
  assert.deepEqual(ids(first), created.slice(4).reverse());
  assert.deepEqual(ids(second), created.slice(1, 4).reverse());
  assert.deepEqual(ids(third), [created[0]]);
});

test('each page keeps the child, manual-kind and finished-status filters', () => {
  const older = insert({ created: '2026-01-01 00:00:00', status: 'failed' });
  insert({ child: OTHER, created: '2026-01-01 00:00:00' });
  insert({ kind: 'wake', created: '2026-01-01 00:00:00' });
  insert({ status: 'pending', created: '2026-01-01 00:00:00' });
  const newest = insert({ created: '2026-01-02 00:00:00' });
  const first = listChildRecordings(CHILD, { limit: 1 });
  assert.deepEqual(ids(first), [newest]);
  assert.deepEqual(ids(listChildRecordings(CHILD, { limit: 1, before: cursor(first[0]) })), [older]);
});
