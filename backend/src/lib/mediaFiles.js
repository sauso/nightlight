import fs from 'node:fs';
import path from 'node:path';
import { CLIPS_DIR } from './clipsDir.js';
import { logger } from './logger.js';

// #553 phase 2b: the ONE module that reads, serves or deletes a file a MEDIA PROCESS wrote.
//
// WHY. With media isolation on, ffmpeg and MediaMTX run as another Unix user and write the ring segments, clips,
// thumbnails and timelapse videos into folders that user can write (mediaLayout.js). Whatever that user can plant
// there, the app then meets with the app's own, wider privileges. So everything the app does with such a file goes
// through here, and the rule is: the app only touches an entry it has just looked at, and only if it is what it
// should be.
//   * A SYMBOLIC LINK named like a clip could point at the database: sendFile would serve it, and a flat unlink is
//     safe but an open for writing is not. Refused by opening with O_NOFOLLOW.
//   * A HARD LINK to the database or a secret is NOT stopped by a symlink check. The Linux hardening that would stop
//     the media user making one (fs.protected_hardlinks) is OFF on some hosts, including the owner's Unraid, where the
//     media user could link the database into its folder (link count 2, measured). So a file is served only with
//     nlink === 1. A real clip, thumbnail or segment never has another name.
//   * A FIFO (named pipe) planted under a clip's name would hang a plain open() until a writer appears, and the
//     request with it. O_NONBLOCK makes the open return at once; the fstat then says it is not a regular file.
//   * A FOLDER swapped for a link to somewhere else: the real path of the file's parent must be exactly the folder it
//     is expected to be in, with no link anywhere on the way.
//   * A file name is untrusted text: segment names go into a concat list that ffmpeg reads with `-safe 0`, where a
//     newline or a quote would add directives of the attacker's choosing (safeSegmentNames).
// The checks are cheap and harmless with isolation off, so the code path is the same either way (nobody has to
// remember which mode they are in). The tests that prove each refusal are in backend/test/media-files.test.js.

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0; // undefined on Windows (a dev machine only): the checks below still apply
const O_NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

// Refusals worth a log line are logged once per path, and the set is capped: the names are the media process's to
// choose, so an unbounded set would be a way to make the app use memory.
const WARNED_MAX = 200;
const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key) || warned.size >= WARNED_MAX) return;
  warned.add(key);
  logger.warn(message);
}
const shown = (s) => JSON.stringify(String(s).slice(0, 120));

// The path of `abs` below `root`, or null when it is not strictly below it (or when a segment is a dotfile folder
// such as .ring or .concat: the old res.sendFile({dotfiles: 'deny'}) refused those, so a stored path that names one
// still cannot be served).
function relativeBelow(abs, root) {
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

// The real path of the file's parent must be the expected folder: the real path of the root joined with the
// file's own relative parent. realpath resolves EVERY component, so a link anywhere on the way (the root's own
// being the owner's arrangement and handled by realpathing the root too) makes the two differ.
// Answers 'ok', 'missing' (the parent, or the root, is not there: nothing to open or remove) or 'mismatch' (a link on
// the way, or a path outside the root: refused, and worth saying so).
function checkParent(abs, root) {
  const rel = relativeBelow(abs, root);
  if (!rel) return 'mismatch';
  let realRoot;
  let realParent;
  try {
    realRoot = fs.realpathSync(root);
    realParent = fs.realpathSync(path.dirname(abs));
  } catch {
    return 'missing';
  }
  if (realParent === path.join(realRoot, path.dirname(rel))) return 'ok';
  warnOnce(`parent:${abs}`, `[media-files] refusing ${shown(abs)}: its folder is not where it should be (a link on the way?)`);
  return 'mismatch';
}

/**
 * Open a media-written file for reading, or null. Returns { fd, size, mtime } (mtime a Date); the CALLER closes fd.
 * Null when: the parent chain is not exactly the expected folders, the entry is a link, is not a regular file, has
 * more than one name, or cannot be opened (missing included). Never throws, and never blocks (FIFO).
 */
export function openMediaFile(abs, { root = CLIPS_DIR } = {}) {
  const rel = relativeBelow(abs, root);
  if (!rel || rel.split(path.sep).some((seg) => seg.startsWith('.'))) return null;
  if (checkParent(abs, root) !== 'ok') return null;
  let fd;
  try {
    fd = fs.openSync(abs, fs.constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (e) {
    if (e.code === 'ELOOP') warnOnce(`link:${abs}`, `[media-files] refusing ${shown(abs)}: it is a symbolic link`);
    return null;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      warnOnce(`type:${abs}`, `[media-files] refusing ${shown(abs)}: it is not a regular file`);
    } else if (st.nlink !== 1) {
      warnOnce(`nlink:${abs}`, `[media-files] refusing ${shown(abs)}: it has ${st.nlink} names (a hard link?)`);
    } else {
      return { fd, size: st.size, mtime: st.mtime };
    }
  } catch { /* fstat failed: treat as not openable */ }
  try { fs.closeSync(fd); } catch { /* already closed */ }
  return null;
}

/**
 * The stored path `relPath` (relative to the clips folder, from a database column) as an absolute path strictly below
 * `root`, or null. A stored path is not trusted: a database can be restored, edited or seeded.
 */
export function resolveUnder(relPath, root = CLIPS_DIR) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const abs = path.resolve(root, relPath);
  return relativeBelow(abs, root) ? abs : null;
}

/**
 * A { root, path } for a stored clip path whose file exists as a plain one-name file, or null: what the lookups
 * behind the clip, recording and timelapse routes return (the route then serves it with serveMediaFile).
 */
export function jailedMediaFile(relPath, root = CLIPS_DIR) {
  const abs = resolveUnder(relPath, root);
  if (!abs || !statMediaFile(abs)) return null;
  return { root, path: path.relative(root, abs) };
}

/**
 * { size, mtimeMs } of a media-written regular file with exactly one name, or null. lstat, so a symbolic link is
 * not followed and its target is never counted (a link to a big file must not inflate a size, nor a link to a
 * secret be measured). For metadata only (existence, size, age); to READ or SERVE a file use openMediaFile.
 */
export function statMediaFile(abs) {
  try {
    const st = fs.lstatSync(abs);
    if (!st.isFile() || st.nlink !== 1) return null;
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Delete ONE media-written entry by its path: a flat unlink, never recursive, never following a link (an unlink
 * removes the link itself). Returns true if it removed something, false if it was already gone (or its folder is).
 * THROWS when the path is outside `root` or a link is on the way to it (code EMEDIAJAIL, nothing touched), and on any
 * other failure (permission, I/O), so a caller that must know (the purge) stops, and one that does not wraps it.
 */
export function unlinkMediaFile(abs, { root = CLIPS_DIR } = {}) {
  const parent = checkParent(abs, root);
  if (parent === 'missing') return false;
  // THROWS, not false: a purge that reads "false" as "already gone" would delete the row while the file stays.
  if (parent !== 'ok') throw Object.assign(new Error(`refusing to remove ${shown(abs)}: its folder is not where it should be`), { code: 'EMEDIAJAIL' });
  try {
    fs.unlinkSync(abs);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false;
    throw e;
  }
}

/**
 * Remove a media-writable FOLDER (a leaf such as .ring/<camera> or <camera>) and what is in it, FLAT: each file
 * unlinked, each empty sub-folder removed, then the folder. Deliberately not rmSync({recursive}): a recursive walk
 * of a folder another user can write into can be raced (a folder swapped for a link between the check and the
 * descent) into deleting something elsewhere. A sub-folder that is not empty makes this throw (ENOTEMPTY) and the
 * caller stops; nothing the app puts in a leaf is a folder, so that only ever means something foreign.
 * Throws ENOENT if the folder is not there; the caller decides what that means.
 */
export function removeLeafDir(dir) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isDirectory()) fs.rmdirSync(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

// The segmenter's own file names (clipRecorder.js segmenterArgs: `seg-%Y%m%d-%H%M%S.mkv`). Anything else in a ring
// folder was not written by it.
export const SEGMENT_NAME_RE = /^seg-\d{8}-\d{6}\.mkv$/;

/**
 * Keep only the names the segmenter writes. The rest is ignored (and logged once): a segment list becomes a concat
 * list that ffmpeg reads with `-safe 0` (absolute paths allowed), so a name with a newline or a quote in it could
 * add `file '/...'` directives of the media process's choosing, and any other name is simply not footage.
 */
export function safeSegmentNames(entries) {
  const out = [];
  for (const name of entries) {
    if (typeof name === 'string' && SEGMENT_NAME_RE.test(name)) out.push(name);
    else warnOnce(`seg:${name}`, `[media-files] ignoring ${shown(name)} in a ring folder: it is not a segment name`);
  }
  return out;
}

// --- serving ---------------------------------------------------------------------------------------------------

// What Express's res.sendFile answered for these, so a browser sees no difference.
const CONTENT_TYPES = { '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

const httpDate = (s) => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
};

// Same rules as the `fresh` package res.sendFile uses (no-cache, If-None-Match as a list with weak comparison,
// If-Modified-Since), for a 200 that would otherwise be sent.
function requestIsFresh(headers, etag, lastModified) {
  const noneMatch = headers['if-none-match'];
  const modifiedSince = headers['if-modified-since'];
  if (!noneMatch && !modifiedSince) return false;
  const cc = headers['cache-control'];
  if (cc && /(?:^|,)\s*?no-cache\s*?(?:,|$)/.test(cc)) return false;
  if (noneMatch && noneMatch !== '*') {
    const stale = !noneMatch.split(/ *, */).some((m) => m === etag || m === `W/${etag}` || `W/${m}` === etag);
    if (stale) return false;
  }
  if (modifiedSince) {
    const since = httpDate(modifiedSince);
    if (!(httpDate(lastModified) <= since)) return false;
  }
  return true;
}

// The Range header against `size`, by the rules res.sendFile used (the `range-parser` package under `send`, which this mirrors so
// that a browser's <video> seeks exactly as before; backend/test/media-files.test.js compares the two request by request):
//   null           serve the whole file: no Range, not `bytes=`, or several separate ranges (send serves only one)
//   'unsatisfiable' answer 416: a `bytes=` header none of whose ranges can be met (also a malformed one, as send does)
//   { start, end }  answer 206 with these bytes (inclusive)
const BYTES_RANGE_RE = /^ *bytes=/;
function parseRange(header, size) {
  if (!BYTES_RANGE_RE.test(header)) return null;
  const ranges = [];
  for (const part of header.slice(header.indexOf('=') + 1).split(',')) {
    const [a, b] = part.split('-');
    let start = parseInt(a, 10);
    let end = parseInt(b, 10);
    if (Number.isNaN(start)) { start = size - end; end = size - 1; } // -nnn: the last nnn bytes
    else if (Number.isNaN(end)) end = size - 1; // nnn-
    if (end > size - 1) end = size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0) continue; // invalid or unsatisfiable
    ranges.push({ start, end });
  }
  if (ranges.length < 1) return 'unsatisfiable';
  ranges.sort((x, y) => x.start - y.start);
  const merged = [{ ...ranges[0] }];
  for (const r of ranges.slice(1)) {
    const last = merged[merged.length - 1];
    if (r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged.length === 1 ? merged[0] : null;
}

/**
 * Serve a media-written file from the descriptor we validated, with the headers and Range support res.sendFile gave
 * (Accept-Ranges, ETag, Last-Modified, Cache-Control, 206/416, 304, HEAD). The file is opened ONCE, by openMediaFile,
 * and read from that same descriptor: it is never opened again by path, so nothing swapped in after the checks can be
 * what is sent. The descriptor is closed on every path (finished, error, client gone, HEAD, 304, 416).
 * Returns true if it started a response from the file, false after answering 404 (no usable file) itself.
 * Not done, because no browser asks for it: If-Match / If-Unmodified-Since (412) and multi-range replies (the whole file is
 * sent, as send does). A 416 has an EMPTY body (send's has a small HTML error page); nothing reads it.
 */
export function serveMediaFile(req, res, abs, { contentType, root = CLIPS_DIR } = {}) {
  const f = openMediaFile(abs, { root });
  if (!f) {
    res.status(404).json({ error: 'Not found.' });
    return false;
  }
  const close = () => { try { fs.closeSync(f.fd); } catch { /* already closed */ } };
  try {
    const etag = `W/"${f.size.toString(16)}-${f.mtime.getTime().toString(16)}"`;
    const lastModified = f.mtime.toUTCString();
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=0');
    res.setHeader('Last-Modified', lastModified);
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', contentType || CONTENT_TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream');

    if (requestIsFresh(req.headers, etag, lastModified)) {
      res.statusCode = 304;
      for (const h of ['Content-Type', 'Content-Length', 'Content-Encoding']) res.removeHeader(h);
      res.end();
      close();
      return true;
    }

    let start = 0;
    let end = f.size - 1;
    let length = f.size;
    const rangeHeader = req.headers.range;
    if (rangeHeader) {
      // If-Range: a validator that no longer matches means "send the whole thing".
      const ifRange = req.headers['if-range'];
      const rangeStale = ifRange
        ? ifRange.includes('"') ? !ifRange.includes(etag) : !(httpDate(lastModified) <= httpDate(ifRange))
        : false;
      const range = rangeStale ? null : parseRange(rangeHeader, f.size);
      if (range === 'unsatisfiable') {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${f.size}`);
        res.removeHeader('Content-Type');
        res.end();
        close();
        return true;
      }
      if (range) {
        ({ start, end } = range);
        length = end - start + 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${f.size}`);
      }
    }
    res.setHeader('Content-Length', length);

    if (req.method === 'HEAD' || length === 0) {
      res.end();
      close();
      return true;
    }

    // autoClose: the stream closes the descriptor when it ends or is destroyed. A client that goes away destroys it.
    const stream = fs.createReadStream(null, { fd: f.fd, start, end, autoClose: true });
    const stop = () => stream.destroy();
    res.on('close', stop);
    stream.on('error', () => {
      stop();
      res.destroy();
    });
    stream.pipe(res);
    return true;
  } catch (e) {
    close();
    throw e;
  }
}
