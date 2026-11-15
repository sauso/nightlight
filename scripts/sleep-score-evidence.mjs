#!/usr/bin/env node
// SLEEP SCORE EVIDENCE: what would the sleep score (backend/src/lib/sleepScore.js) say about every stored night of
// a database snapshot? For tuning the curves and for a person to read against the nights they remember. It changes
// no behaviour and stores nothing: the score itself is not shown anywhere yet (sleep score plan, phase 1b).
//
//   node scripts/sleep-score-evidence.mjs <path-to-sqlite-snapshot>
//        [--clock=<ISO>] [--split=<YYYY-MM-DD>] [--recompute-stir] [--out=<file>] [--label=<text>] [--backend=<dir>]
//
//   --clock           the instant "now" is frozen at. Default: the snapshot file's modification time. It decides
//                     which night is still in progress and, with --recompute-stir, which nights still have samples.
//   --split           print the score spread separately for nights before this date and from it on. Use it when
//                     something changed in the room on a known date (a camera was moved or re-aimed). The date is
//                     an argument on purpose: nothing about one household's history belongs in the code.
//   --recompute-stir  ALSO recompute each night that has no stored stir count from the raw samples (kept about 30
//                     days) and use ONLY its stir RATE (stir minutes per minute asleep, applied to the stored
//                     night's asleep minutes), so the restlessness component can be looked at on nights stored
//                     before that column existed. ⚠️ Approximate, and labelled `stir*` on every line it touches:
//                     the recompute runs today's rules, whose sleep span can differ from the stored row's, and the
//                     value is written to the TEMPORARY COPY only.
//   --out             write the report to this file instead of stdout. REFUSED inside this repository.
//   --label           free text carried into the header ("prod", "staging").
//   --backend         the backend/ directory whose scoring code to run. Default: this checkout's.
//
// ## Why it cannot damage the snapshot (the same handling as scripts/scoreboard.mjs)
// The snapshot (and its -wal, if one sits beside it) is copied into a fresh temp directory and the backend is
// pointed at the copy; db.js migrates and sets WAL mode on open, so it is never handed the original. The clock is
// frozen for JS before the backend loads. The temp directory is deleted at the end.
//
// ## How to read it
//  * Children are printed as the first 6 characters of their id. A name is never read.
//  * One line per stored night: the score, its band (or `early` for an early estimate, which has no band word),
//    each component's score (`-` = unavailable), what capped it, the figures that went in, and the flags.
//  * "Baseline" lines show, for each night, how many usable values stood behind each metric's median and the
//    median itself; `*` marks a metric that is ready (7 or more). Read these for the nights after a change in the
//    room: they show how long the old nights keep shaping "usual".
//  * This is ONE household's evidence however many snapshots it is run on, if they hold the same children and
//    cameras. Every curve it helped set is a starting value.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = [
  'usage: node scripts/sleep-score-evidence.mjs <path-to-sqlite-snapshot> [--clock=<ISO>] [--split=<YYYY-MM-DD>]',
  '                                             [--recompute-stir] [--out=<file>] [--label=<text>] [--backend=<dir>]',
].join('\n');

// How far back --recompute-stir reaches. One day inside the 30-day sample retention (activityTracker.js), so the
// oldest night asked for still has its whole window.
export const RECOMPUTE_DAYS = 29;
const COMPONENTS = ['duration', 'continuity', 'settling', 'restlessness', 'consistency'];
const BASELINE_KEYS = ['asleep', 'efficiency', 'wake_count', 'longest_share', 'settle_minutes', 'stir_rate', 'onset_clock', 'wake_clock'];

/** Epoch ms for an ISO instant or a zone-less database time (read as UTC), else null. */
export function parseInstant(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  const bare = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/.exec(s);
  const iso = bare ? `${bare[1]}T${bare[2] || '00:00:00'}Z` : s;
  if (!bare && !/(Z|[+-]\d{2}:?\d{2})$/.test(iso)) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Parse argv (without node and the script). Throws an Error naming the bad argument. */
export function parseArgs(argv) {
  const out = { db: null, clock: null, split: null, recomputeStir: false, out: null, label: null, backend: null, help: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--recompute-stir') out.recomputeStir = true;
    else if (/^--(clock|split|out|label|backend)=./.test(a)) {
      const eq = a.indexOf('=');
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--')) {
      // A flag typo must not be silently ignored: a mistyped --split would print one spread and look complete.
      throw new Error(`unknown or incomplete option: ${a}`);
    } else if (out.db == null) out.db = a;
    else throw new Error(`unexpected extra argument: ${a}`);
  }
  if (!out.help && out.db == null) throw new Error('missing the path to the SQLite snapshot');
  if (out.clock != null && parseInstant(out.clock) == null) throw new Error(`--clock is not a time: ${out.clock}`);
  if (out.split != null && !/^\d{4}-\d{2}-\d{2}$/.test(out.split)) throw new Error(`--split is not a date (YYYY-MM-DD): ${out.split}`);
  return out;
}

// ---- totals (pure: no database, no clock) -----------------------------------------------------------------

const medianOf = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function spread(records) {
  const scores = records.map((r) => r.result.score);
  const bands = { great: 0, good: 0, fair: 0, none: 0, early: 0 };
  for (const r of records) bands[r.result.early_estimate ? 'early' : (r.result.band ?? 'none')]++;
  return { nights: scores.length, min: scores.length ? Math.min(...scores) : null, median: medianOf(scores), max: scores.length ? Math.max(...scores) : null, bands };
}

/**
 * Totals over the per-night records.
 *
 * @param records  [{ child, date, status, in_bed_at, result }] where `result` is scoreNight's return value
 * @param split    'YYYY-MM-DD' or null: also give each child's spread before it and from it on
 */
export function summarise(records, { split = null } = {}) {
  const scored = records.filter((r) => r.result.score != null);
  const notScored = {};
  for (const r of records) if (r.result.score == null) notScored[r.result.reason] = (notScored[r.result.reason] || 0) + 1;

  const components = {};
  for (const key of COMPONENTS) {
    const reasons = {};
    let unavailable = 0;
    for (const r of scored) {
      const c = r.result.components.find((x) => x.key === key);
      if (c.available) continue;
      unavailable++;
      reasons[c.reason] = (reasons[c.reason] || 0) + 1;
    }
    components[key] = { unavailable, of: scored.length, reasons };
  }

  const children = [...new Set(records.map((r) => r.child))].sort();
  const perChild = children.map((child) => {
    const mine = scored.filter((r) => r.child === child);
    const row = { child, all: spread(mine) };
    if (split) {
      row.before = spread(mine.filter((r) => r.date < split));
      row.from = spread(mine.filter((r) => r.date >= split));
    }
    return row;
  });

  // The put-down is judged on `ok` nights only: no other night has an onset for it to precede.
  const inBedOf = (set) => {
    const ok = set.filter((r) => r.status === 'ok');
    const missing = ok.filter((r) => !r.in_bed_at).length;
    return { ok_nights: ok.length, missing, rate: ok.length ? missing / ok.length : null };
  };
  const capped = {};
  for (const r of scored) if (r.result.capped_by) capped[r.result.capped_by] = (capped[r.result.capped_by] || 0) + 1;

  return {
    nights: records.length,
    scored: scored.length,
    not_scored: notScored,
    components,
    per_child: perChild,
    // With a split, the two sides apart: nights stored before the put-down was recorded at all have none, and
    // would otherwise drown the rate that matters (how often it is missing now).
    in_bed: {
      all: inBedOf(records),
      ...(split ? { before: inBedOf(records.filter((r) => r.date < split)), from: inBedOf(records.filter((r) => r.date >= split)) } : {}),
    },
    capped,
    flags: {
      provisional: scored.filter((r) => r.result.provisional).length,
      low_confidence: scored.filter((r) => r.result.low_confidence).length,
      early_estimate: scored.filter((r) => r.result.early_estimate).length,
    },
  };
}

// ---- rendering ----------------------------------------------------------------------------------------------

const n1 = (v) => (v == null ? '-' : String(Math.round(v * 10) / 10));
const n2 = (v) => (v == null ? '-' : v.toFixed(2));
const comp = (result, key) => result.components.find((c) => c.key === key);
const sc = (c) => (c && c.available ? String(c.score) : '-');

function nightLine(r) {
  const head = `${r.child} ${r.date}`;
  if (r.result.score == null) return `${head}   --  ${r.result.reason}${r.result.status ? ` (${r.result.status})` : ''}`;
  const res = r.result;
  const m = r.input.metrics;
  const cont = comp(res, 'continuity');
  const t = (k) => sc(cont.terms.find((x) => x.key === k));
  const dur = comp(res, 'duration');
  const flags = [res.provisional && 'provisional', res.low_confidence && `low(${res.low_confidence_reasons.join(',')})`, r.input.corrected && 'corrected', r.stirRecomputed && 'stir*']
    .filter(Boolean).join(' ');
  return [
    `${head}  ${String(res.score).padStart(3)} ${(res.early_estimate ? 'early' : res.band ?? '-').padEnd(5)}`,
    `dur ${sc(dur)} cont ${sc(cont)} (eff ${t('efficiency')} long ${t('longest_share')} wakes ${t('wake_count')}) settle ${sc(comp(res, 'settling'))} rest ${sc(comp(res, 'restlessness'))} cons ${sc(comp(res, 'consistency'))}`,
    `cap ${res.capped_by ?? '-'}`,
    `asleep ${n1(m.asleep.value)} ref ${n1(dur.usual)} awake ${n1(m.awake_minutes.value)} wakes ${n1(m.wake_count.value)} eff ${n2(m.efficiency.value)} longest ${n1(r.input.longest_stretch_display)} share ${n2(m.longest_share.value)} settle ${n1(m.settle_minutes.value)} stir/h ${n1(m.stir_rate.value)} unwatched ${r.input.unknown_minutes}`,
    flags || '-',
  ].join(' | ');
}

function baselineLine(r) {
  const b = r.baseline.metrics;
  const cell = (k) => `${k} ${k === 'efficiency' || k === 'longest_share' ? n2(b[k].median) : n1(b[k].median)}(${b[k].n}${b[k].ready ? '*' : ''})`;
  return `${r.child} ${r.date} nights ${r.baseline.nights} | ${BASELINE_KEYS.map(cell).join(' ')}`;
}

const spreadText = (s) =>
  (s.nights ? `n=${s.nights} min ${s.min} median ${n1(s.median)} max ${s.max}; great ${s.bands.great} good ${s.bands.good} fair ${s.bands.fair} no word ${s.bands.none} early estimate ${s.bands.early}` : 'n=0');

export function renderReport(report) {
  const L = [];
  const t = report.totals;
  L.push('# Sleep score evidence');
  L.push('');
  L.push(`- Snapshot: ${report.db}${report.label ? `, label: ${report.label}` : ''}`);
  L.push(`- Frozen clock: ${report.clock} (${report.clock_source}); score version ${report.version}`);
  L.push(`- Stir counts: ${report.recomputed_stir == null ? 'stored only' : `stored, plus ${report.recomputed_stir} nights RECOMPUTED from raw samples (marked stir*, approximate)`}`);
  if (report.split) L.push(`- Split: before ${report.split} / from ${report.split}`);
  L.push('');
  L.push('## Nights');
  for (const r of report.records) L.push(nightLine(r));
  L.push('');
  L.push('## Baseline behind each scored night (median(values), * = ready)');
  for (const r of report.records) if (r.result.score != null) L.push(baselineLine(r));
  L.push('');
  L.push('## Totals');
  L.push(`- Stored nights ${t.nights}; scored ${t.scored}; not scored: ${Object.entries(t.not_scored).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  L.push(`- Flags among scored nights: provisional ${t.flags.provisional}, low confidence ${t.flags.low_confidence}, early estimate ${t.flags.early_estimate}`);
  L.push(`- Capped: ${Object.entries(t.capped).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  for (const key of COMPONENTS) {
    const c = t.components[key];
    L.push(`- ${key} unavailable on ${c.unavailable} of ${c.of}${c.unavailable ? ` (${Object.entries(c.reasons).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}`);
  }
  const inBedText = (s) => `${s.missing} of ${s.ok_nights} ok nights${s.rate == null ? '' : ` (${Math.round(s.rate * 100)}%)`}`;
  L.push(`- Put-down (in_bed_at) missing on ${inBedText(t.in_bed.all)}`
    + `${t.in_bed.before ? `; before the split ${inBedText(t.in_bed.before)}; from the split ${inBedText(t.in_bed.from)}` : ''}`);
  for (const c of t.per_child) {
    L.push(`- Child ${c.child}: ${spreadText(c.all)}`);
    if (c.before) L.push(`  - before the split: ${spreadText(c.before)}`);
    if (c.from) L.push(`  - from the split: ${spreadText(c.from)}`);
  }
  return `${L.join('\n')}\n`;
}

// ---- running against a real snapshot ---------------------------------------------------------------------

const shiftDate = (dateStr, days) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** Score every stored night of `dbPath` with the backend in `backendDir`. Never touches `dbPath` beyond reading it. */
export async function runEvidence({ dbPath, clockMs, clockSource, split = null, recomputeStir = false, backendDir, label = null }) {
  if (!fs.existsSync(dbPath)) throw new Error(`no such snapshot: ${dbPath}`);
  if (!fs.existsSync(path.join(backendDir, 'src', 'lib', 'sleepScore.js'))) throw new Error(`not a nightlight backend with the sleep score: ${backendDir}`);
  if (!fs.existsSync(path.join(backendDir, 'node_modules'))) throw new Error(`${backendDir} has no node_modules (run npm ci there first)`);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nightlight-sleep-score-'));
  const RealDate = globalThis.Date;
  const priorDataDir = process.env.DATA_DIR;
  let db = null;
  try {
    fs.copyFileSync(dbPath, path.join(work, 'babymonitor.db'));
    if (fs.existsSync(`${dbPath}-wal`)) fs.copyFileSync(`${dbPath}-wal`, path.join(work, 'babymonitor.db-wal'));
    process.env.DATA_DIR = work;
    // Frozen BEFORE the backend is imported, the no-argument constructor too (scoreboard.mjs says why).
    globalThis.Date = class FrozenDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(clockMs); else super(...args); }
      static now() { return clockMs; }
    };
    const imp = (rel) => import(pathToFileURL(path.join(backendDir, 'src', rel)).href);
    const sa = await imp('lib/sleepAnalysis.js');
    const { applyCorrection } = await imp('lib/sleepReviews.js');
    const score = await imp('lib/sleepScore.js');
    const { sleepBaseline } = await imp('lib/sleepBaseline.js');
    db = (await imp('db.js')).default;

    const children = db.prepare('SELECT id, birthday FROM children ORDER BY created_at, id').all();
    const nightsOf = db.prepare('SELECT * FROM sleep_nights WHERE child_id = ? ORDER BY night_date');

    // --recompute-stir: fill the COPY's missing stir counts from a fresh compute, so the ordinary path below (the
    // real sleepBaseline, the real scoreNight) reads them like stored ones. Only `stir_minutes` is taken.
    const recomputed = new Set();
    if (recomputeStir) {
      const setStir = db.prepare('UPDATE sleep_nights SET stir_minutes = ? WHERE child_id = ? AND night_date = ?');
      const oldest = shiftDate(new RealDate(clockMs).toISOString().slice(0, 10), -RECOMPUTE_DAYS);
      for (const c of children) {
        for (const row of nightsOf.all(c.id)) {
          if (row.status !== 'ok' || row.stir_minutes != null || row.night_date < oldest) continue;
          // With the row's own saved settings when it has them, so the camera and window are the stored night's.
          const context = sa.parseScoringContext(row.scoring_context) ? row.scoring_context : null;
          const fresh = sa.computeNight(c.id, row.night_date, { context });
          if (fresh.status !== 'ok' || fresh.stir_minutes == null || !(fresh.asleep_minutes > 0) || !(row.asleep_minutes > 0)) continue;
          // The recompute's RATE (stir minutes per minute asleep) applied to the STORED asleep minutes, because
          // the score reads stir per hour asleep from the stored row. Taking the raw count instead gave a
          // 30-minute stored night 45 "stir minutes" from a recompute that found a ten-hour sleep.
          setStir.run(Math.round((fresh.stir_minutes / fresh.asleep_minutes) * row.asleep_minutes), c.id, row.night_date);
          recomputed.add(`${c.id} ${row.night_date}`);
        }
      }
    }

    const records = [];
    for (const c of children) {
      for (const row of nightsOf.all(c.id)) {
        const night = applyCorrection(c.id, row);
        const input = score.toScoringInput(night);
        const baseline = sleepBaseline(c.id, input);
        const result = score.scoreNight(input, baseline, score.ageMonthsOn(c.birthday, row.night_date));
        records.push({
          child: c.id.slice(0, 6),
          date: row.night_date,
          status: night.status,
          in_bed_at: night.in_bed_at ?? null,
          stirRecomputed: recomputed.has(`${c.id} ${row.night_date}`),
          input,
          baseline,
          result,
        });
      }
    }
    return {
      db: path.basename(dbPath),
      label,
      clock: new RealDate(clockMs).toISOString(),
      clock_source: clockSource,
      version: score.SCORE_VERSION,
      split,
      recomputed_stir: recomputeStir ? recomputed.size : null,
      records,
      totals: summarise(records, { split }),
    };
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
    console.error(`sleep-score-evidence: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) { console.log(USAGE); return 0; }
  if (args.out && insideRepo(args.out)) {
    console.error(`sleep-score-evidence: refusing to write ${args.out} inside the repository; it holds a household's nights`);
    return 2;
  }
  const dbPath = path.resolve(args.db);
  let clockMs;
  let clockSource;
  if (args.clock != null) { clockMs = parseInstant(args.clock); clockSource = '--clock'; } else {
    try { clockMs = fs.statSync(dbPath).mtimeMs; } catch { console.error(`sleep-score-evidence: no such snapshot: ${dbPath}`); return 2; }
    clockSource = 'snapshot file modification time';
  }
  let report;
  try {
    report = await runEvidence({
      dbPath, clockMs, clockSource, split: args.split, recomputeStir: args.recomputeStir, label: args.label,
      backendDir: path.resolve(args.backend || path.join(REPO_ROOT, 'backend')),
    });
  } catch (e) {
    console.error(`sleep-score-evidence: ${e.message}`);
    return 1;
  }
  const text = renderReport(report);
  if (args.out) fs.writeFileSync(args.out, text); else process.stdout.write(text);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
