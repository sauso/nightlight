// #553 phase 2b: the FENCE around media-written files.
//
// With media isolation on, ffmpeg runs as another user and writes into folders it can write. Everything the app does
// with such a file (serve it, read it, stat it, delete it) has to go through backend/src/lib/mediaFiles.js, which opens
// without following links, checks the file is a plain one-name file, and serves from the open descriptor. One new
// `res.sendFile(path)` or `fs.readFileSync(path.join(CLIPS_DIR, ...))` somewhere else would quietly walk around all of
// it, and no behavioural test would notice: the route would work, for an honest file.
//
// So this reads the SOURCE, on tokens (not an exact string, so a reformat or a renamed variable cannot break it):
//   A. `sendFile(` / `.download(` anywhere under src/ outside the helper modules;
//   B. in any file that mentions the clips folder (CLIPS_DIR, a `clipsDir` variable, the ring), a call that reads, stats,
//      opens, copies or deletes by path (readFileSync, createReadStream, statSync, lstatSync, existsSync, rmSync,
//      unlinkSync, openSync, copyFileSync, realpathSync, opendirSync, accessSync and their async forms).
// A line is allowed when it carries a comment saying why it is not a media-written file: `fence-ok: <reason>` (the kernel's
// mount table, a snapshot in private/) or `app-only` (a folder only the app can enter: frames, the write probe). The marker
// is the review prompt: whoever adds one has to say it. readdir is not fenced on purpose: a listing returns NAMES, and a
// name is never trusted without going through safeSegmentNames or a stored-path check.
// The helper modules themselves (mediaFiles.js, mediaLayout.js, clipsDir.js) are exempt: they ARE the fence.
//
// "A fence that has only ever seen clean code has not been shown to fence": the last tests feed it code that must be refused.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const EXEMPT = new Set(['lib/mediaFiles.js', 'lib/mediaLayout.js', 'lib/clipsDir.js']);
// Writes its own demo seed files into a folder it makes itself, in a demo build only; it never reads back anything a media
// process wrote.
const NOT_MEDIA = new Set(['lib/demoSeed.js']);

const SERVE = /\b(?:sendFile|download)\s*\(/;
const CLIPS = /\bCLIPS_DIR\b|\bclipsDir\b|['"`]\.ring['"`]|\bRING_ROOT\b/;
const FS_CALL = /\b(?:readFileSync|readFile|createReadStream|statSync|lstatSync|stat|lstat|existsSync|exists|rmSync|rm|unlinkSync|unlink|openSync|open|copyFileSync|copyFile|realpathSync|realpath|opendirSync|opendir|accessSync|access)\s*\(/;
const MARKER = /fence-ok|app-only/;

// Strip comments, keeping line numbers. Strings are left alone (a `//` inside a URL string would only hide the rest of
// that one line, and the rest of the line is rarely where the call is).
function codeLines(source) {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlocks.split(/\r?\n/).map((line) => line.replace(/(^|[^:'"`\\])\/\/.*$/, '$1'));
}

// Returns the offending lines of one file: [{ line, text, rule }].
export function scan(relPath, source) {
  if (EXEMPT.has(relPath) || NOT_MEDIA.has(relPath)) return [];
  const original = source.split(/\r?\n/); // the working tree may be CRLF (autocrlf); CI is LF
  const code = codeLines(source);
  const mentionsClips = code.some((l) => CLIPS.test(l));
  const out = [];
  code.forEach((l, i) => {
    // a marker on the line itself, or on the line just above it (a comment placed over a long statement)
    const marked = MARKER.test(original[i]) || (i > 0 && /^\s*\/\//.test(original[i - 1]) && MARKER.test(original[i - 1]));
    if (marked) return;
    if (SERVE.test(l)) out.push({ line: i + 1, text: original[i].trim(), rule: 'A: serves a file by path (use serveMediaFile)' });
    else if (mentionsClips && FS_CALL.test(l)) out.push({ line: i + 1, text: original[i].trim(), rule: 'B: reads, stats or deletes by path in a file that handles the clips folder (use mediaFiles.js)' });
  });
  return out;
}

function sourceFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p, base));
    else if (e.name.endsWith('.js')) out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out;
}

describe('#553 the fence around media-written files', () => {
  test('no sendFile/download or path-based read of the clips folder outside mediaFiles.js, unless a line says why', () => {
    const files = sourceFiles(SRC);
    assert.ok(files.length > 20 && files.includes('lib/clipRecorder.js') && files.includes('routes/recordings.js'), 'the scan found the source tree');
    const found = [];
    for (const rel of files) {
      for (const hit of scan(rel, fs.readFileSync(path.join(SRC, rel), 'utf8'))) found.push(`src/${rel}:${hit.line}  ${hit.rule}\n      ${hit.text}`);
    }
    assert.deepEqual(found, [], `these bypass lib/mediaFiles.js (or need a "fence-ok: <why>" / "app-only" comment):\n  ${found.join('\n  ')}`);
  });

  test('the routes that serve clips, recordings and timelapses do so through serveMediaFile', () => {
    for (const rel of ['routes/cameras.js', 'routes/recordings.js', 'routes/timelapses.js']) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8');
      assert.match(src, /\bserveMediaFile\s*\(/, `${rel} does not serve through serveMediaFile`);
    }
  });

  describe('it can fail (fixtures)', () => {
    test('a sendFile of a path is refused; the same line with a reason, or in a comment, is not', () => {
      assert.equal(scan('routes/x.js', 'router.get("/a", (req, res) => {\n  res.sendFile(file.path, { root: file.root });\n});\n').length, 1);
      assert.equal(scan('routes/x.js', 'res.sendFile(p); // fence-ok: a build asset\n').length, 0);
      assert.equal(scan('routes/x.js', '// fence-ok: a build asset\nres.sendFile(p);\n').length, 0, 'a marker comment on the line above');
      assert.equal(scan('routes/x.js', '// do not use res.sendFile( here\nconst a = 1;\n').length, 0, 'a comment');
      assert.equal(scan('routes/x.js', '/* res.sendFile(x) is gone */\nconst a = 1;\n').length, 0, 'a block comment');
      assert.equal(scan('routes/x.js', 'res.download(f);\n').length, 1);
    });

    test('a read, stat or delete by path in a file that handles the clips folder is refused', () => {
      for (const call of [
        "fs.readFileSync(path.join(CLIPS_DIR, rel))", "fs.createReadStream(abs)", "fs.statSync(abs).size", "fs.lstatSync(abs)",
        "fs.existsSync(abs)", "fs.rmSync(abs, { force: true })", "fs.unlinkSync(abs)", "fs.openSync(abs, 'r')", "fs.copyFileSync(a, b)",
        "fs.realpathSync(abs)", "await fs.promises.readFile(abs)", "fs.promises.unlink(abs)", "fs.accessSync(abs)",
      ]) {
        const hits = scan('lib/x.js', `import { CLIPS_DIR } from './clipRecorder.js';\n${call};\n`);
        assert.equal(hits.length, 1, `not refused: ${call}`);
      }
    });

    test('the same calls are fine in a file that never touches the clips folder, and in the helper modules', () => {
      assert.equal(scan('lib/other.js', 'fs.readFileSync(configPath);\nfs.rmSync(tmp);\n').length, 0);
      assert.equal(scan('lib/mediaFiles.js', "import { CLIPS_DIR } from './clipsDir.js';\nfs.readFileSync(CLIPS_DIR);\n").length, 0);
      assert.equal(scan('lib/mediaLayout.js', "const dir = CLIPS_DIR;\nfs.unlinkSync(dir);\n").length, 0);
    });

    test('a name listing is not fenced; a mention of the ring in a string is enough to put a file under rule B', () => {
      assert.equal(scan('lib/x.js', "const d = path.join(CLIPS_DIR, 'x');\nfs.readdirSync(d);\n").length, 0);
      assert.equal(scan('lib/x.js', "const d = path.join(root, '.ring');\nfs.rmSync(d);\n").length, 1);
    });

    test('the markers must be on the line or the one above, not anywhere in the file', () => {
      assert.equal(scan('lib/x.js', "// app-only: a folder only the app enters\nconst a = 1;\nconst b = CLIPS_DIR;\nfs.rmSync(a);\n").length, 1);
    });
  });
});
