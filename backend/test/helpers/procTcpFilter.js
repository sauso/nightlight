import fs from 'node:fs';

// #971 (Opus review of PR #973, reproduced in a container): the tests that read the REAL /proc/net/tcp assumed an
// empty network namespace. CI's `unit` job runs on a VM, in parallel with other test files, so the runner's own
// listeners counted as foreign and the correct build failed. This keeps socket OWNERSHIP real (the real /proc/<pid>/fd
// is still read) and trims only the listener TABLE to the rows a test opened on purpose, so the assertion is about
// those sockets and nothing else on the machine.
export function onlyListenerPorts(getPorts, real = fs.readFileSync) {
  return (file, encoding) => {
    const text = real(file, encoding);
    if (file !== '/proc/net/tcp' && file !== '/proc/net/tcp6') return text;
    const keep = new Set(getPorts());
    const [header, ...rows] = String(text).split('\n');
    const wanted = rows.filter((row) => keep.has(parseInt(row.trim().split(/\s+/)[1]?.split(':')[1], 16)));
    return [header, ...wanted].join('\n');
  };
}
