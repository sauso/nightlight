// Native service entry point. Set paths BEFORE importing the backend: its DB,
// auth secret and recording modules read DATA_DIR during module evaluation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function readPort(ini) {
  let section = '';
  let port = 4000;
  for (const raw of ini.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) { section = heading[1].toLowerCase(); continue; }
    const entry = /^Port\s*=\s*(.*?)\s*$/i.exec(line);
    if (section === 'server' && entry) {
      if (!/^\d+$/.test(entry[1]) || Number(entry[1]) < 1 || Number(entry[1]) > 65535) {
        throw new Error('Port in server.ini must be a whole number from 1 to 65535.');
      }
      port = Number(entry[1]);
    }
  }
  return port;
}

export function configureEnvironment({ installDir, dataDir, ini, env = process.env }) {
  if (!path.isAbsolute(installDir) || !path.isAbsolute(dataDir)) throw new Error('Installation and data directories must be absolute.');
  const tempDir = path.join(dataDir, 'tmp');
  fs.mkdirSync(tempDir, { recursive: true });
  Object.assign(env, {
    DATA_DIR: dataDir,
    NODE_ENV: 'production',
    PORT: String(readPort(ini)),
    // Native MediaMTX also advertises the PC's interfaces itself. Explicit
    // loopback keeps the Start menu's localhost URL working without STUN.
    PUBLIC_HOST: '127.0.0.1',
    STUN_SERVERS: '',
    PATH: [path.join(installDir, 'bin'), env.PATH || env.Path || ''].filter(Boolean).join(path.delimiter),
    TEMP: tempDir,
    TMP: tempDir,
  });
  return env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const installDir = path.dirname(fileURLToPath(import.meta.url));
  if (!process.env.ProgramData) throw new Error('Windows ProgramData is not available.');
  const dataDir = path.join(process.env.ProgramData, 'Nightlight');
  const ini = fs.readFileSync(path.join(dataDir, 'server.ini'), 'utf8');
  configureEnvironment({ installDir, dataDir, ini });
  process.chdir(path.join(installDir, 'app'));
  await import('./app/src/index.js');
}
