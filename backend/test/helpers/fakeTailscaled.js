#!/usr/bin/env node
// A real child for #965 supervisor tests. It reads test controls only from argv, not environment.
import fs from 'node:fs';
import path from 'node:path';

const value = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const markerDir = value('marker-dir');
if (!markerDir) process.exit(2);
fs.mkdirSync(markerDir, { recursive: true });
const marker = path.join(markerDir, `pid-${process.pid}`);
const save = (name, data) => fs.writeFileSync(path.join(markerDir, `${name}-${process.pid}.json`), JSON.stringify(data));
fs.writeFileSync(marker, String(process.pid));
save('argv', process.argv.slice(2));
const mode = value('mode') ?? 'stay';
if (mode === 'dump-env') save('env', process.env);
if (mode === 'list-fds' && process.platform === 'linux') {
  save('fds', fs.readdirSync('/proc/self/fd').map(Number).filter((n) => Number.isInteger(n)));
}
if (mode.startsWith('write-state=')) {
  const state = value('state');
  const fileMode = Number.parseInt(mode.slice('write-state='.length), 8);
  fs.writeFileSync(state, 'fake state', { mode: fileMode });
  fs.chmodSync(state, fileMode); // Hostile to a guard that relies on the parent's umask.
}
if (mode.startsWith('print-lines=')) {
  for (const line of JSON.parse(mode.slice('print-lines='.length))) console.log(line);
}
if (mode === 'print-hostile') console.log('a.'.repeat(32768));
if (mode.startsWith('exit=')) process.exit(Number(mode.slice('exit='.length)));
if (mode.startsWith('crash-after=')) setTimeout(() => process.exit(1), Number(mode.slice('crash-after='.length)));
if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {});
  // Opus plan review of #967: stop tests need proof the handler is installed
  // before sending SIGTERM; the PID marker is written earlier in startup.
  fs.writeFileSync(path.join(markerDir, `ready-${process.pid}`), 'ready');
}
setInterval(() => {}, 1000);
