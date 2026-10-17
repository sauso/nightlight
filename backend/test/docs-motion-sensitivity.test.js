// #368 C8 (simplified in #754): docs/notifications.md must state the motion-sensitivity threshold the code actually uses.
//
// What can go stale is the NUMBER, not the prose: the fixed bed-transition threshold lives in bedTransitionRules.js, so the
// percent is DERIVED from the exported constant here, not typed. Change the constant and this fails until the doc says the
// new number. (The rules file has no imports, so this needs no database.) The test used to pin whole sentences ("calibrated
// in one house", "in either direction", the link anchor); those rejected an honest rewording and caught nothing a reader
// could be misled by, so they are gone. What it still checks is that the doc exists, covers the setting, and carries the
// right number in the two places a reader looks for it.
//
// It also keeps ONE claim about behaviour: the doc must not go back to saying motion sensitivity "does not work this way"
// as the contrast to sound sensitivity. That was false until #368 and is the one sentence that would mislead a reader about
// what the slider changes.
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

// The settings-table row for the setting, and the section (any heading mentioning the fixed threshold) up to the next heading.
const sensitivityRow = doc.split('\n').find((l) => l.startsWith('| **Motion sensitivity**'));
const fixedSection = (() => {
  const m = /^#{2,4} .*fixed threshold.*$/im.exec(doc);
  if (!m) return '';
  const next = doc.indexOf('\n#', m.index + m[0].length);
  return doc.slice(m.index, next < 0 ? undefined : next);
})();

test('#368 C8: the Motion sensitivity row exists and states the fixed transition threshold the code uses', () => {
  assert.ok(sensitivityRow, 'the Motion sensitivity row is missing from the settings table');
  assert.ok(sensitivityRow.includes(PCT), `the Motion sensitivity row must state the fixed transition threshold (${PCT}) derived from BED_TRANSITION_ACTIVE_FRACTION`);
});

test('#368 C8: a section on the fixed threshold exists and states the same number', () => {
  assert.ok(fixedSection, 'a heading about the fixed bed-exit/entry threshold is missing from docs/notifications.md');
  assert.ok(fixedSection.includes(PCT), `the section must state ${PCT}`);
});

test('#368 C8: the sound-sensitivity section still exists, and the stale "does not work this way" contrast is not back', () => {
  assert.match(doc, /^#{2,4} .*Sound sensitivity/im, 'the sound sensitivity section is missing');
  assert.ok(!/motion sensitivity does (\*\*)?not(\*\*)? work this way/i.test(doc), 'the stale contrast sentence is back');
});
