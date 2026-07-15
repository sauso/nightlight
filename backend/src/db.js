import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'babymonitor.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'caregiver',
    first_name TEXT,
    last_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS children (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    birthday TEXT,
    color TEXT NOT NULL DEFAULT '#F5D9A8',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cameras (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rtsp_url TEXT NOT NULL,
    child_id TEXT,
    mediamtx_path TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY DEFAULT 'app',
    app_name TEXT NOT NULL DEFAULT 'The Nursery',
    accent_color TEXT NOT NULL DEFAULT '#F5D9A8',
    live_color TEXT NOT NULL DEFAULT '#7FBFA3',
    offline_color TEXT NOT NULL DEFAULT '#E08585',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    font_choice TEXT NOT NULL DEFAULT 'warm-serif'
  );
`);

// Migrations: columns added after the initial release, for databases created before them.
const usersColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!usersColumns.includes('first_name')) {
  db.exec('ALTER TABLE users ADD COLUMN first_name TEXT');
}
if (!usersColumns.includes('last_name')) {
  db.exec('ALTER TABLE users ADD COLUMN last_name TEXT');
}

const settingsColumns = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name);
if (!settingsColumns.includes('timezone')) {
  db.exec("ALTER TABLE settings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
}
if (!settingsColumns.includes('font_choice')) {
  db.exec("ALTER TABLE settings ADD COLUMN font_choice TEXT NOT NULL DEFAULT 'warm-serif'");
}

// Ensure the single settings row always exists.
db.prepare(
  `INSERT OR IGNORE INTO settings (id, app_name, accent_color, live_color, offline_color, timezone, font_choice)
   VALUES ('app', 'The Nursery', '#F5D9A8', '#7FBFA3', '#E08585', 'UTC', 'warm-serif')`
).run();

export default db;
