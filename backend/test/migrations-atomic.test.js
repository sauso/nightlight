// A migration that fails partway must leave the schema exactly as it was, not half-applied.
//
// The migrations at the bottom of db.js are groups of ALTER TABLE statements behind a single
// sentinel-column check. Every db.exec used to autocommit on its own, so an interruption — power loss,
// an OOM kill, a `docker stop` landing mid-upgrade — could leave a group half applied permanently:
//
//   • Sentinel added LAST (the activity_samples group): the next boot re-runs the first ALTER and
//     throws `duplicate column name` AT MODULE LOAD, before the server starts, on every restart. The
//     install is bricked and needs manual sqlite3 surgery.
//   • Sentinel added FIRST (ntfy and about a dozen others): the guard is true forever, the remaining
//     columns never arrive, db.js loads "fine", and it surfaces later as `no such column`.
//
// See issue #258. The fix wraps the whole schema section in one transaction, so a boot either brings
// the schema fully up to date or leaves it untouched and retries next time.
//
// ⚠️ WHAT THIS TEST CAN AND CANNOT SHOW. The fix PREVENTS a torn schema; it does not REPAIR one that
// already exists. So a test that hand-builds a torn database and expects db.js to heal it would fail
// with the fix in place and prove nothing. What is testable is the thing that actually changed: make a
// migration fail partway and check whether the statements that ran BEFORE the failure survived.
//
// db.js is a singleton that runs its schema work once at import, so each scenario runs in a CHILD
// PROCESS against its own DATA_DIR — re-importing in this process would be a no-op.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

// A URL, not a path: import() on Windows rejects a bare drive-letter path.
const DB_JS_URL = new URL('../src/db.js', import.meta.url).href;

const dirs = [];
function freshDir() {
  const d = mkdtempSync(join(tmpdir(), 'nl-mig-'));
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

// Import db.js in a child process with DATA_DIR pointed at `dir`. Returns the exit status and stderr,
// so a scenario can assert that a boot failed as well as what it left behind.
function bootDbJs(dir) {
  const script = join(dir, 'boot.mjs');
  writeFileSync(script, `import(${JSON.stringify(DB_JS_URL)}).then(() => process.exit(0));\n`);
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, DATA_DIR: dir },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr || '' };
}

const columnsOf = (dir, table) => {
  const db = new Database(join(dir, 'babymonitor.db'));
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  } finally {
    db.close();
  }
};

describe('a migration group that fails partway', () => {
  test('leaves none of its columns behind', () => {
    const dir = freshDir();

    // 1. A normal, fully-migrated install.
    assert.equal(bootDbJs(dir).status, 0, 'baseline boot should succeed');
    assert.ok(columnsOf(dir, 'settings').includes('ntfy_enabled'), 'baseline should have the ntfy group');

    // 2. Rewind to before the ntfy migration, then plant a collision: put ONE of the group's later
    //    columns back by hand. This is what an interrupted upgrade leaves behind, and it is also the
    //    cleanest way to make the group fail at a known point — the guard keys on `ntfy_enabled`, which
    //    is absent, so the group runs, adds `ntfy_enabled`, then hits `ntfy_server_url` and throws.
    {
      const db = new Database(join(dir, 'babymonitor.db'));
      for (const col of ['ntfy_enabled', 'ntfy_server_url', 'ntfy_topic', 'ntfy_token', 'ntfy_username', 'ntfy_password']) {
        db.exec(`ALTER TABLE settings DROP COLUMN ${col}`);
      }
      db.exec("ALTER TABLE settings ADD COLUMN ntfy_server_url TEXT NOT NULL DEFAULT 'https://ntfy.sh'");
      db.close();
    }

    const before = columnsOf(dir, 'settings');
    assert.ok(!before.includes('ntfy_enabled'), 'setup: the sentinel must be absent so the group runs');
    assert.ok(before.includes('ntfy_server_url'), 'setup: the collision column must be present');

    // 3. Boot again. The group runs and throws partway, so the boot must fail — that part is true with
    //    or without the fix, and is only a precondition.
    const boot = bootDbJs(dir);
    assert.notEqual(boot.status, 0, 'the boot should have failed on the duplicate column');
    assert.match(boot.stderr, /duplicate column name/i, `unexpected failure: ${boot.stderr.slice(0, 300)}`);

    // 4. THE ASSERTION THAT DISCRIMINATES. `ntfy_enabled` was added successfully before the throw.
    //    Without the transaction it autocommits and survives — and because the guard keys on it, the
    //    group is now skipped forever and the remaining columns never arrive: silently, permanently
    //    broken. With the transaction the whole attempt rolls back, so the schema is exactly as it was
    //    and a later boot can complete it once the collision is resolved.
    const after_ = columnsOf(dir, 'settings');
    assert.ok(
      !after_.includes('ntfy_enabled'),
      'a failed migration left its sentinel column committed — the group will now be skipped forever'
    );
    assert.deepEqual(
      after_, before,
      'a failed migration changed the schema; it must leave it exactly as it was'
    );
  });

  test('a normal boot is unaffected, and is still idempotent', () => {
    // The control. If the transaction ever broke ordinary startup, or stopped the schema being applied
    // at all, the case above would pass for the wrong reason.
    const dir = freshDir();
    assert.equal(bootDbJs(dir).status, 0);
    const first = columnsOf(dir, 'settings');
    assert.ok(first.includes('ntfy_enabled') && first.includes('ntfy_password'));

    assert.equal(bootDbJs(dir).status, 0, 'a second boot must be a clean no-op');
    assert.deepEqual(columnsOf(dir, 'settings'), first, 'a second boot changed the schema');
  });

  test('an old database is still upgraded in full', () => {
    // Same shape as a real upgrade: drop a whole group cleanly (no collision) and boot. Everything
    // should come back. This is what proves the transaction commits rather than silently rolling back.
    const dir = freshDir();
    assert.equal(bootDbJs(dir).status, 0);
    const full = columnsOf(dir, 'settings');

    {
      const db = new Database(join(dir, 'babymonitor.db'));
      for (const col of ['ntfy_enabled', 'ntfy_server_url', 'ntfy_topic', 'ntfy_token', 'ntfy_username', 'ntfy_password']) {
        db.exec(`ALTER TABLE settings DROP COLUMN ${col}`);
      }
      db.close();
    }
    assert.ok(!columnsOf(dir, 'settings').includes('ntfy_enabled'), 'setup: group removed');

    assert.equal(bootDbJs(dir).status, 0, 'upgrading an old database should succeed');
    // Sorted: SQLite appends re-added columns at the end, so the ORDER differs from a database that
    // never lost them. Only the set matters — nothing reads settings positionally.
    assert.deepEqual(
      columnsOf(dir, 'settings').sort(), [...full].sort(),
      'the upgrade did not restore every column'
    );
  });
});
