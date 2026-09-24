// Guards the specific dependency findings from the 2026-09-17 review (#455).
// Dependabot and npm audit remain the general scanners; these checks prevent a
// lockfile regeneration or a lockless Playwright update from quietly undoing the fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8').replace(/\r\n/g, '\n');

// DERIVED from the tree, not a typed list, so a manifest added later is covered by T1 without anyone
// remembering to edit this file (#455: the E2E manifest aged unwatched precisely because the list in
// dependabot.yml was hand-kept). A filesystem walk rather than `git ls-files`: the Codex sandbox that
// builds and reviews here cannot spawn child processes. Skip only .git, .claude (which holds whole
// repo copies in worktrees), and node_modules; manifests in other dot-dirs need coverage too.
function manifestDirs(dir = REPO, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', '.claude', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) manifestDirs(full, found);
    else if (entry.isFile() && entry.name === 'package.json') {
      const rel = path.relative(REPO, dir).split(path.sep).join('/');
      found.push(`/${rel}`);
    }
  }
  return found;
}

function npmDependabotDirs(yamlText) {
  const dirs = [];
  let inUpdates = false;
  let item = null;
  const finishItem = () => {
    if (item?.['package-ecosystem'] !== 'npm') return;
    // `directories:` is valid Dependabot YAML but this deliberately small parser does not support it.
    // Fail loudly so a new layout cannot make T1 silently claim coverage it has not checked.
    assert.ok(!Object.hasOwn(item, 'directories'), 'npm Dependabot directories: is unsupported');
    if (item.directory && item['open-pull-requests-limit'] !== '0') dirs.push(item.directory);
  };
  const record = (source) => {
    const field = /^(package-ecosystem|directory|directories|open-pull-requests-limit):\s*(.*?)\s*$/.exec(source);
    if (!field) return;
    const raw = field[2].replace(/\s+#.*$/, '').trim();
    item[field[1]] = raw.replace(/^(['"])(.*)\1$/, '$2');
  };
  for (const line of yamlText.split('\n')) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (!inUpdates) {
      if (/^updates:\s*(?:#.*)?$/.test(line)) inUpdates = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    const start = /^  - (.*)$/.exec(line);
    if (start) {
      finishItem();
      item = {};
      record(start[1]);
    } else if (item && /^ {4}\S/.test(line)) {
      record(line.slice(4));
    }
  }
  if (inUpdates) finishItem();
  return dirs;
}

function playwrightImage(composeText) {
  let inServices = false;
  let inPlaywright = false;
  const images = [];
  for (const line of composeText.split('\n')) {
    if (/^\s*(?:#|$)/.test(line)) continue;
    if (!inServices) {
      if (/^services:\s*(?:#.*)?$/.test(line)) inServices = true;
      continue;
    }
    if (/^\S/.test(line)) break;
    if (/^  \S/.test(line)) {
      if (inPlaywright) break;
      inPlaywright = /^  playwright:\s*(?:#.*)?$/.test(line);
      continue;
    }
    if (inPlaywright) {
      const match = /^    image:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/.exec(line);
      if (match) images.push(match[1] ?? match[2] ?? match[3]);
    }
  }
  assert.equal(images.length, 1, 'e2e/playwright/package.json and e2e/docker-compose.e2e.yml must match: playwright: needs exactly one active image: line; bump the image tag in the same PR');
  return images[0];
}

function lockEntriesFor(packages, name) {
  return Object.entries(packages).filter(([key, details]) => {
    const marker = 'node_modules/';
    const last = key.lastIndexOf(marker);
    return last >= 0 && (details.name ?? key.slice(last + marker.length)) === name;
  });
}

function numericSemver(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `expected a numeric semver version, got ${version}`);
  return version.split('.').map(Number);
}

function atLeast(version, floor) {
  const got = numericSemver(version);
  const min = numericSemver(floor);
  for (let i = 0; i < 3; i++) {
    if (got[i] !== min[i]) return got[i] > min[i];
  }
  return true;
}

const playwrightPin = () => JSON.parse(read('e2e/playwright/package.json')).devDependencies['@playwright/test'];

test('T1: every npm manifest directory has exact Dependabot coverage', () => {
  const manifests = manifestDirs();
  const covered = npmDependabotDirs(read('.github/dependabot.yml'));
  // backend, frontend and e2e/playwright exist today. Without a floor, a walk that silently found
  // nothing (wrong REPO root, say) would pass by checking an empty list.
  assert.ok(manifests.length >= 3, `manifest walk found only ${manifests.length} directories`);
  // `includes`, i.e. an EXACT match: Dependabot's `directory` is not recursive, so covering "/e2e"
  // does not cover "/e2e/playwright" (mutant #455 M1).
  for (const dir of manifests) {
    assert.ok(covered.includes(dir), `${dir} has no exact npm directory in .github/dependabot.yml`);
  }
});

// The image ships the browsers and @playwright/test drives them, so the two versions must be the same
// release. A lockless Dependabot PR bumps only the pin, and this is what turns that PR red instead of
// letting it break E2E after merge. An exact pin is required because a range would let the container's
// `npm install` drift away from the image on its own.
test('T2: exact Playwright pin matches the active E2E image', () => {
  const pin = playwrightPin();
  const guidance = 'e2e/playwright/package.json and e2e/docker-compose.e2e.yml must match: bump the image tag in the same PR';
  assert.match(pin, /^\d+\.\d+\.\d+$/, `@playwright/test must have an exact pin; ${guidance}`);
  // Read only the active service image: an extension block before `services:` is ignored by Compose
  // and cannot establish which browser version the service runs.
  const image = playwrightImage(read('e2e/docker-compose.e2e.yml'));
  // Any distro suffix (-jammy today, -noble, …): moving base OS is a separate, deliberate choice, and
  // this check is about the VERSION only.
  const tag = /^mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)(?:-[a-z]+)?$/.exec(image);
  assert.ok(tag, `unexpected Playwright image ${image}; ${guidance}`);
  assert.equal(tag[1], pin, `image is v${tag[1]} but @playwright/test is ${pin}; ${guidance}`);
});

test('T3: #455 qs, uuid, and Playwright advisory floors hold', () => {
  const packages = JSON.parse(read('backend/package-lock.json')).packages;
  // Floors = the first patched release of each advisory (qs GHSA-4mjr/GHSA-x5fp, uuid GHSA-w5hq,
  // Playwright GHSA-7mvr). Nested copies count: the uuid that matched was
  // node_modules/gaxios/node_modules/uuid, which only package.json's scoped override keeps at 11.x
  // (mutant #455 M8).
  for (const [name, floor] of [['qs', '6.16.0'], ['uuid', '11.1.1']]) {
    const entries = lockEntriesFor(packages, name);
    assert.ok(entries.length > 0, `backend/package-lock.json has no node_modules/${name} entries`);
    for (const [key, details] of entries) {
      assert.ok(atLeast(details.version, floor), `${key} is ${details.version}, below ${floor}`);
    }
  }
  assert.ok(atLeast(playwrightPin(), '1.55.1'), 'e2e/playwright/package.json pins Playwright below 1.55.1');
});

test('T5: dependency parsers reject misleading fixtures and accept valid coverage', () => {
  assert.deepEqual(npmDependabotDirs(`updates:\n  - target-branch: "dev"\n    package-ecosystem: "docker"\n    directory: "/e2e/playwright"\n`), []);
  assert.deepEqual(npmDependabotDirs(`updates:\n  - package-ecosystem: npm\n    directory: /off\n    open-pull-requests-limit: 0\n`), []);
  assert.deepEqual(npmDependabotDirs(`updates:\n  - package-ecosystem: npm\n    # directory: "/x"\n`), []);
  assert.deepEqual(npmDependabotDirs(`updates:\n  - package-ecosystem: "npm"\n    directory: "/a" # watched\n  - directory: "/b"\n    package-ecosystem: 'npm'\n`), ['/a', '/b']);
  assert.throws(() => npmDependabotDirs(`updates:\n  - package-ecosystem: npm\n    directories:\n      - /a\n`), /directories: is unsupported/);

  assert.equal(playwrightImage(`x-example:\n  playwright:\n    image: mcr.microsoft.com/playwright:v1.63.0-jammy\nservices:\n  playwright:\n    image: mcr.microsoft.com/playwright:v1.49.0-jammy\n`), 'mcr.microsoft.com/playwright:v1.49.0-jammy');
  assert.equal(playwrightImage(`services:\n  playwright:\n    image: "mcr.microsoft.com/playwright:v1.63.0-jammy" # current\n`), 'mcr.microsoft.com/playwright:v1.63.0-jammy');
  assert.equal(playwrightImage(`services:\n  playwright:\n    image: 'mcr.microsoft.com/playwright:v1.63.0-jammy'\n`), 'mcr.microsoft.com/playwright:v1.63.0-jammy');
  assert.deepEqual(lockEntriesFor({ 'node_modules/qs-legacy': { name: 'qs', version: '6.15.3' } }, 'qs'), [
    ['node_modules/qs-legacy', { name: 'qs', version: '6.15.3' }],
  ]);
});
