// The Node version the project supports is stated in five places, and they must agree (issue #565).
//
// Before this, nothing stated it: CI ran Node 24, `engines` and `.nvmrc` did not exist, and a contributor on
// Node 22 got a red backend suite with no hint why. Stating it once is not enough, because the image, CI and
// the two package files each move on their own: a Dockerfile bumped to 26 with CI left on 24 would still
// build and still pass, and the "supported version" would quietly mean two things.
//
// ⚠️ Reads the real files, no fixture: the claim is about THIS repository's configuration. `.nvmrc` is the
// reference and the others are compared against it, so a bump is one edit plus the places this names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const nvmrc = /^(\d+)\s*$/.exec(read('.nvmrc'));
const major = nvmrc ? Number(nvmrc[1]) : NaN;

test('.nvmrc is a bare major version', () => {
  assert.ok(nvmrc, `.nvmrc must be just a major version number, got ${JSON.stringify(read('.nvmrc'))}`);
});

test('both package.json files require that major or newer', () => {
  for (const pkg of ['backend/package.json', 'frontend/package.json']) {
    const range = JSON.parse(read(pkg)).engines?.node;
    assert.equal(range, `>=${major}`, `${pkg} engines.node is ${JSON.stringify(range)}, .nvmrc says ${major}`);
  }
});

test('every Dockerfile stage runs that major', () => {
  const stages = [...read('Dockerfile').matchAll(/^FROM node:(\d+)[\w.-]*/gm)].map((m) => Number(m[1]));
  // Not vacuous: the image has three node stages today. A rewrite that stops using `FROM node:` must update this.
  assert.ok(stages.length >= 1, 'no `FROM node:<major>` line found in the Dockerfile');
  for (const s of stages) assert.equal(s, major, `a Dockerfile stage runs Node ${s}, .nvmrc says ${major}`);
});

test('every workflow that sets up Node uses that major', () => {
  const dir = path.join(REPO, '.github', 'workflows');
  const found = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/node-version:\s*['"]?(\d+)/g)) found.push([f, Number(m[1])]);
  }
  assert.ok(found.length >= 1, 'no `node-version:` found in any workflow');
  for (const [f, v] of found) assert.equal(v, major, `${f} sets up Node ${v}, .nvmrc says ${major}`);
});

// WHY A RUNNING-VERSION CHECK TOO (issue #565, the "cause unexplained" half). The five places above say what
// the project SUPPORTS; nothing said what the suite is RUN on, so a contributor on Node 22 saw 16 files
// fail with errors that read as unrelated bugs. Measured on Node 22.22 against 24.21 (2026-10-13): 18
// failures in 16 files on 22 (15 whole files plus 3 sleepInsights tests), none on 24. One cause: the tests replace modules with `mock.module(name, { exports })`,
// and 22 only understands the older `defaultExport` / `namedExports` options, so it silently builds a mock
// with NO named exports and `import { spawn } from 'child_process'` fails to link. Probed directly below
// rather than inferred from the version number, so the day Node 22 gains `exports` this stops failing for
// the right reason, and a bump of .nvmrc is not what makes it green.
test('the Node running this suite honours mock.module({ exports }), which many test files rely on', () => {
  const probe = [
    "import { mock } from 'node:test';",
    "mock.module('node:child_process', { exports: { spawn: () => 'mocked' } });",
    "const m = await import('node:child_process');",
    "console.log(typeof m.spawn === 'function' && m.spawn() === 'mocked' ? 'honoured' : 'ignored');",
  ].join('\n');
  // A child, not this process: mock.module needs the flag, and an already-imported module cannot be mocked.
  const r = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', probe], { encoding: 'utf8' });
  assert.equal(
    r.stdout.trim(),
    'honoured',
    `Node ${process.versions.node} ignores the "exports" option of mock.module, so every test that mocks a module ` +
      `(16 files on 22.22) fails to link with "does not provide an export named ...". The project needs Node ${major} ` +
      `(.nvmrc): run \`nvm use\`, or in a sandbox without nvm \`. scripts/use-node.sh\`. stderr: ${r.stderr.slice(-300)}`
  );
});

test('the running Node is at least the pinned major', () => {
  const running = Number(process.versions.node.split('.')[0]);
  assert.ok(running >= major, `running Node ${process.versions.node}, but .nvmrc / engines say ${major}: run \`nvm use\`, or in a sandbox without nvm \`. scripts/use-node.sh\``);
});
