// #368 C8: what docs/notifications.md says about motion sensitivity must be what the code does.
//
// The doc used to say motion sensitivity "does not work this way, it only affects alerts" as the contrast to sound
// sensitivity, which was false: until #368 the same number also classified the frames the bed-transition tracker reads.
// It is now true, because the tracker reads a fixed constant (bedTransitionRules.js). A doc that states a number the code
// owns goes stale the day the number changes, so the percent is DERIVED from the exported constant here, not typed: change
// the constant and this fails until the doc says the new number. (The rules file has no imports, so this needs no database.)
//
// "Docs-only" in the workspace rules means prose no test reads: this makes docs/notifications.md a file a test reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BED_TRANSITION_ACTIVE_FRACTION } from '../src/lib/bedTransitionRules.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const doc = fs.readFileSync(path.join(REPO, 'docs/notifications.md'), 'utf8').replace(/\r\n/g, '\n');

// The percent as the docs write it: two decimals, no space, e.g. "1.19%".
const PCT = `${(BED_TRANSITION_ACTIVE_FRACTION * 100).toFixed(2)}%`;

// The settings-table row, up to the next row.
const sensitivityRow = doc.split('\n').find((l) => l.startsWith('| **Motion sensitivity**'));
// The prose section that explains the fixed threshold, up to the next heading.
const fixedSection = (() => {
  const start = doc.indexOf('### Bed exits and entries use a fixed threshold');
  if (start < 0) return '';
  const next = doc.indexOf('\n### ', start + 1);
  return doc.slice(start, next < 0 ? undefined : next);
})();

test('#368 C8: the motion sensitivity row says alerts only and names the fixed threshold the code uses', () => {
  assert.ok(sensitivityRow, 'the Motion sensitivity row is missing from the settings table');
  assert.ok(sensitivityRow.includes(PCT), `the Motion sensitivity row must state the fixed transition threshold (${PCT}) derived from BED_TRANSITION_ACTIVE_FRACTION`);
  assert.match(sensitivityRow, /alerts only/i, 'the row must say motion sensitivity changes alerts only');
  assert.ok(sensitivityRow.includes('(#bed-exits-and-entries-use-a-fixed-threshold)'), 'the row must link to the section that explains the fixed threshold');
});

test('#368 C8: a section explains the fixed threshold, its number, and the known limit', () => {
  assert.ok(fixedSection, 'the "Bed exits and entries use a fixed threshold" section is missing');
  assert.ok(fixedSection.includes(PCT), `the section must state ${PCT}`);
  // The two things the owner of another house must be told: it was measured in one house, and they may see a change.
  assert.match(fixedSection, /measured in one house/i);
  assert.match(fixedSection, /in either direction/i);
  assert.match(fixedSection, /redraw the detection zone/i, 'the remedy for a noisy room must be named');
});

test('#368 C8: the doc no longer says motion sensitivity "does not work this way" as the contrast to sound sensitivity', () => {
  assert.ok(!/motion sensitivity does \*\*not\*\* work this way/i.test(doc), 'the stale contrast sentence is back');
  assert.ok(!/motion sensitivity does not work this way/i.test(doc));
  // The sound section still says sound sensitivity changes sleep tracking (that part is true and must stay).
  assert.match(doc, /### ⚠️ Sound sensitivity also changes sleep tracking/);
  assert.match(doc, /Sound sensitivity affects\s+\*\*both\*\*/);
});
