import fs from 'node:fs';
import path from 'node:path';
import { CLIPS_DIR } from './clipsDir.js';
import { mediaIsolationOn, MEDIA_GID } from './childEnv.js';

// #553 phase 2b: WHO MAY WRITE WHERE under the clips folder, when media isolation is on. mediaFiles.js is the other half:
// it decides what the app will read or serve back out of what the media user wrote.
//
// THE RULE: a folder the app writes into is never one the media user can write into, and the media user can never
// rename a folder the app trusts. So the clips folder holds three kinds of folder:
//   * TRAVERSE folders (CLIPS_DIR, .ring, timelapse, .concat, .timelapse-frames and the folders below it): owned by the
//     app, group = the media group, mode 0750. The media user can enter and list them, nothing more: it cannot create,
//     rename or delete anything in them, so it cannot replace a folder the app trusts, and cannot plant a link next to one.
//   * LEAF folders (.ring/<camera>, <camera>, timelapse/<child>): the ONLY places the media user may write. Owned
//     by the APP (not the media user), group = the media group, mode 1770. App-owned so the app can always remove
//     anything in them (the sticky bit stops the media user deleting or replacing the APP's files, and stops it renaming
//     what it has not made); the group write bit is how ffmpeg writes. Its own files come out 0660 group-media (umask
//     007 in media-exec.sh, primary group 1700), which the app reads as a member of that group.
//   * INPUT files (the concat lists, the timelapse frames): files the media user must READ but must never change,
//     so they live in traverse folders, mode 0640 group-media, created with O_EXCL.
// NO SETGID BITS anywhere (#553 plan, revision 4): the owner's Unraid kernel drops a setgid bit that a chmod sets
// without CAP_FSETID (measured: a 3770 came out 1770), and shfs does not inherit a group either (a new folder got
// group 100). So nothing relies on inheritance: the media process has the media group as its PRIMARY group, and the
// app sets the group on everything it makes with a chown on the open descriptor.
//
// EXISTING FOLDERS ARE REPAIRED ON FIRST USE. Folders made before isolation was on are 0700 app-only. Every function
// below that makes or uses a folder also brings an existing one to the right owner-group and mode, through a
// descriptor opened with O_NOFOLLOW|O_DIRECTORY (so a path swapped for a link cannot redirect the chmod), and refuses
// a folder the app does not own (a chmod would fail, and one it does not own is not one it should hand to the group).
// Files made before are NOT touched, with one exception (shareInputFile): they are app-owned 0600 and only the app
// reads them.
//
// WITH ISOLATION OFF nothing here changes a mode or a group: the folders are made as plain mkdir did.
//
// The unit tests (backend/test/media-layout.test.js) check the real modes on a real filesystem; the end-to-end
// proof as the media user is e2e/media-isolation.sh.

export const TRAVERSE_MODE = 0o750;
export const LEAF_MODE = 0o1770;
export const INPUT_MODE = 0o640;
// App-only (the media user cannot even enter): the clips folder's own scratch, such as the writability probe.
export const APP_ONLY_MODE = 0o700;

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const O_DIRECTORY = fs.constants.O_DIRECTORY ?? 0;

const isolated = () => mediaIsolationOn();

function mkdirIfMissing(dir) {
  try {
    fs.mkdirSync(dir);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

// Bring an open file or folder to group = media, and `mode`, by DESCRIPTOR. Skips a call that would change nothing.
function fixOpen(fd, abs, mode) {
  const st = fs.fstatSync(fd);
  // The app must own it: it cannot chmod another user's folder anyway, and a folder some other uid owns is not one to
  // open to the media group. geteuid is absent on Windows (a dev machine, where isolation is never on).
  const me = typeof process.geteuid === 'function' ? process.geteuid() : st.uid;
  if (st.uid !== me) {
    throw Object.assign(new Error(`${abs} is owned by uid ${st.uid}, not the app (${me}); it cannot be made shareable with the media user`), { code: 'EMEDIAOWNER' });
  }
  if (st.gid !== MEDIA_GID) fs.fchownSync(fd, st.uid, MEDIA_GID);
  if ((st.mode & 0o7777) !== mode) fs.fchmodSync(fd, mode);
}

function fixDir(abs, mode) {
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error(`${abs} is not a folder`), { code: 'ENOTDIR' });
    fixOpen(fd, abs, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Make (or repair) the folder CLIPS_DIR/<parts...>. Every folder on the way is a traverse folder; the last one is a
 * LEAF (media-writable) when `leaf` is true. Returns its absolute path. CLIPS_DIR itself is left to the start-up script
 * (it may be an external mount); it is only created here if it is missing. With isolation off this is `mkdir -p`.
 */
export function ensureClipsFolder(parts, { leaf = false } = {}) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
  let dir = CLIPS_DIR;
  parts.forEach((part, i) => {
    dir = path.join(dir, part);
    mkdirIfMissing(dir);
    if (isolated()) fixDir(dir, leaf && i === parts.length - 1 ? LEAF_MODE : TRAVERSE_MODE);
  });
  return dir;
}

/** CLIPS_DIR/<name>, 0700 and app-only (isolation or not), for the app's own scratch inside the clips volume. */
export function ensureAppOnlyFolder(name) {
  const dir = path.join(CLIPS_DIR, name);
  fs.mkdirSync(dir, { recursive: true, mode: APP_ONLY_MODE });
  // Windows (a dev machine only) has no POSIX modes: fchmod on a folder there is EPERM, and the folder is the user's own.
  if (process.platform === 'win32') return dir;
  // The umask cuts a mkdir mode (UMASK=022 would give 0755), so say it again, on the open folder.
  const fd = fs.openSync(dir, fs.constants.O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  try {
    if ((fs.fstatSync(fd).mode & 0o777) !== APP_ONLY_MODE) fs.fchmodSync(fd, APP_ONLY_MODE);
  } finally {
    fs.closeSync(fd);
  }
  return dir;
}

/**
 * Write a file the media user must READ and never change (a concat list): created new (an old one of the same name is
 * removed first; the folder is the app's alone, so nothing can be racing it), O_EXCL, never through a link. With
 * isolation on it is 0640, group = media, set on the open descriptor before any content is written: a mode
 * requested at creation is cut by the umask (077 gives 0600, which the media user could not read).
 */
export function writeInputFile(abs, data) {
  try {
    fs.unlinkSync(abs);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (!isolated()) {
    fs.writeFileSync(abs, data, { flag: 'wx' });
    return;
  }
  const fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, INPUT_MODE);
  try {
    fixOpen(fd, abs, INPUT_MODE);
    fs.writeFileSync(fd, data);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Let the media user READ an existing app-written file (a timelapse frame saved before isolation was on, which is
 * 0600). Isolation on only; a no-op otherwise. Opens without following a link and requires a regular file.
 */
export function shareInputFile(abs) {
  if (!isolated()) return;
  const fd = fs.openSync(abs, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error(`${abs} is not a regular file`), { code: 'EISDIR' });
    fixOpen(fd, abs, INPUT_MODE);
  } finally {
    fs.closeSync(fd);
  }
}
