// #549: ONE startup line showing the file-creation mask this process actually runs with, and the database file's
// mode. entrypoint.sh logs what it SET; only the app can show the mask REACHED it, and so the FFmpeg and MediaMTX
// processes it starts (a umask is inherited by every child). After an upgrade, `docker logs` (on staging,
// `hx.sh logs`) shows both lines; docs/operations.md, "Who can read the data directory", says what they should read.
//
//   [data-dir] app umask 077; babymonitor.db mode 600
//
// Read-only and never throws: a log line must not be able to stop the server starting.
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

// The mask is read from /proc/self/status (Linux 4.7+, every Docker host) and NOT from `process.umask()`. Called
// without an argument, process.umask() SETS the mask to 0 and back again (Node's DEP0139): for that instant any file a
// libuv worker thread creates would be world-writable, which is the opposite of what this change is for. Anywhere
// /proc is missing (a bare `node src/index.js` on macOS or Windows) the line says `unknown` instead.
export function parseUmask(procStatus) {
  const m = /^Umask:\s*([0-7]{1,4})\s*$/m.exec(typeof procStatus === 'string' ? procStatus : '');
  return m ? parseInt(m[1], 8) : null;
}

// Three octal digits, as `stat -c %a` and the entrypoint's own line print them, so the two lines read the same.
const octal = (n) => (n & 0o777).toString(8).padStart(3, '0');

export function formatDataDirModes({ umask, dbMode }) {
  return (
    `[data-dir] app umask ${umask == null ? 'unknown' : octal(umask)}; ` +
    `babymonitor.db mode ${dbMode == null ? 'unknown' : octal(dbMode)}`
  );
}

export function logDataDirModes(dataDir, {
  readStatus = () => fs.readFileSync('/proc/self/status', 'utf8'),
  stat = fs.statSync,
  log = (line) => logger.info(line),
} = {}) {
  let umask = null;
  try { umask = parseUmask(readStatus()); } catch { /* no /proc: reported as unknown */ }
  let dbMode = null;
  try { dbMode = stat(path.join(dataDir, 'babymonitor.db')).mode; } catch { /* reported as unknown */ }
  log(formatDataDirModes({ umask, dbMode }));
}
