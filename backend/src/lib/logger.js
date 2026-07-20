// Writes to stdout/stderr (captured by `docker logs`) rather than a file in the data
// volume - simpler to access day-to-day, and Docker's own log rotation (configured at
// the container level - see docker-compose.yml / the Unraid template's extra
// parameters) keeps it from growing unbounded.
//
// Timestamps use local time (respecting the container's TZ setting) rather than
// toISOString()'s always-UTC output, specifically to match MediaMTX's own log
// timestamps, which are already local - having both logs agree makes it far easier to
// correlate "something happened around 11pm" against what you actually remember
// happening, rather than mentally converting UTC each time.
function timestamp() {
  const d = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function write(stream, level, args) {
  const line = `${timestamp()} [${level}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  stream(line);
}

export const logger = {
  info: (...args) => write(console.log, 'INFO', args),
  error: (...args) => write(console.error, 'ERROR', args),
};
