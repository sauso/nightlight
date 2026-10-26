// #553 phase 2a: the REAL move (src/scripts/migrate-private-layout.js) run by the REAL backend/entrypoint.sh, on a real
// database that db.js made, with only what needs root or the image stubbed (id, usermod, groupmod, chown, su-exec; NOT
// node). entrypoint-private-layout.test.js pins the script's own rules with a stand-in for the move; this proves the
// two fit together where the image puts them (the tool next to the script, run through su-exec, before the app), short
// of building the image, which e2e/private-layout.sh does.
// Linux only, and it needs the host's better-sqlite3, so it is NOT in the node:24-alpine run of test.yml.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..');
const SCRIPT = path.join(BACKEND, 'entrypoint.sh');
const skip = process.platform === 'linux' ? false : 'POSIX shell: Linux only (runs in CI)';

const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) exit 1 ;; esac\n',
  usermod: '#!/bin/sh\nexit 0\n',
  groupmod: '#!/bin/sh\nexit 0\n',
  chown: '#!/bin/sh\nexit 0\n',
  'su-exec': '#!/bin/sh\nshift\nexec "$@"\n',
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-ep-private-real-'));
after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function run(dataDir) {
  const stubs = path.join(ROOT, 'bin');
  if (!fs.existsSync(stubs)) {
    fs.mkdirSync(stubs);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(stubs, name), body, { mode: 0o755 });
  }
  // PUID/PGID: this user, so the ownership pass has nothing to do and every file stays readable to the test.
  const r = spawnSync('/bin/sh', [SCRIPT, '/bin/sh', '-c', 'echo "APP ran"'], {
    // NIGHTLIGHT_MEDIA_ISOLATION=0: the real move into private/, with isolation off (asked for by default since #553 phase 4).
    env: { PATH: `${stubs}:${process.env.PATH}`, DATA_DIR: dataDir, PUID: String(process.getuid()), PGID: String(process.getgid()), NIGHTLIGHT_MEDIA_ISOLATION: '0' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  const all = `${r.stdout}\n${r.stderr}`.split('\n');
  return {
    status: r.status,
    stdout: r.stdout,
    warnings: all.filter((l) => l.startsWith('[entrypoint] warning:')),
    layout: all.filter((l) => /^\[entrypoint\] (warning: )?private layout: /.test(l)),
    report: all.find((l) => l.startsWith('[entrypoint] umask ')) ?? '',
    ctx: `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
  };
}

test('#553 the real move through the real script: a legacy install ends up in private/, before the app starts', { skip }, () => {
  const d = path.join(ROOT, 'data');
  fs.mkdirSync(d);
  // A real database made by db.js, then put at the top level with its companions (it leaves a -wal: the process exits
  // without closing), as an install from before #553 has it.
  const made = spawnSync(process.execPath, ['-e', [
    "import('./src/db.js').then((m) => {",
    "  m.default.prepare(\"INSERT INTO users (id, username, password_hash, role) VALUES ('u1', 'admin-a', 'x', 'admin')\").run();",
    '  process.exit(0);',
    '});',
  ].join('\n')], { cwd: BACKEND, env: { ...process.env, DATA_DIR: d }, encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  for (const f of fs.readdirSync(path.join(d, 'private'))) fs.renameSync(path.join(d, 'private', f), path.join(d, f));
  fs.rmdirSync(path.join(d, 'private'));
  fs.writeFileSync(path.join(d, '.jwt_secret'), 'S', { mode: 0o644 });
  fs.writeFileSync(path.join(d, 'google-services.json'), '{}', { mode: 0o644 });
  fs.mkdirSync(path.join(d, 'transition-snapshots'));
  fs.writeFileSync(path.join(d, 'transition-snapshots', '1.jpg'), 'jpg');

  const r = run(d);
  assert.equal(r.status, 0, r.ctx);
  assert.match(r.stdout, /^APP ran$/m, r.ctx);
  assert.deepEqual(r.warnings, [], r.ctx);
  assert.equal(r.layout.length, 1, r.ctx);
  assert.match(r.layout[0], /^\[entrypoint\] private layout: the database and secrets are in /, r.ctx);
  assert.deepEqual(fs.readdirSync(d), ['private'], `left at the top level${r.ctx}`);
  for (const f of ['babymonitor.db', '.jwt_secret', 'google-services.json', 'transition-snapshots/1.jpg']) {
    assert.ok(fs.existsSync(path.join(d, 'private', f)), `${f} is not in private/${r.ctx}`);
  }
  for (const f of ['babymonitor.db-wal', 'babymonitor.db-shm']) assert.equal(fs.existsSync(path.join(d, 'private', f)), false, f);
  assert.match(r.report, / private\/babymonitor\.db=\d+ .* private\/\.jwt_secret=600$/, r.ctx);
  // The tool's own [private-layout] lines come before the app starts.
  assert.ok(r.stdout.indexOf('[private-layout] moved babymonitor.db') >= 0, r.ctx);
  assert.ok(r.stdout.indexOf('[private-layout] moved babymonitor.db') < r.stdout.indexOf('APP ran'), r.ctx);
  // The row db.js wrote is there, read the way the app reads it.
  const check = spawnSync(process.execPath, ['src/scripts/promote-admin.js'], { cwd: BACKEND, env: { ...process.env, DATA_DIR: d }, encoding: 'utf8' });
  assert.match(check.stdout, /- admin-a \(admin\)/, check.stderr);

  // A second start is a no-op: nothing moved, nothing set aside, no warning.
  const again = run(d);
  assert.equal(again.status, 0, again.ctx);
  assert.doesNotMatch(again.stdout, /\[private-layout\] (moved|.*set aside)/, again.ctx);
  assert.deepEqual(again.warnings, [], again.ctx);
});
