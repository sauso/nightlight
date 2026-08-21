import db from '../db.js';
import { logger } from './logger.js';
import { notifySleepReports } from './sleepReportAlert.js';

// A computed night is "fresh" (worth notifying about) only if its window closed within this long — so a
// mid-day container restart that re-computes an already-seen night does NOT re-send the report push.
const REPORT_FRESH_MS = 2 * 60 * 60 * 1000;

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

// Per-child sleep config: whether to track this child + their own bedtime/wake window (local HH:MM,
// wraps midnight). Replaces the old single global window. Falls back to the 19:00-07:00 default.
function childSleepConfig(childId) {
  const c = db.prepare('SELECT track_sleep, sleep_window_start, sleep_window_end FROM children WHERE id = ?').get(childId);
  return {
    track: c ? c.track_sleep !== 0 : false,
    start: (c && c.sleep_window_start) || '19:00',
    end: (c && c.sleep_window_end) || '07:00',
  };
}

// Does this child have sleep tracking turned on? Used to gate the nightly compute + the "should this
// child ever run an activity leg" question.
export function childTracksSleep(childId) {
  return childSleepConfig(childId).track;
}

// A few minutes of slack on each side of the window so the 5-min reconcile that starts/stops the
// activity leg never clips the window edges: the leg is running a touch before bedtime and lingers a
// touch past wake, guaranteeing full coverage of [start, end) even with the reconcile's granularity.
const WINDOW_MARGIN_MS = 5 * 60 * 1000;

// Is this child's sleep window open RIGHT NOW (within the small margin above)? The activity-only motion
// leg is gated on this so it only samples overnight, not all day — there's no point running it outside
// each child's window. Returns false when the child doesn't track sleep. (Frame-diff ALERT legs are not
// gated on this; they run 24/7 regardless — see motionDetector.motionLegWanted.)
export function childWindowActiveNow(childId) {
  const cfg = childSleepConfig(childId);
  if (!cfg.track) return false;
  const tz = appSettings().timezone || 'UTC';
  const now = Date.now();
  // Check today's window and yesterday's (a window that wraps midnight is still open in the small hours).
  for (let delta = 0; delta >= -1; delta--) {
    const date = localDateStr(tz, delta);
    const { startUtc, endUtc } = windowBoundsUtc(date, tz, cfg.start, cfg.end);
    if (now >= startUtc.getTime() - WINDOW_MARGIN_MS && now < endUtc.getTime() + WINDOW_MARGIN_MS) return true;
  }
  return false;
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

// The start date of the child's night currently IN PROGRESS (their window contains 'now'), or null in
// the daytime gap. Per-child window. Powers the live "tonight so far" view.
export function currentNightDate(childId) {
  const tz = appSettings().timezone || 'UTC';
  const cfg = childSleepConfig(childId);
  const now = Date.now();
  for (let delta = 0; delta >= -1; delta--) {
    const date = localDateStr(tz, delta);
    const { startUtc, endUtc } = windowBoundsUtc(date, tz, cfg.start, cfg.end);
    if (startUtc.getTime() <= now && now < endUtc.getTime()) return date;
  }
  return null;
}

// The start date of the child's most recent night whose window has fully ended (safe to compute).
export function lastCompletedNightDate(childId) {
  const tz = appSettings().timezone || 'UTC';
  const cfg = childSleepConfig(childId);
  const now = Date.now();
  for (let delta = 0; delta >= -3; delta--) {
    const date = localDateStr(tz, delta);
    const { endUtc } = windowBoundsUtc(date, tz, cfg.start, cfg.end);
    if (endUtc.getTime() <= now) return date;
  }
  return localDateStr(tz, -3);
}

// --- room climate (temp/humidity) over the night, from sensor_readings ---

// Overnight temperature/humidity for the child's cameras (those with an MQTT sensor) across
// [startSql, asOfSql). Returns a summary (avg/min/max, Celsius + %) always, plus a downsampled
// per-5-min series when includeSeries is set (for the detail chart). Null when there are no readings —
// so a child without a temp/humidity sensor simply shows no climate. Times are the same UTC
// 'YYYY-MM-DD HH:MM:SS' strings sensor_readings.created_at uses, so a lexical range works.
function nightClimate(cams, startSql, asOfSql, { includeSeries = false } = {}) {
  if (!cams.length) return null;
  const ph = cams.map(() => '?').join(',');
  const agg = db
    .prepare(
      `SELECT AVG(temperature) AS ta, MIN(temperature) AS tmin, MAX(temperature) AS tmax, COUNT(temperature) AS tn,
              AVG(humidity) AS ha, MIN(humidity) AS hmin, MAX(humidity) AS hmax, COUNT(humidity) AS hn
         FROM sensor_readings
         WHERE camera_id IN (${ph}) AND created_at >= ? AND created_at < ?`
    )
    .get(...cams, startSql, asOfSql);
  if (!agg || (!agg.tn && !agg.hn)) return null;
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const r0 = (v) => (v == null ? null : Math.round(v));
  const climate = {
    temp_avg: r1(agg.ta), temp_min: r1(agg.tmin), temp_max: r1(agg.tmax), temp_samples: agg.tn,
    humidity_avg: r0(agg.ha), humidity_min: r0(agg.hmin), humidity_max: r0(agg.hmax), humidity_samples: agg.hn,
  };
  if (includeSeries) {
    const rows = db
      .prepare(
        `SELECT created_at AS t, temperature, humidity FROM sensor_readings
           WHERE camera_id IN (${ph}) AND created_at >= ? AND created_at < ? ORDER BY created_at`
      )
      .all(...cams, startSql, asOfSql);
    // Bucket to a 5-min grid and average across cameras, so multiple sensors (or jittery timestamps)
    // give one clean line rather than a zig-zag between rooms.
    const BUCKET_MS = 5 * 60000;
    const buckets = new Map();
    for (const row of rows) {
      const ms = new Date(row.t.replace(' ', 'T') + 'Z').getTime();
      const key = Math.floor(ms / BUCKET_MS);
      let b = buckets.get(key);
      if (!b) { b = { t: toSqlUtc(new Date(key * BUCKET_MS)), ts: [], hs: [] }; buckets.set(key, b); }
      if (typeof row.temperature === 'number') b.ts.push(row.temperature);
      if (typeof row.humidity === 'number') b.hs.push(row.humidity);
    }
    const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
    climate.series = [...buckets.values()]
      .sort((a, b) => (a.t < b.t ? -1 : 1))
      .map((b) => ({ t: b.t, temperature: r1(avg(b.ts)), humidity: r0(avg(b.hs)) }));
  }
  return climate;
}

// --- the inference itself ---

// Compute (but do not store) a child's sleep summary for the night starting on local date `nightDate`.
// Returns { status, ...metrics, timeline? } — timeline only when includeTimeline is set (for tuning).
export function computeNight(childId, nightDate, { includeTimeline = false } = {}) {
  const tz = appSettings().timezone || 'UTC';
  const cfg = childSleepConfig(childId);
  const { startUtc, endUtc } = windowBoundsUtc(nightDate, tz, cfg.start, cfg.end);
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
  // Room climate over the window so far — present on every non-off status (independent of whether we
  // detected sleep). The bigger per-5-min series only when a timeline is asked for (the detail view).
  const climate = nightClimate(cams, startSql, asOfSql, { includeSeries: includeTimeline });
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
    climate,
  };
  if (!cfg.track) return { ...base, status: 'off' };
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

    // Detection alerts (motion/sound) that fired anywhere in the window, so the detail view can line
    // each wake-up up with what the cameras actually flagged at that time. A windowed query (not the
    // recent-200 feed) so it works for any night in the date picker. Ascending by time.
    const aph = cams.map(() => '?').join(',');
    out.alerts = aph
      ? db
          .prepare(
            `SELECT id, camera_id, camera_name, type, detail, created_at, snapshot,
                    clip_status, clip_duration_s
               FROM detection_events
               WHERE camera_id IN (${aph}) AND created_at >= ? AND created_at < ?
               ORDER BY created_at ASC`
          )
          .all(...cams, startSql, endSql)
      : [];
  }
  return out;
}

const upsertNight = db.prepare(
  `INSERT INTO sleep_nights
     (child_id, night_date, window_start, window_end, status, onset_at, wake_at,
      asleep_minutes, awake_minutes, wake_count, longest_stretch_minutes, coverage_minutes,
      avg_temperature, avg_humidity, computed_at)
   VALUES (@child_id, @night_date, @window_start, @window_end, @status, @onset_at, @wake_at,
           @asleep_minutes, @awake_minutes, @wake_count, @longest_stretch_minutes, @coverage_minutes,
           @avg_temperature, @avg_humidity, datetime('now'))
   ON CONFLICT(child_id, night_date) DO UPDATE SET
     window_start=excluded.window_start, window_end=excluded.window_end, status=excluded.status,
     onset_at=excluded.onset_at, wake_at=excluded.wake_at, asleep_minutes=excluded.asleep_minutes,
     awake_minutes=excluded.awake_minutes, wake_count=excluded.wake_count,
     longest_stretch_minutes=excluded.longest_stretch_minutes, coverage_minutes=excluded.coverage_minutes,
     avg_temperature=excluded.avg_temperature, avg_humidity=excluded.avg_humidity,
     computed_at=datetime('now')`
);

export function computeAndStoreNight(childId, nightDate) {
  const summary = computeNight(childId, nightDate);
  upsertNight.run({
    child_id: childId,
    ...summary,
    avg_temperature: summary.climate?.temp_avg ?? null,
    avg_humidity: summary.climate?.humidity_avg ?? null,
  });
  return summary;
}

export function getStoredNights(childId, limit = 14) {
  return db
    .prepare('SELECT * FROM sleep_nights WHERE child_id = ? ORDER BY night_date DESC LIMIT ?')
    .all(childId, Math.min(60, Math.max(1, limit)));
}

// --- Phase 5: temperature ↔ sleep correlation ---

const INSIGHT_MIN_NIGHTS = 5; // fewer than this and any correlation is noise — say "keep tracking"
const INSIGHT_R = 0.35; // |Pearson r| at/above this counts as a real link (moderate)
const INSIGHT_TEMP_SPREAD = 1; // need at least this much °C spread across nights, else "too flat to tell"

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// Does room temperature correlate with this child's sleep, across their recent stored nights? Uses the
// per-night avg_temperature stored on each 'ok' night (so it needs no re-scan of sensor history). Splits
// the nights at the median temperature into a warmer half and a cooler half and compares wake-ups + sleep
// duration, and reports a Pearson r for temp↔wakes. All temperatures are Celsius (the client converts to
// the user's unit). Returns { status }: 'off' | 'insufficient' | 'ok'. The client renders the wording.
export function sleepInsights(childId, { nights = 30 } = {}) {
  if (!childTracksSleep(childId)) return { status: 'off' };
  const rows = db
    .prepare(
      `SELECT night_date, wake_count, asleep_minutes, avg_temperature, avg_humidity
         FROM sleep_nights
         WHERE child_id = ? AND status = 'ok' AND avg_temperature IS NOT NULL
           AND wake_count IS NOT NULL AND asleep_minutes IS NOT NULL
         ORDER BY night_date DESC LIMIT ?`
    )
    .all(childId, Math.min(60, Math.max(1, nights)));

  if (rows.length < INSIGHT_MIN_NIGHTS) {
    return { status: 'insufficient', nights_analyzed: rows.length, min_nights: INSIGHT_MIN_NIGHTS };
  }

  const temps = rows.map((r) => r.avg_temperature);
  const wakes = rows.map((r) => r.wake_count);
  const asleep = rows.map((r) => r.asleep_minutes);
  const spread = Math.max(...temps) - Math.min(...temps);

  const rWakes = pearson(temps, wakes);
  const rAsleep = pearson(temps, asleep);

  // Median split into cooler/warmer halves (the middle night, on an odd count, drops out of both).
  const sorted = [...temps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const cool = rows.filter((r) => r.avg_temperature < median);
  const warm = rows.filter((r) => r.avg_temperature > median);

  const half = (set) => ({
    nights: set.length,
    avg_temp: Math.round(mean(set.map((r) => r.avg_temperature)) * 10) / 10,
    avg_wakes: Math.round(mean(set.map((r) => r.wake_count)) * 10) / 10,
    avg_asleep_minutes: Math.round(mean(set.map((r) => r.asleep_minutes))),
  });

  // Verdict the UI turns into a sentence. 'flat' = temperature barely varied, so we can't say anything.
  let verdict = 'none';
  if (spread < INSIGHT_TEMP_SPREAD) verdict = 'flat';
  else if (rWakes != null && rWakes >= INSIGHT_R) verdict = 'warm_more_wakes';
  else if (rWakes != null && rWakes <= -INSIGHT_R) verdict = 'warm_fewer_wakes';

  return {
    status: 'ok',
    nights_analyzed: rows.length,
    verdict,
    temp_wake_r: rWakes == null ? null : Math.round(rWakes * 100) / 100,
    temp_asleep_r: rAsleep == null ? null : Math.round(rAsleep * 100) / 100,
    temp_spread: Math.round(spread * 10) / 10,
    overall: {
      avg_temp: Math.round(mean(temps) * 10) / 10,
      min_temp: Math.round(Math.min(...temps) * 10) / 10,
      max_temp: Math.round(Math.max(...temps) * 10) / 10,
      avg_humidity: rows.some((r) => r.avg_humidity != null)
        ? Math.round(mean(rows.filter((r) => r.avg_humidity != null).map((r) => r.avg_humidity)))
        : null,
    },
    cooler: cool.length ? half(cool) : null,
    warmer: warm.length ? half(warm) : null,
  };
}

// Compute + store the most recent completed night for every child, if not already stored. Called from
// the scheduler (and once at startup) so "last night" is ready without an on-request compute.
export function runNightlySleepJob() {
  try {
    const kids = db.prepare('SELECT id, name FROM children').all();
    let computed = 0;
    const fresh = []; // freshly-closed nights to notify about ({ name, summary })
    const now = Date.now();
    const notifyOn = db.prepare('SELECT sleep_report_alert_enabled FROM settings WHERE id = ?').get('app')?.sleep_report_alert_enabled;
    for (const kid of kids) {
      if (!childTracksSleep(kid.id)) continue; // sleep tracking off for this child
      const nightDate = lastCompletedNightDate(kid.id); // each child on their own window
      const existing = db.prepare('SELECT status FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(kid.id, nightDate);
      if (existing) continue;
      const summary = computeAndStoreNight(kid.id, nightDate);
      computed++;
      // Only notify if the window closed recently (guards against a mid-day restart re-notifying).
      const endMs = summary.window_end ? new Date(summary.window_end.replace(' ', 'T') + 'Z').getTime() : 0;
      if (endMs && now - endMs <= REPORT_FRESH_MS) fresh.push({ name: kid.name, summary });
    }
    if (computed > 0) logger.info(`[sleep] Computed ${computed} sleep summary(ies).`);
    if (notifyOn && fresh.length > 0) notifySleepReports(fresh);
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
