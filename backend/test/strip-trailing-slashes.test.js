// stripTrailingSlashes (CodeQL js/polynomial-redos #12, #13): same result as `.replace(/\/+$/, '')`, in linear time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTrailingSlashes } from '../src/lib/stripTrailingSlashes.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('it removes every trailing slash and nothing else', () => {
  const cases = [
    ['https://ntfy.sh', 'https://ntfy.sh'],
    ['https://ntfy.sh/', 'https://ntfy.sh'],
    ['https://ntfy.sh////', 'https://ntfy.sh'],
    ['https://host/base/path/', 'https://host/base/path'],
    ['https://host//a//b', 'https://host//a//b'], // inner and doubled slashes are kept
    ['/', ''],
    ['////', ''],
    ['', ''],
    ['a/b', 'a/b'],
    ['/a', '/a'], // a LEADING slash is not trailing
    ['a/ ', 'a/ '], // a trailing space is not a slash (callers trim first)
  ];
  for (const [input, want] of cases) {
    assert.equal(stripTrailingSlashes(input), want, JSON.stringify(input));
    // The contract is "identical to the regular expression it replaced", so check it against that too.
    assert.equal(stripTrailingSlashes(input), input.replace(/\/+$/, ''), `regex parity for ${JSON.stringify(input)}`);
  }
});

test('null and undefined are treated as an empty string', () => {
  assert.equal(stripTrailingSlashes(undefined), '');
  assert.equal(stripTrailingSlashes(null), '');
});

test('a very long run of slashes then one other character is handled in linear time', () => {
  // The old regular expression needed about 6 s for this input (and 1.5 s for 50,000); the loop needs well under a
  // millisecond. 250 ms is two orders of magnitude of slack for a slow CI runner and still far below the old cost.
  const input = `https://x${'/'.repeat(100000)}y`;
  const t0 = process.hrtime.bigint();
  const out = stripTrailingSlashes(input);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(out, input, 'the string does not END in a slash, so it is unchanged');
  assert.ok(ms < 250, `took ${ms.toFixed(1)} ms for 100,000 slashes: the pattern is quadratic again`);
  // And the ordinary worst case, a long run AT the end, also comes back fast and trimmed.
  const t1 = process.hrtime.bigint();
  assert.equal(stripTrailingSlashes(`https://x${'/'.repeat(100000)}`), 'https://x');
  assert.ok(Number(process.hrtime.bigint() - t1) / 1e6 < 250);
});

// A guard against the pattern coming back by copy-paste: every backend source file is scanned for the exact vulnerable
// call. Token-based, so a reformat cannot break it, and a deliberate use elsewhere is a decision to make visibly.
test('no backend source file trims trailing slashes with the quadratic regular expression', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.js') && /\.replace\(\s*\/\\\/\+\$\/\s*,/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(SRC, p));
    }
  };
  walk(SRC);
  assert.deepEqual(offenders, [], `use stripTrailingSlashes() (lib/stripTrailingSlashes.js) instead of .replace(/\\/+$/, ''): ${offenders.join(', ')}`);
});
