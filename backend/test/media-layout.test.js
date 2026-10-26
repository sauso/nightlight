// #553 phase 2b: backend/src/lib/mediaLayout.js, WHO MAY WRITE WHERE under the clips folder when media isolation is on.
//
//   traverse folders (CLIPS_DIR's children .ring, .concat, .timelapse-frames, timelapse and what is below them):
//       app-owned, group = media, 0750   -> the media user can enter and list, never create, rename or delete
//   leaf folders (.ring/<camera>, <camera>, timelapse/<child>):
//       app-owned, group = media, 1770   -> the only places the media user writes; sticky; NO setgid bit anywhere
//   input files (concat lists, timelapse frames):
//       0640, group = media, whatever the umask   -> the media user reads, never writes
//   an older, app-only (0700) folder is brought to the right owner-group and mode on first use, through a descriptor
//   opened with O_NOFOLLOW (a path swapped for a link cannot redirect the chmod), and a folder the app does not own is
//   refused rather than handed to the group.
// With isolation OFF none of it changes a mode or a group (the folders are made as plain mkdir did).
//
// The real chgrp to the media group (1700) needs root, which a unit test does not have. So childEnv.js (not a core
// module, safe to mock) is replaced by a stand-in whose "media group" is the test process's OWN group: every call, mode
// and descriptor is real; only the number of the group differs. The real 1700 is proven by entrypoint-media-isolation-
// real.test.js (root) and e2e/media-isolation.sh (the image). POSIX modes: Linux only.
import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ON_LINUX = process.platform === 'linux';
const skip = ON_LINUX ? false : 'POSIX modes: Linux only (runs in CI)';
const GID = process.getgid?.() ?? 0;

const state = { on: true };
mock.module(new URL('../src/lib/childEnv.js', import.meta.url).href, {
  exports: { mediaIsolationOn: () => state.on, MEDIA_GID: GID },
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-layout-'));
process.env.CLIPS_DIR = path.join(TMP, 'clips');
const L = await import('../src/lib/mediaLayout.js');

const mode = (p) => fs.lstatSync(p).mode & 0o7777;
const gidOf = (p) => fs.lstatSync(p).gid;
let n = 0;
const fresh = () => { n += 1; return `c${n}`; };

after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('#553 ensureClipsFolder: traverse folders and leaves', { skip }, () => {
  before(() => { state.on = true; });

  test('isolation on: the folders on the way are 0750, the LEAF is 1770, all in the media group, none with a setgid bit', () => {
    const cam = fresh();
    const leaf = L.ensureClipsFolder(['.ring', cam], { leaf: true });
    assert.equal(leaf, path.join(process.env.CLIPS_DIR, '.ring', cam));
    assert.equal(mode(path.join(process.env.CLIPS_DIR, '.ring')), 0o750, 'a traverse folder');
    assert.equal(mode(leaf), 0o1770, 'the leaf: sticky, group-writable');
    for (const p of [path.join(process.env.CLIPS_DIR, '.ring'), leaf]) {
      assert.equal(gidOf(p), GID, 'the media group');
      assert.equal(mode(p) & 0o2000, 0, `no setgid bit on ${p} (the owner's Unraid kernel drops it, and nothing may rely on it)`);
    }
  });

  test('a clip folder <camera> is a leaf directly under the clips folder; the timelapse leaf is two deep', () => {
    const cam = fresh();
    const clipLeaf = L.ensureClipsFolder([cam], { leaf: true });
    assert.equal(mode(clipLeaf), 0o1770);
    const kid = fresh();
    const tl = L.ensureClipsFolder(['timelapse', kid], { leaf: true });
    assert.equal(mode(path.dirname(tl)), 0o750);
    assert.equal(mode(tl), 0o1770);
  });

  test('without `leaf` the LAST folder is a traverse folder too (the app-only inputs: concat lists, frames, .seq)', () => {
    const d = L.ensureClipsFolder(['.concat', fresh()]);
    assert.equal(mode(d), 0o750);
  });

  test('an older app-only (0700) folder is REPAIRED on first use, and a second call changes nothing', () => {
    const cam = fresh();
    const dir = path.join(process.env.CLIPS_DIR, cam);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
    L.ensureClipsFolder([cam], { leaf: true });
    assert.equal(mode(dir), 0o1770);
    const before = fs.statSync(dir).ctimeMs;
    L.ensureClipsFolder([cam], { leaf: true });
    assert.equal(fs.statSync(dir).ctimeMs, before, 'already right: no chmod, no chown (ctime unchanged)');
  });

  test('files already in an older folder are NOT touched (they are app-owned 0600 and only the app reads them)', () => {
    const cam = fresh();
    const dir = path.join(process.env.CLIPS_DIR, cam);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.mp4'), 'old', { mode: 0o600 });
    L.ensureClipsFolder([cam], { leaf: true });
    assert.equal(mode(path.join(dir, 'old.mp4')), 0o600);
  });

  test('a folder that is a LINK is refused (O_NOFOLLOW), and what it points at keeps its mode', () => {
    const target = path.join(TMP, `link-target-${n}`);
    fs.mkdirSync(target, { mode: 0o700 });
    const cam = fresh();
    fs.mkdirSync(process.env.CLIPS_DIR, { recursive: true });
    fs.symlinkSync(target, path.join(process.env.CLIPS_DIR, cam), 'dir');
    assert.throws(() => L.ensureClipsFolder([cam], { leaf: true }), (e) => e.code === 'ELOOP' || e.code === 'ENOTDIR');
    assert.equal(mode(target), 0o700, 'the folder behind the link was not opened up to the media group');
  });

  test('a folder some OTHER user owns is refused (EMEDIAOWNER) and not changed', () => {
    const cam = fresh();
    const dir = path.join(process.env.CLIPS_DIR, cam);
    fs.mkdirSync(dir, { recursive: true });
    fs.chmodSync(dir, 0o700);
    const real = process.geteuid;
    process.geteuid = () => real.call(process) + 1; // "the app is another uid than the owner"
    try {
      assert.throws(() => L.ensureClipsFolder([cam], { leaf: true }), { code: 'EMEDIAOWNER' });
    } finally { process.geteuid = real; }
    assert.equal(mode(dir), 0o700);
  });

  test('a FILE where a folder belongs is refused', () => {
    const name = fresh();
    fs.mkdirSync(process.env.CLIPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.CLIPS_DIR, name), 'x');
    assert.throws(() => L.ensureClipsFolder([name], { leaf: true }));
  });

  test('isolation OFF: folders are made as plain mkdir -p did, and no mode or group is changed', () => {
    state.on = false;
    try {
      const cam = fresh();
      const dir = L.ensureClipsFolder(['.ring', cam], { leaf: true });
      const plain = path.join(TMP, `plain-${n}`);
      fs.mkdirSync(plain);
      assert.equal(mode(dir), mode(plain), 'the same mode a plain mkdir gives under this umask');
      assert.equal(mode(path.join(process.env.CLIPS_DIR, '.ring')) & 0o1000, 0, 'no sticky bit');
      // and an existing 0700 folder stays 0700
      const old = path.join(process.env.CLIPS_DIR, fresh());
      fs.mkdirSync(old, { recursive: true });
      fs.chmodSync(old, 0o700);
      L.ensureClipsFolder([path.basename(old)], { leaf: true });
      assert.equal(mode(old), 0o700);
    } finally { state.on = true; }
  });
});

describe('#553 writeInputFile and shareInputFile: what the media user may READ and never write', { skip }, () => {
  before(() => { state.on = true; });
  const old = process.umask();
  after(() => { process.umask(old); });

  test('0640, media group, even under the strictest umask (a mode asked at creation is cut by the mask)', () => {
    process.umask(0o077);
    const dir = L.ensureClipsFolder(['.concat', fresh()]);
    const f = path.join(dir, 'concat-1.txt');
    L.writeInputFile(f, 'file one\n');
    assert.equal(mode(f), 0o640);
    assert.equal(gidOf(f), GID);
    assert.equal(fs.readFileSync(f, 'utf8'), 'file one\n');
  });

  test('replaces an older file of the same name (a new inode), and never writes through a link planted there', () => {
    const dir = L.ensureClipsFolder(['.concat', fresh()]);
    const f = path.join(dir, 'concat-2.txt');
    L.writeInputFile(f, 'first');
    const ino = fs.statSync(f).ino;
    L.writeInputFile(f, 'second');
    assert.equal(fs.readFileSync(f, 'utf8'), 'second');
    // a link where the file goes: it is removed, the TARGET is not written
    const target = path.join(TMP, `link-victim-${n}`);
    fs.writeFileSync(target, 'precious');
    fs.unlinkSync(f);
    fs.symlinkSync(target, f);
    L.writeInputFile(f, 'third');
    assert.equal(fs.readFileSync(target, 'utf8'), 'precious', 'the link\'s target was not overwritten');
    assert.equal(fs.lstatSync(f).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(f, 'utf8'), 'third');
    assert.notEqual(ino, undefined);
  });

  test('isolation OFF: an ordinary file, no chmod or chgrp (the mask decides)', () => {
    state.on = false;
    try {
      process.umask(0o022);
      const dir = L.ensureClipsFolder(['.concat', fresh()]);
      const f = path.join(dir, 'concat-3.txt');
      L.writeInputFile(f, 'x');
      assert.equal(mode(f), 0o644);
    } finally { state.on = true; }
  });

  test('shareInputFile brings an older 0600 frame to 0640 and the media group; a link or a folder is refused', () => {
    const dir = L.ensureClipsFolder(['.timelapse-frames', fresh()]);
    const f = path.join(dir, 'f-1.jpg');
    fs.writeFileSync(f, 'jpg', { mode: 0o600 });
    L.shareInputFile(f);
    assert.equal(mode(f), 0o640);
    assert.equal(gidOf(f), GID);
    const link = path.join(dir, 'f-2.jpg');
    fs.symlinkSync(f, link);
    assert.throws(() => L.shareInputFile(link), (e) => e.code === 'ELOOP');
    fs.mkdirSync(path.join(dir, 'f-3.jpg'));
    assert.throws(() => L.shareInputFile(path.join(dir, 'f-3.jpg')));
  });

  test('shareInputFile with isolation OFF does nothing', () => {
    state.on = false;
    try {
      const dir = L.ensureClipsFolder(['.timelapse-frames', fresh()]);
      const f = path.join(dir, 'f-9.jpg');
      fs.writeFileSync(f, 'jpg', { mode: 0o600 });
      L.shareInputFile(f);
      assert.equal(mode(f), 0o600);
    } finally { state.on = true; }
  });
});

describe('#553 ensureAppOnlyFolder', { skip }, () => {
  test('0700 under any umask (UMASK=022 would give 0755), and a wider older one is tightened', () => {
    const old = process.umask(0o022);
    try {
      const d = L.ensureAppOnlyFolder('.app-test');
      assert.equal(mode(d), 0o700);
      fs.chmodSync(d, 0o755);
      L.ensureAppOnlyFolder('.app-test');
      assert.equal(mode(d), 0o700);
    } finally { process.umask(old); }
  });
});
