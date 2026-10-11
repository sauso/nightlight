#!/usr/bin/env node
// SLEEP ACCURACY SCOREBOARD: how far is the app's FRESH answer for a night from what the parent said
// actually happened? One command, one DB snapshot, one number per field you can put in a ledger.
//
//   node scripts/scoreboard.mjs <path-to-sqlite-snapshot>
//        [--clock=<ISO>] [--unseen-after=<ISO>] [--json] [--out=<file>] [--label=<text>] [--backend=<dir>]
//
//   --clock         the instant "now" is frozen at while every night is recomputed. Default: the snapshot
//                   file's own modification time (a `cp -p` copy keeps it; a plain copy does NOT, so pass
//                   --clock when you did not preserve it). Matters only for a night still in progress.
//   --unseen-after  the split (default 2026-10-11T00:00:00Z). A review saved at or before it is "fitted-to";
//                   after it, "unseen". A timestamp with no zone ("2026-10-11 07:50:00") is read as UTC,
//                   the way the database stores times, never as this machine's local time.
//   --json          print the report as JSON instead of Markdown.
//   --out           write the output to this file instead of stdout. REFUSED inside this repo: the ledger
//                   this feeds lives outside it, and the script never writes into the working tree.
//   --label         free text (a short sha, "staging", "prod") carried into the ledger row.
//   --backend       the backend/ directory whose computeNight to score. Default: this checkout's backend/.
//                   Point it at another checkout's backend/ (npm ci done) to score an OLD version on the
//                   same snapshot: that is the whole old-vs-new comparison, one flag.
//
// ## Why this exists
// Every sleep change so far was judged on the same handful of nights it was designed on, and the reviewed
// nights are the ones people looked at BECAUSE something looked wrong. This turns the owner's morning
// reviews (sleep_reviews) into one repeatable table, so "did we get better?" is a comparison of two
// printed rows instead of an argument. It changes no behaviour: it only reads.
//
// ## What it does (and why it cannot damage the snapshot)
//  1. Copies the snapshot (and its -wal, if one sits beside it, since that is where the newest rows live)
//     into a fresh temp directory and points the backend at THAT. The backend's db.js migrates and sets
//     WAL mode on open, which writes, so it must never be handed the original. The original is only ever
//     read, once, by the copy; the temp directory is deleted at the end.
//  2. Freezes Date.now()/new Date() the way the A/B harness for #669 did, then loads the backend's OWN
//     computeNight. No algorithm is duplicated here: a copy would drift from the thing it scores.
//  3. For every reviewed night, compares the FRESH recompute (not the stored row: stored rows are frozen
//     at the code and clock of their day) with the review's true_in_bed_at / true_onset_at / true_wake_at,
//     each falling back to the time of the bed transition the parent picked (true_*_transition_id) when no
//     time was typed. Most reviews are answered by picking a transition, so without the fallback most
//     nights would have no truth at all.
//
// ## What the numbers do and do not mean
//  * Reviewed nights are NOT a random sample: they are the nights somebody checked.
//  * "fitted-to" (reviewed at or before --unseen-after) flatters us: those nights shaped the thresholds.
//    Only "unseen" measures progress, and it is small. Every row prints its n and a set under 10 nights
//    is flagged: a percentage of 3 nights is a story, not a measurement.
//  * A reviewed time that the parent accepted as the app's own answer counts as truth, so agreement on
//    those nights is partly the app agreeing with itself. Another reason "fitted-to" is the optimistic set.
//  * "within X min" counts a night the app left BLANK as a miss (a missing answer is not a right one);
//    median and mean error are over the nights where both a computed and a true time exist, so a blank
//    cannot flatter them.
//  * The table shows absolute minutes; the JSON per-night list carries SIGNED minutes (+ = the app is later
//    than the truth).
//  * Not scored, and counted in the header: dismissed reviews, "nobody was in the bed" reviews, reviews
//    with no true time at all, and nights that come back `no_data`. The last matters: activity samples are
//    kept only 30 days, so on a snapshot taken today every older reviewed night is `no_data` and cannot be
//    recomputed (21 of 60 on the first real run). The scoreboard therefore scores the LAST ~30 DAYS of
//    reviews: "fitted-to" shrinks as nights age out, so two ledger rows are only comparable when taken from
//    snapshots of the same age, or when compared on the nights both have.
//    Child labels are "child 1", "child 2" by creation order: a name is never read.
//  * Thresholds (10 min in-bed, 15 min onset, 10 min wake) were set by the owner for this scoreboard
//    (2026-10-11), not derived from a clinical definition. They are in minutes, so they mean the same in
//    any household; what the figures are measured ON (two cameras in one house) does not.
//  * The timezone is whatever the snapshot's settings say.
//  * The clock is frozen for JS (Date.now / new Date), not for SQLite's datetime('now').

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_UNSEEN_AFTER = '2026-10-11T00:00:00Z';
// minutes; the same three figures the owner reads a night by (in-bed and wake 10, onset 15).
export const THRESHOLDS_MIN = { in_bed: 10, onset: 15, wake: 10 };
// A wake this far off is not a rounding error, it is the wrong morning: counted on its own.
export const BIG_WAKE_ERROR_MIN = 60;
// Below this many nights in a set the percentages are printed but flagged.
export const SMALL_SET = 10;
const FIELDS = ['in_bed', 'onset', 'wake'];

// ---- time -------------------------------------------------------------------------------------------

/**
 * Epoch ms for a database time ("YYYY-MM-DD HH:MM:SS", stored UTC) or an ISO instant, else null.
 *
 * ⚠️ A zone-less string must be UTC. `Date.parse('2026-10-11T07:50:00')` reads it as LOCAL time, so the
 * same snapshot would split differently on a laptop in another timezone: parse it ourselves.
 */
export function parseInstant(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const bare = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/.exec(s);
  const iso = bare ? `${bare[1]}T${bare[2] || '00:00:00'}Z` : s;
  if (!bare && !/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// ---- arguments --------------------------------------------------------------------------------------

const USAGE = [
  'usage: node scripts/scoreboard.mjs <path-to-sqlite-snapshot> [--clock=<ISO>] [--unseen-after=<ISO>]',
  '                                   [--json] [--out=<file>] [--label=<text>] [--backend=<dir>]',
].join('\n');

/** Parse argv (without node and the script). Throws an Error whose message names the bad argument. */
export function parseArgs(argv) {
  const out = { db: null, clock: null, unseenAfter: DEFAULT_UNSEEN_AFTER, json: false, out: null, label: null, backend: null, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--json') out.json = true;
    else if (/^--(clock|unseen-after|out|label|backend)=./.test(a)) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq);
      out[key === 'unseen-after' ? 'unseenAfter' : key] = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      // A flag typo must not be silently ignored: --unseen-afer would score the wrong split and look fine.
      throw new Error(`unknown or incomplete option: ${a}`);
    } else if (out.db == null) out.db = a;
    else throw new Error(`unexpected extra argument: ${a}`);
  }
  if (!out.help && out.db == null) throw new Error('missing the path to the SQLite snapshot');
  if (out.clock != null && parseInstant(out.clock) == null) throw new Error(`--clock is not a time: ${out.clock}`);
  if (parseInstant(out.unseenAfter) == null) throw new Error(`--unseen-after is not a time: ${out.unseenAfter}`);
  return out;
}

// ---- scoring (pure: no database, no clock) --------------------------------------------------------

const minutesBetween = (computed, truth) => {
  const a = parseInstant(computed);
  const b = parseInstant(truth);
  return a == null || b == null ? null : (a - b) / 60000;
};

/**
 * Score every review that carries a truth.
 *
 * @param reviews   rows { child_id, night_date, dismissed, nobody_in_bed, reviewed_at,
 *                  true_in_bed_at, true_onset_at, true_wake_at } (transition ids already resolved to times)
 * @param childNo   Map child_id -> 1-based child number; a review whose child is missing is excluded
 * @param compute   (childId, nightDate) -> { status, in_bed_at, onset_at, wake_at }; the real computeNight
 *                  in production, a stub in tests
 * @param unseenAfterMs  reviewed_at <= this is "fitted"; strictly after is "unseen"
 */
export function scoreReviews(reviews, { childNo, compute, unseenAfterMs }) {
  const excluded = { dismissed: 0, nobody_in_bed: 0, no_true_time: 0, unknown_child: 0, no_data: 0 };
  const nights = [];
  for (const r of reviews) {
    // One reason per row, in this order: a dismissed review says nothing was answered at all.
    if (r.dismissed) { excluded.dismissed++; continue; }
    if (r.nobody_in_bed) { excluded.nobody_in_bed++; continue; }
    const truth = { in_bed: r.true_in_bed_at ?? null, onset: r.true_onset_at ?? null, wake: r.true_wake_at ?? null };
    if (!FIELDS.some((f) => truth[f] != null)) { excluded.no_true_time++; continue; }
    const child = childNo.get(r.child_id);
    if (child == null) { excluded.unknown_child++; continue; }

    let res;
    try { res = compute(r.child_id, r.night_date); } catch (e) { res = { status: 'threw', error: String(e?.message || e) }; }
    // 'no_data' means the snapshot cannot see the night: activity samples are kept 30 days, so every
    // reviewed night older than that comes back no_data whatever the algorithm would have said. Scoring it
    // would call 21 of 60 nights on one snapshot 'wake blank', and would make the ledger drift with the
    // calendar rather than with the code. It is counted and named instead, never silently dropped.
    if (res?.status === 'no_data') { excluded.no_data++; continue; }
    const computed = { in_bed: res?.in_bed_at ?? null, onset: res?.onset_at ?? null, wake: res?.wake_at ?? null };
    const err = {};
    for (const f of FIELDS) err[f] = truth[f] != null && computed[f] != null ? minutesBetween(computed[f], truth[f]) : null;
    // A review with no parseable reviewed_at cannot be proven unseen, and "unseen" is the set that is
    // allowed to claim progress: it goes to fitted, the cautious side.
    const reviewedMs = parseInstant(r.reviewed_at);
    nights.push({
      child, night: r.night_date, status: res?.status ?? null,
      set: reviewedMs != null && reviewedMs > unseenAfterMs ? 'unseen' : 'fitted',
      reviewed_at: r.reviewed_at ?? null,
      truth, computed, err,
    });
  }
  nights.sort((a, b) => (a.child - b.child) || a.night.localeCompare(b.night));
  return { nights, excluded };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/** Per-field and whole-set statistics for a list of scored nights. */
export function summarise(nights) {
  const fields = {};
  for (const f of FIELDS) {
    const withTruth = nights.filter((n) => n.truth[f] != null);
    const abs = withTruth.filter((n) => n.err[f] != null).map((n) => Math.abs(n.err[f]));
    const within = abs.filter((e) => e <= THRESHOLDS_MIN[f]).length;
    fields[f] = {
      threshold_min: THRESHOLDS_MIN[f],
      n_truth: withTruth.length,
      n_scored: abs.length,
      within,
      within_pct: withTruth.length ? Math.round((100 * within) / withTruth.length) : null,
      median_abs_min: round1(median(abs)),
      mean_abs_min: abs.length ? round1(abs.reduce((a, b) => a + b, 0) / abs.length) : null,
    };
  }
  const wakeTruth = nights.filter((n) => n.truth.wake != null);
  return {
    nights: nights.length,
    fields,
    // The two ways a wake can be badly wrong, kept apart: blank (the app gave no wake) and far off.
    wake_null: wakeTruth.filter((n) => n.computed.wake == null).length,
    wake_over_60: wakeTruth.filter((n) => n.err.wake != null && Math.abs(n.err.wake) > BIG_WAKE_ERROR_MIN).length,
  };
}

/** Build the report object from scored nights. */
export function buildReport({ nights, excluded }, meta) {
  const childNumbers = [...new Set(nights.map((n) => n.child))].sort((a, b) => a - b);
  const groups = [
    ...childNumbers.map((c) => ({ group: `child ${c}`, rows: nights.filter((n) => n.child === c) })),
    { group: 'overall', rows: nights },
  ].map(({ group, rows }) => ({
    group,
    fitted: summarise(rows.filter((n) => n.set === 'fitted')),
    unseen: summarise(rows.filter((n) => n.set === 'unseen')),
  }));
  const statuses = {};
  for (const n of nights) statuses[n.status ?? 'unknown'] = (statuses[n.status ?? 'unknown'] || 0) + 1;
  return {
    ...meta,
    thresholds_min: THRESHOLDS_MIN,
    excluded,
    scored_nights: nights.length,
    status_counts: statuses,
    groups,
    nights: nights.map((n) => ({
      child: n.child, night: n.night, set: n.set, status: n.status,
      err_min: Object.fromEntries(FIELDS.map((f) => [f, round1(n.err[f])])),
      truth_given: Object.fromEntries(FIELDS.map((f) => [f, n.truth[f] != null])),
    })),
  };
}

// ---- rendering --------------------------------------------------------------------------------------

const pct = (s) => (s.n_truth ? `${s.within_pct}% (${s.within}/${s.n_truth})` : '-');
const med = (s) => (s.n_scored ? `${s.median_abs_min} / ${s.mean_abs_min}` : '-');

/** The report as Markdown: a header that says how not to read it, one table, a ledger row. */
export function renderMarkdown(report) {
  const L = [];
  const ex = report.excluded;
  L.push('# Sleep accuracy scoreboard');
  L.push('');
  L.push('**How to read this.** Reviewed nights are not a random sample: they are the nights someone checked. '
    + '"fitted-to" nights (reviewed at or before the split) shaped our thresholds, so that set flatters us. '
    + 'Only "unseen" measures progress, and it is small: read its n before its percentages.');
  L.push('');
  L.push(`- Snapshot: \`${report.db}\`${report.label ? `, label: ${report.label}` : ''}`);
  L.push(`- Recomputed at (frozen clock): ${report.clock} (${report.clock_source}); timezone in the snapshot: ${report.timezone}`);
  L.push(`- Split: fitted-to = reviewed at or before ${report.unseen_after}; unseen = after it`);
  L.push(`- Scored ${report.scored_nights} reviewed nights. Excluded: ${ex.dismissed} dismissed, `
    + `${ex.nobody_in_bed} "nobody in the bed", ${ex.no_true_time} with no true time`
    + `${ex.unknown_child ? `, ${ex.unknown_child} for a child no longer in the database` : ''}, `
    + `${ex.no_data} with no activity data in the snapshot (older than the 30-day retention, or the camera was not watched: cannot be recomputed).`);
  L.push(`- Within = |computed - true| at most ${report.thresholds_min.in_bed} min (in-bed), ${report.thresholds_min.onset} min (onset), `
    + `${report.thresholds_min.wake} min (wake). A night the app left blank counts as a miss. Median / mean are absolute minutes over nights where both times exist.`);
  L.push('');
  L.push('| Group | Set | Nights | In-bed within | Onset within | Wake within | In-bed med / mean | Onset med / mean | Wake med / mean | Wake blank | Wake off by > 60 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|');
  const small = [];
  for (const g of report.groups) {
    for (const set of ['fitted', 'unseen']) {
      const s = g[set];
      const flag = s.nights > 0 && s.nights < SMALL_SET ? '*' : '';
      if (flag) small.push(`${g.group} ${set} (n=${s.nights})`);
      L.push(`| ${g.group} | ${set === 'fitted' ? 'fitted-to' : 'unseen'} | ${s.nights}${flag} | ${pct(s.fields.in_bed)} | ${pct(s.fields.onset)} | ${pct(s.fields.wake)} `
        + `| ${med(s.fields.in_bed)} | ${med(s.fields.onset)} | ${med(s.fields.wake)} | ${s.wake_null} | ${s.wake_over_60} |`);
    }
  }
  L.push('');
  if (small.length) L.push(`\\* Fewer than ${SMALL_SET} nights: ${small.join('; ')}. Do not read a trend from these.`);
  L.push('');
  const overall = report.groups[report.groups.length - 1];
  const cell = (s) => `${s.nights} | ${pct(s.fields.in_bed)} | ${pct(s.fields.onset)} | ${pct(s.fields.wake)} | ${med(s.fields.wake)} | ${s.wake_null} | ${s.wake_over_60}`;
  L.push('Ledger row (overall; append to a file kept outside the repo):');
  L.push('');
  L.push('| Label | Clock | Unseen n | in-bed | onset | wake | wake med / mean | blank | > 60 | Fitted n | in-bed | onset | wake | wake med / mean | blank | > 60 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  L.push(`| ${report.label || report.db} | ${report.clock} | ${cell(overall.unseen)} | ${cell(overall.fitted)} |`);
  return `${L.join('\n')}\n`;
}

// ---- running against a real snapshot ---------------------------------------------------------------

const REVIEW_SQL = `
  SELECT r.child_id, r.night_date, r.dismissed, r.nobody_in_bed, r.reviewed_at,
         COALESCE(r.true_in_bed_at, (SELECT t.created_at FROM bed_transitions t WHERE t.id = r.true_in_bed_transition_id)) AS true_in_bed_at,
         COALESCE(r.true_onset_at,  (SELECT t.created_at FROM bed_transitions t WHERE t.id = r.true_onset_transition_id))  AS true_onset_at,
         COALESCE(r.true_wake_at,   (SELECT t.created_at FROM bed_transitions t WHERE t.id = r.true_wake_transition_id))   AS true_wake_at
    FROM sleep_reviews r
   ORDER BY r.child_id, r.night_date`;

/**
 * Recompute every reviewed night of `dbPath` with the backend in `backendDir` and score it.
 * Never touches `dbPath` beyond reading it; see the header.
 */
export async function runScoreboard({ dbPath, clockMs, clockSource, unseenAfter, backendDir, label }) {
  if (!fs.existsSync(dbPath)) throw new Error(`no such snapshot: ${dbPath}`);
  if (!fs.existsSync(path.join(backendDir, 'src', 'lib', 'sleepAnalysis.js'))) throw new Error(`not a nightlight backend: ${backendDir}`);
  if (!fs.existsSync(path.join(backendDir, 'node_modules'))) throw new Error(`${backendDir} has no node_modules (run npm ci there first)`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-scoreboard-'));
  const RealDate = globalThis.Date;
  const priorDataDir = process.env.DATA_DIR;
  let db = null;
  try {
    fs.copyFileSync(dbPath, path.join(work, 'babymonitor.db'));
    if (fs.existsSync(`${dbPath}-wal`)) fs.copyFileSync(`${dbPath}-wal`, path.join(work, 'babymonitor.db-wal'));
    process.env.DATA_DIR = work;
    let frozen = clockMs;
    // Same technique as the #669 A/B harness: only the no-argument constructor and now() are frozen, so
    // date arithmetic and parsing keep working. It is installed BEFORE the backend is imported.
    // The no-argument constructor is frozen too although computeNight today reads only Date.now() (a mutant
    // that unfreezes just the constructor survives every test, so it is a known-equivalent one): a future
    // `new Date()` on that path must not quietly score against the real clock.
    globalThis.Date = class FrozenDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(frozen); else super(...args); }
      static now() { return frozen; }
    };
    const imp = (rel) => import(pathToFileURL(path.join(backendDir, 'src', rel)).href);
    const sa = await imp('lib/sleepAnalysis.js');
    db = (await imp('db.js')).default;

    const children = db.prepare('SELECT id FROM children ORDER BY created_at, id').all();
    const childNo = new Map(children.map((c, i) => [c.id, i + 1]));
    const timezone = (db.prepare('SELECT timezone FROM settings LIMIT 1').get() || {}).timezone || 'UTC';
    const reviews = db.prepare(REVIEW_SQL).all();
    const scored = scoreReviews(reviews, {
      childNo,
      compute: (childId, night) => sa.computeNight(childId, night),
      unseenAfterMs: parseInstant(unseenAfter),
    });
    return buildReport(scored, {
      db: path.basename(dbPath),
      label: label || null,
      clock: new RealDate(clockMs).toISOString(),
      clock_source: clockSource,
      unseen_after: new RealDate(parseInstant(unseenAfter)).toISOString(),
      timezone,
    });
  } finally {
    globalThis.Date = RealDate;
    try { db?.close(); } catch { /* already closed */ }
    if (priorDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = priorDataDir;
    // Only the directory this call made, under the OS temp dir: nothing the caller owns is removed.
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp dir, harmless */ }
  }
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const insideRepo = (p) => {
  const rel = path.relative(REPO_ROOT, path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

async function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) {
    console.error(`scoreboard: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.out && insideRepo(args.out)) {
    console.error(`scoreboard: refusing to write ${args.out} inside the repository; keep the ledger outside it`);
    return 2;
  }
  const dbPath = path.resolve(args.db);
  let clockMs;
  let clockSource;
  if (args.clock != null) { clockMs = parseInstant(args.clock); clockSource = '--clock'; } else {
    try { clockMs = fs.statSync(dbPath).mtimeMs; } catch { console.error(`scoreboard: no such snapshot: ${dbPath}`); return 2; }
    clockSource = 'snapshot file modification time';
  }
  let report;
  try {
    report = await runScoreboard({
      dbPath, clockMs, clockSource, unseenAfter: args.unseenAfter, label: args.label,
      backendDir: path.resolve(args.backend || path.join(REPO_ROOT, 'backend')),
    });
  } catch (e) {
    console.error(`scoreboard: ${e.message}`);
    return 1;
  }
  const text = args.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
  if (args.out) fs.writeFileSync(args.out, text); else process.stdout.write(text);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
