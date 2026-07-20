import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'babymonitor.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
    sort_order INTEGER NOT NULL DEFAULT 0,
    mqtt_topic TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    id TEXT PRIMARY KEY DEFAULT 'app',
    app_name TEXT NOT NULL DEFAULT 'Nightlight',
    accent_color TEXT NOT NULL DEFAULT '#F5D9A8',
    live_color TEXT NOT NULL DEFAULT '#7FBFA3',
    offline_color TEXT NOT NULL DEFAULT '#E08585',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    font_choice TEXT NOT NULL DEFAULT 'warm-serif',
    temp_unit TEXT NOT NULL DEFAULT 'C',
    mqtt_host TEXT,
    mqtt_port INTEGER,
    mqtt_username TEXT,
    mqtt_password TEXT
  );

  -- One row per login. The JWT carries this row's id (see routes/auth.js) - a request
  -- is only valid if this row still exists, which is what makes both "sign out this
  -- device" and "delete this caregiver" take effect immediately rather than waiting
  -- for the token to naturally expire.
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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

const camerasColumns = db.prepare('PRAGMA table_info(cameras)').all().map((c) => c.name);
if (!camerasColumns.includes('sort_order')) {
  db.exec('ALTER TABLE cameras ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  const existing = db.prepare('SELECT id FROM cameras ORDER BY created_at').all();
  const setOrder = db.prepare('UPDATE cameras SET sort_order = ? WHERE id = ?');
  existing.forEach((cam, index) => setOrder.run(index, cam.id));
}

const settingsColumns = db.prepare('PRAGMA table_info(settings)').all().map((c) => c.name);
if (!settingsColumns.includes('timezone')) {
  db.exec("ALTER TABLE settings ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC'");
}
if (!settingsColumns.includes('font_choice')) {
  db.exec("ALTER TABLE settings ADD COLUMN font_choice TEXT NOT NULL DEFAULT 'warm-serif'");
}
if (!settingsColumns.includes('temp_unit')) {
  db.exec("ALTER TABLE settings ADD COLUMN temp_unit TEXT NOT NULL DEFAULT 'C'");
}
if (!settingsColumns.includes('mqtt_host')) {
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_host TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_port INTEGER');
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_username TEXT');
  db.exec('ALTER TABLE settings ADD COLUMN mqtt_password TEXT');
}

if (!camerasColumns.includes('mqtt_topic')) {
  db.exec('ALTER TABLE cameras ADD COLUMN mqtt_topic TEXT');
}

// Ensure the single settings row always exists.
db.prepare(
  `INSERT OR IGNORE INTO settings (id, app_name, accent_color, live_color, offline_color, timezone, font_choice, temp_unit)
   VALUES ('app', 'Nightlight', '#F5D9A8', '#7FBFA3', '#E08585', 'UTC', 'warm-serif', 'C')`
).run();

export default db;
