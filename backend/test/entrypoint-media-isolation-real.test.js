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
// #553 PHASE 2B: the dry run now also tries the MEDIA FOLDERS for real (media-probe.sh folders_probe / data_probe), so the
// "on" case below proves the whole layout on a real kernel (the media user writes in a leaf and the app reads and removes it;
// it reads a 0640 input and not a 0600 file; it cannot create in, rename or delete from the folders the app trusts; it
// cannot list the data directory or enter private/), and the `layout` cases run the probe on purpose-built WRONG layouts and
// need it to refuse each one, with the reason that fits.
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
  // The image's "nightlight" user does not exist here: the name is read as 99:100 and the REAL chown runs (root), so a
  // re-own can be seen on real files.
  chown: '#!/bin/sh\nfor a; do shift; case "$a" in nightlight:nightlight) a=99:100 ;; esac; set -- "$@" "$a"; done\nexec /bin/chown "$@"\n',
  // $2 too (#553 phase 2a): the move into private/ also starts through su-exec (`su-exec nightlight node <tool>`), so
  // "su-exec ran" must mean the app's start (/bin/sh app.sh). `node`, that tool, is a no-op here.
  'su-exec': '#!/bin/sh\necho "STUB su-exec $1 $2"\nshift\nexec "$@"\n',
  node: '#!/bin/sh\nexit 0\n',
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
  // The data directory and the clips folder, owned by the app as they are on a real install (the stubbed chown here does
  // nothing, and the layout step refuses a clips folder some other uid owns).
  for (const d of [path.join(ROOT, `data-${n}`), path.join(ROOT, `data-${n}`, 'clips')]) {
    fs.mkdirSync(d, { recursive: true });
    fs.chownSync(d, 99, 100);
  }
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
    suExec: r.stdout.includes('STUB su-exec nightlight /bin/sh'),
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
    // The layout the dry run proved is what is left on disk, and the probe's own folder is gone from the clips folder.
    const data = path.join(ROOT, `data-${n}`);
    const st = (p) => { const x = fs.statSync(p); return `${(x.mode & 0o7777).toString(8)} ${x.uid}:${x.gid}`; };
    assert.equal(st(data), '710 99:1700', 'the data directory: traverse only, the media group');
    assert.equal(st(path.join(data, 'clips')), '750 99:1700', 'the clips folder: list, no write');
    assert.deepEqual(fs.readdirSync(path.join(data, 'clips')), [], 'the probe left a folder behind in the clips folder');
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

  // --- the folder probe on WRONG layouts: it must refuse each one -----------------------------------------------
  // The probe is run as the entrypoint runs it (the app's launcher), but straight, on a layout built here, so a layout the
  // entrypoint would have fixed first can be shown to the probe as it is.
  const APP_DROP = ['--reuid=99', '--regid=100', '--groups=100,1700', '--inh-caps=+setuid,+setgid,+kill', '--ambient-caps=+setuid,+setgid,+kill', '--no-new-privs'];
  function probeLayout({ clipsMode, dataMode, clipsOwner = [99, 1700], mutate }) {
    n += 1;
    const base = path.join(ROOT, `layout-${n}`);
    const data = path.join(base, 'data');
    const clips = path.join(data, 'clips');
    for (const d of [base, data, clips, path.join(data, 'private')]) fs.mkdirSync(d, { recursive: true });
    fs.chmodSync(base, 0o755);
    fs.chownSync(data, 99, 1700); fs.chmodSync(data, dataMode ?? 0o710);
    fs.chownSync(clips, ...clipsOwner); fs.chmodSync(clips, clipsMode ?? 0o750);
    fs.chownSync(path.join(data, 'private'), 99, 100); fs.chmodSync(path.join(data, 'private'), 0o700);
    const dir = tree();
    if (mutate) mutate({ data, clips, dir });
    const tmp = path.join(ROOT, `tmp-layout-${n}`);
    fs.mkdirSync(tmp);
    fs.chmodSync(tmp, 0o1777);
    const r = spawnSync('setpriv', [...APP_DROP, '--', '/bin/sh', path.join(dir, 'media-probe.sh'), 'app', path.join(dir, 'media-exec.sh'), '1700', '99', clips, data], {
      env: { PATH: `${STUB_DIR}:${process.env.PATH}`, TMPDIR: tmp }, encoding: 'utf8', timeout: 60_000,
    });
    return { out: `${r.stdout}${r.stderr}`.trim(), status: r.status, clipsLeft: fs.readdirSync(clips), tmpLeft: fs.readdirSync(tmp), last: r.stdout.trim().split(String.fromCharCode(10)).pop() };
  }

  test('#553 the folder probe passes on the intended layout, and leaves nothing behind in the clips folder or TMPDIR', () => {
    const r = probeLayout({});
    assert.equal(r.last, 'MEDIA-PROBE-OK', r.out);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(r.clipsLeft, []);
    assert.deepEqual(r.tmpLeft, []);
  });

  test('#553 the folder probe refuses a clips folder the media group can WRITE to (it could rename what the app trusts)', () => {
    const r = probeLayout({ clipsMode: 0o770 });
    assert.match(r.last, /^MEDIA-PROBE-FAIL a media process could rename a folder the app trusts/, r.out);
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.clipsLeft, [], 'a refused probe leaves nothing');
  });

  test('#553 the folder probe refuses a data directory the media group can LIST', () => {
    const r = probeLayout({ dataMode: 0o750 });
    assert.match(r.last, /^MEDIA-PROBE-FAIL a media process could list the data directory/, r.out);
  });

  test('#553 the folder probe refuses a clips folder the media user cannot enter (0700): it could not read what the app wrote', () => {
    const r = probeLayout({ clipsMode: 0o700 });
    assert.match(r.last, /^MEDIA-PROBE-FAIL a media process could not read a 0640 file the app wrote for it/, r.out);
  });

  test('#553 the folder probe refuses a data directory with no private/ (nothing to keep the media user out of)', () => {
    const r = probeLayout({ mutate: ({ data }) => fs.rmdirSync(path.join(data, 'private')) });
    assert.match(r.last, /^MEDIA-PROBE-FAIL .*private does not exist/, r.out);
  });

  test('#553 the folder probe refuses a clips folder the app cannot write to', () => {
    const r = probeLayout({ clipsOwner: [0, 1700], clipsMode: 0o750 });
    assert.match(r.last, /^MEDIA-PROBE-FAIL the app could not create a folder in the clips folder/, r.out);
  });


  // --- back to OFF after an ON run (review of PR #871) -----------------------------------------------------------
  // A real media-owned file, written the way an ON run leaves it (1700:1700, 0660, in a folder with the media group), and a
  // start that ends OFF (KILL missing from the bounding set, as in the nokill case). The app (99:100, no media group) must be
  // able to read the clip afterwards, which it could not if the tighten walk had made it media-owned 0600.
  test('★ #553 a media-owned clip stays READABLE by the app after a start that falls back to off; the next start re-owns nothing', () => {
    n += 1;
    const data = path.join(ROOT, `data-${n}`);
    const clips = path.join(data, 'clips');
    const clip = path.join(clips, 'cam', 'a.mp4');
    for (const d of [data, clips, path.dirname(clip)]) { fs.mkdirSync(d, { recursive: true }); fs.chownSync(d, 99, 1700); }
    fs.chmodSync(data, 0o710); fs.chmodSync(clips, 0o750); fs.chmodSync(path.dirname(clip), 0o1770);
    fs.writeFileSync(clip, 'clip bytes');
    fs.chownSync(clip, 1700, 1700); fs.chmodSync(clip, 0o660);
    const readAsApp = () => spawnSync('setpriv', ['--reuid=99', '--regid=100', '--clear-groups', '--', 'cat', clip], { encoding: 'utf8' });
    assert.notEqual(readAsApp().stdout, 'clip bytes', 'precondition: the app WITHOUT the media group cannot read the file yet (0660 1700:1700 in a 99:1700 tree... other has no access)');

    const go = (prefix) => {
      const dir = tree();
      const tmp = path.join(ROOT, `tmp-${n}-${Math.random().toString(36).slice(2, 6)}`);
      fs.mkdirSync(tmp);
      fs.chmodSync(tmp, 0o1777);
      const r = spawnSync(prefix[0], [...prefix.slice(1), '/bin/sh', path.join(dir, 'entrypoint.sh'), '/bin/sh', path.join(dir, 'app.sh'), 'app', path.join(dir, 'media-exec.sh')], {
        env: { PATH: `${STUB_DIR}:${process.env.PATH}`, DATA_DIR: data, TMPDIR: tmp, PUID: '99', PGID: '100', NIGHTLIGHT_MEDIA_ISOLATION: '1' },
        encoding: 'utf8', timeout: 60_000,
      });
      return { out: `${r.stdout}\n${r.stderr}`, status: r.status };
    };
    const noKill = ['setpriv', '--bounding-set=-kill', '--'];
    const first = go(noKill);
    assert.equal(first.status, 0, first.out);
    assert.match(first.out, /media isolation is off: the dry run could not start the app/, first.out);
    assert.match(first.out, /an earlier start had it on: giving \S+ and the clip tree back to 99:100 once/, first.out);
    const st = fs.statSync(clip);
    assert.equal(`${st.uid}:${st.gid}`, '99:100', 'the media-owned clip was not given back to the app');
    assert.equal(readAsApp().stdout, 'clip bytes', 'the app cannot read the clip after the fallback');
    assert.equal(fs.statSync(data).mode & 0o7777, 0o700, 'the data directory is back to its OFF mode');
    assert.equal(fs.statSync(data).gid, 100);

    const second = go(noKill);
    assert.equal(second.status, 0, second.out);
    assert.doesNotMatch(second.out, /an earlier start had it on/, 'the second start walked the tree again');
    assert.equal(readAsApp().stdout, 'clip bytes');
  });

  test('★ #553 the same with an EXTERNAL clips folder: its media-owned files are given back too', () => {
    n += 1;
    const data = path.join(ROOT, `data-${n}`);
    const ext = path.join(ROOT, `ext-${n}`);
    const clip = path.join(ext, 'cam', 'a.mp4');
    for (const d of [data, ext, path.dirname(clip)]) { fs.mkdirSync(d, { recursive: true }); fs.chownSync(d, 99, 100); }
    fs.chownSync(ext, 99, 1700); fs.chmodSync(ext, 0o750);
    fs.writeFileSync(clip, 'ext bytes');
    fs.chownSync(clip, 1700, 1700); fs.chmodSync(clip, 0o660);
    const dir = tree();
    const tmp = path.join(ROOT, `tmp-ext-${n}`);
    fs.mkdirSync(tmp);
    fs.chmodSync(tmp, 0o1777);
    const r = spawnSync('setpriv', ['--bounding-set=-kill', '--', '/bin/sh', path.join(dir, 'entrypoint.sh'), '/bin/sh', path.join(dir, 'app.sh'), 'app', path.join(dir, 'media-exec.sh')], {
      env: { PATH: `${STUB_DIR}:${process.env.PATH}`, DATA_DIR: data, CLIPS_DIR: ext, TMPDIR: tmp, PUID: '99', PGID: '100', NIGHTLIGHT_MEDIA_ISOLATION: '1' },
      encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const st = fs.statSync(clip);
    assert.equal(`${st.uid}:${st.gid}`, '99:100', r.stdout + r.stderr);
    assert.equal(spawnSync('setpriv', ['--reuid=99', '--regid=100', '--clear-groups', '--', 'cat', clip], { encoding: 'utf8' }).stdout, 'ext bytes');
  });

});
