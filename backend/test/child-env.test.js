// #553 (a): ffmpeg, ffprobe and MediaMTX are started with an allowlisted environment, never the backend's own.
//
// Three shapes of check, because each one alone can pass while the others are broken:
//   1. a REAL child (node, printing its own environment) shows exactly what a spawned process receives;
//   2. childEnv() pins the allowlist and the MTX_* rule as data;
//   3. a SOURCE test fails when any file under src/ starts a process some other way, or when a known spawn
//      site stops going through the helper. (1) cannot see a spawn site it never calls.
// None of this needs ffmpeg or mediamtx installed. Hardware decode and proxy setups are NOT exercised.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnChild, childEnv, ALLOWED_NAMES } from '../src/lib/childEnv.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PRINT_ENV = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];

function runAndReadEnv(options, extraOpts) {
  return new Promise((resolve, reject) => {
    // process.execPath is absolute, so PATH does not need to resolve it: the test does not depend on PATH.
    const proc = spawnChild(process.execPath, PRINT_ENV, { stdio: ['ignore', 'pipe', 'inherit'], ...options }, extraOpts);
    let out = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', reject);
    proc.on('close', () => resolve(JSON.parse(out)));
  });
}

// Plant a marker in every kind of variable the parent might hold, and put them back afterwards.
function withParentEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  return Promise.resolve(fn()).finally(() => {
    for (const k of Object.keys(vars)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

const SECRETS = {
  JWT_SECRET: 'planted-jwt-secret',
  FIREBASE_CREDENTIALS: '{"private_key":"planted"}',
  DATA_DIR: '/planted/data',
  PUBLIC_HOST: 'planted.example',
  HTTPS_PROXY: 'http://planted-proxy:3128',
  LIBVA_DRIVER_NAME: 'planted',
  HOME: '/planted/home',
  MTX_PLANTED: 'operator-override',
};

describe('a spawned child receives exactly the allowlist (#553)', () => {
  test('its whole environment is the allowlisted names that are set, and nothing else', async () => {
    await withParentEnv({ ...SECRETS, TZ: 'Europe/Paris', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, async () => {
      const seen = await runAndReadEnv({});
      // Under `npm run test:core` the child is a NODE process, and node itself puts NODE_V8_COVERAGE into
      // its own environment before user code runs (found by that gate, #553). It is the runtime's, not ours.
      delete seen.NODE_V8_COVERAGE;
      const expected = {};
      for (const k of ALLOWED_NAMES) if (process.env[k] !== undefined) expected[k] = process.env[k];
      assert.deepEqual(seen, expected);
      assert.equal(seen.TZ, 'Europe/Paris');
      assert.equal(seen.LANG, 'C.UTF-8');
      assert.ok(seen.PATH, 'PATH must reach the child so ffmpeg can find its own helpers');
    });
  });

  test('JWT_SECRET and every other planted secret is absent (ffmpeg/ffprobe get no MTX_* either)', async () => {
    await withParentEnv(SECRETS, async () => {
      const seen = await runAndReadEnv({});
      for (const k of Object.keys(SECRETS)) assert.equal(k in seen, false, `${k} leaked into the child`);
      assert.ok(!JSON.stringify(seen).includes('planted'), 'a planted value is in the child environment');
    });
  });

  test('a variable that is unset in the parent is unset in the child, not the string "undefined"', async () => {
    const savedTz = process.env.TZ;
    delete process.env.TZ;
    try {
      const seen = await runAndReadEnv({});
      assert.equal('TZ' in seen, false);
    } finally {
      if (savedTz !== undefined) process.env.TZ = savedTz;
    }
  });

  test('a caller-supplied options.env cannot bring a variable back in', async () => {
    await withParentEnv(SECRETS, async () => {
      const seen = await runAndReadEnv({ env: { JWT_SECRET: 'via-options', ...process.env } });
      assert.equal('JWT_SECRET' in seen, false);
    });
  });

  test('MediaMTX gets the operator MTX_* overrides and the launch-computed ones, and still no secrets', async () => {
    await withParentEnv({ ...SECRETS, MTX_WEBRTCADDITIONALHOSTS: 'stale' }, async () => {
      const seen = await runAndReadEnv({}, { mediamtx: true, extra: { MTX_WEBRTCADDITIONALHOSTS: '10.0.0.5' } });
      assert.equal(seen.MTX_PLANTED, 'operator-override');
      assert.equal(seen.MTX_WEBRTCADDITIONALHOSTS, '10.0.0.5', 'the computed value must win over an inherited one');
      assert.equal('JWT_SECRET' in seen, false);
      assert.equal('PUBLIC_HOST' in seen, false);
      assert.equal('HTTPS_PROXY' in seen, false);
    });
  });
});

describe('childEnv() as data (#553)', () => {
  test('the allowlist is PATH, TZ, LANG, LC_ALL: adding a name is a decision this test makes you re-read', () => {
    assert.deepEqual([...ALLOWED_NAMES], ['PATH', 'TZ', 'LANG', 'LC_ALL']);
    assert.ok(Object.isFrozen(ALLOWED_NAMES));
  });

  test('MTX_* is matched by prefix, case-sensitively, and only when asked for', () => {
    const parent = { PATH: '/bin', MTX_A: '1', mtx_b: '2', XMTX_C: '3', JWT_SECRET: 's' };
    assert.deepEqual(childEnv({ parent }), { PATH: '/bin' });
    assert.deepEqual(childEnv({ parent, mediamtx: true }), { PATH: '/bin', MTX_A: '1' });
  });

  test('extra wins over the inherited value and is the only way to add a name', () => {
    const parent = { PATH: '/bin', TZ: 'UTC' };
    assert.deepEqual(childEnv({ parent, extra: { TZ: 'X', CUSTOM: 'y' } }), { PATH: '/bin', TZ: 'X', CUSTOM: 'y' });
  });
});

describe('every process the backend starts goes through the helper (#553, source test)', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
  // Strip comments so prose that mentions spawn() is not a hit, and a commented-out call is not a pass.
  const code = (f) => fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const rel = (f) => path.relative(SRC, f).replaceAll('\\', '/');

  test('only childEnv.js imports child_process', () => {
    const offenders = walk(SRC).filter((f) => rel(f) !== 'lib/childEnv.js' && /['"](node:)?child_process['"]/.test(code(f)));
    assert.deepEqual(offenders.map(rel), []);
  });

  test('no file calls spawn/exec/execFile/fork (sync or not) directly', () => {
    const re = /(?<![\w.$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/;
    const offenders = walk(SRC).filter((f) => {
      const src = code(f);
      // db.exec( is node:sqlite; .exec( on a regex is a method call and is excluded by the lookbehind.
      return rel(f) !== 'lib/childEnv.js' && re.test(src);
    });
    assert.deepEqual(offenders.map(rel), []);
  });

  test('each known spawn site calls spawnChild the expected number of times, and MediaMTX asks for MTX_*', () => {
    const expected = {
      'lib/soundDetector.js': 1, 'lib/timelapse.js': 1, 'lib/transcoder.js': 1, 'lib/clipRecorder.js': 2,
      'lib/snapshot.js': 1, 'lib/audioLiveness.js': 2, 'lib/motionDetector.js': 1, 'lib/rtspProbe.js': 4,
      'lib/mediamtxProcess.js': 1,
    };
    for (const [file, n] of Object.entries(expected)) {
      const src = code(path.join(SRC, file));
      assert.equal(src.match(/(?<![\w.$])spawnChild\(/g)?.length ?? 0, n, `${file}: spawnChild call count`);
    }
    assert.match(code(path.join(SRC, 'lib/mediamtxProcess.js')), /spawnChild\('mediamtx'[\s\S]*?\{ mediamtx: true, extra \}\)/);
    for (const file of Object.keys(expected).filter((f) => f !== 'lib/mediamtxProcess.js')) {
      assert.doesNotMatch(code(path.join(SRC, file)), /mediamtx:\s*true/, `${file}: ffmpeg/ffprobe must not receive MTX_*`);
    }
  });
});
