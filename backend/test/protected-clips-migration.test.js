// #932: an existing database gets both flags without a table rebuild or changed old rows.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

const dir = useTempDataDir();
const file = path.join(dir, 'babymonitor.db'); // existing installations can still have this layout
const old = new Database(file);
old.exec(`CREATE TABLE detection_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, camera_name TEXT NOT NULL,
  type TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  snapshot INTEGER NOT NULL DEFAULT 0, clip_status TEXT, clip_path TEXT,
  clip_duration_s INTEGER, clip_bytes INTEGER
);
CREATE TABLE recordings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, camera_id TEXT NOT NULL, child_id TEXT,
  status TEXT NOT NULL DEFAULT 'recording', started_at TEXT NOT NULL, ended_at TEXT,
  duration_s INTEGER, path TEXT, thumb_path TEXT, bytes INTEGER, triggered_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), kind TEXT NOT NULL DEFAULT 'manual'
);
INSERT INTO detection_events (camera_id, camera_name, type) VALUES ('cam', 'Test camera', 'motion');
INSERT INTO recordings (camera_id, status, started_at, kind) VALUES ('cam', 'ready', datetime('now'), 'wake');`);
old.close();
const { default: db } = await import('../src/db.js');
after(() => { db.close(); cleanupTempDataDirs(); });

test('old schema gains protected columns with default zero and a second migration leaves them alone', async () => {
  for (const table of ['detection_events', 'recordings']) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.name === 'protected');
    assert.equal(cols.length, 1);
    assert.equal(cols[0].notnull, 1);
    assert.equal(db.prepare(`SELECT protected FROM ${table}`).get().protected, 0);
  }
  const { default: second } = await import('../src/db.js?second-boot');
  for (const table of ['detection_events', 'recordings']) {
    assert.equal(db.prepare(`PRAGMA table_info(${table})`).all().filter((c) => c.name === 'protected').length, 1);
  }
  second.close();
});
