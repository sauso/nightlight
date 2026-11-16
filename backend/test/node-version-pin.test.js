// The supported Node version is pinned in .nvmrc, both packages and CI (issue #565).
// #751 SOAK: the Docker image may temporarily run the next-major preview version.
//
// Before this, nothing stated it: CI ran Node 24, `engines` and `.nvmrc` did not exist, and a contributor on
// Node 22 got a red backend suite with no hint why. Stating it once is not enough, because the image, CI and
// the two package files each move on their own. During #751, the image has one explicit, whole-image exception.
//
// ⚠️ Reads the real files, no fixture: the claim is about THIS repository's configuration. `.nvmrc` is the
// reference for support; the preview workflow supplies the only allowed image soak major.
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

// #751, Codex plan review 2026-11-16: scan every FROM, including --platform, and retain the
// final-stage check. The old /^FROM node:/ scan missed the Tailscale stage entirely.
export function scanDockerNodeStages(text) {
  return text.split(/\r?\n/).filter((line) => /^\s*FROM\b/i.test(line)).map((line) => {
    const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i.exec(line);
    return { line, image: match?.[1] ?? null, name: match?.[2] ?? null,
      major: match ? Number(/^node:(\d+)(?:[.-]|$)/i.exec(match[1])?.[1]) || null : null };
  });
}

export function assertDockerNodeStages(text, supported, preview) {
  const from = scanDockerNodeStages(text);
  assert.ok(from.length > 0, 'Dockerfile has no FROM lines');
  assert.ok(from.every((s) => s.image), 'every Dockerfile FROM line must be parsed');
  assert.ok(from.at(-1).major !== null, 'Dockerfile final stage must be a Node image');
  const stages = from.filter((s) => s.major !== null);
  assert.equal(stages.length, 4, 'Dockerfile must have exactly four Node stages');
  assert.deepEqual(stages.map((s) => s.name), ['frontend-build', 'backend-deps', 'tailscale-binaries', null],
    'Dockerfile Node stages must remain frontend-build, backend-deps, tailscale-binaries and final runtime');
  const versions = new Set(stages.map((s) => s.major));
  assert.equal(versions.size, 1, `Dockerfile Node stages are mixed: ${[...versions].join(', ')}`);
  assert.ok(versions.has(supported) || versions.has(preview),
    `all four Dockerfile Node stages must use supported Node ${supported} or preview Node ${preview}`);
  return stages[0].major;
}

function previewMajor() {
  const pins = workflowNodeVersions().filter((e) => e.file === PREVIEW_WORKFLOW && e.key === 'node-version');
  const versions = new Set(pins.map((e) => Number(e.raw.replace(/['"]/g, ''))));
  assert.equal(versions.size, 1, `${PREVIEW_WORKFLOW} must pin exactly one preview major`);
  return [...versions][0];
}

test('every Dockerfile Node stage runs either the supported or preview major', () => {
  assertDockerNodeStages(read('Dockerfile'), major, previewMajor());
});

test('Dockerfile scan includes --platform and rejects mixed stages or a non-Node final stage', () => {
  const fixture = `FROM node:24-alpine AS frontend-build\nFROM bluenviron/mediamtx:1 AS mediamtx-binary\nFROM node:24-alpine AS backend-deps\nFROM --platform=$BUILDPLATFORM node:24-alpine AS tailscale-binaries\nFROM node:24-alpine\n`;
  assert.equal(scanDockerNodeStages(fixture)[3].major, 24);
  assert.equal(assertDockerNodeStages(fixture, 24, 26), 24);
  assert.throws(() => assertDockerNodeStages(fixture.replace('node:24-alpine AS tailscale-binaries', 'node:26-alpine AS tailscale-binaries'), 24, 26), /mixed/);
  assert.throws(() => assertDockerNodeStages(fixture.replace(/FROM node:24-alpine\n$/, 'FROM alpine:3.24\n'), 24, 26), /final stage/);
});

test('the preview-major Dockerfile announces the #751 SOAK', () => {
  const dockerfile = read('Dockerfile');
  if (assertDockerNodeStages(dockerfile, major, previewMajor()) === previewMajor()) {
    assert.ok(dockerfile.includes('SOAK') && dockerfile.includes('#751'),
      'preview-major Dockerfile must announce SOAK and #751');
  }
});

// ONE named CI exception (#751 step 1): the preview workflow runs the suites on the NEXT major, beside the supported one,
// so that what breaks on the move is known before anyone makes it. It is a preview, not a gate: it may pin a major
// ABOVE .nvmrc's and no other workflow may. A second exception, or this one pinning the supported major or something older,
// is a mistake and must fail here.
const PREVIEW_WORKFLOW = 'node-next.yml';

// What a workflow's text pins. Two holes the first version of this scan had, found by the review of #884 (the first
// pre-dates #751): a COMMENT such as `# node-version: 26` counted as a pin, so a workflow could set up Node from
// `.nvmrc` and still pass on the strength of its own comment; and a value that is not a bare major (`lts/*`, `26.x`,
// `node-version-file:`) was not matched at all, so it escaped the scan instead of failing it. So: comments are removed
// first, every `node-version` value is returned RAW, and a separate test requires each one to be a bare integer.
export function scanNodeVersions(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const code = line.replace(/(^|\s)#.*$/, ''); // a YAML comment starts at a `#` at the start or after whitespace
    const file = /\bnode-version-file\s*:/.exec(code);
    if (file) out.push({ key: 'node-version-file', raw: code.trim() });
    const m = /\bnode-version\s*:\s*(\S+)/.exec(code);
    if (m) out.push({ key: 'node-version', raw: m[1] });
  }
  return out;
}

function workflowNodeVersions() {
  const dir = path.join(REPO, '.github', 'workflows');
  const found = [];
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    for (const e of scanNodeVersions(fs.readFileSync(path.join(dir, f), 'utf8'))) found.push({ file: f, ...e });
  }
  return found;
}

test('the workflow scan ignores comments and does not let an alias, a range or a version file through', () => {
  assert.deepEqual(scanNodeVersions("# node-version: 26\n      - run: x # node-version: 99\n"), [], 'a comment was read as a pin');
  assert.deepEqual(scanNodeVersions("          node-version: '24'  # the supported major\n"), [{ key: 'node-version', raw: "'24'" }]);
  assert.deepEqual(scanNodeVersions('          node-version: lts/*\n'), [{ key: 'node-version', raw: 'lts/*' }]);
  assert.deepEqual(scanNodeVersions('          node-version: 26.x\n'), [{ key: 'node-version', raw: '26.x' }]);
  assert.equal(scanNodeVersions('          node-version-file: .nvmrc\n')[0].key, 'node-version-file');
});

test('every workflow pins Node by a bare major: no version file, alias or range', () => {
  const found = workflowNodeVersions();
  assert.ok(found.length >= 1, 'no `node-version:` found in any workflow');
  for (const e of found) {
    assert.equal(e.key, 'node-version', `${e.file} uses ${e.raw}: a version file hides which Node CI runs from this test`);
    assert.match(e.raw, /^['"]?\d+['"]?$/, `${e.file} sets node-version ${e.raw}: it must be a bare major (an alias or range cannot be compared with .nvmrc)`);
  }
});

test('every workflow that sets up Node uses that major, except the one next-major preview', () => {
  const found = workflowNodeVersions().map((e) => [e.file, Number(e.raw.replace(/['"]/g, ''))]);
  assert.ok(found.length >= 1, 'no `node-version:` found in any workflow');
  for (const [f, v] of found) {
    if (f === PREVIEW_WORKFLOW) continue;
    assert.equal(v, major, `${f} sets up Node ${v}, .nvmrc says ${major}`);
  }
});

test('the next-major preview workflow exists and pins a major above the supported one', () => {
  const preview = workflowNodeVersions().filter((e) => e.file === PREVIEW_WORKFLOW && e.key === 'node-version');
  // Not vacuous: the exemption above must not outlive the file, and a file that stops setting up Node is a rename to notice.
  assert.ok(preview.length >= 1, `${PREVIEW_WORKFLOW} no longer sets up Node: drop the exemption in this test, or restore the workflow`);
  for (const e of preview) {
    const v = Number(e.raw.replace(/['"]/g, ''));
    assert.ok(v > major, `${e.file} sets up Node ${v}, which must be above the supported ${major} (it is the preview of the NEXT major)`);
  }
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
