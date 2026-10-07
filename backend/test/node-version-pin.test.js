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
