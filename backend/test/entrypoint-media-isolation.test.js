// #553 phase 1: backend/entrypoint.sh decides whether media isolation is on, and starts the app accordingly.
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
// HOW. The REAL script, with only what needs root, the image or a kernel stubbed by a directory first on PATH (the
// entrypoint-umask.test.js technique): id, usermod, groupmod and chown as there; su-exec prints a marker and execs;
// `timeout` records its first argument and execs; `setpriv` records its options and its command, then either plays the
// dry run's part (NL_PROBE: what the probe would have printed and returned) or execs the app, as the real one does.
// What this CANNOT show is whether the kernel really gives a media process what the probe checks: that is
// entrypoint-media-isolation-real.test.js (root, real setpriv) and e2e/media-isolation.sh (the image).
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
  "      *) echo 'setpriv: apply capabilities: Operation not permitted' >&2; exit 127 ;;",
  '    esac ;;',
  'esac',
  'exec "$@"',
  '',
].join('\n');

const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) exit 1 ;; esac\n',
  usermod: '#!/bin/sh\nexit 0\n',
  groupmod: '#!/bin/sh\nexit 0\n',
  chown: '#!/bin/sh\nexit 0\n',
  'su-exec': '#!/bin/sh\necho "STUB su-exec $1"\nshift\nexec "$@"\n',
  timeout: '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$NL_LOG.timeout"\nshift\nexec "$@"\n',
  setpriv: SETPRIV_STUB,
};

const APP = ['/bin/sh', '-c', 'printf "APP MEDIA_ISOLATION=%s\\n" "${MEDIA_ISOLATION-unset}"'];
const DROP_99 = '--reuid=99 --regid=100 --groups=100,1700 --inh-caps=+setuid,+setgid,+kill --ambient-caps=+setuid,+setgid,+kill --no-new-privs';
const PROBE_CMD = (uid) => `/bin/sh ${SCRIPT_DIR}/media-probe.sh app ${SCRIPT_DIR}/media-exec.sh 1700 ${uid}`;

let ROOT;
let STUB_DIR;
let n = 0;

function run(env) {
  n += 1;
  const data = path.join(ROOT, `data-${n}`);
  const log = path.join(ROOT, `log-${n}`);
  const r = spawnSync('/bin/sh', [SCRIPT, ...APP], {
    env: { PATH: `${STUB_DIR}:${process.env.PATH}`, DATA_DIR: data, NL_LOG: log, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  const both = `${r.stdout}\n${r.stderr}`.split('\n');
  return {
    status: r.status,
    app: (/^APP MEDIA_ISOLATION=(.*)$/m.exec(r.stdout) || [])[1] ?? null,
    suExec: r.stdout.includes('STUB su-exec nightlight'),
    setpriv: read(`${log}.setpriv`).map((l) => { const [opts, cmd] = l.split('|'); return { opts, cmd }; }),
    timeouts: read(`${log}.timeout`),
    isoWarnings: both.filter((l) => l.includes('[entrypoint] warning: media isolation is off:')),
    onLines: both.filter((l) => l.startsWith('[entrypoint] media isolation on:')),
    ctx: `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
  };
}

// The usual start, untouched by #553: su-exec, told "off", no dry run, nothing said about isolation.
function assertUsualSilent(r, why) {
  assert.equal(r.status, 0, `${why}${r.ctx}`);
  assert.equal(r.app, 'off', `${why}: the app must be told off${r.ctx}`);
  assert.ok(r.suExec, `${why}: not the su-exec start${r.ctx}`);
  assert.deepEqual(r.setpriv, [], `${why}: setpriv ran${r.ctx}`);
  assert.deepEqual(r.isoWarnings, [], `${why}: a warning nobody asked for${r.ctx}`);
  assert.deepEqual(r.onLines, [], r.ctx);
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
}

describe('#553 entrypoint: the media isolation decision', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-iso-'));
    STUB_DIR = path.join(ROOT, 'bin');
    fs.mkdirSync(STUB_DIR);
    for (const [name, body] of Object.entries(STUBS)) fs.writeFileSync(path.join(STUB_DIR, name), body, { mode: 0o755 });
  });
  after(() => { if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true }); });

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
    const r = run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'ok' });
    assert.equal(r.status, 0, r.ctx);
    assert.equal(r.app, 'on', r.ctx);
    assert.equal(r.suExec, false, `su-exec ran${r.ctx}`);
    assert.deepEqual(r.isoWarnings, [], r.ctx);
    assert.deepEqual(r.onLines, ['[entrypoint] media isolation on: ffmpeg, ffprobe and MediaMTX run as uid 1700, the app as 99:100'], r.ctx);
    // Two setpriv calls: the dry run, then the real start. The SAME options in both, and they are exactly these.
    assert.equal(r.setpriv.length, 2, r.ctx);
    assert.deepEqual(r.setpriv[0], { opts: DROP_99, cmd: PROBE_CMD(99) }, 'the dry run');
    assert.deepEqual(r.setpriv[1], { opts: DROP_99, cmd: APP.join(' ') }, 'the real start');
    // The dry run, and only it, runs under the time limit.
    assert.deepEqual(r.timeouts, ['30'], r.ctx);
  });

  test('#553 the probe reports a failure: off, its reason in the one warning, the usual start', () => {
    const r = run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'fail' });
    assertFallback(r, 'media isolation is off: a media process could read a file only the app may read', 'probe FAIL');
    assert.equal(r.setpriv.length, 1, `only the dry run went through setpriv${r.ctx}`);
  });

  test('#553 the drop to the app user itself fails (KILL missing): off, the failure in the warning, still starts', () => {
    const r = run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'drop-fails' });
    assertFallback(
      r,
      'the dry run could not start the app as uid 99 with CAP_SETUID, CAP_SETGID and CAP_KILL (exit 127: setpriv: apply capabilities: Operation not permitted)',
      'drop fails',
    );
  });

  test('#553 an OK line with a failed status, or a status 0 with no OK line, is NOT a pass', () => {
    assertFallback(run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'ok-status-1' }), 'the dry run could not start the app', 'OK + status 1');
    assertFallback(run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'silent' }), 'the dry run could not start the app', 'status 0, no OK');
  });

  test('#553 PUID=0 (any spelling): off with a warning, no dry run (the e2e and demo stacks run as root)', () => {
    for (const puid of ['0', '000']) {
      const r = run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'ok', PUID: puid });
      assertFallback(r, 'PUID=0 runs the app as root', `PUID=${puid}`);
      assert.deepEqual(r.setpriv, [], `PUID=${puid}: the dry run ran${r.ctx}`);
    }
  });

  test('#553 PUID or PGID equal to the media id 1700, compared as numbers: off, no dry run', () => {
    for (const ids of [{ PUID: '1700' }, { PUID: '01700' }, { PGID: '1700' }, { PGID: '001700' }]) {
      const r = run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'ok', ...ids });
      assertFallback(r, 'PUID or PGID is 1700, the media user\'s id', JSON.stringify(ids));
      assert.deepEqual(r.setpriv, [], `${JSON.stringify(ids)}: the dry run ran${r.ctx}`);
    }
    // ...and an id that merely contains 1700 is not it.
    const near = run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'ok', PUID: '17000', PGID: '170' });
    assert.equal(near.app, 'on', near.ctx);
  });

  test('#553 ids written with leading zeros are passed to setpriv as the numbers usermod reads', () => {
    const r = run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'ok', PUID: '099', PGID: '0100' });
    assert.equal(r.app, 'on', r.ctx);
    assert.deepEqual(r.setpriv.map((c) => c.opts), [DROP_99, DROP_99], r.ctx);
    assert.equal(r.setpriv[0].cmd, PROBE_CMD(99));
  });

  test('#553 a PUID that is not a number (usermod would refuse it in the image): off, no dry run', () => {
    const r = run({ NIGHTLIGHT_MEDIA_ISOLATION: '1', NL_PROBE: 'ok', PUID: 'abc' });
    assertFallback(r, 'are not both numbers', 'PUID=abc');
    assert.deepEqual(r.setpriv, [], r.ctx);
  });
});
