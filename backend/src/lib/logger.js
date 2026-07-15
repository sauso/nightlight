import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const LOG_FILE = path.join(DATA_DIR, 'app.log');
const MAX_BYTES = 5 * 1024 * 1024; // 5MB before rotating

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > MAX_BYTES) {
      fs.renameSync(LOG_FILE, `${LOG_FILE}.old`);
    }
  } catch {
    // File doesn't exist yet — nothing to rotate.
  }
}

function write(level, args) {
  rotateIfNeeded();
  const line = `${new Date().toISOString()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

// Writes to a file in the data volume instead of stdout, so normal operation doesn't
// consume Docker's own (much more space-constrained) log storage. Kept to one rotated
// backup file, capped at 5MB each — plenty for a home server, self-cleaning over time.
export const logger = {
  info: (...args) => write('INFO', args),
  error: (...args) => write('ERROR', args),
};
