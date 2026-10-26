// #553 phase 2b: backend/src/lib/mediaFiles.js, the one module that reads, serves or deletes a file a MEDIA PROCESS wrote.
//
// With media isolation on, ffmpeg runs as another Unix user and writes into folders that user can write. Whatever it
// can plant there, the app meets with its own privileges. Each test below is one thing the media user (or a damaged
// disk) could do, and the app's answer:
//   a symbolic link to a secret             -> not opened, not served, not counted, removed as a link (target untouched)
//   a hard link to a secret (nlink 2)       -> refused. fs.protected_hardlinks is 0 on some hosts, so the media user can
//                                              make one; no symlink check sees it
//   a FIFO under a clip's name              -> open returns at once (O_NONBLOCK) instead of hanging the request
//   a folder, not a file                    -> refused
//   a leaf folder swapped for a link        -> refused (the parent's real path is not the expected folder)
//   a file name with a newline in it        -> never reaches the concat list (safeSegmentNames)
// and serveMediaFile gives the same answers res.sendFile did (status, headers, Range, 304, HEAD), from the OPEN
// descriptor, closing it on every path.
// Symbolic links and FIFOs are created with the OS's own tools; a machine that cannot make one (Windows without the
// privilege, a dev machine only) skips those cases. CI is Linux and runs them all.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import express from 'express';
import { logger } from '../src/lib/logger.js';
import {
  openMediaFile, serveMediaFile, unlinkMediaFile, removeLeafDir, statMediaFile, resolveUnder, jailedMediaFile,
  safeSegmentNames, SEGMENT_NAME_RE,
} from '../src/lib/mediaFiles.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-media-files-'));
const ROOT = path.join(TMP, 'clips');
const SECRET = path.join(TMP, 'secret.db');
const SECRET_TEXT = 'SQLite format 3\0 the database';
const BODY = 'abcdefghijklmnopqrstuvwxyz0123456789';
let n = 0;

function canSymlink() {
  const t = path.join(TMP, 'probe-link');
  try { fs.symlinkSync(TMP, t, 'dir'); fs.unlinkSync(t); return true; } catch { return false; }
}
const SYMLINKS = canSymlink();
const skipLink = SYMLINKS ? false : 'cannot create symbolic links here';
const skipFifo = process.platform === 'linux' ? false : 'FIFOs: Linux only';

// A fresh leaf folder with one clip in it: returns the folder and the clip's path.
function leaf(body = BODY) {
  n += 1;
  const dir = path.join(ROOT, `cam-${n}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'clip.mp4');
  fs.writeFileSync(file, body);
  return { dir, file };
}

// Capture what the module logs, without hiding it.
function captureWarnings(fn) {
  const seen = [];
  const orig = logger.warn;
  logger.warn = (...a) => { seen.push(a.join(' ')); };
  try { return { result: fn(), seen }; } finally { logger.warn = orig; }
}

before(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(SECRET, SECRET_TEXT);
});
after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('openMediaFile: what the app will open', () => {
  test('a plain one-name file opens, with its size and mtime; the caller closes the descriptor', () => {
    const { file } = leaf();
    const f = openMediaFile(file, { root: ROOT });
    assert.ok(f, 'a plain file must open');
    try {
      assert.equal(f.size, BODY.length);
      assert.ok(f.mtime instanceof Date);
      const buf = Buffer.alloc(BODY.length);
      fs.readSync(f.fd, buf, 0, buf.length, 0);
      assert.equal(buf.toString(), BODY);
    } finally { fs.closeSync(f.fd); }
  });

  test('a missing file, a path outside the root, and a dot-folder on the way are null (never a throw)', () => {
    const { dir } = leaf();
    assert.equal(openMediaFile(path.join(dir, 'nope.mp4'), { root: ROOT }), null);
    assert.equal(openMediaFile(SECRET, { root: ROOT }), null, 'a file outside the root');
    assert.equal(openMediaFile(path.join(ROOT, '..', 'secret.db'), { root: ROOT }), null);
    assert.equal(openMediaFile(ROOT, { root: ROOT }), null, 'the root itself');
    fs.mkdirSync(path.join(ROOT, '.ring', 'cam'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '.ring', 'cam', 'seg.mkv'), 'x');
    assert.equal(openMediaFile(path.join(ROOT, '.ring', 'cam', 'seg.mkv'), { root: ROOT }), null, 'the old sendFile({dotfiles: "deny"}) rule');
  });

  test('a SYMBOLIC LINK to the database is refused, and the refusal is logged once', { skip: skipLink }, () => {
    const { dir } = leaf();
    const link = path.join(dir, 'evil.mp4');
    fs.symlinkSync(SECRET, link);
    const { result, seen } = captureWarnings(() => [openMediaFile(link, { root: ROOT }), openMediaFile(link, { root: ROOT })]);
    assert.deepEqual(result, [null, null]);
    assert.equal(seen.filter((l) => l.includes('symbolic link')).length, 1, 'logged once per path');
    assert.equal(fs.readFileSync(SECRET, 'utf8'), SECRET_TEXT, 'the target is untouched');
  });

  test('a HARD LINK to the database (two names) is refused; with the second name gone the same file is served', () => {
    const { dir } = leaf();
    const hard = path.join(dir, 'hard.mp4');
    fs.linkSync(SECRET, hard);
    try {
      assert.equal(fs.statSync(hard).nlink, 2, 'precondition: the link count is 2');
      assert.equal(openMediaFile(hard, { root: ROOT }), null);
    } finally { fs.unlinkSync(hard); }
    // The control: the very same file with ONE name opens, so the refusal above was the link count and nothing else.
    const copy = path.join(dir, 'copy.mp4');
    fs.copyFileSync(SECRET, copy);
    const f = openMediaFile(copy, { root: ROOT });
    assert.ok(f, 'a one-name copy opens');
    fs.closeSync(f.fd);
  });

  test('a folder under a clip\'s name is refused', () => {
    const { dir } = leaf();
    fs.mkdirSync(path.join(dir, 'a-folder.mp4'));
    assert.equal(openMediaFile(path.join(dir, 'a-folder.mp4'), { root: ROOT }), null);
  });

  test('a FIFO under a clip\'s name does not hang the open (O_NONBLOCK); run in a child with a time limit', { skip: skipFifo }, () => {
    const { dir } = leaf();
    const fifo = path.join(dir, 'pipe.mp4');
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status !== 0) return; // no mkfifo here
    // In a child process: without O_NONBLOCK the open blocks for a writer FOREVER, and a hang in this process could not
    // be timed out. spawnSync kills the child at the limit and reports ETIMEDOUT.
    const code = `import { openMediaFile } from ${JSON.stringify(new URL('../src/lib/mediaFiles.js', import.meta.url).href)};
      const r = openMediaFile(${JSON.stringify(fifo)}, { root: ${JSON.stringify(ROOT)} });
      process.stdout.write(r === null ? 'NULL' : 'OPENED');`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 15_000 });
    assert.notEqual(r.error?.code, 'ETIMEDOUT', 'opening a FIFO hung: O_NONBLOCK is missing');
    assert.equal(r.stdout, 'NULL', `${r.stdout} ${r.stderr}`);
  });

  test('a leaf folder swapped for a link to another folder: nothing inside is opened (the parent\'s real path is wrong)', { skip: skipLink }, () => {
    const { dir } = leaf();
    const elsewhere = path.join(TMP, `elsewhere-${n}`);
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'clip.mp4'), 'planted');
    const swapped = path.join(ROOT, `swapped-${n}`);
    fs.symlinkSync(elsewhere, swapped, 'dir');
    assert.equal(openMediaFile(path.join(swapped, 'clip.mp4'), { root: ROOT }), null);
    // control: the real folder next to it opens
    const f = openMediaFile(path.join(dir, 'clip.mp4'), { root: ROOT });
    assert.ok(f);
    fs.closeSync(f.fd);
  });

  test('a CLIPS_DIR that is itself a link (the owner\'s own arrangement) still works: only links BELOW it are refused', { skip: skipLink }, () => {
    const real = path.join(TMP, `real-root-${n}`);
    fs.mkdirSync(path.join(real, 'cam'), { recursive: true });
    fs.writeFileSync(path.join(real, 'cam', 'clip.mp4'), 'x');
    const linkedRoot = path.join(TMP, `linked-root-${n}`);
    fs.symlinkSync(real, linkedRoot, 'dir');
    const f = openMediaFile(path.join(linkedRoot, 'cam', 'clip.mp4'), { root: linkedRoot });
    assert.ok(f, 'a linked root is the install\'s layout, not an attack');
    fs.closeSync(f.fd);
  });
});

describe('statMediaFile, resolveUnder, jailedMediaFile', () => {
  test('lstat: a symbolic link is not followed, so a link to a big file does not borrow its size', { skip: skipLink }, () => {
    const { dir, file } = leaf();
    const link = path.join(dir, 'big.mp4');
    fs.symlinkSync(SECRET, link);
    assert.equal(statMediaFile(link), null);
    assert.deepEqual(Object.keys(statMediaFile(file)).sort(), ['mtimeMs', 'size']);
    assert.equal(statMediaFile(file).size, BODY.length);
  });

  test('a hard link and a missing file are null', () => {
    const { dir } = leaf();
    const hard = path.join(dir, 'h.mp4');
    fs.linkSync(SECRET, hard);
    assert.equal(statMediaFile(hard), null);
    fs.unlinkSync(hard);
    assert.equal(statMediaFile(path.join(dir, 'gone.mp4')), null);
  });

  test('resolveUnder jails a stored path: `..`, absolute paths, empty and non-strings are null', () => {
    assert.equal(resolveUnder('cam/clip.mp4', ROOT), path.join(ROOT, 'cam', 'clip.mp4'));
    for (const bad of ['../secret.db', '../../etc/passwd', '', null, undefined, 42, '..', '.']) {
      assert.equal(resolveUnder(bad, ROOT), null, JSON.stringify(bad));
    }
    assert.equal(resolveUnder(SECRET, ROOT), null, 'an absolute path outside');
    assert.equal(resolveUnder(path.join(ROOT, 'cam', 'x.mp4'), ROOT), path.join(ROOT, 'cam', 'x.mp4'), 'an absolute path inside is fine');
  });

  test('jailedMediaFile returns { root, path } for a plain file and null for a missing or planted one', { skip: skipLink }, () => {
    const { dir } = leaf();
    const rel = path.relative(ROOT, path.join(dir, 'clip.mp4'));
    assert.deepEqual(jailedMediaFile(rel, ROOT), { root: ROOT, path: rel });
    fs.symlinkSync(SECRET, path.join(dir, 'l.mp4'));
    assert.equal(jailedMediaFile(path.join(path.relative(ROOT, dir), 'l.mp4'), ROOT), null);
    assert.equal(jailedMediaFile('nope/none.mp4', ROOT), null);
    assert.equal(jailedMediaFile('../secret.db', ROOT), null);
  });
});

describe('unlinkMediaFile and removeLeafDir: flat deletes inside a folder the media user writes in', () => {
  test('removes ONE file; true when it was there, false when it was not', () => {
    const { file } = leaf();
    assert.equal(unlinkMediaFile(file, { root: ROOT }), true);
    assert.equal(fs.existsSync(file), false);
    assert.equal(unlinkMediaFile(file, { root: ROOT }), false, 'already gone');
    assert.equal(unlinkMediaFile(path.join(ROOT, 'no-such-folder', 'x.mp4'), { root: ROOT }), false, 'its folder is gone too');
  });

  test('a symbolic link is removed ITSELF; what it points at survives', { skip: skipLink }, () => {
    const { dir } = leaf();
    const link = path.join(dir, 'evil.mp4');
    fs.symlinkSync(SECRET, link);
    assert.equal(unlinkMediaFile(link, { root: ROOT }), true);
    assert.equal(fs.existsSync(SECRET), true, 'the database was not deleted');
    assert.equal(fs.readFileSync(SECRET, 'utf8'), SECRET_TEXT);
  });

  test('a hard link loses its NAME and the other name keeps the file', () => {
    const { dir } = leaf();
    const hard = path.join(dir, 'h.mp4');
    fs.linkSync(SECRET, hard);
    assert.equal(unlinkMediaFile(hard, { root: ROOT }), true);
    assert.equal(fs.readFileSync(SECRET, 'utf8'), SECRET_TEXT);
  });

  test('a folder is never removed by it (a flat unlink), and the folder survives', () => {
    const { dir } = leaf();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    assert.throws(() => unlinkMediaFile(sub, { root: ROOT }));
    assert.equal(fs.existsSync(sub), true);
  });

  test('a path whose folder is a link to elsewhere THROWS EMEDIAJAIL and removes nothing', { skip: skipLink }, () => {
    const elsewhere = path.join(TMP, `del-elsewhere-${n}`);
    fs.mkdirSync(elsewhere);
    const victim = path.join(elsewhere, 'precious.mp4');
    fs.writeFileSync(victim, 'keep me');
    const swapped = path.join(ROOT, `del-swapped-${n}`);
    fs.symlinkSync(elsewhere, swapped, 'dir');
    assert.throws(() => unlinkMediaFile(path.join(swapped, 'precious.mp4'), { root: ROOT }), { code: 'EMEDIAJAIL' });
    assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
  });

  test('a path outside the root throws EMEDIAJAIL', () => {
    assert.throws(() => unlinkMediaFile(SECRET, { root: ROOT }), { code: 'EMEDIAJAIL' });
    assert.equal(fs.existsSync(SECRET), true);
  });

  test('removeLeafDir sweeps files and empty sub-folders, then the folder; a link inside is removed, not followed', { skip: skipLink }, () => {
    const { dir } = leaf();
    fs.mkdirSync(path.join(dir, 'empty-sub'));
    fs.writeFileSync(path.join(dir, 'a.jpg'), 'a');
    const outside = path.join(TMP, `sweep-outside-${n}`);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
    fs.symlinkSync(outside, path.join(dir, 'link-to-dir'), 'dir');
    removeLeafDir(dir);
    assert.equal(fs.existsSync(dir), false);
    assert.equal(fs.readFileSync(path.join(outside, 'precious.txt'), 'utf8'), 'keep me', 'a link to a folder is not walked into');
  });

  test('a NON-empty sub-folder stops the sweep (nothing recursive), and what is inside it is untouched', () => {
    const { dir } = leaf();
    const sub = path.join(dir, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'deep.txt'), 'deep');
    assert.throws(() => removeLeafDir(dir), (e) => e.code === 'ENOTEMPTY' || e.code === 'EEXIST');
    assert.equal(fs.readFileSync(path.join(sub, 'deep.txt'), 'utf8'), 'deep');
  });

  test('a folder that is not there throws ENOENT (the caller decides what that means)', () => {
    assert.throws(() => removeLeafDir(path.join(ROOT, 'never-made')), { code: 'ENOENT' });
  });
});

describe('safeSegmentNames: a file name is untrusted text', () => {
  test('keeps the segmenter\'s own names and nothing else', () => {
    const good = ['seg-20261026-093000.mkv', 'seg-19990101-000000.mkv'];
    const bad = [
      'seg-20261026-093000.mkv\nfile \'/app/data/private/babymonitor.db\'', // a newline: a second concat directive
      "seg-20261026-093000.mkv'", // a quote
      'seg-20261026-093000.mkv ', // a trailing space
      'seg-2026102-093000.mkv', // wrong width
      'seg-20261026-093000.mp4',
      'SEG-20261026-093000.mkv',
      '../seg-20261026-093000.mkv',
      '/etc/passwd',
      'concat-1.txt',
      'seg-20261026-093000.mkv.tmp',
      '',
    ];
    const { result } = captureWarnings(() => safeSegmentNames([...bad.slice(0, 5), ...good, ...bad.slice(5)]));
    assert.deepEqual(result, good);
  });

  test('is anchored: no partial match anywhere in the name (newline before OR after)', () => {
    assert.equal(SEGMENT_NAME_RE.test('x\nseg-20261026-093000.mkv'), false);
    assert.equal(SEGMENT_NAME_RE.test('seg-20261026-093000.mkv\nx'), false);
    assert.equal(SEGMENT_NAME_RE.test('seg-20261026-093000.mkv'), true);
  });

  test('non-strings are ignored; each ignored name is logged once, and the log is bounded', () => {
    const { result, seen } = captureWarnings(() => [
      safeSegmentNames([null, 42, {}, 'odd-one-out-1', 'odd-one-out-1']),
      safeSegmentNames(Array.from({ length: 500 }, (_, i) => `junk-${i}`)),
    ]);
    assert.deepEqual(result[0], []);
    assert.deepEqual(result[1], []);
    assert.equal(seen.filter((l) => l.includes('odd-one-out-1')).length, 1, 'once per name');
    assert.ok(seen.length <= 200, `the set of remembered names is capped (saw ${seen.length} lines)`);
  });
});

// --- serving ---------------------------------------------------------------------------------------------------

describe('serveMediaFile: the same answers res.sendFile gave, from the open descriptor', () => {
  let server;
  let base;
  let file;
  let twin;
  const opened = []; // descriptors fs.openSync handed out while serving

  before(async () => {
    ({ file } = leaf(BODY));
    // The twin: sendFile of an identical file, the reference for "must not change what an ordinary request returns".
    twin = path.join(path.dirname(file), 'twin.mp4');
    fs.copyFileSync(file, twin);
    fs.utimesSync(twin, fs.statSync(file).atime, fs.statSync(file).mtime);
    const app = express();
    app.get('/new', (req, res) => { serveMediaFile(req, res, file, { contentType: 'video/mp4', root: ROOT }); });
    app.head('/new', (req, res) => { serveMediaFile(req, res, file, { contentType: 'video/mp4', root: ROOT }); });
    app.get('/old', (req, res) => { res.sendFile(path.relative(ROOT, twin), { root: ROOT, dotfiles: 'deny' }); });
    app.head('/old', (req, res) => { res.sendFile(path.relative(ROOT, twin), { root: ROOT, dotfiles: 'deny' }); });
    app.get('/missing', (req, res) => { serveMediaFile(req, res, path.join(ROOT, 'nope', 'x.mp4'), { contentType: 'video/mp4', root: ROOT }); });
    app.get('/big', (req, res) => { serveMediaFile(req, res, bigFile, { contentType: 'video/mp4', root: ROOT }); });
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  const bigFile = path.join(ROOT, `big-${process.pid}.mp4`);
  before(() => { fs.writeFileSync(bigFile, Buffer.alloc(6 * 1024 * 1024, 7)); });

  const HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified'];
  // node:http, not fetch: fetch adds Cache-Control: no-cache to any request that carries a validator, which switches the
  // 304 logic off in sendFile and here alike, so a fetch could never show a 304.
  function get(url, init = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method: init.method || 'GET', headers: init.headers || {} }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          h: Object.fromEntries(HEADERS.map((k) => [k, res.headers[k] ?? null])),
          etag: res.headers.etag ?? null,
          body: Buffer.concat(chunks).toString(),
        }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    });
  }

  // Every request shape a browser's <video> makes, compared with sendFile's answer to the identical request.
  const CASES = [
    ['a plain GET', {}],
    ['a HEAD', { method: 'HEAD' }],
    ['a Range from the middle', { headers: { Range: 'bytes=5-14' } }],
    ['an open-ended Range (the browser\'s first probe)', { headers: { Range: 'bytes=0-' } }],
    ['an open-ended Range from the middle', { headers: { Range: 'bytes=10-' } }],
    ['a suffix Range (the last bytes: some players read the index at the end)', { headers: { Range: 'bytes=-7' } }],
    ['a Range past the end is clamped', { headers: { Range: 'bytes=30-9999' } }],
    ['an unsatisfiable Range (416)', { headers: { Range: 'bytes=500-' } }],
    ['a malformed Range is ignored, the whole file is sent', { headers: { Range: 'bytes=abc' } }],
    ['a Range unit nobody knows is ignored', { headers: { Range: 'items=1-2' } }],
    ['several separate ranges: the whole file (send serves one range only)', { headers: { Range: 'bytes=0-1,5-6' } }],
    ['overlapping ranges are combined into one', { headers: { Range: 'bytes=0-3,2-9' } }],
    ['a suffix longer than the file', { headers: { Range: 'bytes=-1000' } }],
    ['leading spaces before bytes=', { headers: { Range: '  bytes=1-2' } }],
    ['the last byte', { headers: { Range: `bytes=${BODY.length - 1}-${BODY.length - 1}` } }],
  ];
  for (const [name, init] of CASES) {
    test(`${name}: status, headers and body equal sendFile's`, async () => {
      const a = await get(`${base}/new`, init);
      const b = await get(`${base}/old`, init);
      assert.equal(a.status, b.status, `status ${a.status} vs ${b.status}`);
      if (a.status === 416) {
        // send answers 416 with a small HTML error page; ours has no body. Nothing reads it; the status and Content-Range matter.
        assert.equal(a.h['content-range'], b.h['content-range']);
        return;
      }
      assert.deepEqual(a.h, b.h);
      assert.equal(a.body, b.body);
      assert.ok(a.etag && /^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(a.etag), `a weak ETag of size and mtime: ${a.etag}`);
    });
  }

  test('206: the exact bytes, Content-Range and Content-Length', async () => {
    const r = await get(`${base}/new`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(r.status, 206);
    assert.equal(r.body, BODY.slice(2, 6));
    assert.equal(r.h['content-range'], `bytes 2-5/${BODY.length}`);
    assert.equal(r.h['content-length'], '4');
    assert.equal(r.h['accept-ranges'], 'bytes');
  });

  test('416 carries Content-Range: bytes */size and no body', async () => {
    const r = await get(`${base}/new`, { headers: { Range: `bytes=${BODY.length}-` } });
    assert.equal(r.status, 416);
    assert.equal(r.h['content-range'], `bytes */${BODY.length}`);
    assert.equal(r.body, '');
  });

  test('If-None-Match with the ETag answers 304 with no body; a different one gets the file', async () => {
    const first = await get(`${base}/new`);
    const hit = await get(`${base}/new`, { headers: { 'If-None-Match': first.etag } });
    assert.equal(hit.status, 304);
    assert.equal(hit.body, '');
    const miss = await get(`${base}/new`, { headers: { 'If-None-Match': 'W/"0-0"' } });
    assert.equal(miss.status, 200);
    assert.equal(miss.body, BODY);
    const old = await get(`${base}/old`, { headers: { 'If-None-Match': first.etag } });
    assert.equal(old.status, 304, 'sendFile answers the same to the same validator');
  });

  test('If-Range with a stale validator sends the whole file (200), a current one the part (206)', async () => {
    const first = await get(`${base}/new`);
    const stale = await get(`${base}/new`, { headers: { Range: 'bytes=0-3', 'If-Range': 'W/"1-1"' } });
    assert.equal(stale.status, 200);
    assert.equal(stale.body, BODY);
    const current = await get(`${base}/new`, { headers: { Range: 'bytes=0-3', 'If-Range': first.h['last-modified'] } });
    assert.equal(current.status, 206);
  });

  test('no usable file: 404 JSON, nothing served from outside', async () => {
    const r = await fetch(`${base}/missing`);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'Not found.' });
  });

  test('a link planted under the name is a 404 and the secret is not in the answer', { skip: skipLink }, async () => {
    const { dir } = leaf();
    const evil = path.join(dir, 'evil.mp4');
    fs.symlinkSync(SECRET, evil);
    const app = express();
    app.get('/x', (req, res) => { serveMediaFile(req, res, evil, { contentType: 'video/mp4', root: ROOT }); });
    const s = http.createServer(app);
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      const r = await fetch(`http://127.0.0.1:${s.address().port}/x`);
      assert.equal(r.status, 404);
      assert.ok(!(await r.text()).includes('SQLite format'));
    } finally { s.closeAllConnections?.(); await new Promise((r) => s.close(r)); }
  });

  // THE DESCRIPTOR IS CLOSED ON EVERY PATH. fs.openSync is wrapped to remember what it hands out; a closed descriptor
  // answers EBADF to fstat. (A reused number would fool this, so each case checks straight after its own request.)
  describe('the descriptor is closed on every path', () => {
    const real = fs.openSync;
    before(() => { fs.openSync = (...a) => { const fd = real(...a); opened.push(fd); return fd; }; });
    after(() => { fs.openSync = real; });

    const closed = (fd) => { try { fs.fstatSync(fd); return false; } catch (e) { return e.code === 'EBADF'; } };
    async function closedAfter(url, init) {
      opened.length = 0;
      await get(url, init).catch(() => {});
      const mine = opened.slice();
      assert.ok(mine.length >= 1, 'the request opened the file');
      // The stream closes asynchronously after the last byte; give it a moment, but a leak never closes.
      for (let i = 0; i < 40 && !mine.every(closed); i += 1) await new Promise((r) => setTimeout(r, 25));
      assert.ok(mine.every(closed), `descriptor(s) ${mine} still open`);
    }

    test('after a full read', async () => { await closedAfter(`${base}/new`); });
    test('after a Range read', async () => { await closedAfter(`${base}/new`, { headers: { Range: 'bytes=1-3' } }); });
    test('after a HEAD (nothing is read)', async () => { await closedAfter(`${base}/new`, { method: 'HEAD' }); });
    test('after a 304', async () => {
      const first = await get(`${base}/new`);
      await closedAfter(`${base}/new`, { headers: { 'If-None-Match': first.etag } });
    });
    test('after a 416', async () => { await closedAfter(`${base}/new`, { headers: { Range: 'bytes=999-' } }); });
    test('after the client goes away mid-stream (abort)', async () => {
      opened.length = 0;
      const req = http.get(`${base}/big`);
      const res = await new Promise((r, j) => { req.on('response', r); req.on('error', j); });
      await new Promise((r) => res.once('data', r)); // the first chunk: the stream is open and unfinished
      const mine = opened.slice();
      assert.ok(mine.length >= 1);
      req.destroy();
      for (let i = 0; i < 80 && !mine.every(closed); i += 1) await new Promise((r2) => setTimeout(r2, 25));
      assert.ok(mine.every(closed), `descriptor(s) ${mine} still open after an abort`);
    });
  });
});
