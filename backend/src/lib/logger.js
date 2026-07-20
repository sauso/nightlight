// Writes to stdout/stderr (captured by `docker logs`) rather than a file in the data
// volume - simpler to access day-to-day, and Docker's own log rotation (configured at
// the container level - see docker-compose.yml / the Unraid template's extra
// parameters) keeps it from growing unbounded.
//
// Also keeps a small in-memory ring buffer of recent lines for the in-app log viewer
// (Settings page) - deliberately memory-only and capped, not persisted, so it can't
// reintroduce the disk-growth problem the file-based approach had. This means it
// resets on every restart - a "what's happened recently" view, not a permanent
// history (docker logs / your own log aggregation is still the right tool for that).
//
// Timestamps use local time (respecting the container's TZ setting) rather than
// toISOString()'s always-UTC output, specifically to match MediaMTX's own log
// timestamps, which are already local - having both logs agree makes it far easier to
// correlate "something happened around 11pm" against what you actually remember
// happening, rather than mentally converting UTC each time.
const MAX_BUFFERED_LINES = 1000;
const buffer = [];

function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function pushToBuffer(line) {
  buffer.push(line);
  if (buffer.length > MAX_BUFFERED_LINES) buffer.shift();
}

function write(stream, level, args) {
  const line = `${timestamp()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  stream(line);
  pushToBuffer(line);
}

export const logger = {
  info: (...args) => write(console.log, 'INFO', args),
  error: (...args) => write(console.error, 'ERROR', args),
  // For forwarding already-formatted output from child processes (MediaMTX, FFmpeg) -
  // these come with their own embedded timestamp/level, so pass through as-is with
  // just a source tag rather than re-wrapping in our own format.
  raw: (source, line) => {
    const tagged = `[${source}] ${line}`;
    console.log(tagged);
    pushToBuffer(tagged);
  },
  getRecent: () => [...buffer],
};
