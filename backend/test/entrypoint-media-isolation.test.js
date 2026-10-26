// #553 phases 1 and 2b: backend/entrypoint.sh decides whether media isolation is on, prepares the folders it needs, and
// starts the app accordingly.
//
// THE DECISION TABLE pinned here (the switch is NIGHTLIGHT_MEDIA_ISOLATION, internal, read only by the entrypoint):
//   switch not exactly 1 (unset, 0, blank, "true", "on", " 1")  -> off, SILENT, no dry run, the su-exec start
//   switch 1 and the dry run passes                              -> on: `setpriv <app drop>` with the SAME argv the dry
//                                                                   run used, MEDIA_ISOLATION=on, one info line
//   switch 1 and the dry run fails (a FAIL line, the drop itself
//   failing, an OK with a bad status, no OK at all)              -> off, ONE warning with the reason, su-exec, and the
//                                                                   container still starts (set -e cannot abort it)
//   switch 1 and PUID=0 / 000                                    -> off, one warning, no dry run
//   switch 1 and PUID or PGID = 1700 (also written 01700)        -> off, one warning, no dry run
//   switch 1 and PUID=099 PGID=0100                              -> the drop uses 99 and 100 (compared and passed as numbers)
//   an operator's own MEDIA_ISOLATION=on with the switch off     -> the app is told off
// #553 PHASE 2B adds, all with the switch at 1 (and none of it with the switch off, which is the old start unchanged):
//   a database, backup, snapshot folder, secret or Firebase file still at the TOP of the data directory
//                                                                -> off, one warning naming it, no dry run, nothing re-moded
//   (.jwt_secret with JWT_SECRET set, a Firebase file named by its env var, .demo-ready and the clips folder are exempt)
//   the data directory becomes group 1700 / 0710 and the clips folder 0750 (its parents too, inside the data directory; an
//   external CLIPS_DIR only its own top folder), and a folder some other uid owns is refused, not taken over
//   the tighten walk is CONFINED to private/ and the files at the top, so the group bits survive; if isolation ends up off
//   the whole tree is walked after all
//   the dry run runs in the BACKGROUND with a deadline: a probe that never finishes (a stalled share) is abandoned, isolation
//   stays off, and the container still starts
//   the data directory's own group (1700) does not trigger the full ownership walk on the next start
//   BACK TO OFF after an ON run (review of PR #871): a start that ends off and finds the media group on the data directory or
//   the clips folder (or media-owned entries at the top of the clips folder) re-owns both ONCE, before the tighten walk,
//   and hands back what a failed attempt prepared, so the next start finds nothing to do
// HOW. The REAL script, with only what needs root, the image or a kernel stubbed by a directory first on PATH (the
// entrypoint-umask.test.js technique): id, usermod and groupmod as there; chown and chgrp record what they were asked;
// su-exec prints a marker and execs; `stat` answers "owner 99" for the owner check and is the real one otherwise; `setpriv`
// records its options and its command, then either plays the dry run's part (NL_PROBE: what the probe would have printed and
// returned) or execs the app, as the real one does. The real chmod, find and mktemp run on real folders.
// What this CANNOT show is whether the kernel really gives a media process what the probe checks: that is
// entrypoint-media-isolation-real.test.js (root, real setpriv, real probe) and e2e/media-isolation.sh (the image).
// Linux only (POSIX sh); CI also runs it on BusyBox (.github/workflows/test.yml).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = process.env.ENTRYPOINT_UNDER_TEST || path.join(HERE, '..', 'entrypoint.sh');
const SCRIPT_DIR = path.dirname(SCRIPT);
const skip = process.platform === 'linux' ? false : 'POSIX shell: Linux only (runs in CI)';
const REAL_STAT = skip ? '' : spawnSync('sh', ['-c', 'command -v stat'], { encoding: 'utf8' }).stdout.trim();

const SETPRIV_STUB = [
  '#!/bin/sh',
  'opts=',
  'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do opts="$opts $1"; shift; done',
  'shift',
  'printf \'%s|%s\\n\' "${opts# }" "$*" >> "$NL_LOG.setpriv"',
  'case "$2" in',
  '  */media-probe.sh)',
  '    case "$NL_PROBE" in',
  '      ok) echo MEDIA-PROBE-OK; exit 0 ;;',
  "      fail) echo 'MEDIA-PROBE-FAIL a media process could read a file only the app may read'; exit 1 ;;",
  '      ok-status-1) echo MEDIA-PROBE-OK; exit 1 ;;',
  '      silent) exit 0 ;;',
  '      hang) exec sleep 20 ;;',
  "      *) echo 'setpriv: apply capabilities: Operation not permitted' >&2; exit 127 ;;",
  '    esac ;;',
  'esac',
  'exec "$@"',
  '',
].join('\n');

// su-exec prints its user AND the command's first word (#553 phase 2a): the move into private/ also starts through
// su-exec, as `su-exec nightlight node <tool>`, so "su-exec ran" has to mean the APP's start (/bin/sh here). `node` is
// that tool, stubbed: it logs that it ran, so a case can check it ran before the app, whichever way the app starts.
const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) exit 1 ;; esac\n',
  usermod: '#!/bin/sh\nexit 0\n',
  groupmod: '#!/bin/sh\nexit 0\n',
  // chown needs root: it records what was asked (so a re-own can be seen) and succeeds.
  chown: '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$NL_LOG.chown"\nexit 0\n',
  'su-exec': '#!/bin/sh\necho "STUB su-exec $1 $2"\nshift\nexec "$@"\n',
  node: '#!/bin/sh\necho "STUB node $*"\nexit 0\n',
  setpriv: SETPRIV_STUB,
  // chgrp to the media group needs root. The stub records what was asked (group, then paths) and succeeds; chmod is real.
  chgrp: '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$NL_LOG.chgrp"\nexit 0\n',
  // The tests are not uid 99, so `stat -L -c %u <dir>` (the layout's "does the app own this?" check) answers NL_STAT_UID
  // (default 99), and `%u:%g` of the data directory itself answers NL_DATA_UG when set (the group the layout gave it on an
  // earlier start). Everything else is the real stat.
  stat: [
    '#!/bin/sh',
    'case "$*" in',
    '  "-L -c %u "*) u=${NL_STAT_UID:-${PUID:-99}}; u=$(printf "%s" "$u" | sed "s/^0*//"); echo "${u:-0}"; exit 0 ;;',
    '  "-L -c %u:%g "*/.) if [ -n "${NL_DATA_UG:-}" ]; then echo "$NL_DATA_UG"; exit 0; fi ;;',
    '  "-L -c %g "*/.) if [ -n "${NL_DATA_UG:-}" ]; then echo "${NL_DATA_UG#*:}"; exit 0; fi ;;',
    '  "-L -c %g "*) if [ -n "${NL_CLIPS_G:-}" ]; then echo "$NL_CLIPS_G"; exit 0; fi ;;',
    'esac',
    'exec "$NL_REAL_STAT" "$@"',
    '',
  ].join('\n'),
};

const APP = ['/bin/sh', '-c', 'printf "APP MEDIA_ISOLATION=%s\\n" "${MEDIA_ISOLATION-unset}"'];
const DROP_99 = '--reuid=99 --regid=100 --groups=100,1700 --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill --no-new-privs';
// The probe's command: the app, the wrapper, the media id, the app's uid, then (phase 2b) the clips folder and the data directory.
const PROBE_CMD = (uid, clips, data, dir = SCRIPT_DIR) =>
  `/bin/sh ${dir}/media-probe.sh app ${dir}/media-exec.sh 1700 ${uid} ${clips} ${data}`;

let ROOT;
let STUB_DIR;
let n = 0;
const modeOf = (p) => fs.statSync(p).mode & 0o7777;
const write = (p, body = 'x', mode) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); if (mode != null) fs.chmodSync(p, mode); };
const dir = (p, mode) => { fs.mkdirSync(p, { recursive: true }); if (mode != null) fs.chmodSync(p, mode); };

// options: seed(dataDir) builds what is on disk before the start; cwd; script (a variant of the entrypoint).
function run(env, { seed, cwd, script = SCRIPT } = {}) {
  n += 1;
  const data = path.join(ROOT, `data-${n}`);
  const log = path.join(ROOT, `log-${n}`);
  const tmp = path.join(ROOT, `tmp-${n}`);
  fs.mkdirSync(tmp);
  if (seed) { fs.mkdirSync(data, { recursive: true }); seed(data); }
  const t0 = Date.now();
  const r = spawnSync('/bin/sh', [script, ...APP], {
    env: { PATH: `${STUB_DIR}:${process.env.PATH}`, DATA_DIR: data, NL_LOG: log, NL_REAL_STAT: REAL_STAT, TMPDIR: tmp, ...env },
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  const both = `${r.stdout}\n${r.stderr}`.split('\n');
  return {
    status: r.status,
    data,
    tmp,
    elapsedMs: Date.now() - t0,
    app: (/^APP MEDIA_ISOLATION=(.*)$/m.exec(r.stdout) || [])[1] ?? null,
    suExec: r.stdout.includes('STUB su-exec nightlight /bin/sh'),
    // #553 phase 2a: the move ran as the app user, before the app (its line comes first in the output).
    movedFirst: /STUB su-exec nightlight node\nSTUB node \S*migrate-private-layout\.js\n[\s\S]*APP MEDIA_ISOLATION=/.test(r.stdout),
    setpriv: read(`${log}.setpriv`).map((l) => { const [opts, cmd] = l.split('|'); return { opts, cmd }; }),
    chgrp: read(`${log}.chgrp`),
    chown: read(`${log}.chown`),
    isoWarnings: both.filter((l) => l.includes('[entrypoint] warning: media isolation is off:')),
    onLines: both.filter((l) => l.startsWith('[entrypoint] media isolation on:')),
    lines: both.filter((l) => l.startsWith('[entrypoint]')),
    ctx: `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
  };
}

// A copy of the entrypoint (and the two scripts it runs) with one text replaced, for the cases that need a different constant.
function variant(from, to) {
  n += 1;
  const d = path.join(ROOT, `variant-${n}`);
  fs.mkdirSync(d);
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(src.includes(from), `precondition: the entrypoint still has "${from}"`);
  fs.writeFileSync(path.join(d, 'entrypoint.sh'), src.replace(from, to), { mode: 0o755 });
  for (const f of ['media-probe.sh', 'media-exec.sh']) {
    const p = [SCRIPT_DIR, path.join(HERE, '..')].map((b) => path.join(b, f)).find((c) => fs.existsSync(c));
    fs.writeFileSync(path.join(d, f), fs.readFileSync(p), { mode: 0o755 });
  }
  return d;
}

// The usual start, untouched by #553: su-exec, told "off", no dry run, nothing said about isolation.
function assertUsualSilent(r, why) {
  assert.equal(r.status, 0, `${why}${r.ctx}`);
  assert.equal(r.app, 'off', `${why}: the app must be told off${r.ctx}`);
  assert.ok(r.suExec, `${why}: not the su-exec start${r.ctx}`);
  assert.deepEqual(r.setpriv, [], `${why}: setpriv ran${r.ctx}`);
  assert.deepEqual(r.chgrp, [], `${why}: a group was changed${r.ctx}`);
  assert.deepEqual(r.isoWarnings, [], `${why}: a warning nobody asked for${r.ctx}`);
  assert.deepEqual(r.onLines, [], r.ctx);
  assert.ok(r.movedFirst, `${why}: the move into private/ did not run, as the app user, before the app${r.ctx}`);
}

// The fallback: the switch asked, isolation could not be had. su-exec, off, exactly one warning with `reason` in it.
function assertFallback(r, reason, why) {
  assert.equal(r.status, 0, `${why}: the container must still start${r.ctx}`);
  assert.equal(r.app, 'off', `${why}${r.ctx}`);
  assert.ok(r.suExec, `${why}: not the su-exec start${r.ctx}`);
  assert.deepEqual(r.onLines, [], `${why}: it said "on"${r.ctx}`);
  assert.equal(r.isoWarnings.length, 1, `${why}: exactly one warning${r.ctx}`);
  assert.ok(r.isoWarnings[0].includes(reason), `${why}: the warning does not say "${reason}": ${r.isoWarnings[0]}`);
  assert.ok(r.isoWarnings[0].endsWith('; starting the usual way'), r.isoWarnings[0]);
  assert.ok(r.movedFirst, `${why}: the move into private/ did not run, as the app user, before the app${r.ctx}`);
}

const ASK = { NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'ok' };

describe('#553 entrypoint: the media isolation decision', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-iso-'));
    STUB_DIR = path.join(ROOT, 'bin');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => { if (ROOT) { fs.rmSync(ROOT, { recursive: true, force: true }); ROOT = undefined; STUB_DIR = undefined; } });

  test('#553 off by default: no switch, the usual start, and the app is told "off"', () => {
    assertUsualSilent(run({}), 'unset');
  });

  test('#553 only exactly "1" asks: 0, blank, true, on, " 1" are off, silently', () => {
    for (const v of ['0', '', 'true', 'on', ' 1', '1 ', 'yes']) assertUsualSilent(run({ NIGHTLIGHT_MEDIA_ISOLATION: v, NL_PROBE: 'ok' }), JSON.stringify(v));
  });

  test('#553 an operator\'s own MEDIA_ISOLATION=on never reaches the app (the entrypoint always sets it)', () => {
    assertUsualSilent(run({ MEDIA_ISOLATION: 'on' }), 'MEDIA_ISOLATION=on, switch off');
  });

  test('#553 on: the dry run passes, and the app starts through setpriv with the SAME argv, told "on"', () => {
    const r = run(ASK);
    assert.equal(r.status, 0, r.ctx);
    assert.equal(r.app, 'on', r.ctx);
    assert.equal(r.suExec, false, `su-exec ran${r.ctx}`);
    assert.ok(r.movedFirst, `the move into private/ must run before the isolated start too${r.ctx}`);
    assert.deepEqual(r.isoWarnings, [], r.ctx);
    assert.deepEqual(r.onLines, ['[entrypoint] media isolation on: ffmpeg, ffprobe and MediaMTX run as uid 1700, the app as 99:100'], r.ctx);
    // Two setpriv calls: the dry run, then the real start. The SAME options in both, and they are exactly these.
    assert.equal(r.setpriv.length, 2, r.ctx);
    assert.deepEqual(r.setpriv[0], { opts: DROP_99, cmd: PROBE_CMD(99, `${r.data}/clips`, r.data) }, 'the dry run, told which folders to probe');
    assert.deepEqual(r.setpriv[1], { opts: DROP_99, cmd: APP.join(' ') }, 'the real start');
    assert.deepEqual(fs.readdirSync(r.tmp), [], 'the dry run left something in TMPDIR');
  });

  test('#553 the probe reports a failure: off, its reason in the one warning, the usual start', () => {
    const r = run({ ...ASK, NL_PROBE: 'fail' });
    assertFallback(r, 'media isolation is off: a media process could read a file only the app may read', 'probe FAIL');
    assert.equal(r.setpriv.length, 1, `only the dry run went through setpriv${r.ctx}`);
  });

  test('#553 the drop to the app user itself fails (KILL missing): off, the failure in the warning, still starts', () => {
    const r = run({ ...ASK, NL_PROBE: 'drop-fails' });
    assertFallback(
      r,
      'the dry run could not start the app as uid 99 with CAP_SETUID, CAP_SETGID and CAP_KILL (exit 127: setpriv: apply capabilities: Operation not permitted)',
      'drop fails',
    );
  });

  test('#553 an OK line with a failed status, or a status 0 with no OK line, is NOT a pass', () => {
    assertFallback(run({ ...ASK, NL_PROBE: 'ok-status-1' }), 'the dry run could not start the app', 'OK + status 1');
    assertFallback(run({ ...ASK, NL_PROBE: 'silent' }), 'the dry run could not start the app', 'status 0, no OK');
  });

  test('#553 PUID=0 (any spelling): off with a warning, no dry run (the e2e and demo stacks run as root)', () => {
    for (const puid of ['0', '000']) {
      const r = run({ ...ASK, PUID: puid });
      assertFallback(r, 'PUID=0 runs the app as root', `PUID=${puid}`);
      assert.deepEqual(r.setpriv, [], `PUID=${puid}: the dry run ran${r.ctx}`);
    }
  });

  test('#553 PUID or PGID equal to the media id 1700, compared as numbers: off, no dry run', () => {
    for (const ids of [{ PUID: '1700' }, { PUID: '01700' }, { PGID: '1700' }, { PGID: '001700' }]) {
      const r = run({ ...ASK, ...ids });
      assertFallback(r, 'PUID or PGID is 1700, the media user\'s id', JSON.stringify(ids));
      assert.deepEqual(r.setpriv, [], `${JSON.stringify(ids)}: the dry run ran${r.ctx}`);
    }
    // ...and an id that merely contains 1700 is not it.
    const near = run({ ...ASK, PUID: '17000', PGID: '170' });
    assert.equal(near.app, 'on', near.ctx);
  });

  test('#553 ids written with leading zeros are passed to setpriv as the numbers usermod reads', () => {
    const r = run({ ...ASK, PUID: '099', PGID: '0100' });
    assert.equal(r.app, 'on', r.ctx);
    assert.deepEqual(r.setpriv.map((c) => c.opts), [DROP_99, DROP_99], r.ctx);
    assert.equal(r.setpriv[0].cmd, PROBE_CMD(99, `${r.data}/clips`, r.data));
  });

  test('#553 a PUID that is not a number (usermod would refuse it in the image): off, no dry run', () => {
    const r = run({ ...ASK, PUID: 'abc' });
    assertFallback(r, 'are not both numbers', 'PUID=abc');
    assert.deepEqual(r.setpriv, [], r.ctx);
  });
});

// --- #553 phase 2b ---------------------------------------------------------------------------------------------

describe('#553 phase 2b entrypoint: nothing at the top level of the data directory that belongs in private/', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-iso-'));
    STUB_DIR = path.join(ROOT, 'bin');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => { if (ROOT) { fs.rmSync(ROOT, { recursive: true, force: true }); ROOT = undefined; STUB_DIR = undefined; } });

  // Every name the move into private/ is responsible for. A skipped or unfinished move (the stubbed tool here does nothing)
  // leaves it at the top, and isolation must not go on with the data directory open to the media group.
  const LEFTOVERS = [
    'babymonitor.db', 'babymonitor.db-wal', 'babymonitor.db-shm', 'babymonitor.db-journal',
    'detection-snapshots', 'transition-snapshots', '.jwt_secret', 'firebase-service-account.json', 'google-services.json', 'backup-20261001-0100.db',
  ];
  for (const name of LEFTOVERS) {
    test(`#553 ${name} still at the top: isolation is refused, with that name in the one warning, and no folder is opened up`, () => {
      const r = run(ASK, { seed: (d) => { if (name.includes('snapshots')) dir(path.join(d, name)); else write(path.join(d, name)); } });
      assertFallback(r, `${name} is still at the top level`, name);
      assert.deepEqual(r.setpriv, [], `the dry run ran${r.ctx}`);
      assert.deepEqual(r.chgrp, [], `a group was changed although isolation was refused${r.ctx}`);
    });
  }

  test('#553 a link at the top counts too (a dangling one is still something a person put there)', () => {
    const r = run(ASK, { seed: (d) => fs.symlinkSync('/nowhere', path.join(d, 'babymonitor.db')) });
    assertFallback(r, 'babymonitor.db is still at the top level', 'dangling link');
  });

  test('#553 the exemptions: .jwt_secret with JWT_SECRET set, a Firebase file named by its env var, .demo-ready, the clips folder, and anything in private/', () => {
    const seed = (d) => {
      write(path.join(d, '.jwt_secret'));
      write(path.join(d, 'firebase-service-account.json'));
      write(path.join(d, 'google-services.json'));
      write(path.join(d, '.demo-ready'));
      write(path.join(d, 'clips', 'cam', 'a.mp4'));
      write(path.join(d, 'private', 'babymonitor.db'));
      write(path.join(d, 'private', '.jwt_secret'));
    };
    const r = run({ ...ASK, JWT_SECRET: 'from-env', FIREBASE_CREDENTIALS: '/x/a.json', FIREBASE_CLIENT_CONFIG: '/x/b.json' }, { seed });
    assert.equal(r.app, 'on', r.ctx);
    // ...and the controls: each exemption is conditional. Without the env var the same file refuses.
    for (const [drop, name] of [['JWT_SECRET', '.jwt_secret'], ['FIREBASE_CREDENTIALS', 'firebase-service-account.json'], ['FIREBASE_CLIENT_CONFIG', 'google-services.json']]) {
      const env = { ...ASK, JWT_SECRET: 'from-env', FIREBASE_CREDENTIALS: '/x/a.json', FIREBASE_CLIENT_CONFIG: '/x/b.json' };
      delete env[drop];
      assertFallback(run(env, { seed }), `${name} is still at the top level`, `without ${drop}`);
    }
  });

  test('#553 with the switch off the same leftovers change nothing: the usual start, no warning, nothing re-moded', () => {
    const r = run({}, { seed: (d) => { write(path.join(d, 'babymonitor.db')); dir(path.join(d, 'clips'), 0o755); } });
    assertUsualSilent(r, 'switch off, leftover at the top');
    assert.equal(modeOf(r.data), 0o700, 'the data directory is the owner-only one it always was');
  });
});

describe('#553 phase 2b entrypoint: the folders the media user needs', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-iso-'));
    STUB_DIR = path.join(ROOT, 'bin');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => { if (ROOT) { fs.rmSync(ROOT, { recursive: true, force: true }); ROOT = undefined; STUB_DIR = undefined; } });

  test('#553 on: the data directory is group 1700 and 0710, the clips folder (made when missing) 0750 in the same group', () => {
    const r = run(ASK);
    assert.equal(r.app, 'on', r.ctx);
    assert.equal(modeOf(r.data), 0o710, 'traverse only: the media user cannot list the data directory');
    assert.equal(modeOf(path.join(r.data, 'clips')), 0o750, 'traverse and list, no write');
    assert.deepEqual(r.chgrp, [`1700 ${r.data}`, `1700 ${r.data}/clips`], 'the media group, on exactly these two');
    assert.equal(modeOf(path.join(r.data, 'private')), 0o700, 'private/ stays the app\'s alone');
  });

  test('#553 an existing clips folder keeps what is in it: only its top folder is touched (no walk of the clip tree, #567)', () => {
    const old = (d) => { write(path.join(d, 'clips', 'cam', 'old.mp4'), 'x', 0o644); dir(path.join(d, 'clips', 'cam'), 0o755); dir(path.join(d, 'clips'), 0o755); };
    const r = run(ASK, { seed: old });
    assert.equal(r.app, 'on', r.ctx);
    assert.equal(modeOf(path.join(r.data, 'clips')), 0o750);
    assert.equal(modeOf(path.join(r.data, 'clips', 'cam')), 0o755, 'a folder below the top is left to the app, which repairs it on first use');
    assert.equal(modeOf(path.join(r.data, 'clips', 'cam', 'old.mp4')), 0o644);
    assert.deepEqual(r.chgrp, [`1700 ${r.data}`, `1700 ${r.data}/clips`]);
  });

  test('#553 a nested CLIPS_DIR under the data directory (trailing slash too): its parents get 0750 and the media group', () => {
    n += 1;
    const data = path.join(ROOT, `data-nested-${n}`);
    const clips = `${data}/media/rec/clips/`;
    const r = run({ ...ASK, DATA_DIR: data, CLIPS_DIR: clips });
    assert.equal(r.app, 'on', r.ctx);
    for (const p of ['media', 'media/rec', 'media/rec/clips']) assert.equal(modeOf(path.join(data, p)), 0o750, p);
    assert.deepEqual(r.chgrp, [`1700 ${data}`, `1700 ${data}/media`, `1700 ${data}/media/rec`, `1700 ${data}/media/rec/clips`]);
    assert.equal(r.setpriv[0].cmd, PROBE_CMD(99, `${data}/media/rec/clips`, data), 'the probe gets the path without the trailing slash');
  });

  test('#553 an EXTERNAL CLIPS_DIR (an own mount): only its top folder, and nothing above it, is touched', () => {
    n += 1;
    const ext = path.join(ROOT, `ext-${n}`);
    dir(path.join(ext, 'recordings'), 0o755);
    write(path.join(ext, 'recordings', 'cam', 'old.mp4'));
    const r = run({ ...ASK, CLIPS_DIR: path.join(ext, 'recordings') });
    assert.equal(r.app, 'on', r.ctx);
    assert.equal(modeOf(path.join(ext, 'recordings')), 0o750);
    assert.equal(modeOf(ext), 0o755, 'the folder above an external mount is not ours');
    assert.deepEqual(r.chgrp, [`1700 ${r.data}`, `1700 ${path.join(ext, 'recordings')}`]);
    assert.equal(r.setpriv[0].cmd, PROBE_CMD(99, path.join(ext, 'recordings'), r.data), 'the probe is told to try the external mount');
  });

  test('#553 a relative CLIPS_DIR is relative to the working directory, as the app reads it; blank means the default', () => {
    n += 1;
    const cwd = path.join(ROOT, `cwd-${n}`);
    dir(cwd);
    const rel = run({ ...ASK, CLIPS_DIR: 'rec/' }, { cwd });
    assert.equal(rel.setpriv[0].cmd, PROBE_CMD(99, `${cwd}/rec`, rel.data), rel.ctx);
    for (const blank of ['', '   ']) {
      const r = run({ ...ASK, CLIPS_DIR: blank });
      assert.equal(r.setpriv[0].cmd, PROBE_CMD(99, `${r.data}/clips`, r.data), `CLIPS_DIR=${JSON.stringify(blank)}`);
    }
  });

  test('#553 a clips folder some OTHER uid owns is refused, not taken over: off, with the folder and its owner in the warning', () => {
    const r = run({ ...ASK, NL_STAT_UID: '5' }, { seed: (d) => dir(path.join(d, 'clips')) });
    assertFallback(r, `${path.join(r.data, 'clips')} is not owned by uid 99`, 'foreign owner');
    assert.deepEqual(r.setpriv, [], `the dry run ran${r.ctx}`);
    assert.ok(!r.chgrp.some((l) => l.includes('/clips')), `the foreign folder was handed to the media group${r.ctx}`);
  });

  test('#553 the data directory carrying the media group is NOT a reason to walk and re-own everything on the next start', () => {
    const on = run({ ...ASK, NL_DATA_UG: '99:1700' });
    assert.ok(on.lines.some((l) => l.includes('data directory already owned by 99:100; not walking it')), `walked although it was right${on.ctx}`);
    // The control: without the switch the same answer IS wrong ownership, and the walk runs (that is the old behaviour).
    const off = run({ NL_DATA_UG: '99:1700' });
    assert.ok(off.lines.some((l) => l.includes('is not 99:100; fixing the whole data directory')), `the old check changed${off.ctx}`);
  });

  test('#553 the media group is accepted for the data directory ONLY: a database beside it with the wrong owner still triggers the walk', () => {
    const withGroup = run({ ...ASK, NL_DATA_UG: '99:1700' }, { seed: (d) => write(path.join(d, 'babymonitor.db')) });
    assert.ok(withGroup.lines.some((l) => /ownership of \S*babymonitor\.db is not 99:100; fixing/.test(l)), `the exemption swallowed the database${withGroup.ctx}`);
  });
});

describe('#553 phase 2b entrypoint: the tighten walk and the group bits', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-iso-'));
    STUB_DIR = path.join(ROOT, 'bin');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => { if (ROOT) { fs.rmSync(ROOT, { recursive: true, force: true }); ROOT = undefined; STUB_DIR = undefined; } });

  // An older install: a wide clip tree, a wide private/, a wide file at the top.
  const legacy = (d) => {
    dir(d, 0o755);
    write(path.join(d, 'clips', 'cam', 'old.mp4'), 'x', 0o644);
    dir(path.join(d, 'clips', 'cam'), 0o755);
    dir(path.join(d, 'clips'), 0o755);
    write(path.join(d, 'private', 'wide-secret'), 'x', 0o644);
    write(path.join(d, 'notes.txt'), 'x', 0o644);
  };

  test('#553 isolation asked for and on: the data and clips folders KEEP their group bits; private/ and the top-level files ARE tightened; the clip tree is left alone', () => {
    const r = run(ASK, { seed: legacy });
    assert.equal(r.app, 'on', r.ctx);
    assert.equal(modeOf(r.data), 0o710, 'the walk did not strip the data directory back to 0700');
    assert.equal(modeOf(path.join(r.data, 'clips')), 0o750, 'nor the clips folder');
    assert.equal(modeOf(path.join(r.data, 'private', 'wide-secret')), 0o600, 'the secrets folder is still tightened');
    assert.equal(modeOf(path.join(r.data, 'notes.txt')), 0o600, 'and so is a file at the top');
    assert.equal(modeOf(path.join(r.data, 'clips', 'cam', 'old.mp4')), 0o644, 'the clip tree is the layout\'s business, not the walk\'s (and is never walked on a start, #567)');
    assert.ok(r.lines.some((l) => l.includes('in private/ and at the top level')), `the start-up line says what was walked${r.ctx}`);
  });

  test('#553 the SAME tree with the switch off is walked whole, as before: every entry loses its group and other bits', () => {
    const r = run({}, { seed: legacy });
    assert.equal(modeOf(r.data), 0o700);
    assert.equal(modeOf(path.join(r.data, 'clips')), 0o700);
    assert.equal(modeOf(path.join(r.data, 'clips', 'cam', 'old.mp4')), 0o600);
    assert.equal(modeOf(path.join(r.data, 'private', 'wide-secret')), 0o600);
    assert.ok(r.lines.some((l) => /existing entries with group\/other access found: \d+;/.test(l)), r.ctx);
  });

  test('#553 asked for but refused (the dry run failed): the whole tree is tightened after all, and the line says so', () => {
    const r = run({ ...ASK, NL_PROBE: 'fail' }, { seed: legacy });
    assertFallback(r, 'a media process could read', 'probe fails');
    assert.equal(modeOf(path.join(r.data, 'clips', 'cam', 'old.mp4')), 0o600, 'the clip tree was walked once isolation turned out off');
    assert.equal(modeOf(path.join(r.data, 'clips')), 0o700);
    assert.equal(modeOf(r.data), 0o700, 'the data directory is back to owner-only, which is what an off start is');
    assert.ok(r.lines.some((l) => l.includes('media isolation is off, so the whole data directory was tightened after all')), r.ctx);
  });

  test('#553 refused for a leftover at the top: the same full tighten', () => {
    const r = run(ASK, { seed: (d) => { legacy(d); write(path.join(d, 'babymonitor.db'), 'x', 0o644); } });
    assertFallback(r, 'babymonitor.db is still at the top level', 'leftover');
    assert.equal(modeOf(path.join(r.data, 'clips', 'cam', 'old.mp4')), 0o600);
    assert.equal(modeOf(path.join(r.data, 'babymonitor.db')), 0o600);
  });

  test('#553 UMASK=022 (the opt-out): nothing is tightened either way, isolation on keeps its folders', () => {
    const r = run({ ...ASK, UMASK: '022' }, { seed: legacy });
    assert.equal(r.app, 'on', r.ctx);
    assert.equal(modeOf(path.join(r.data, 'notes.txt')), 0o644);
    assert.equal(modeOf(path.join(r.data, 'clips')), 0o750);
  });
});

describe('#553 phase 2b entrypoint: the dry run runs in the background and gives up at a deadline', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-iso-'));
    STUB_DIR = path.join(ROOT, 'bin');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => { if (ROOT) { fs.rmSync(ROOT, { recursive: true, force: true }); ROOT = undefined; STUB_DIR = undefined; } });

  test('#553 a probe that never finishes (a stalled share) is abandoned at the deadline: off, one warning, the container still starts', () => {
    const v = variant('MEDIA_DRY_RUN_TIMEOUT=30', 'MEDIA_DRY_RUN_TIMEOUT=2');
    const r = run({ ...ASK, NL_PROBE: 'hang' }, { script: path.join(v, 'entrypoint.sh') });
    assertFallback(r, 'the dry run did not finish within 2 seconds', 'hang');
    assert.ok(r.elapsedMs < 15_000, `it waited ${r.elapsedMs} ms: the stub sleeps 20 s, so the deadline did not hold`);
    assert.equal(r.setpriv.length, 1, 'no isolated start');
  });

  test('#553 a probe that finishes is not waited out: the run takes far less than the deadline', () => {
    const r = run(ASK);
    assert.equal(r.app, 'on', r.ctx);
    assert.ok(r.elapsedMs < 20_000, `${r.elapsedMs} ms`);
  });

  test('#553 the probe\'s output reaches the warning even though it ran in the background (file, not pipe)', () => {
    const r = run({ ...ASK, NL_PROBE: 'fail' });
    assert.match(r.isoWarnings[0], /a media process could read a file only the app may read/);
  });

  test('#553 the background job holds nothing of the container\'s log open: the script returns while an abandoned probe still sleeps', () => {
    // spawnSync waits for the stdout/stderr pipes to close. The stub sleeps 20 s; if the background job kept those pipes,
    // this call would take 20 s, not ~the deadline.
    const v = variant('MEDIA_DRY_RUN_TIMEOUT=30', 'MEDIA_DRY_RUN_TIMEOUT=1');
    const r = run({ ...ASK, NL_PROBE: 'hang' }, { script: path.join(v, 'entrypoint.sh') });
    assert.ok(r.elapsedMs < 12_000, `${r.elapsedMs} ms`);
  });
});

describe('#553 phase 2b entrypoint: back to OFF after an ON run (media-owned clips must stay readable)', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-iso-'));
    STUB_DIR = path.join(ROOT, 'bin');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => { if (ROOT) { fs.rmSync(ROOT, { recursive: true, force: true }); ROOT = undefined; STUB_DIR = undefined; } });

  const REOWN = 'an earlier start had it on';
  const reowns = (r) => r.chown.filter((l) => l.startsWith('-R '));
  const tree = (d) => { write(path.join(d, 'clips', 'cam', 'a.mp4'), 'x', 0o660); dir(path.join(d, 'clips', 'cam'), 0o770); dir(path.join(d, 'clips'), 0o750); };

  test('★ the data directory carries the media group and the start ends OFF: the data directory and clip tree are re-owned ONCE, before the tighten walk', () => {
    const r = run({ ...ASK, NL_PROBE: 'fail', NL_DATA_UG: '99:1700' }, { seed: tree });
    assertFallback(r, 'a media process could read', 'ON then off');
    const reown = r.lines.findIndex((l) => l.includes(REOWN));
    const tightened = r.lines.findIndex((l) => l.includes('tightened after all'));
    assert.ok(reown >= 0, `no re-own line${r.ctx}`);
    assert.ok(tightened > reown, `the walk ran before the re-own, so it saw media-owned files${r.ctx}`);
    assert.deepEqual(reowns(r), [`-R nightlight:nightlight ${r.data}`], 'exactly one recursive re-own, of the data directory (the clips folder is inside it)');
    assert.equal(modeOf(r.data), 0o700, 'the data directory is back to its OFF mode');
    assert.ok(r.chgrp.includes(`100 ${r.data}`), `the data directory was not handed back to the app's group${r.ctx}`);
  });

  test('★ ...and the NEXT start (the group is no longer the media group) does not walk or re-own anything', () => {
    const second = run({ ...ASK, NL_PROBE: 'fail', NL_DATA_UG: '99:100' }, { seed: tree });
    assertFallback(second, 'a media process could read', 'second start');
    assert.deepEqual(reowns(second), [], `a start with nothing to undo still re-owned the tree: ${second.chown}`);
    assert.ok(!second.lines.some((l) => l.includes(REOWN)));
  });

  test('★ a failed FIRST attempt hands its own top folders back, so a configuration that never worked walks nothing on later starts', () => {
    const r = run({ ...ASK, NL_PROBE: 'fail' }, { seed: tree });
    assertFallback(r, 'a media process could read', 'first failed attempt');
    assert.ok(!r.lines.some((l) => l.includes(REOWN)), `nothing had been on before, yet it re-owned${r.ctx}`);
    // opened to the media group for the dry run, then given back
    assert.deepEqual(r.chgrp, [`1700 ${r.data}`, `1700 ${r.data}/clips`, `100 ${r.data}`, `100 ${r.data}/clips`]);
    assert.equal(modeOf(r.data), 0o700);
    assert.equal(modeOf(path.join(r.data, 'clips')), 0o700);
  });

  test('★ an EXTERNAL clips folder in the media group is re-owned too (the ownership block never reaches it)', () => {
    n += 1;
    const ext = path.join(ROOT, `ext-${n}`);
    write(path.join(ext, 'cam', 'a.mp4'), 'x', 0o660);
    dir(ext, 0o750);
    const r = run({ ...ASK, NL_PROBE: 'fail', NL_CLIPS_G: '1700', CLIPS_DIR: ext });
    assertFallback(r, 'a media process could read', 'external');
    assert.ok(r.lines.some((l) => l.includes(REOWN)), r.ctx);
    assert.ok(reowns(r).includes(`-R nightlight:nightlight ${ext}`), `the external folder was not re-owned: ${r.chown}`);
    assert.ok(reowns(r).includes(`-R nightlight:nightlight ${r.data}`));
    assert.ok(r.chgrp.includes(`100 ${ext}`));
  });

  test('★ the switch taken away entirely (not asked for, nothing prepared): an external folder still in the media group is re-owned', () => {
    n += 1;
    const ext = path.join(ROOT, `ext-${n}`);
    dir(ext, 0o750);
    const r = run({ NL_CLIPS_G: '1700', CLIPS_DIR: ext });
    assert.equal(r.status, 0, r.ctx);
    assert.equal(r.app, 'off', r.ctx);
    assert.ok(reowns(r).includes(`-R nightlight:nightlight ${ext}`), `${r.chown}`);
  });

  test('PUID/PGID equal to the media id is never evidence (the group IS the app\'s own)', () => {
    const r = run({ NL_DATA_UG: '99:1700', PGID: '1700' });
    assert.ok(!r.lines.some((l) => l.includes(REOWN)), r.ctx);
  });

  test('no evidence, no re-own: an OFF start on an ordinary tree touches nothing extra', () => {
    const r = run({}, { seed: tree });
    assert.ok(!r.lines.some((l) => l.includes(REOWN)), r.ctx);
    assert.deepEqual(r.chgrp, []);
  });
});
