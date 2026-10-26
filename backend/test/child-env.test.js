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

// On Windows, libuv copies these names from the parent into ANY custom environment it is handed (uv_spawn's
// "required variables": without SYSTEMROOT and friends many Windows programs cannot start), so a child there
// always reports them. They are the OS's, not ours, and the Linux image never sees them (#553 review: test 1
// could not pass on win32). Exactly these names are dropped, and only on win32, instead of skipping the test:
// scripts/mutate.mjs runs on win32 too, and a test that always failed there would count every #553 mutant
// as killed.
const WIN32_LIBUV_FORCED = new Set([
  'HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR',
]);
function withoutOsForced(seen) {
  if (process.platform !== 'win32') return seen;
  // Windows variable names are case-insensitive, so compare upper-cased.
  return Object.fromEntries(Object.entries(seen).filter(([k]) => !WIN32_LIBUV_FORCED.has(k.toUpperCase())));
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
  // The entrypoint's reason for isolation being off (the About page's warning); the allowlist must keep both out of
  // every child, the same as MEDIA_ISOLATION itself.
  MEDIA_ISOLATION: 'off',
  MEDIA_ISOLATION_REASON: 'fallback',
  MEDIA_ISOLATION_CAUSE: 'probe-failed',
};

describe('a spawned child receives exactly the allowlist (#553)', () => {
  test('its whole environment is the allowlisted names that are set, and nothing else', async () => {
    await withParentEnv({ ...SECRETS, TZ: 'Europe/Paris', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' }, async () => {
      const seen = withoutOsForced(await runAndReadEnv({}));
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

  // "Unset in the parent stays unset in the child" is NOT tested here through a real child: spawn() itself
  // drops an undefined env value, so such a test passes with or without childEnv()'s guard (#553 review). The
  // guard is pinned as data instead, in "a name with no value produces no key at all" below.

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
    // MTXFOO and a bare MTX: the underscore is part of the prefix (MediaMTX reads MTX_<KEY>), so a name that
    // merely starts with the three letters is not an override and must not reach MediaMTX (#553 review).
    const parent = { PATH: '/bin', MTX_A: '1', mtx_b: '2', XMTX_C: '3', MTXFOO: '4', MTX: '5', JWT_SECRET: 's' };
    assert.deepEqual(childEnv({ parent }), { PATH: '/bin' });
    assert.deepEqual(childEnv({ parent, mediamtx: true }), { PATH: '/bin', MTX_A: '1' });
  });

  test('a name with no value produces no key at all, not an undefined one (allowlist and MTX_* alike)', () => {
    // Only a data-level check can see this: spawn() drops undefined env values, so a real child looks the same
    // with or without the guard. A plain object, because process.env cannot hold undefined (assigning it
    // stores the string "undefined"); `parent` is a parameter, so the guard is the helper's contract.
    const parent = { PATH: '/bin', TZ: undefined, LANG: undefined, MTX_UNSET: undefined, MTX_SET: '1' };
    const env = childEnv({ parent, mediamtx: true });
    assert.deepEqual(Object.keys(env).sort(), ['MTX_SET', 'PATH']);
    assert.equal('TZ' in env, false);
    assert.equal('MTX_UNSET' in env, false);
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
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const code = (f) => strip(fs.readFileSync(f, 'utf8'));
  const rel = (f) => path.relative(SRC, f).replaceAll('\\', '/');
  // The module specifier as a string in ANY quote style, so one pattern covers a static import, import() with
  // a template literal (the case the first version missed, #553 review), require() and createRequire()(),
  // and with them every alias (`import { spawn as run }`, `const cp = ...; cp.spawn()`): an alias cannot be
  // reached without naming the module. NOT caught: a specifier built at run time ('child_' + 'process') and
  // process.binding(); nothing in src does either, and a reviewer has to catch one that tries.
  const IMPORTS_CHILD_PROCESS = /[`'"](?:node:)?child_process[`'"]/;
  // db.exec( is node:sqlite; .exec( on a regex is a method call and is excluded by the lookbehind.
  const CALLS_SPAWN = /(?<![\w.$])(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\(/;

  test('the detectors fire on every import shape and on a direct call, and not on prose (fixtures)', () => {
    // A detector that has only ever seen a clean tree has not been shown to detect anything.
    const imports = [
      "import { spawn } from 'child_process';",
      'import { spawn as run } from "node:child_process";\nrun("ffmpeg", []);',
      'const { execFile } = await import(`node:child_process`);',
      'const cp = await import(`child_process`);\ncp.spawn("ffmpeg", []);',
      "const cp = require('child_process');",
      'const cp = createRequire(import.meta.url)(`node:child_process`);',
    ];
    for (const src of imports) assert.ok(IMPORTS_CHILD_PROCESS.test(strip(src)), `not flagged as an import: ${src}`);
    const notImports = [
      '// this used to import child_process directly',
      '/* `node:child_process` is imported by childEnv.js only */',
      "const label = 'child_process_count';",
      "import { spawnChild } from './childEnv.js';",
    ];
    for (const src of notImports) assert.equal(IMPORTS_CHILD_PROCESS.test(strip(src)), false, `flagged as an import: ${src}`);
    for (const src of ['spawn("ffmpeg", [])', 'x = execFileSync("ffprobe")', 'fork("./worker.js")']) {
      assert.ok(CALLS_SPAWN.test(strip(src)), `not flagged as a call: ${src}`);
    }
    for (const src of ['db.exec("VACUUM")', 're.exec(line)', 'spawnChild("ffmpeg", [])', '// spawn("ffmpeg")']) {
      assert.equal(CALLS_SPAWN.test(strip(src)), false, `flagged as a call: ${src}`);
    }
  });

  test('only childEnv.js imports child_process', () => {
    const offenders = walk(SRC).filter((f) => rel(f) !== 'lib/childEnv.js' && IMPORTS_CHILD_PROCESS.test(code(f)));
    assert.deepEqual(offenders.map(rel), []);
    // ...and the walk really reaches the helper, so an empty offender list is not an empty walk.
    assert.ok(walk(SRC).some((f) => rel(f) === 'lib/childEnv.js' && IMPORTS_CHILD_PROCESS.test(code(f))));
  });

  test('no file calls spawn/exec/execFile/fork (sync or not) directly', () => {
    const offenders = walk(SRC).filter((f) => rel(f) !== 'lib/childEnv.js' && CALLS_SPAWN.test(code(f)));
    assert.deepEqual(offenders.map(rel), []);
  });

  test('each known spawn site calls spawnChild the expected number of times, and MediaMTX asks for MTX_*', () => {
    const expected = {
      // timelapse.js is not listed: since #781 it runs ffmpeg through clipRecorder.js's runFfmpeg (the call counted below).
      'lib/soundDetector.js': 1, 'lib/transcoder.js': 1, 'lib/clipRecorder.js': 2,
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
