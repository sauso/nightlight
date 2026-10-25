// #553 phase 1: the REAL chain, with the real setpriv and the real kernel. entrypoint-media-isolation.test.js pins the
// decision with a stubbed launcher; only this file shows that what media-probe.sh checks is what the kernel does, and
// that the probe can tell a working media-exec.sh from a broken one.
//
// It needs ROOT (to drop to other uids) and util-linux's setpriv. CI runs it as root inside node:24-alpine, the image's
// own base, after `apk add setpriv` (.github/workflows/test.yml), and fails that step if anything here is skipped.
// Everywhere else it is skipped, with the reason.
//
// What runs for real: entrypoint.sh's isolation block, setpriv (both drops), timeout, media-exec.sh, media-probe.sh.
// Stubbed (as in every entrypoint test): id, usermod, groupmod, chown, and su-exec (prints a marker, then execs).
// Each case runs the scripts from a copy in a fresh folder, because the entrypoint finds media-exec.sh and
// media-probe.sh next to itself: that is also how a BROKEN wrapper is put in front of the probe.
//   on       the dry run passes and the app really runs as 99:100 with exactly setuid/setgid/kill, and a media
//            process it starts through media-exec.sh really runs as 1700:1700 with nothing;
//   nokill   KILL taken out of the bounding set before the entrypoint runs (what --cap-drop=KILL does): the app's own
//            drop fails, isolation is off, the start goes on;
//   program  a program the app starts (mediamtx) cannot be run by the media user: isolation is off (the programs are
//            stand-ins on PATH here; the e2e runs the image's real ones);
//   broken   three wrappers the probe must refuse: one that does not exec (the app would signal the wrong pid), one
//            that keeps the app's capabilities, one that keeps the app's groups;
// and every case leaves its temporary folder ($TMPDIR) empty.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, '..');
const ON_LINUX = process.platform === 'linux';
const IS_ROOT = process.getuid?.() === 0;
const UTIL_LINUX_SETPRIV = ON_LINUX && /util-linux/.test(spawnSync('setpriv', ['--version'], { encoding: 'utf8' }).stdout ?? '');
const skip = !ON_LINUX ? 'Linux only'
  : !IS_ROOT ? 'needs root to switch users (CI runs it as root in node:24-alpine)'
    : !UTIL_LINUX_SETPRIV ? "needs util-linux's setpriv (apk add setpriv)" : false;

const STUBS = {
  id: '#!/bin/sh\ncase "$1" in -u) echo 99 ;; -g) echo 100 ;; *) exit 1 ;; esac\n',
  usermod: '#!/bin/sh\nexit 0\n',
  groupmod: '#!/bin/sh\nexit 0\n',
  chown: '#!/bin/sh\nexit 0\n',
  'su-exec': '#!/bin/sh\necho "STUB su-exec $1"\nshift\nexec "$@"\n',
  // The programs the dry run makes the media user run (media-probe.sh): stand-ins that print a version line, so the
  // check is about whether the MEDIA USER can execute them, which is the part that depends on the kernel.
  ffmpeg: '#!/bin/sh\necho "ffmpeg version stub"\n',
  ffprobe: '#!/bin/sh\necho "ffprobe version stub"\n',
  mediamtx: '#!/bin/sh\necho "v1.0.0-stub"\n',
};

// The "app": reports its own identity and capabilities from /proc, then (role app) starts itself again through the
// wrapper as role child, which reports the same about the media process.
const APP_SH = [
  '#!/bin/sh',
  "f() { awk -v k=\"$1:\" '$1 == k { $1 = \"\"; sub(/^[ \\t]+/, \"\"); gsub(/[ \\t]+/, \" \"); print; exit }' \"/proc/$2/status\"; }",
  'report() {',
  '  printf \'%s uid=%s gid=%s groups=%s inh=%s prm=%s eff=%s amb=%s nnp=%s iso=%s\\n\' "$1" "$(f Uid $$)" "$(f Gid $$)" \\',
  '    "$(f Groups $$)" "$(f CapInh $$)" "$(f CapPrm $$)" "$(f CapEff $$)" "$(f CapAmb $$)" "$(f NoNewPrivs $$)" "${MEDIA_ISOLATION-unset}"',
  '}',
  'if [ "$1" = child ]; then report CHILD; exit 0; fi',
  'report APP',
  '"$2" /bin/sh "$0" child',
  '',
].join('\n');

let ROOT;
let STUB_DIR;
let STUB_DIR_NO_MEDIAMTX; // the same stubs without mediamtx (node:24-alpine has none of its own)
let n = 0;

// A fresh copy of the three scripts (with `wrapper` as media-exec.sh when given) plus the app, readable by every uid.
function tree(wrapper) {
  n += 1;
  const dir = path.join(ROOT, `tree-${n}`);
  fs.mkdirSync(dir, { mode: 0o755 });
  fs.chmodSync(dir, 0o755);
  for (const f of ['entrypoint.sh', 'media-probe.sh', 'media-exec.sh']) {
    fs.writeFileSync(path.join(dir, f), fs.readFileSync(path.join(BACKEND, f)), { mode: 0o755 });
  }
  if (wrapper) fs.writeFileSync(path.join(dir, 'media-exec.sh'), wrapper, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'app.sh'), APP_SH, { mode: 0o755 });
  for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o755);
  return dir;
}

function run(dir, { prefix = [], stubDir = STUB_DIR } = {}) {
  const tmp = path.join(ROOT, `tmp-${n}`);
  fs.mkdirSync(tmp);
  fs.chmodSync(tmp, 0o1777); // the probe runs as uid 99 and its media process as 1700: both must use it
  const argv = [...prefix, '/bin/sh', path.join(dir, 'entrypoint.sh'), '/bin/sh', path.join(dir, 'app.sh'), 'app', path.join(dir, 'media-exec.sh')];
  const r = spawnSync(argv[0], argv.slice(1), {
    env: {
      PATH: `${stubDir}:${process.env.PATH}`, DATA_DIR: path.join(ROOT, `data-${n}`), TMPDIR: tmp,
      PUID: '99', PGID: '100', NIGHTLIGHT_MEDIA_ISOLATION: '1',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  const line = (tag) => {
    const m = new RegExp(`^${tag} (.*)$`, 'm').exec(r.stdout);
    return m ? Object.fromEntries(m[1].match(/\w+=[^=]*?(?= \w+=|$)/g).map((kv) => kv.split(/=(.*)/s).slice(0, 2))) : null;
  };
  return {
    status: r.status,
    app: line('APP'),
    child: line('CHILD'),
    suExec: r.stdout.includes('STUB su-exec nightlight'),
    onLine: r.stdout.includes('[entrypoint] media isolation on:'),
    warning: `${r.stdout}\n${r.stderr}`.split('\n').find((l) => l.includes('[entrypoint] warning: media isolation is off:')) ?? null,
    leftovers: fs.readdirSync(tmp),
    ctx: `\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
  };
}

const ZERO = '0000000000000000';

describe('#553 media isolation, the real chain (root, util-linux setpriv)', { skip }, () => {
  before(() => {
    ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-real-'));
    fs.chmodSync(ROOT, 0o755);
    STUB_DIR = path.join(ROOT, 'bin');
    STUB_DIR_NO_MEDIAMTX = path.join(ROOT, 'bin-no-mediamtx');
    for (const [dir, skipName] of [[STUB_DIR, null], [STUB_DIR_NO_MEDIAMTX, 'mediamtx']]) {
      fs.mkdirSync(dir);
      for (const [name, body] of Object.entries(STUBS)) {
        if (name === skipName) continue;
        fs.writeFileSync(path.join(dir, name), body, { mode: 0o755 });
        fs.chmodSync(path.join(dir, name), 0o755);
      }
      fs.chmodSync(dir, 0o755);
    }
  });
  after(() => { if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true }); });

  test('#553 on: the app runs as 99:100 with setuid/setgid/kill only; its media child as 1700:1700 with nothing', () => {
    const r = run(tree());
    assert.equal(r.status, 0, r.ctx);
    assert.ok(r.onLine, `no "media isolation on" line${r.ctx}`);
    assert.equal(r.warning, null, r.ctx);
    assert.equal(r.suExec, false, r.ctx);
    assert.deepEqual(r.app, {
      uid: '99 99 99 99', gid: '100 100 100 100', groups: '100 1700',
      inh: '00000000000000e0', prm: '00000000000000e0', eff: '00000000000000e0', amb: '00000000000000e0', nnp: '1', iso: 'on',
    }, r.ctx);
    assert.ok(r.child, `the media child never reported${r.ctx}`);
    assert.deepEqual(
      { uid: r.child.uid, gid: r.child.gid, groups: r.child.groups, inh: r.child.inh, prm: r.child.prm, eff: r.child.eff, amb: r.child.amb, nnp: r.child.nnp },
      { uid: '1700 1700 1700 1700', gid: '1700 1700 1700 1700', groups: '1700', inh: ZERO, prm: ZERO, eff: ZERO, amb: ZERO, nnp: '1' },
      r.ctx,
    );
    assert.deepEqual(r.leftovers, [], 'the dry run left something in TMPDIR');
  });

  test('#553 KILL not in the bounding set: the app\'s drop fails, isolation is off, the start goes on', () => {
    const r = run(tree(), { prefix: ['setpriv', '--bounding-set=-kill', '--'] });
    assert.equal(r.status, 0, r.ctx);
    assert.equal(r.onLine, false, r.ctx);
    assert.ok(r.suExec, r.ctx);
    assert.equal(r.app?.iso, 'off', r.ctx);
    assert.match(r.warning ?? '', /media isolation is off: the dry run could not start the app as uid 99 with CAP_SETUID, CAP_SETGID and CAP_KILL \(exit \d+: setpriv: /, r.ctx);
    assert.deepEqual(r.leftovers, []);
  });

  // Review of PR #869: the dry run must prove the REAL programs run as the media user, not only /bin/sh and sleep.
  // Here mediamtx is not on PATH at all (setpriv exits 127); every other step passes, so without the program check
  // isolation would go on, and every launch of MediaMTX would then fail.
  test('#553 a program the media user cannot run (mediamtx missing): off, with that reason, and the start goes on', () => {
    const r = run(tree(), { stubDir: STUB_DIR_NO_MEDIAMTX });
    assert.equal(r.status, 0, r.ctx);
    assert.equal(r.onLine, false, `isolation went on although mediamtx cannot run${r.ctx}`);
    assert.ok(r.suExec, r.ctx);
    assert.equal(r.app?.iso, 'off', r.ctx);
    assert.match(r.warning ?? '', /media isolation is off: the media user cannot run mediamtx \(exit 127\)/, r.ctx);
    assert.deepEqual(r.leftovers, []);
  });

  // The real wrapper's line, changed one way each. The probe must refuse every one, with the reason that fits.
  const REAL = fs.readFileSync(path.join(BACKEND, 'media-exec.sh'), 'utf8');
  const EXEC_LINE = 'exec setpriv --reuid=1700 --regid=1700 --groups=1700 --inh-caps=-all --ambient-caps=-all --no-new-privs -- "$@"';
  const broken = {
    'no exec (the app would signal the shell, not the program)': [EXEC_LINE, EXEC_LINE.replace(/^exec /, '')],
    'the app\'s capabilities kept': [EXEC_LINE, EXEC_LINE.replace(' --inh-caps=-all --ambient-caps=-all', '')],
    'the app\'s groups kept': [EXEC_LINE, EXEC_LINE.replace('--groups=1700', '--keep-groups')],
  };
  const reasons = {
    'no exec (the app would signal the shell, not the program)': /did not keep the pid it was started with/,
    'the app\'s capabilities kept': /a media process kept capabilities/,
    'the app\'s groups kept': /a media process had the groups '100 1700', expected only 1700/,
  };
  for (const [what, [from, to]] of Object.entries(broken)) {
    test(`#553 the dry run refuses a broken media-exec.sh: ${what}`, () => {
      assert.ok(REAL.includes(from), 'precondition: the wrapper still has the line this case changes');
      const r = run(tree(REAL.replace(from, to)));
      assert.equal(r.status, 0, r.ctx);
      assert.equal(r.onLine, false, `isolation went on with a broken wrapper${r.ctx}`);
      assert.equal(r.app?.iso, 'off', r.ctx);
      assert.match(r.warning ?? '', reasons[what], r.ctx);
      assert.deepEqual(r.leftovers, []);
    });
  }
});
