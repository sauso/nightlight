#!/usr/bin/env node
// REPLAY STORED NIGHTS: re-run the backend's own sleep scoring over a database snapshot and show what moved. Read-only.
//
//   node scripts/replay-nights.mjs compare <oldBackendDir> <newBackendDir> <snapshot> [--whole] [--clock=<ISO>] [--tz=<Zone>]
//   node scripts/replay-nights.mjs drift   <backendDir> <snapshot> [--threshold=<min>] [--limit=<n>] [--clock=<ISO>] [--tz=<Zone>]
//   node scripts/replay-nights.mjs night   <backendDir> <snapshot> <YYYY-MM-DD> [--child=<1|2|...>] [--clock=<ISO>] [--tz=<Zone>]
//   node scripts/replay-nights.mjs rewrite <backendDir> <snapshot> [--clock=<ISO>] [--tz=<Zone>]
//
//   <snapshot>   a SQLite file, or a folder holding babymonitor.db (with its -wal and -shm, as the host-snapshot and
//                evidence scripts leave it). It is only ever READ, once, to make a copy.
//   <...Dir>     a backend/ directory with its dependencies installed (npm ci). To compare against the last release,
//                make a second checkout of that tag (git worktree) and install it there.
//   --clock      the instant "now" is frozen at while nights are recomputed. Default: the snapshot file's modification
//                time (a `cp -p` copy keeps it; a plain copy does not, so pass --clock then). Matters only for a night
//                still in progress. A time with no zone is read as UTC, the way the database stores times.
//   --tz         the IANA zone times are PRINTED in (default UTC). Nothing is assumed about where you live.
//
// ## Why this exists
// Every sleep change so far was judged by replaying real nights with the old and the new code, and each time the
// harness was rewritten from scratch in a scratch folder. This is that harness, kept. It does not duplicate any
// scoring: it loads the backend's OWN computeNight (and, for `rewrite`, sleepRewrite), so what it shows is what the
// app would do. Run it on BOTH the production and the staging snapshot: the two run independent detectors against the
// same cameras, so their activity samples differ and a change that is harmless on one has failed on the other before
// (0.27.0's empty-bed guard, 2026-08-27). `scripts/scoreboard.mjs` answers a different question (how far is the fresh
// answer from what a parent said); this answers "what did my change move".
//
// ## What each mode does
//  * compare  every stored night, computed by the OLD and the NEW backend; prints only the nights where anything
//             differs (status, onset, in bed, wake, minutes, wake count) beside what the parent said when they
//             reviewed it, then the counts. --whole compares the entire result (timeline included, `scoring_context`
//             left out because it carries the rules label by design) and says which top-level keys differ, and
//             lists any night whose onset and in-bed time did not move but something else did.
//  * drift    for every stored `ok` night: the STORED answer (what the child's card shows) against a FRESH recompute
//             (what the detail page shows), the nights where either time differs by more than --threshold minutes
//             (default 10), and the parent's own time where the night was reviewed.
//  * night    one night's wake-related fields and its bed transitions (a debugging view; `--child` is the child's
//             position in creation order, default 1).
//  * rewrite  the admin "Update past nights" action (lib/sleepRewrite.js) on the copy: preview twice (same hash, wrote
//             nothing), apply, undo, apply again; prints the counts, the changes, the time it took and whether undo
//             put every stored row back exactly. The real run, on a copy: the evidence the in-app check will show.
//
// ## Why it cannot damage the snapshot
// The snapshot (and -wal/-shm beside it) is copied into a fresh temp directory and the backend is pointed at THAT:
// the backend's db.js migrates and switches to WAL on open, which writes. The original is never opened by SQLite
// here. The temp directory is deleted at the end. Child labels are "child 1", "child 2" by creation order: a name is
// never read or printed.
//
// ## Limits (said plainly)
// The clock is frozen for JavaScript (`Date.now`, `new Date()`), not for SQLite's `datetime('now')`. Nights older
// than the 30-day minute-data retention come back `no_data` on a recent snapshot and cannot be replayed. The old and
// the new backend each open their own copy, so a migration the NEW one adds is applied to its copy only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseInstant } from './scoreboard.mjs';

const MODES = ['compare', 'drift', 'night', 'rewrite'];
export const USAGE = [
  'usage: node scripts/replay-nights.mjs compare <oldBackendDir> <newBackendDir> <snapshot> [--whole] [--clock=<ISO>] [--tz=<Zone>]',
  '       node scripts/replay-nights.mjs drift   <backendDir> <snapshot> [--threshold=<min>] [--limit=<n>] [--clock=<ISO>] [--tz=<Zone>]',
  '       node scripts/replay-nights.mjs night   <backendDir> <snapshot> <YYYY-MM-DD> [--child=<n>] [--clock=<ISO>] [--tz=<Zone>]',
  '       node scripts/replay-nights.mjs rewrite <backendDir> <snapshot> [--clock=<ISO>] [--tz=<Zone>]',
].join('\n');

/** Parse argv (without node and the script). Throws an Error whose message names the bad argument. */
export function parseArgs(argv) {
  const out = { mode: null, args: [], clock: null, tz: 'UTC', whole: false, threshold: 10, limit: 30, child: 1, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--whole') out.whole = true;
    else if (a.startsWith('--clock=')) {
      if (parseInstant(a.slice(8)) == null) throw new Error(`--clock needs an ISO time, got ${a.slice(8)}`);
      out.clock = a.slice(8);
    } else if (a.startsWith('--tz=')) {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: a.slice(5) }); } catch { throw new Error(`--tz needs an IANA zone such as Europe/London, got ${a.slice(5)}`); }
      out.tz = a.slice(5);
    } else if (a.startsWith('--threshold=')) {
      const n = Number(a.slice(12));
      if (!Number.isFinite(n) || n < 0) throw new Error(`--threshold needs minutes, got ${a.slice(12)}`);
      out.threshold = n;
    } else if (a.startsWith('--limit=')) {
      const n = Number(a.slice(8));
      if (!Number.isInteger(n) || n < 0) throw new Error(`--limit needs a whole number, got ${a.slice(8)}`);
      out.limit = n;
    } else if (a.startsWith('--child=')) {
      const n = Number(a.slice(8));
      if (!Number.isInteger(n) || n < 1) throw new Error(`--child needs 1 or more, got ${a.slice(8)}`);
      out.child = n;
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else if (out.mode == null) out.mode = a;
    else out.args.push(a);
  }
  if (out.help) return out;
  if (!MODES.includes(out.mode)) throw new Error(`the first argument must be one of ${MODES.join(', ')}`);
  const need = { compare: 3, drift: 2, night: 3, rewrite: 2 }[out.mode];
  if (out.args.length !== need) throw new Error(`${out.mode} takes ${need} arguments, got ${out.args.length}`);
  if (out.mode === 'night' && !/^\d{4}-\d{2}-\d{2}$/.test(out.args[2])) throw new Error(`night needs a date like 2026-11-24, got ${out.args[2]}`);
  return out;
}

/** "MM-DD HH:mm" in `tz` for a database time, or "--" for none. */
export function localTime(value, tz) {
  const ms = parseInstant(value);
  if (ms == null) return '--';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

const minutesBetween = (a, b) => Math.round((parseInstant(a) - parseInstant(b)) / 60000);

function snapshotFile(arg) {
  const file = fs.existsSync(arg) && fs.statSync(arg).isDirectory() ? path.join(arg, 'babymonitor.db') : arg;
  if (!fs.existsSync(file)) throw new Error(`no such snapshot: ${arg}`);
  return file;
}

/**
 * Open `backendDir` against a fresh COPY of the snapshot with the clock frozen. Returns what a mode needs and a
 * `close()` that restores the clock, closes the database and removes the copy.
 */
async function openBackend(backendDir, dbFile, clockMs, wantRewrite = false) {
  const entry = path.join(path.resolve(backendDir), 'src', 'lib', 'sleepAnalysis.js');
  if (!fs.existsSync(entry)) throw new Error(`${backendDir} is not a backend directory (no src/lib/sleepAnalysis.js)`);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-replay-'));
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, path.join(work, `babymonitor.db${suffix}`));
  }
  const RealDate = globalThis.Date;
  // Same technique as scoreboard.mjs: only the no-argument constructor and now() are frozen.
  globalThis.Date = class FrozenDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(clockMs); else super(...args); }
    static now() { return clockMs; }
  };
  process.env.DATA_DIR = work;
  const imp = (rel) => import(pathToFileURL(path.join(path.resolve(backendDir), 'src', rel)).href + `?replay=${Math.random()}`);
  let sa; let db; let rewrite = null;
  try {
    sa = await imp('lib/sleepAnalysis.js');
    db = (await imp('db.js')).default;
    if (wantRewrite) {
      if (!fs.existsSync(path.join(path.resolve(backendDir), 'src', 'lib', 'sleepRewrite.js'))) {
        throw new Error(`${backendDir} has no src/lib/sleepRewrite.js: that backend predates "Update past nights"`);
      }
      rewrite = await imp('lib/sleepRewrite.js');
    }
  } catch (e) {
    globalThis.Date = RealDate;
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp dir */ }
    throw e;
  }
  return {
    sa, db, rewrite, RealDate,
    close() {
      globalThis.Date = RealDate;
      try { db.close(); } catch { /* already closed */ }
      try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* temp dir, harmless (Windows can hold the file) */ }
    },
  };
}

const childLabels = (db) => new Map(db.prepare('SELECT id FROM children ORDER BY created_at, id').all().map((c, i) => [c.id, `child ${i + 1}`]));
const storedNights = (db) => db.prepare('SELECT DISTINCT child_id, night_date FROM sleep_nights ORDER BY child_id, night_date').all();
const reviewTimes = (db) => new Map(db.prepare(`
  SELECT r.child_id, r.night_date,
         COALESCE(r.true_in_bed_at, (SELECT t.created_at FROM bed_transitions t WHERE t.id = r.true_in_bed_transition_id)) AS in_bed,
         COALESCE(r.true_onset_at,  (SELECT t.created_at FROM bed_transitions t WHERE t.id = r.true_onset_transition_id))  AS onset,
         COALESCE(r.true_wake_at,   (SELECT t.created_at FROM bed_transitions t WHERE t.id = r.true_wake_transition_id))   AS wake
    FROM sleep_reviews r WHERE r.nobody_in_bed IS NOT 1`).all().map((r) => [`${r.child_id}|${r.night_date}`, r]));

function computeAll(sa, nights, whole) {
  const out = new Map();
  for (const n of nights) {
    let r;
    try { r = sa.computeNight(n.child_id, n.night_date, whole ? { includeTimeline: true } : undefined); } catch (e) { r = { status: `ERR ${String(e.message).slice(0, 60)}` }; }
    if (whole) { const { scoring_context: _ignored, ...rest } = r; out.set(`${n.child_id}|${n.night_date}`, rest); } else {
      out.set(`${n.child_id}|${n.night_date}`, {
        status: r.status, onset: r.onset_at, in_bed: r.in_bed_at, wake: r.wake_at, asleep: r.asleep_minutes, awake: r.awake_minutes, wakes: r.wake_count,
      });
    }
  }
  return out;
}

async function compare(a, dbFile, clockMs) {
  const oldB = await openBackend(a.args[0], dbFile, clockMs);
  let nights; let labels; let reviews; let before;
  try {
    nights = storedNights(oldB.db); labels = childLabels(oldB.db); reviews = reviewTimes(oldB.db);
    before = computeAll(oldB.sa, nights, a.whole);
  } finally { oldB.close(); }
  const newB = await openBackend(a.args[1], dbFile, clockMs);
  let after;
  try { after = computeAll(newB.sa, nights, a.whole); } finally { newB.close(); }
  let changed = 0; const unmovedButDifferent = []; const keyCount = {};
  for (const n of nights) {
    const key = `${n.child_id}|${n.night_date}`;
    const x = before.get(key); const y = after.get(key);
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    changed++;
    const rv = reviews.get(key);
    if (a.whole) {
      const keys = Object.keys({ ...x, ...y }).filter((k) => JSON.stringify(x[k]) !== JSON.stringify(y[k]));
      const moved = x.onset_at !== y.onset_at || x.in_bed_at !== y.in_bed_at;
      if (moved) for (const k of keys) keyCount[k] = (keyCount[k] || 0) + 1; else unmovedButDifferent.push(`${labels.get(n.child_id)} ${n.night_date}: ${keys.join(', ')}`);
      console.log(`${labels.get(n.child_id)} ${n.night_date} differs in: ${keys.join(', ')}${moved ? ' (onset or in-bed moved)' : ''}`);
    } else {
      const fmt = (s) => ({ ...s, onset: localTime(s.onset, a.tz), in_bed: localTime(s.in_bed, a.tz), wake: localTime(s.wake, a.tz) });
      console.log(JSON.stringify({
        child: labels.get(n.child_id), night: n.night_date, old: fmt(x), new: fmt(y),
        parent: rv ? { in_bed: localTime(rv.in_bed, a.tz), onset: localTime(rv.onset, a.tz), wake: localTime(rv.wake, a.tz) } : null,
      }));
    }
  }
  console.log(`times printed in ${a.tz}; nights compared: ${nights.length}; changed: ${changed}`);
  if (a.whole) {
    console.log(`nights whose onset and in-bed time did NOT move but something else did: ${unmovedButDifferent.length}`);
    for (const l of unmovedButDifferent) console.log(`  ${l}`);
    console.log(`keys differing on nights that moved: ${JSON.stringify(keyCount)}`);
  }
}

async function drift(a, dbFile, clockMs) {
  const b = await openBackend(a.args[0], dbFile, clockMs);
  try {
    const labels = childLabels(b.db); const reviews = reviewTimes(b.db);
    const nights = b.db.prepare("SELECT child_id, night_date, onset_at, wake_at FROM sleep_nights WHERE status = 'ok' ORDER BY night_date").all();
    let n = 0; let wakeDiff = 0; let onsetDiff = 0; const lines = [];
    const sign = (v) => (v > 0 ? `+${v}` : `${v}`);
    for (const s of nights) {
      let f;
      try { f = b.sa.computeNight(s.child_id, s.night_date); } catch { continue; }
      if (!f || f.status !== 'ok') continue;
      n++;
      const dw = s.wake_at && f.wake_at ? minutesBetween(f.wake_at, s.wake_at) : null;
      const dO = s.onset_at && f.onset_at ? minutesBetween(f.onset_at, s.onset_at) : null;
      const wakeOff = dw != null && Math.abs(dw) > a.threshold; const onsetOff = dO != null && Math.abs(dO) > a.threshold;
      if (wakeOff) wakeDiff++;
      if (onsetOff) onsetDiff++;
      if (!wakeOff && !onsetOff) continue;
      const r = reviews.get(`${s.child_id}|${s.night_date}`);
      lines.push(`${labels.get(s.child_id)} ${s.night_date}: wake stored ${localTime(s.wake_at, a.tz)} fresh ${localTime(f.wake_at, a.tz)} (${dw == null ? 'n/a' : sign(dw)})`
        + `${r?.wake ? ` parent ${localTime(r.wake, a.tz)}` : ''} | onset stored ${localTime(s.onset_at, a.tz)} fresh ${localTime(f.onset_at, a.tz)} (${dO == null ? 'n/a' : sign(dO)})`
        + `${r?.onset ? ` parent ${localTime(r.onset, a.tz)}` : ''}`);
    }
    console.log(`stored ok nights recomputed: ${n}; fresh wake differs from stored by more than ${a.threshold} min on ${wakeDiff}; fresh onset on ${onsetDiff} (times in ${a.tz})`);
    for (const l of lines.slice(-a.limit)) console.log(`  ${l}`);
  } finally { b.close(); }
}

async function night(a, dbFile, clockMs) {
  const b = await openBackend(a.args[0], dbFile, clockMs);
  try {
    const kids = b.db.prepare('SELECT id FROM children ORDER BY created_at, id').all();
    const kid = kids[a.child - 1];
    if (!kid) throw new Error(`the snapshot has ${kids.length} child(ren); --child=${a.child} does not exist`);
    const r = b.sa.computeNight(kid.id, a.args[2], { includeTimeline: false });
    const out = {};
    for (const k of ['status', 'onset_at', 'in_bed_at', 'wake_at', 'wake_at_algo', 'wake_at_shadow', 'wake_unconfirmed', 'span_basis', 'wake_at_sensor', 'sensor_rejects']) {
      if (!(k in r)) continue;
      const v = r[k];
      out[k] = /_at$/.test(k) && typeof v === 'string' ? localTime(v, a.tz) : (k === 'wake_unconfirmed' && v?.at ? { ...v, at: localTime(v.at, a.tz) } : v);
    }
    console.log(`child ${a.child}, night ${a.args[2]} (times in ${a.tz})`);
    console.log(JSON.stringify(out));
    console.log(`transitions in the result: ${JSON.stringify((r.transitions || []).map((t) => ({ at: localTime(t.at || t.created_at, a.tz), type: t.type, status: t.status, verdict: t.verdict })))}`);
    const rows = b.db.prepare(`SELECT type, created_at, out_frames, peak, verdict FROM bed_transitions
      WHERE camera_id IN (SELECT id FROM cameras WHERE child_id = ?) AND created_at >= ? AND created_at <= ? ORDER BY created_at`)
      .all(kid.id, r.window_start || `${a.args[2]} 00:00:00`, r.window_end || `${a.args[2]} 23:59:59`);
    console.log(`stored transitions inside the night's window: ${rows.map((t) => `${localTime(t.created_at, a.tz)} ${t.type} f${t.out_frames} p${t.peak} ${t.verdict ?? ''}`.trim()).join(' | ') || 'none'}`);
  } finally { b.close(); }
}

async function rewrite(a, dbFile, clockMs) {
  const b = await openBackend(a.args[0], dbFile, clockMs, true);
  try {
    const labels = childLabels(b.db);
    const snapshotRows = () => JSON.stringify(b.db.prepare('SELECT * FROM sleep_nights ORDER BY child_id, night_date').all());
    const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
    const original = snapshotRows();
    // performance.now(), not Date.now(): the clock is frozen above, so Date would time every step as 0 ms.
    const t0 = performance.now(); const first = b.rewrite.rewritePastNights({ apply: false }); const previewMs = Math.round(performance.now() - t0);
    const wroteNothing = snapshotRows() === original;
    const second = b.rewrite.rewritePastNights({ apply: false });
    console.log(`stored nights: ${b.db.prepare('SELECT COUNT(*) AS n FROM sleep_nights').get().n}; times in ${a.tz}`);
    console.log(`preview ${previewMs} ms; same hash twice: ${first.preview === second.preview}; the preview wrote nothing: ${wroteNothing}`);
    console.log(`would change ${first.changed} night(s): ${first.figures_changed} in their figures, ${first.facts_only} facts only`);
    for (const c of first.children) {
      console.log(`${labels.get(c.child_id) ?? 'child'}: changed ${c.changed.length}, unchanged ${c.unchanged}, skipped ${JSON.stringify(c.skipped)}`);
      for (const n of c.changed) {
        console.log(`  ${n.night_date} ${n.figures_changed ? 'figures' : 'facts  '} onset ${localTime(n.before.onset_at, a.tz)} -> ${localTime(n.after.onset_at, a.tz)}`
          + ` | wake ${localTime(n.before.wake_at, a.tz)} -> ${localTime(n.after.wake_at, a.tz)} | asleep ${n.before.asleep_minutes} -> ${n.after.asleep_minutes} | wakes ${n.before.wake_count} -> ${n.after.wake_count}`);
      }
    }
    const t1 = performance.now(); const applied = b.rewrite.rewritePastNights({ apply: true, expect: first.preview }); const applyMs = Math.round(performance.now() - t1);
    console.log(`apply ${applyMs} ms; changed ${applied.changed}; same as the preview: ${applied.preview === first.preview}`);
    const latest = b.rewrite.latestRewrite();
    if (!latest) { console.log('nothing was changed, so there is nothing to undo'); return; }
    const undone = b.rewrite.undoRewrite({ batchId: latest.batch_id });
    console.log(`undo restored ${undone.restored}, left ${JSON.stringify(undone.skipped)}; every stored row is back exactly as in the snapshot: ${snapshotRows() === original} (${hash(original)} vs ${hash(snapshotRows())})`);
    const again = b.rewrite.rewritePastNights({ apply: true, expect: b.rewrite.rewritePastNights({ apply: false }).preview });
    console.log(`a second update after the undo changed ${again.changed} (the first changed ${applied.changed})`);
  } finally { b.close(); }
}

/** Run with argv (without node and the script). Returns the process exit code. */
export async function main(argv) {
  let a;
  try { a = parseArgs(argv); } catch (e) { console.error(`replay-nights: ${e.message}\n${USAGE}`); return 2; }
  if (a.help) { console.log(USAGE); return 0; }
  try {
    const dbFile = snapshotFile(a.mode === 'compare' ? a.args[2] : a.args[1]);
    const clockMs = a.clock != null ? parseInstant(a.clock) : fs.statSync(dbFile).mtimeMs;
    await { compare, drift, night, rewrite }[a.mode](a, dbFile, clockMs);
    return 0;
  } catch (e) { console.error(`replay-nights: ${e.message}`); return 2; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
