import db from '../db.js';
import { logger } from './logger.js';

// Stage-2 sleep tracking: infer a child's overnight sleep from the per-minute activity_samples the
// motion/sound detectors produce (see activityTracker.js). Nothing here is a medical/vitals claim —
// it's a sleep-PATTERN estimate from movement + noise, labelled as such in the UI.
//
// Approach: over a configurable night window (local time, wraps midnight), build a per-minute
// active/quiet timeline for the child (union of the child's cameras), then:
//   - onset  = start of the first sustained QUIET run (>= ONSET_QUIET_MIN) after the window opens
//   - wake events = sustained ACTIVE runs (>= WAKE_ACTIVE_MIN) after onset — brief stirs don't count
//   - final wake = the morning active run that runs to the window end (else "still asleep at window end")
// All thresholds are deliberately conservative constants up here so we can tune against real nights
// without schema/UI churn (they can graduate to settings later).

const MOTION_ACTIVE = 0.01; // in-crib per-frame changed-fraction above this = real movement (sleeping room ~0)
const MOTION_OUT_ACTIVE = 0.01; // outside-crib changed-fraction above this = someone in the room / out of bed
const SOUND_ACTIVE = 6; // dB over ambient above this = a clear noise/cry
const ONSET_QUIET_MIN = 15; // continuous quiet minutes to call it "asleep"
const WAKE_ACTIVE_MIN = 5; // active minutes (within a run) to count as an awakening (vs a brief stir)
const WAKE_GAP_MIN = 3; // bridge quiet gaps up to this long inside one awakening (intermittent noise/movement)
const MIN_COVERAGE_FRAC = 0.5; // need activity samples for at least this fraction of the window, else no_data

// --- timezone helpers (no library; same Intl approach as detectSchedule.nowMinutesInAppTz) ---

function appSettings() {
  return (
    db.prepare('SELECT timezone, sleep_window_start, sleep_window_end FROM settings WHERE id = ?').get('app') || {}
  );
}

// Offset (localWallClock - UTC) in ms for a given instant in a tz.
function tzOffsetMs(instant, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(instant).reduce((a, x) => ((a[x.type] = x.value), a), {});
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - instant.getTime();
}

// A wall-clock local time (moZero is 0-based) in tz -> the corresponding UTC Date. One refinement pass
// handles DST edges cleanly enough for a night window.
function zonedToUtc(y, moZero, d, h, mi, tz) {
  const guess = Date.UTC(y, moZero, d, h, mi, 0);
  let off = tzOffsetMs(new Date(guess), tz);
  off = tzOffsetMs(new Date(guess - off), tz);
  return new Date(guess - off);
}

const pad = (n) => String(n).padStart(2, '0');
// Format a Date as the UTC 'YYYY-MM-DD HH:MM:00' string that matches activity_samples.bucket_start.
function toSqlUtc(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:00`;
}
function parseHm(s) {
  const [h, m] = String(s || '').split(':').map((x) => parseInt(x, 10));
  return { h: Number.isFinite(h) ? h : 19, m: Number.isFinite(m) ? m : 0 };
}

// UTC [start, end) for the night that STARTS on local calendar date `nightDate` ('YYYY-MM-DD').
function windowBoundsUtc(nightDate, tz, startHM, endHM) {
  const [y, mo, d] = nightDate.split('-').map(Number);
  const s = parseHm(startHM);
  const e = parseHm(endHM);
  const startUtc = zonedToUtc(y, mo - 1, d, s.h, s.m, tz);
  // End is next local day when the window wraps midnight (end <= start).
  const wraps = e.h * 60 + e.m <= s.h * 60 + s.m;
  const endBase = new Date(Date.UTC(y, mo - 1, d + (wraps ? 1 : 0)));
  const endUtc = zonedToUtc(endBase.getUTCFullYear(), endBase.getUTCMonth(), endBase.getUTCDate(), e.h, e.m, tz);
  return { startUtc, endUtc };
}

// The local calendar date (YYYY-MM-DD) currently in tz, offset by `deltaDays`.
function localDateStr(tz, deltaDays = 0) {
  const now = new Date(Date.now() + deltaDays * 86400000);
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}`;
}

// The start date of the night currently IN PROGRESS (its window contains 'now'), or null in the daytime
// gap between windows. Powers the live "tonight so far" view.
export function currentNightDate(settings = appSettings()) {
  const tz = settings.timezone || 'UTC';
  const now = Date.now();
  for (let delta = 0; delta >= -1; delta--) {
    const date = localDateStr(tz, delta);
    const { startUtc, endUtc } = windowBoundsUtc(date, tz, settings.sleep_window_start, settings.sleep_window_end);
    if (startUtc.getTime() <= now && now < endUtc.getTime()) return date;
  }
  return null;
}

// The start date of the most recent night whose window has fully ended (so it's safe to compute).
export function lastCompletedNightDate(settings = appSettings()) {
  const tz = settings.timezone || 'UTC';
  const now = Date.now();
  for (let delta = 0; delta >= -3; delta--) {
    const date = localDateStr(tz, delta);
    const { endUtc } = windowBoundsUtc(date, tz, settings.sleep_window_start, settings.sleep_window_end);
    if (endUtc.getTime() <= now) return date;
  }
  return localDateStr(tz, -3);
}

// --- the inference itself ---

// Compute (but do not store) a child's sleep summary for the night starting on local date `nightDate`.
// Returns { status, ...metrics, timeline? } — timeline only when includeTimeline is set (for tuning).
export function computeNight(childId, nightDate, { includeTimeline = false } = {}) {
  const settings = appSettings();
  const tz = settings.timezone || 'UTC';
  const { startUtc, endUtc } = windowBoundsUtc(nightDate, tz, settings.sleep_window_start, settings.sleep_window_end);
  const startSql = toSqlUtc(startUtc);
  const endSql = toSqlUtc(endUtc);

  // In-progress night: the window is still open. Cap the analysis at "now" so a morning wake that's
  // happening right now resolves to a real wake time, instead of the not-yet-elapsed minutes reading as
  // quiet (= "still asleep"). A completed night uses the full window unchanged.
  const nowMs = Date.now();
  const inProgress = nowMs >= startUtc.getTime() && nowMs < endUtc.getTime();
  const effEndMs = inProgress ? nowMs : endUtc.getTime();
  const asOfSql = toSqlUtc(new Date(effEndMs));

  const cams = db.prepare('SELECT id FROM cameras WHERE child_id = ?').all(childId).map((c) => c.id);
  const base = {
    night_date: nightDate,
    window_start: startSql,
    window_end: endSql,
    in_progress: inProgress,
    as_of: asOfSql,
    onset_at: null,
    wake_at: null,
    asleep_minutes: null,
    awake_minutes: null,
    wake_count: null,
    longest_stretch_minutes: null,
    coverage_minutes: 0,
  };
  if (cams.length === 0) return { ...base, status: 'no_data' };

  const placeholders = cams.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT bucket_start AS t, motion_peak, sound_peak, motion_out_peak FROM activity_samples
         WHERE camera_id IN (${placeholders}) AND bucket_start >= ? AND bucket_start < ?`
    )
    .all(...cams, startSql, endSql);

  const totalMin = Math.max(0, Math.floor((effEndMs - startUtc.getTime()) / 60000));
  if (totalMin === 0) return { ...base, status: 'no_data' };

  // Per-minute state over the whole window: null = no sample (gap), false = quiet, true = active. A
  // minute is active if ANY of the child's cameras saw in-crib movement, a clear noise, OR movement
  // outside the crib (someone in the room / the child out of bed). outAt[] marks the outside-crib
  // minutes so the timeline can surface them as room activity distinct from stirring in the crib.
  const state = new Array(totalMin).fill(null);
  const outAt = new Array(totalMin).fill(false);
  const idxOf = (t) => Math.round((new Date(t.replace(' ', 'T') + 'Z').getTime() - startUtc.getTime()) / 60000);
  for (const r of rows) {
    const i = idxOf(r.t);
    if (i < 0 || i >= totalMin) continue;
    const out = r.motion_out_peak != null && r.motion_out_peak > MOTION_OUT_ACTIVE;
    const active = (r.motion_peak != null && r.motion_peak > MOTION_ACTIVE) || (r.sound_peak != null && r.sound_peak > SOUND_ACTIVE) || out;
    if (state[i] === null) state[i] = active;
    else state[i] = state[i] || active;
    if (out) outAt[i] = true;
  }
  const coverage = state.reduce((n, s) => n + (s !== null ? 1 : 0), 0);
  const result = { ...base, coverage_minutes: coverage };
  if (coverage < totalMin * MIN_COVERAGE_FRAC) return { ...result, status: 'no_data' };

  // Treat a gap as quiet for continuity (detector momentarily down ≠ awake), but coverage above is what
  // gates confidence. active[] is the boolean working timeline.
  const active = state.map((s) => s === true);

  // Onset: first index starting a quiet run of >= ONSET_QUIET_MIN.
  let onset = -1;
  for (let i = 0; i + ONSET_QUIET_MIN <= totalMin; i++) {
    let quiet = true;
    for (let j = i; j < i + ONSET_QUIET_MIN; j++) if (active[j]) { quiet = false; break; }
    if (quiet) { onset = i; break; }
  }
  if (onset === -1) return { ...result, status: 'no_sleep' };

  // Mark minutes that belong to a qualifying awakening after onset. A run bridges short quiet gaps
  // (<= WAKE_GAP_MIN) so intermittent noise/movement — a child fussing on and off, or moving in and out
  // of view — reads as ONE wake rather than being split into sub-threshold stirs. A run qualifies when
  // it contains >= WAKE_ACTIVE_MIN active minutes; it's trimmed to its first/last active minute.
  const inWake = new Array(totalMin).fill(false);
  for (let i = onset; i < totalMin; ) {
    if (!active[i]) { i++; continue; }
    let last = i;
    let count = 0;
    let k = i;
    while (k < totalMin) {
      if (active[k]) { last = k; count++; k++; continue; }
      let g = k;
      while (g < totalMin && !active[g]) g++;
      if (g < totalMin && g - k <= WAKE_GAP_MIN) { k = g; continue; } // bridge a short quiet gap
      break;
    }
    if (count >= WAKE_ACTIVE_MIN) for (let j = i; j <= last; j++) inWake[j] = true;
    i = last + 1;
  }

  // Final (morning) wake = start of the wake run that reaches the window end; else still asleep at end.
  let sleepEnd = totalMin; // exclusive
  if (inWake[totalMin - 1]) {
    let j = totalMin - 1;
    while (j >= onset && inWake[j]) j--;
    sleepEnd = j + 1;
  }

  // Metrics over [onset, sleepEnd): asleep = minutes not in a wake run; awake = minutes in wake runs.
  let asleep = 0;
  let awake = 0;
  let wakeCount = 0;
  let longest = 0;
  let run = 0;
  let prevWake = false;
  for (let i = onset; i < sleepEnd; i++) {
    if (inWake[i]) {
      awake++;
      if (!prevWake) wakeCount++;
      run = 0;
    } else {
      asleep++;
      run++;
      if (run > longest) longest = run;
    }
    prevWake = inWake[i];
  }

  const minuteTime = (i) => toSqlUtc(new Date(startUtc.getTime() + i * 60000));
  const out = {
    ...result,
    status: 'ok',
    onset_at: minuteTime(onset),
    wake_at: sleepEnd < totalMin ? minuteTime(sleepEnd) : null, // null = still asleep when the window closed
    asleep_minutes: asleep,
    awake_minutes: awake,
    wake_count: wakeCount,
    longest_stretch_minutes: longest,
  };
  if (includeTimeline) {
    out.timeline = state.map((s, i) => ({ t: minuteTime(i), state: s === null ? 'gap' : s ? 'active' : 'quiet', inWake: inWake[i], out: outAt[i] }));

    // The counted awakenings, with clock times + duration — powers the "where the wake-ups were" list.
    const wakes = [];
    for (let i = onset; i < sleepEnd; ) {
      if (!inWake[i]) { i++; continue; }
      let k = i;
      while (k < sleepEnd && inWake[k]) k++;
      wakes.push({ start_at: minuteTime(i), end_at: minuteTime(k), minutes: k - i });
      i = k;
    }
    out.wakes = wakes;

    // Outside-the-crib movement grouped into "room activity" events (someone came in / the child out of
    // bed), bridging single-minute gaps. Shown distinctly from the child's own stirring/waking.
    const visits = [];
    for (let i = 0; i < totalMin; ) {
      if (!outAt[i]) { i++; continue; }
      let last = i;
      let k = i + 1;
      while (k < totalMin && (outAt[k] || (k + 1 < totalMin && outAt[k + 1]))) { if (outAt[k]) last = k; k++; }
      visits.push({ start_at: minuteTime(i), end_at: minuteTime(last + 1), minutes: last - i + 1 });
      i = last + 1;
    }
    out.visits = visits;

    // Run-length segments across the WHOLE window for the to-scale bar. Each minute is labelled:
    // settling (before onset), asleep (quiet), stir (brief in-crib movement/noise that didn't reach a
    // full awakening), wake (a counted awakening), or awake (morning, after the final wake).
    const label = (i) =>
      i < onset ? 'settling' : i >= sleepEnd ? 'awake' : inWake[i] ? 'wake' : active[i] ? 'stir' : 'asleep';
    const segments = [];
    for (let i = 0; i < totalMin; ) {
      const l = label(i);
      let k = i;
      while (k < totalMin && label(k) === l) k++;
      segments.push({ state: l, from_at: minuteTime(i), to_at: minuteTime(k), minutes: k - i });
      i = k;
    }
    out.segments = segments;
  }
  return out;
}

const upsertNight = db.prepare(
  `INSERT INTO sleep_nights
     (child_id, night_date, window_start, window_end, status, onset_at, wake_at,
      asleep_minutes, awake_minutes, wake_count, longest_stretch_minutes, coverage_minutes, computed_at)
   VALUES (@child_id, @night_date, @window_start, @window_end, @status, @onset_at, @wake_at,
           @asleep_minutes, @awake_minutes, @wake_count, @longest_stretch_minutes, @coverage_minutes, datetime('now'))
   ON CONFLICT(child_id, night_date) DO UPDATE SET
     window_start=excluded.window_start, window_end=excluded.window_end, status=excluded.status,
     onset_at=excluded.onset_at, wake_at=excluded.wake_at, asleep_minutes=excluded.asleep_minutes,
     awake_minutes=excluded.awake_minutes, wake_count=excluded.wake_count,
     longest_stretch_minutes=excluded.longest_stretch_minutes, coverage_minutes=excluded.coverage_minutes,
     computed_at=datetime('now')`
);

export function computeAndStoreNight(childId, nightDate) {
  const summary = computeNight(childId, nightDate);
  upsertNight.run({ child_id: childId, ...summary });
  return summary;
}

export function getStoredNights(childId, limit = 14) {
  return db
    .prepare('SELECT * FROM sleep_nights WHERE child_id = ? ORDER BY night_date DESC LIMIT ?')
    .all(childId, Math.min(60, Math.max(1, limit)));
}

// Compute + store the most recent completed night for every child, if not already stored. Called from
// the scheduler (and once at startup) so "last night" is ready without an on-request compute.
export function runNightlySleepJob() {
  try {
    const settings = appSettings();
    const nightDate = lastCompletedNightDate(settings);
    const kids = db.prepare('SELECT id FROM children').all();
    let computed = 0;
    for (const kid of kids) {
      const existing = db.prepare('SELECT status FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(kid.id, nightDate);
      if (existing) continue;
      computeAndStoreNight(kid.id, nightDate);
      computed++;
    }
    if (computed > 0) logger.info(`[sleep] Computed ${computed} sleep summary(ies) for night ${nightDate}.`);
  } catch (err) {
    logger.error('[sleep] Nightly job failed:', err.message);
  }
}

let jobTimer = null;
export function startSleepJob() {
  if (jobTimer) return;
  runNightlySleepJob(); // backfill the last completed night on boot
  jobTimer = setInterval(runNightlySleepJob, 30 * 60 * 1000); // and catch the window closing within 30 min
  logger.info('[sleep] Nightly sleep computation scheduled (every 30 min; last completed night).');
}
