// The sleep score evidence script (scripts/sleep-score-evidence.mjs): scores every stored night of a database
// snapshot so a person can read the scores against the nights they remember.
//
// It lives here because this is the only test harness in the repo (as scoreboard.test.js says of its own script).
//
// Claim -> test:
//   the totals count what they say (unavailable components, the put-down
//     rate on each side of a split, the spread and band counts) ......... "totals ..."
//   the snapshot is never written, although db.js migrates what it opens . "the real script ..."
//   the backend's own baseline and score are what is printed ............. "the real script ..." (the 93)
//   a child is printed as six characters of its id, never by name ........ "the real script ..."
//   a mistyped option stops the run ....................................... "a mistyped option ..."
//
// NOT tested: --recompute-stir (it needs a night of raw samples; it only fills the temporary copy, and the rate it
// writes is one line of arithmetic), and the layout of the report beyond the two lines read below.
//
// ⚠️ Fixture ids and the child's name are made up: the repo is public.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const EV = await import(new URL('../../scripts/sleep-score-evidence.mjs', import.meta.url).href);
const SCRIPT = fileURLToPath(new URL('../../scripts/sleep-score-evidence.mjs', import.meta.url));
const { default: db } = await import('../src/db.js');

const tmpDirs = [];
after(() => {
  for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  try { db.close(); } catch { /* already closed */ }
  cleanupTempDataDirs();
});

describe('totals', () => {
  const part = (key, available, reason = null) => ({ key, available, reason: available ? null : reason, score: available ? 50 : null });
  const scored = (child, date, score, band, { settling = true, early = false, in_bed_at = 'x' } = {}) => ({
    child, date, status: 'ok', in_bed_at,
    result: {
      score, band, early_estimate: early, provisional: false, low_confidence: false, capped_by: score === 40 ? 'continuity' : null,
      components: [part('duration', true), part('continuity', true), part('settling', settling, 'no_in_bed'), part('restlessness', false, 'missing'), part('consistency', true)],
    },
  });
  const RECORDS = [
    scored('aaaaaa', '2026-01-01', 90, 'great'),
    scored('aaaaaa', '2026-01-02', 40, null, { settling: false, in_bed_at: null }),
    scored('aaaaaa', '2026-01-03', 60, null, { early: true }),
    scored('aaaaaa', '2026-01-04', 72, 'good', { settling: false, in_bed_at: null }),
    scored('bbbbbb', '2026-01-03', 55, 'fair'),
    { child: 'bbbbbb', date: '2026-01-04', status: 'empty', in_bed_at: null, result: { score: null, reason: 'not_ok', status: 'empty' } },
  ];

  test('totals: unavailable components, the put-down rate either side of the split, spread and bands per child', () => {
    const t = EV.summarise(RECORDS, { split: '2026-01-03' });
    assert.deepEqual([t.nights, t.scored, t.not_scored], [6, 5, { not_ok: 1 }]);
    assert.deepEqual(t.components.settling, { unavailable: 2, of: 5, reasons: { no_in_bed: 2 } });
    assert.deepEqual(t.components.restlessness, { unavailable: 5, of: 5, reasons: { missing: 5 } });
    assert.deepEqual(t.components.duration, { unavailable: 0, of: 5, reasons: {} });
    // The put-down is counted on `ok` nights only: the empty night has none and is not a miss.
    assert.deepEqual(t.in_bed.all, { ok_nights: 5, missing: 2, rate: 0.4 });
    assert.deepEqual(t.in_bed.before, { ok_nights: 2, missing: 1, rate: 0.5 });
    assert.deepEqual(t.in_bed.from, { ok_nights: 3, missing: 1, rate: 1 / 3 });
    assert.deepEqual(t.capped, { continuity: 1 });
    const a = t.per_child.find((c) => c.child === 'aaaaaa');
    // 40, 60, 72, 90: the median of four is 66. The early estimate is counted apart from "no word".
    assert.deepEqual(a.all, { nights: 4, min: 40, median: 66, max: 90, bands: { great: 1, good: 1, fair: 0, none: 1, early: 1 } });
    assert.deepEqual([a.before.nights, a.before.median, a.from.nights, a.from.median], [2, 65, 2, 66]);
    assert.deepEqual(t.per_child.find((c) => c.child === 'bbbbbb').all.bands, { great: 0, good: 0, fair: 1, none: 0, early: 0 });
  });

  test('a mistyped option stops the run instead of printing a report that looks complete', () => {
    assert.throws(() => EV.parseArgs(['snap.db', '--splt=2026-01-03']), /unknown or incomplete option/);
    assert.throws(() => EV.parseArgs(['snap.db', '--split=January']), /--split is not a date/);
    assert.throws(() => EV.parseArgs([]), /missing the path/);
    assert.deepEqual(EV.parseArgs(['snap.db', '--split=2026-01-03', '--recompute-stir']).recomputeStir, true);
  });
});

describe('the real script', () => {
  test('the real script scores a copy: the snapshot is byte for byte untouched, the score is the backend\'s, no name is printed', () => {
    const CHILD = 'ev1234-made-up-child-id';
    const NAME = 'Zebedee-Marker';
    db.prepare('INSERT INTO children (id, name, birthday) VALUES (?, ?, ?)').run(CHILD, NAME, '2022-03-01'); // 36 months on the first night
    const ctx = JSON.stringify({ v: 1, camera_id: 'ev-cam', tz: 'UTC', window: { start: '19:00', end: '07:00' }, algo: '6' });
    const ins = db.prepare(
      `INSERT INTO sleep_nights (child_id, night_date, window_start, window_end, status, onset_at, wake_at, in_bed_at,
         asleep_minutes, awake_minutes, unknown_minutes, wake_count, longest_stretch_minutes, coverage_minutes,
         stir_minutes, scoring_context, computed_at)
       VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, 600, 150, 0, 4, 300, 720, 20, ?, ?)`
    );
    // Eight identical nights, 2025-03-01 to 03-08: the eighth has seven behind it, so its usual is itself.
    for (let d = 1; d <= 8; d++) {
      const a = `2025-03-0${d}`;
      const b = `2025-03-${String(d + 1).padStart(2, '0')}`;
      ins.run(CHILD, a, `${a} 19:00:00`, `${b} 07:00:00`, `${a} 19:30:00`, `${b} 06:30:00`, `${a} 19:10:00`, ctx, `${b} 10:00:00`);
    }
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-ev-test-'));
    tmpDirs.push(dir);
    const snap = path.join(dir, 'snapshot.db');
    fs.copyFileSync(db.name, snap); // wherever db.js keeps the file under DATA_DIR
    const sha = () => crypto.createHash('sha256').update(fs.readFileSync(snap)).digest('hex');
    const before = sha();

    const run = spawnSync(process.execPath, [SCRIPT, snap, '--clock=2025-04-01T00:00:00Z', '--split=2025-03-05'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(sha(), before);
    assert.deepEqual(fs.readdirSync(dir), ['snapshot.db']); // no -wal or -shm left beside it either

    const lines = run.stdout.split('\n');
    // The first night has nothing behind it: an early estimate against the age figure (3 years: 684 minutes).
    assert.match(lines.find((l) => l.startsWith('ev1234 2025-03-01')), /^ev1234 2025-03-01 +\d+ early .*ref 684 /);
    // The eighth: duration 100, continuity 77 (the fixed curves; the child is over 12 months), the rest 100 -> 93.
    assert.match(lines.find((l) => l.startsWith('ev1234 2025-03-08')), /^ev1234 2025-03-08 +93 great \| dur 100 cont 77 .*settle 100 rest 100 cons 100 \| cap - \| asleep 600 ref 600 /);
    assert.ok(lines.some((l) => l.startsWith('ev1234 2025-03-08 nights 7 | asleep 600(7*)')), 'the baseline line of the eighth night');
    assert.ok(!run.stdout.includes(NAME) && !run.stdout.includes(CHILD), 'only six characters of the id may appear');
    assert.ok(lines.some((l) => l.includes('from the split: n=4')), 'the split is applied');
  });

  test('--out inside the repository is refused', () => {
    const run = spawnSync(process.execPath, [SCRIPT, 'whatever.db', `--out=${path.join(path.dirname(SCRIPT), 'evidence.txt')}`], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /refusing to write/);
    assert.equal(fs.existsSync(path.join(path.dirname(SCRIPT), 'evidence.txt')), false);
  });
});
