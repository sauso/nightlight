// The supported Node version is pinned in .nvmrc, both packages, CI and the Docker image (issue #565, #751).
//
// Before this, nothing stated it: CI ran Node 24, `engines` and `.nvmrc` did not exist, and a contributor on
// Node 22 got a red backend suite with no hint why. Stating it once is not enough, because the image, CI and
// the two package files each move on their own. For a week (2026-11-16 to 2026-11-23, #751) the image ran Node 26
// while the rest stayed on 24, under one explicit exception; that soak ended clean, the whole repository moved to 26
// (release 0.50.0 shipped the image on 26) and the exception is gone: every place below must now say the same major.
//
// ⚠️ Reads the real files, no fixture: the claim is about THIS repository's configuration. `.nvmrc` is the
// reference for support.
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

// #751, PR #1121 round 1: scan every FROM, including --platform, then guard the full five-stage
// graph. Counting only Node stages let an extra scratch stage or a missing MediaMTX stage through.
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
  // #1159: the sixth stage is `FROM scratch AS yamnet-model`, which only downloads and checksums the two model files.
  assert.equal(from.length, 6, 'Dockerfile must have exactly six stages');
  assert.deepEqual(from.map((s) => s.name),
    ['frontend-build', 'mediamtx-binary', 'yamnet-model', 'backend-deps', 'tailscale-binaries', null],
    'Dockerfile stage names and order must match the production build');
  assert.equal(from[1].image, 'bluenviron/mediamtx:1', 'MediaMTX stage must use the reviewed image');
  assert.equal(from[2].image, 'scratch', 'the model stage must be FROM scratch (it runs nothing)');
  assert.ok(from.at(-1).major !== null, 'Dockerfile final stage must be a Node image');
  const stages = from.filter((s) => s.major !== null);
  assert.equal(stages.length, 4, 'Dockerfile must have exactly four Node stages');
  // #751, PR #1121 round 1: a major alone accepts node:26 and node:26-bookworm,
  // but the soak and its BusyBox/native-module assumptions require Alpine in every Node stage.
  for (const stage of stages) {
    assert.match(stage.image, /^node:\d+-alpine$/, `${stage.name ?? 'runtime'} must use node:<major>-alpine`);
  }
  const versions = new Set(stages.map((s) => s.major));
  assert.equal(versions.size, 1, `Dockerfile Node stages are mixed: ${[...versions].join(', ')}`);
  assert.ok(versions.has(supported),
    `all four Dockerfile Node stages must use the supported Node ${supported} (.nvmrc), not ${[...versions].join(', ')}`);
  return stages[0].major;
}

test('every Dockerfile Node stage runs the supported major', () => {
  assertDockerNodeStages(read('Dockerfile'), major);
});

test('Dockerfile scan includes --platform and rejects mixed stages or a non-Node final stage', () => {
  const fixture = `FROM node:24-alpine AS frontend-build\nFROM bluenviron/mediamtx:1 AS mediamtx-binary\nFROM scratch AS yamnet-model\nFROM node:24-alpine AS backend-deps\nFROM --platform=$BUILDPLATFORM node:24-alpine AS tailscale-binaries\nFROM node:24-alpine\n`;
  assert.equal(scanDockerNodeStages(fixture)[4].major, 24);
  assert.equal(assertDockerNodeStages(fixture, 24), 24);
  assert.throws(() => assertDockerNodeStages(fixture.replace('node:24-alpine AS tailscale-binaries', 'node:26-alpine AS tailscale-binaries'), 24), /mixed/);
  assert.throws(() => assertDockerNodeStages(fixture.replace(/FROM node:24-alpine\n$/, 'FROM alpine:3.24\n'), 24), /final stage/);
});

// #751, PR #1121 round 1: guard the exact image family and stage graph, including non-Node stages.
const dockerStagesFixture = `FROM node:24-alpine AS frontend-build\nFROM bluenviron/mediamtx:1 AS mediamtx-binary\nFROM scratch AS yamnet-model\nFROM node:24-alpine AS backend-deps\nFROM --platform=$BUILDPLATFORM node:24-alpine AS tailscale-binaries\nFROM node:24-alpine\n`;

test('Dockerfile rejects a bare Node tag', () => {
  assert.throws(() => assertDockerNodeStages(dockerStagesFixture.replaceAll('node:24-alpine', 'node:26-alpine').replace('node:26-alpine AS frontend-build', 'node:26 AS frontend-build'), 26));
});

test('Dockerfile rejects a different Node distro', () => {
  assert.throws(() => assertDockerNodeStages(dockerStagesFixture.replaceAll('node:24-alpine', 'node:26-alpine').replace('node:26-alpine AS frontend-build', 'node:26-bookworm AS frontend-build'), 26));
});

test('Dockerfile rejects an extra non-Node stage', () => {
  assert.throws(() => assertDockerNodeStages(dockerStagesFixture.replace('FROM node:24-alpine\n', 'FROM scratch AS extra\nFROM node:24-alpine\n'), 24));
});

test('Dockerfile rejects a missing model stage', () => {
  assert.throws(() => assertDockerNodeStages(dockerStagesFixture.replace('FROM scratch AS yamnet-model\n', ''), 24));
});

test('Dockerfile rejects a missing non-Node stage', () => {
  assert.throws(() => assertDockerNodeStages(dockerStagesFixture.replace('FROM bluenviron/mediamtx:1 AS mediamtx-binary\n', ''), 24));
});

// Every workflow pins the supported major, with no exception. From 2026-11-24 there is no "next major" preview workflow
// (#751: Node 26 became the supported major, and the next one, 27, has no release to preview yet: nodejs.org lists only
// an alpha). The one that existed, node-next.yml, was the only allowed exception; if a preview workflow comes back for
// Node 28, this test is where its exception is named again.

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

test('every workflow that sets up Node uses that major', () => {
  const found = workflowNodeVersions().map((e) => [e.file, Number(e.raw.replace(/['"]/g, ''))]);
  assert.ok(found.length >= 1, 'no `node-version:` found in any workflow');
  for (const [f, v] of found) {
    assert.equal(v, major, `${f} sets up Node ${v}, .nvmrc says ${major}`);
  }
});

// The CI containers that test the entrypoint (BusyBox sh, find, stat, chmod) run in a node:<major>-alpine image, which is
// the image base too. They were node:24-alpine while the image soaked on 26 and are 26 now; a hand-edit that leaves one
// behind would test a different userland from the one that ships, so every `node:<major>-alpine` named in a workflow
// must be the supported major.
test('every node:<major>-alpine image a workflow runs is the supported major', () => {
  const dir = path.join(REPO, '.github', 'workflows');
  let seen = 0;
  for (const f of fs.readdirSync(dir).filter((n) => /\.ya?ml$/.test(n))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
    for (const m of text.matchAll(/\bnode:(\d+)-alpine\b/g)) {
      seen += 1;
      assert.equal(Number(m[1]), major, `${f} runs node:${m[1]}-alpine, .nvmrc says ${major}`);
    }
  }
  assert.ok(seen >= 1, 'no node:<major>-alpine image found in any workflow: this test would pass for nothing');
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
