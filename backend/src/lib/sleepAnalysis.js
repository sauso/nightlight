import db from '../db.js';
import { logger } from './logger.js';
import { notifySleepReports } from './sleepReportAlert.js';
import { getBedTransitions, TRANSITION } from './bedTransitions.js';
import { listChildWakeClips } from './recordings.js';

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

const MOTION_ACTIVE = 0.01; // in-bed per-frame changed-fraction above this = real movement (sleeping room ~0)
// Outside-bed changed-fraction above this = real activity outside the bed (someone in the room, or the
// child out of it). Deliberately HIGHER than MOTION_ACTIVE, and not for symmetry's sake: the outside
// area is most of the frame, so it collects far more incidental change (IR gain shifts, a shadow,
// compression noise) than the small bed rectangle does, and every false 'movement outside the bed' block
// on the timeline has come from a reading barely over the old 0.01.
//
// Measured over the nights of 2026-08-27 (owner-confirmed nobody entered either room after bedtime):
// the five spurious outside blocks read 0.010, 0.013, 0.013, 0.014, 0.018 and 0.023, while the one
// genuine event of the night - Renz climbing out at 05:53 - read 0.104 and 0.074, and a parent in the
// room reads 0.1-1.0. 0.03 clears the highest false reading on record with room to spare and sits well
// below the quietest genuine one.
//
// NB: this is the per-MINUTE display/analysis threshold, deliberately independent of the per-FRAME
// threshold the detector uses to open a bed-transition candidate (motionDetector.js, from
// detect_sensitivity). They answer different questions and are not kept in step.
const MOTION_OUT_ACTIVE = 0.03;
const SOUND_ACTIVE = 6; // dB over ambient above this = a clear noise/cry
const ONSET_QUIET_MIN = 15; // continuous quiet minutes to call it "asleep"
const WAKE_ACTIVE_MIN = 5; // active minutes (within a run) to count as an awakening (vs a brief stir)
const WAKE_GAP_MIN = 3; // bridge quiet gaps up to this long inside one awakening (intermittent noise/movement)
// Exported so the LIVE wake watcher (lib/wakeWatcher.js) decides "active minute", "asleep" and
// "this run is a wake, not a stir" with the EXACT same numbers this nightly job uses. If the two ever
// drift, a clip appears for a wake the timeline doesn't show, or a shown wake has no clip — which is
// the confusion the feature exists to remove. One definition, imported, never copied.
export const SLEEP_THRESHOLDS = Object.freeze({
  MOTION_ACTIVE,
  SOUND_ACTIVE,
  ONSET_QUIET_MIN,
  WAKE_ACTIVE_MIN,
  WAKE_GAP_MIN,
});

const MIN_COVERAGE_FRAC = 0.5; // need activity samples for at least this fraction of the window, else no_data
// How far PAST the window end to keep looking for the morning "out of bed" — a child can sleep past the
// window edge, so the terminal exit that marks "up for the day" may fall a couple hours later. The
// movement-only wake still stops at the window; the transition-derived departure uses this lookahead.
const WAKE_LOOKAHEAD_MS = 3 * 60 * 60 * 1000;
// The morning departure needs the bed to stay empty (no in-bed motion) at least this long after the last
// in-bed movement to call it "up for the day" (vs a momentary lull while still asleep in the bed).
const MORNING_ABSENCE_MIN = 20;
// A morning departure is a sustained empty-bed gap after which only a FEW isolated bed-active minutes
// remain — a parent reaching into the empty bed after the child is already up (getting them, tidying).
// A mid-sleep quiet gap, by contrast, is followed by lots more in-bed stirring. This cap is what keeps a
// parent handling the bed post-wake from dragging the wake time out to the last hand-in-the-bed, and
// keeps a long deep-sleep lull from reading as the morning exit.
//
// Set from the measured separation across every night on record, NOT guessed. Real morning exits leave
// 5-8 trailing active minutes (2026-08-25 Raffa 8, 2026-08-24 Renz 5); the one bogus mid-night gap that
// an out_of_bed corroborates leaves 31 (2026-08-24 Renz 01:29). 20 sits midway between those two
// populations. It was 10, which sat right on top of the real exits: on 2026-08-25 Raffa's true 05:09
// departure passed with a margin of ZERO on staging (10 trailing, limit 10) and 1 on prod — one extra
// minute of a parent touching the bed would have skipped it and reported the wake ~2h late. Raising to
// 20 changes no pick on any night on record; it only buys margin.
//
// NB: gap LENGTH is deliberately not used as a "this is the terminal one" test. It looks appealing but
// the data disproves it — in-bed motion is sparse enough that MID-SLEEP empty runs of 226 min
// (2026-08-23 Raffa) and 312 min (2026-08-25 Raffa, five hours before he actually got up) are normal.
const MAX_POST_EXIT_ACTIVE_MIN = 20;
// A bedtime is never a rigid clock time — a tired child can be asleep well before the window opens, and
// clipping onset to window_start silently loses that sleep (and misreports the night's length). So the
// timeline is built from this far BEFORE window_start; symmetric with WAKE_LOOKAHEAD_MS at the other
// end. This costs nothing to collect: on an alerting (framediff) camera the sampling leg already runs
// 24/7, so these minutes are already in activity_samples — measured at ~1437 of a possible 1440 rows
// per camera per day. An early onset is only ACCEPTED under the two guards in computeNight (a real
// into_bed, and sleep continuing into the window) — quiet alone is not evidence of a child, which is
// the whole lesson of the empty-bed case below.
const ONSET_LOOKBEHIND_MS = 3 * 60 * 60 * 1000;
// An into_bed this long before a quiet run still counts as the put-down that started it (the child is
// placed, fusses a little, then settles).
const EARLY_ONSET_PUTDOWN_MS = 45 * 60 * 1000;
// SOUND NEEDS A WITNESS, AT BEDTIME ONLY. A bedroom mic hears the whole house, and bedtime is when the
// house is at its loudest — the other child being settled, adults talking, a TV. Sound travels through
// walls; movement does not. So for the ONSET search a sound-only minute counts as "awake" only when the
// same room ALSO saw real movement (in the bed or elsewhere in it) within this many minutes either side.
//
// Measured, not guessed (2026-08-26, owner-confirmed ground truth): Renz was asleep from 18:50 but onset
// was reported at 19:50. Of the 19 sound-active minutes that held it back, 16 were simultaneously loud in
// his brother's room, and his own bed moved in exactly ONE of them — he lay motionless for the hour while
// his brother was put to bed next door. With this rule his onset lands at 18:51 and his brother's at
// 19:23, both matching the ground truth to the minute.
//
// Deliberately scoped to onset. Wake detection keeps the plain sound rule: mid-night the house is quiet,
// so a noise in a bedroom is far more likely to be the child's own, and a child who cries without moving
// is exactly the wake-up a parent most wants counted.
const ONSET_SOUND_MOTION_WITHIN_MIN = 2;
// The same witness rule, applied to the FIRST wake run after onset for this long. Onset and the wake
// finder read the timeline with different rules, and that seam produces a contradiction at exactly the
// moment the cross-talk is loudest: once onset correctly ignores the sibling's bedtime next door, the
// very same sound-only minutes are picked up moments later as the child's first awakening. Measured on
// prod, 2026-08-27: Renz's onset moves 19:52 -> 19:21 (right), and the noise that had been delaying it
// immediately reappears as a 10-minute 'wake' at 19:21-19:31 (wrong) - he did not stir once.
//
// Scoped to a grace period, not applied to the night, because the argument for discounting sound is
// entirely about WHEN: bedtime is when the rest of the house is awake and loud. Mid-night it is quiet,
// a noise in a bedroom is most likely the child's own, and a cry without movement is precisely the
// wake-up a parent wants counted - so past this grace the plain rule returns. 30 minutes covers the
// other child's bedtime routine (measured 19:19-19:51 on 2026-08-27).
//
// What this can cost: a genuine cry in the first half hour that produces NO movement in the bed at all
// goes uncounted as an awakening. That is a narrow case (a child who cries almost always moves), and it
// costs nothing in alerting - sound alerts and their pushes are a separate path and still fire.
const POST_ONSET_SOUND_WITNESS_MIN = 30;
// Consecutive into_bed events closer together than this are ONE settling episode, not several arrivals.
// A child is put down, fusses, is picked up and re-settled — the detector logs each re-settle, but the
// bedtime a parent would name is when the episode STARTED, and that is the marker the timeline draws.
// Measured on the nights on record: within an episode the events sit 2-8 minutes apart (2026-08-27
// Raffa 19:29/19:31/19:34/19:36, Renz 18:30/18:33/18:37/18:39; 2026-08-26 Raffa 19:11/19:19), while the
// nearest unrelated into_bed is hours away. 10 minutes separates those two populations with margin.
const PUTDOWN_EPISODE_GAP_MIN = 10;
// EMPTY BED. The activity-only algo cannot tell a quiet sleeping child from a bed nobody is in: an empty
// room still yields samples (so coverage passes) and near-zero motion satisfies ONSET_QUIET_MIN, so a
// night with no child in the bed reported a flawless 11h06m sleep with 0 wakes (2026-08-25, Renz away).
// The assumption is written into MOTION_ACTIVE itself ("sleeping room ~0") — an EMPTY room is ~0 too.
// Measured separation, empty vs 17 occupied prod nights: max in-bed motion_peak 0.0163 empty vs a floor
// of 0.2883 occupied (usually ~1.0). 0.10 sits ~6x above the empty night and ~3x below the occupied
// floor. Paired with the wake_count/awake_minutes test below, which no occupied night on record trips.
const EMPTY_BED_MAX_PEAK = 0.1;
// EMPTY BED, part two: the same trap one candidate at a time. EMPTY_BED_MAX_PEAK judges the WHOLE night,
// so it is blind to a night that really did contain sleep but whose onset was anchored on a put-down
// hours before the child was in the bed. Measured 2026-08-28 (Raffa): a stray into_bed at 16:52 was
// undone by an out_of_bed 23 seconds later, the room then sat empty until his real 19:51 bedtime, and
// onset was reported at 16:56 — 2h55m early. Every existing guard passed. The quiet run passed because
// an empty room is quiet; the nap guard passed because an empty room never wakes; coverage passed
// because an empty room still yields samples. Household noise would have broken the run, but the
// put-down anchor discounts uncorroborated sound (ONSET_SOUND_MOTION_WITHIN_MIN) — correctly, when the
// put-down is real. So a FALSE put-down turns every safeguard off at once.
//
// The evidence that separates them is positive, not negative: an occupied bed is never perfectly still
// for hours, and an empty one is. Measured across the 14 stored nights, max in-bed motion_peak in the
// 150 minutes after the reported onset:
//   the false 16:56 onset ......... 0.0001   (the sensor floor — no frame differed, at all)
//   quietest genuine onset ........ 0.0045   (2026-08-27 Raffa, under a blanket)
//   loudest genuine onset ......... 0.6730
// 0.002 sits ~20x above the false night and ~2x below the quietest true one. NB the *fraction* of still
// minutes does NOT separate these (0.993 false vs 0.960 true) — only the maximum does. 150 minutes is
// long enough that even the stillest child on record clears it, and short enough to fit between a
// spurious afternoon put-down and a real bedtime.
const OCCUPANCY_WITNESS_MIN = 150;
const OCCUPANCY_MIN_PEAK = 0.002;
// Use bed-transition-derived onset/wake as the AUTHORITATIVE times rather than merely showing them
// alongside the movement-only figures. The movement timeline cannot distinguish an empty quiet bed from
// a sleeping child; where a real transition supports a time it is simply the better estimate. Against
// owner-confirmed ground truth the movement-only wake has been 55-89 minutes late every morning, while
// the transition-derived one has been exact. Adoption is safe by construction - each value falls back to
// the movement-only figure unless a transition corroborates it, so the uncorroborated case is exactly
// the old behaviour. Both are stored either way (`*_algo` keeps the movement-only figures) so the two
// methods stay comparable night by night. Flip this to false to revert to movement-only everywhere.
const USE_TRANSITION_TIMES = true;
// When the empty-bed run starts near a recorded bed transition, snap the wake to that transition's clock
// time (its TIMING is trustworthy even though its in/out LABEL isn't — see the destination-state note).
const WAKE_SNAP_MS = 5 * 60 * 1000;

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
function windowOpenNow(childId, leadMs) {
  const cfg = childSleepConfig(childId);
  if (!cfg.track) return false;
  const tz = appSettings().timezone || 'UTC';
  const now = Date.now();
  // Check today's window and yesterday's (a window that wraps midnight is still open in the small hours).
  for (let delta = 0; delta >= -1; delta--) {
    const date = localDateStr(tz, delta);
    const { startUtc, endUtc } = windowBoundsUtc(date, tz, cfg.start, cfg.end);
    if (now >= startUtc.getTime() - leadMs && now < endUtc.getTime() + WINDOW_MARGIN_MS) return true;
  }
  return false;
}

export function childWindowActiveNow(childId) {
  return windowOpenNow(childId, WINDOW_MARGIN_MS);
}

// Should the activity-only SAMPLING leg be running now? Same window, but opened ONSET_LOOKBEHIND_MS
// early so a child who goes down before their configured bedtime is already being sampled — otherwise
// the lookbehind in computeNight has nothing to read and an early night is still clipped.
//
// Kept separate from childWindowActiveNow deliberately: that one also gates the timelapse, which should
// keep starting at the configured bedtime rather than three hours before it. This only widens sampling.
//
// It costs nothing on a framediff-ALERTING camera, which is never window-gated (motionLegWanted returns
// early for those) and already samples 24/7 — measured at ~1437 of a possible 1440 rows/camera/day, or
// ~10.7 MB at the 30-day retention. It matters for the MQTT-source/alerts-off cameras that DO get gated,
// where running 24/7 would burn detector CPU all day for no benefit.
export function childSamplingActiveNow(childId) {
  return windowOpenNow(childId, ONSET_LOOKBEHIND_MS);
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
//
// The shift is CALENDAR arithmetic on the local date, not "subtract 86400000 ms and see where you
// land" — a day is not 24 hours on the two nights a year the clocks move, and the old form was wrong
// for a full hour on each of them. Measured for Australia/Melbourne:
//   spring forward — at 00:00-00:59 on 2026-10-05, deltaDays -1 returned 2026-10-03, SKIPPING 10-04
//   fall back      — at 23:00-23:59 on 2026-04-05, deltaDays -1 returned 2026-04-05, TODAY again
// Both matter because the callers below walk `delta` down as a list of candidate nights: a skipped
// date is a night never considered, and a repeated one wastes the only other slot. currentNightDate
// tries just 0 and -1, so on the morning after the spring-forward it found no in-progress night at all
// and the live "tonight so far" view vanished for an hour.
//
// Doing it on the date parts is exact: pull the local Y/M/D, then add days in UTC where every day IS
// 24 hours, and read the date straight back. No instant is ever converted, so no offset can be applied.
function localDateStr(tz, deltaDays = 0) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date())
    .reduce((a, x) => ((a[x.type] = x.value), a), {});
  if (!deltaDays) return `${p.year}-${p.month}-${p.day}`;
  return new Date(Date.UTC(+p.year, +p.month - 1, +p.day + deltaDays)).toISOString().slice(0, 10);
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
    onset_at_shadow: null,
    wake_at_shadow: null,
    onset_at_algo: null,
    wake_at_algo: null,
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

  // The timeline runs from ONSET_LOOKBEHIND_MS before the window opens, so a child who went down early
  // is measured from when they actually fell asleep rather than from the window edge. Index 0 is that
  // earlier origin; `preMin` is the index at which the configured window actually starts. Everything
  // user-facing (coverage, the window bounds we report) still keys off the WINDOW, not this origin.
  const analysisStartUtc = new Date(startUtc.getTime() - ONSET_LOOKBEHIND_MS);
  const analysisStartSql = toSqlUtc(analysisStartUtc);
  const preMin = Math.round(ONSET_LOOKBEHIND_MS / 60000);
  const winMin = Math.max(0, Math.floor((effEndMs - startUtc.getTime()) / 60000));
  if (winMin === 0) return { ...base, status: 'no_data' };
  const totalMin = preMin + winMin;

  const rows = db
    .prepare(
      `SELECT bucket_start AS t, motion_peak, sound_peak, motion_out_peak FROM activity_samples
         WHERE camera_id IN (${placeholders}) AND bucket_start >= ? AND bucket_start < ?`
    )
    .all(...cams, analysisStartSql, asOfSql);

  // Per-minute state over the whole timeline: null = no sample (gap), false = quiet, true = active. A
  // minute is active if ANY of the child's cameras saw in-bed movement, a clear noise, OR movement
  // outside the bed (someone in the room / the child out of bed). outAt[] marks the outside-bed
  // minutes so the timeline can surface them as room activity distinct from stirring in the bed.
  const state = new Array(totalMin).fill(null);
  const outAt = new Array(totalMin).fill(false);
  // The two channels kept apart as well as combined: the onset search below has to ask "did anything
  // actually MOVE in this room", which `state` alone can no longer answer once sound has folded into it.
  const motionAt = new Array(totalMin).fill(false); // real movement seen by a camera (in the bed or not)
  const soundAt = new Array(totalMin).fill(false); // a clear noise, wherever in the house it came from
  const idxOf = (t) => Math.round((new Date(t.replace(' ', 'T') + 'Z').getTime() - analysisStartUtc.getTime()) / 60000);
  // Strongest in-bed movement seen anywhere in the WINDOW — the empty-bed test below reads this.
  let maxBedPeak = 0;
  // Strongest in-bed movement per MINUTE, over the whole timeline including the lookbehind. The
  // whole-night maxBedPeak cannot answer "was the bed occupied at this candidate onset" — that needs the
  // peaks kept where they happened (see OCCUPANCY_MIN_PEAK).
  const bedPeakAt = new Array(totalMin).fill(0);
  for (const r of rows) {
    const i = idxOf(r.t);
    if (i < 0 || i >= totalMin) continue;
    const out = r.motion_out_peak != null && r.motion_out_peak > MOTION_OUT_ACTIVE;
    const moved = (r.motion_peak != null && r.motion_peak > MOTION_ACTIVE) || out;
    const heard = r.sound_peak != null && r.sound_peak > SOUND_ACTIVE;
    const active = moved || heard;
    if (state[i] === null) state[i] = active;
    else state[i] = state[i] || active;
    if (out) outAt[i] = true;
    if (moved) motionAt[i] = true;
    if (heard) soundAt[i] = true;
    if (i >= preMin && r.motion_peak != null && r.motion_peak > maxBedPeak) maxBedPeak = r.motion_peak;
    if (r.motion_peak != null && r.motion_peak > bedPeakAt[i]) bedPeakAt[i] = r.motion_peak;
  }
  // Coverage is a statement about the configured window ("did we watch the night"), so it counts only
  // window minutes — the lookbehind must never inflate or dilute it.
  let coverage = 0;
  for (let i = preMin; i < totalMin; i++) if (state[i] !== null) coverage++;
  const result = { ...base, coverage_minutes: coverage };
  if (coverage < winMin * MIN_COVERAGE_FRAC) return { ...result, status: 'no_data' };

  // Treat a gap as quiet for continuity (detector momentarily down ≠ awake), but coverage above is what
  // gates confidence. active[] is the boolean working timeline.
  const active = state.map((s) => s === true);

  // The onset view of the same timeline, with uncorroborated sound discounted (see
  // ONSET_SOUND_MOTION_WITHIN_MIN). Movement always counts; a noise counts only if this room moved around
  // the same time. Used ONLY by the two onset helpers below — every other measurement on the night
  // (wakes, stirs, awake minutes, the segment bar) keeps reading `active`.
  const activeForOnset = new Array(totalMin);
  for (let i = 0; i < totalMin; i++) {
    if (motionAt[i]) { activeForOnset[i] = true; continue; }
    if (!soundAt[i]) { activeForOnset[i] = false; continue; }
    let witnessed = false;
    const from = Math.max(0, i - ONSET_SOUND_MOTION_WITHIN_MIN);
    const to = Math.min(totalMin - 1, i + ONSET_SOUND_MOTION_WITHIN_MIN);
    for (let j = from; j <= to; j++) if (motionAt[j]) { witnessed = true; break; }
    activeForOnset[i] = witnessed;
  }

  // Bed transitions across the whole timeline (lookbehind included, plus a lookahead past the window end
  // for the morning exit on a completed night). Fetched once here because BOTH the early-bedtime guard
  // below and the shadow wake block further down need them.
  const lookahead = inProgress ? 0 : WAKE_LOOKAHEAD_MS;
  const txEndSql = toSqlUtc(new Date(endUtc.getTime() + lookahead));
  const transitions = getBedTransitions(cams, analysisStartSql, txEndSql);
  const txMs = (t) => new Date(t.replace(' ', 'T') + 'Z').getTime();
  const txIdx = (t) => Math.round((txMs(t) - analysisStartUtc.getTime()) / 60000);

  // First index starting a quiet run of >= ONSET_QUIET_MIN at or after `from` (null if none).
  //
  // `afterPutDown` selects which view of the timeline to read, and the distinction is load-bearing.
  // Discounting uncorroborated sound is only safe once a real into_bed proves the child is IN the bed:
  // then stillness plus household noise means asleep. Applied to the unanchored search it re-creates the
  // exact trap EMPTY_BED_MAX_PEAK exists for — quiet is not evidence of a child. Measured: on 2026-08-21
  // Renz's room had someone in it until ~20:00 (outside-motion peaks up to 0.98), but the ten minutes
  // before he was carried in were still and merely noisy, so discounting there declared him asleep at
  // 19:00, an hour and a half early. Anchored on the put-down, the same data gives the right answer.
  const firstQuietRunFrom = (from, afterPutDown = false) => {
    const view = afterPutDown ? activeForOnset : active;
    for (let i = Math.max(0, from); i + ONSET_QUIET_MIN <= totalMin; i++) {
      let quiet = true;
      for (let j = i; j < i + ONSET_QUIET_MIN; j++) if (view[j]) { quiet = false; break; }
      if (quiet) return i;
    }
    return null;
  };

  // Did the bed show any sign of being OCCUPIED in the OCCUPANCY_WITNESS_MIN minutes from `from`? A
  // sleeping child produces an occasional twitch; an empty bed produces nothing at all. See
  // OCCUPANCY_MIN_PEAK for the measured separation.
  //
  // Returns TRUE when it cannot tell — a window that runs off the end of the data (an in-progress night,
  // or a bedtime close to the morning) is not evidence of an empty bed. That is the safe direction: this
  // guard only ever REJECTS an onset, so failing open leaves today's behaviour untouched rather than
  // inventing a later bedtime from missing data.
  const bedOccupiedAfter = (from) => {
    const to = from + OCCUPANCY_WITNESS_MIN;
    if (to > totalMin) return true; // not enough timeline left to judge
    for (let i = from; i < to; i++) {
      if (state[i] === null) return true; // a gap: can't prove the bed was empty through it
      if (bedPeakAt[i] >= OCCUPANCY_MIN_PEAK) return true;
    }
    return false;
  };

  // Is there a qualifying awakening (>= WAKE_ACTIVE_MIN active minutes, bridging short quiet gaps)
  // anywhere in [from, to)? Same run logic as the wake marking below, used as an early-onset guard — and
  // so, like firstQuietRunFrom, it reads the onset view: the nap it exists to exclude is one the child
  // physically got up from, which is movement, not noise from elsewhere in the house.
  const hasAwakening = (from, to) => {
    for (let i = Math.max(0, from); i < to; ) {
      if (!activeForOnset[i]) { i++; continue; }
      let count = 0;
      let last = i;
      let k = i;
      while (k < to) {
        if (activeForOnset[k]) { last = k; count++; k++; continue; }
        let g = k;
        while (g < to && !activeForOnset[g]) g++;
        if (g < to && g - k <= WAKE_GAP_MIN) { k = g; continue; }
        break;
      }
      if (count >= WAKE_ACTIVE_MIN) return true;
      i = last + 1;
    }
    return false;
  };

  // Onset. The baseline is the historical rule — first sustained quiet run at or after the window opens.
  let onset = firstQuietRunFrom(preMin);

  // PUT-DOWN-ANCHORED ONSET. Bedtime is never a rigid clock time. It moves nightly, and nobody is going
  // to edit the configured window to match it, so the window is a guide and the put-down is the evidence:
  // onset is the settle that follows the into_bed which actually started the sleep, wherever that lands
  // relative to the window edge. Adopt the quiet run that follows it — but only under guards, because a
  // quiet room is not by itself evidence of a sleeping child (that is exactly how an empty bed reports a
  // full night, see EMPTY_BED_MAX_PEAK):
  //   1. a real into_bed put-down starts it — someone actually placed the child in the bed; and
  //   2. that sleep runs CONTINUOUSLY into the window (no qualifying awakening in between).
  // Guard 2 is what excludes a late-afternoon NAP: a nap the child got up from has an awakening between
  // it and bedtime, so it can never be mistaken for the night's onset. It is vacuous for a settle that
  // lands after the window has already opened (there is no nap to confuse with a bedtime by then); what
  // bounds those is the "earlier only" test below.
  //
  // This deliberately does NOT require the settle to land before the window opens. It used to, and that
  // one clause silently disabled ONSET_SOUND_MOTION_WITHIN_MIN for every ordinary bedtime: the discount
  // is only ever applied to a search anchored on a put-down, and this was the only anchored search there
  // was. Measured on prod, 2026-08-27, both children: the anchored search computed 19:20 and 19:38
  // (ground truth 19:13 and 19:36), both were discarded for settling after the window had opened, and
  // the reported onsets fell back to the raw search at 19:52 and 19:51 — 39 and 15 minutes late.
  // Anchored on the PUT-DOWN, not on "the first quiet run in the lookbehind". That distinction is
  // load-bearing: a minute with no sample is treated as quiet for continuity (see `active` above), so
  // before sampling starts the timeline is one long fake quiet run — searching it for quiet would always
  // land on the start of a data gap, never on a real bedtime. Walking the into_bed events instead means
  // we only ever consider stretches an actual put-down began.
  const maxSettleMin = EARLY_ONSET_PUTDOWN_MS / 60000;
  const earlyPutDowns = transitions
    .filter((t) => t.type === TRANSITION.INTO_BED)
    .map((t) => ({ idx: txIdx(t.created_at) }))
    .filter((p) => p.idx >= 0 && p.idx < totalMin)
    .sort((a, b) => a.idx - b.idx);
  for (const { idx: putDown } of earlyPutDowns) {
    const q = firstQuietRunFrom(putDown, true);
    if (q == null) continue; // never settled after this put-down
    // Only ever EARLIER than the plain search. The put-down anchor exists to recover sleep the plain
    // search loses to household noise; it must never push onset later. It is also what stops a 3am
    // re-settle — whose own following quiet run qualifies just as well — from being adopted as the
    // night's bedtime on a night where every evening put-down failed its guards.
    if (onset != null && q >= onset) continue;
    if (q - putDown > maxSettleMin) continue; // settled far too long after this put-down to be its result
    // Don't claim sleep we didn't actually observe: the settle minute must have a sample, and the
    // stretch from there to the window must be mostly covered.
    if (state[q] === null) continue;
    let seen = 0;
    for (let i = q; i < preMin; i++) if (state[i] !== null) seen++;
    if (seen < (preMin - q) * MIN_COVERAGE_FRAC) continue;
    // Guard 2: it has to still be the same sleep when the window opens. A nap the child got up from has
    // an awakening between it and bedtime, so it can never be adopted as the night's onset.
    if (hasAwakening(q, preMin)) continue;
    // Guard 3: the bed has to look OCCUPIED afterwards. Guards 1 and 2 both rest on the put-down being
    // real, and a put-down the detector got wrong satisfies them trivially — an empty room never wakes,
    // so guard 2 in particular passes vacuously. This is the only guard that asks for positive evidence
    // of a child rather than an absence of contradiction. Applied HERE and not to the plain search
    // above, because the plain search reads the undiscounted `active` view, where household noise
    // already breaks the quiet run over an empty bed; it is the sound discount that this search turns on
    // — correctly, for a real put-down — that removes that protection.
    if (!bedOccupiedAfter(q)) continue;
    onset = q;
    break; // earliest qualifying put-down wins
  }
  if (onset == null) return { ...result, status: 'no_sleep' };
  const algoOnset = onset;

  // --- Bed-boundary onset/wake. Computed BEFORE the metrics because, once adopted, they define the span
  // the metrics are measured over - promoting only the displayed times would leave the durations
  // describing a different night from the times printed above them. ---

  // Onset: an into_bed only ever DELAYS onset - before the child was actually placed in the bed the
  // quiet is an empty bed, not sleep. Onset is a once-per-night event: the FIRST put-down that leads to
  // sustained sleep. Take the EARLIEST into_bed whose following quiet run qualifies (firstQuietRunFrom
  // already skips the evening fussing, so this lands on the settle, not the put-down instant); never move
  // earlier than the movement-only onset. Using the earliest - not the latest - is deliberate: on a
  // restless night the child is re-settled several times (into_bed at ~3am after a 2-4am waking), and the
  // LAST such re-settle must not be mistaken for the night's onset (that bug put onset at 4:20am on
  // 2026-08-23). The first qualifying sleep stretch is the onset; later re-settles are mid-night wakes.
  //
  // Bounded to put-downs within maxSettleMin of the movement-only onset, because "an into_bed only ever
  // delays onset" is only true of the put-down that STARTED this sleep. Put-downs are missed often
  // enough for that to matter — on 2026-08-27 the real 19:13 put-down was recorded as an out_of_bed, so
  // the night had no bedtime into_bed at all. On a night like that the earliest into_bed on the timeline
  // can be a 2am re-settle, and delaying onset to it reports a 10-hour night as a 5-hour one. A
  // put-down hours after the room went quiet is not the one that began the sleep.
  let transitionOnset = null;
  for (const t of transitions) {
    if (t.type !== TRANSITION.INTO_BED) continue;
    const idx = txIdx(t.created_at);
    if (idx < 0 || idx >= totalMin) continue;
    if (idx > algoOnset + maxSettleMin) continue; // too late to be the put-down that started this sleep
    const q = firstQuietRunFrom(idx, true);
    if (q != null) { transitionOnset = Math.max(q, algoOnset); break; } // earliest qualifying into_bed wins
  }

  // Wake: find the morning DEPARTURE from the bed-motion timeline, ignoring the unreliable in/out labels
  // (the SAME 06:41 exit was labelled oppositely on two legs of one camera, 2026-08-23) AND ignoring a
  // parent handling the bed after the child is already up. This deliberately does NOT use the LAST in-bed
  // motion: on 2026-08-24 the child was up ~06:38 but a parent then reached into the bed (peaks 0.89/0.99
  // at 07:22-08:11), which the old "last motion then empty" rule mistook for the wake. Completed nights
  // only - mid-night we don't guess a morning wake.
  // Kept as an exact timestamp, NOT a minute index: the reported wake time is this instant truncated to
  // its minute, and rounding to the nearest index instead would report 05:10 for an exit recorded at
  // 05:09:31. The index derived from it (for the metrics span) therefore FLOORS.
  let transitionExitMs = null;
  // The out_of_bed that corroborated it — the only exit marker the timeline is entitled to draw.
  let exitTransitionAt = null;
  if (!inProgress) {
    // Indices here share the timeline origin (analysisStartUtc) used by idxOf, so the lookbehind is
    // included at the front and the lookahead past the window end at the back.
    const totalMinExt = Math.max(totalMin, Math.round((endUtc.getTime() + lookahead - analysisStartUtc.getTime()) / 60000));
    const extRows = db
      .prepare(
        `SELECT bucket_start AS t, motion_peak FROM activity_samples
           WHERE camera_id IN (${placeholders}) AND bucket_start >= ? AND bucket_start < ?`
      )
      .all(...cams, analysisStartSql, txEndSql);
    const cribActExt = new Array(totalMinExt).fill(false);
    for (const r of extRows) {
      const i = idxOf(r.t);
      if (i >= 0 && i < totalMinExt && r.motion_peak != null && r.motion_peak > MOTION_ACTIVE) cribActExt[i] = true;
    }
    // Suffix count of bed-active minutes from each index to the end, so we can cheaply ask "how much
    // in-bed motion remains after this point?" for each candidate gap.
    const activeSuffix = new Array(totalMinExt + 1).fill(0);
    for (let i = totalMinExt - 1; i >= 0; i--) activeSuffix[i] = activeSuffix[i + 1] + (cribActExt[i] ? 1 : 0);

    // Morning departure = the EARLIEST sustained empty-bed gap (>= MORNING_ABSENCE_MIN) at/after onset
    // after which only a few isolated bed-active minutes remain (<= MAX_POST_EXIT_ACTIVE_MIN). Scanning
    // for the FIRST such gap - rather than the last in-bed motion - is the fix for a parent handling the
    // bed after the child is already up: those late hand-in-bed spikes fall AFTER the departure gap, so
    // they no longer drag the wake later. The "few active minutes remain" test is what stops a mid-sleep
    // lull (followed by lots more stirring) from being mistaken for the exit.
    //
    // A qualifying gap is only ACCEPTED if a real out-of-bed transition corroborates it (within
    // WAKE_SNAP_MS); otherwise we keep scanning for a later gap that is corroborated. That second,
    // independent signal matters because the gap test alone is knife-edge: on 2026-08-24 a single missing
    // sample minute manufactured a 22-minute gap (threshold 20) carrying 9 trailing active minutes -
    // within 2 of flipping - which put the wake 40 minutes early on staging while prod, reading the same
    // camera, got it exactly right. Scanning on rather than giving up at the first candidate is what lets
    // that bogus gap be skipped and the real departure still be found.
    //
    // Corroboration does most of the discriminating here - see MAX_POST_EXIT_ACTIVE_MIN for why that cap
    // is 20 and not the 10 it started at (real exits leave 5-8 trailing minutes; the one corroborated
    // mid-night impostor on record leaves 31).
    //
    // The transition must be an `out_of_bed` specifically: accepting any transition would let an
    // `into_bed` vouch for a departure, which is how the other child's wake landed 53 minutes late (that
    // bed kept registering motion long after the child was carried out, and the nearest marker was an
    // into-bed). If nothing corroborates any gap we keep the movement-only wake rather than guess.
    for (let i = Math.max(algoOnset, 0); i < totalMinExt; ) {
      if (cribActExt[i]) { i++; continue; }
      let j = i;
      while (j < totalMinExt && !cribActExt[j]) j++; // [i, j) is a maximal empty run
      if (j - i >= MORNING_ABSENCE_MIN && activeSuffix[i] <= MAX_POST_EXIT_ACTIVE_MIN) {
        const emptyStartMs = analysisStartUtc.getTime() + i * 60000;
        let best = null;
        for (const t of transitions) {
          if (t.type !== TRANSITION.OUT_OF_BED) continue;
          // The corroborating exit must not PRE-DATE onset. The gap already starts at or after onset,
          // but the snap window let a transition up to WAKE_SNAP_MS EARLIER vouch for it — and at
          // bedtime the nearest out_of_bed is the parent walking away from the bed they have just put
          // the child into. Prod, 2026-08-26: onset 19:23, the mother left at 19:20, and that
          // three-minutes-earlier event corroborated a gap starting at onset — reporting the morning
          // wake as 19:20 and the whole night as 0h00m asleep. A departure before the child fell asleep
          // is not a departure. Latent until onset moved earlier; the earlier onset merely exposed it.
          if (txMs(t.created_at) < analysisStartUtc.getTime() + algoOnset * 60000) continue;
          const dt = Math.abs(txMs(t.created_at) - emptyStartMs);
          if (dt <= WAKE_SNAP_MS && (best == null || dt < best.dt)) best = { dt, ms: txMs(t.created_at), at: t.created_at };
        }
        if (best) { transitionExitMs = best.ms; exitTransitionAt = best.at; break; } // corroborated departure - the morning exit
      }
      i = j;
    }
  }

  const transitionExitIdx =
    transitionExitMs == null ? null : Math.floor((transitionExitMs - analysisStartUtc.getTime()) / 60000);

  if (USE_TRANSITION_TIMES && transitionOnset != null) onset = transitionOnset;

  // The single into_bed the timeline may draw for onset: the put-down that actually started this sleep.
  // Take the LATEST into_bed at or before onset that is close enough to have caused it, then walk BACK
  // through the settling episode it belongs to (see PUTDOWN_EPISODE_GAP_MIN) and draw the START of that
  // episode — the moment a parent would call bedtime.
  //
  // Neither end of that alone is right, which is why it is both. Taking the latest event reports the
  // last re-settle as the bedtime (2026-08-26 Raffa: put down 19:10, marker 19:19 — which was actually
  // his mother leaving, misread as an arrival). Taking the earliest that passes the onset guards reports
  // the first attempt on a night with several (2026-08-27 Raffa: marker 19:29 for a 19:36 put-down).
  // Anchoring on the latest and then walking back over the episode gets 2026-08-26 Raffa to 19:11
  // (observed 19:10) and 2026-08-27 Raffa to 19:29 (observed 19:28).
  //
  // Deliberately NOT the into_bed that transitionOnset iterates to. That loop stops at the EARLIEST
  // into_bed with any qualifying quiet run after it, then clamps the result up to algoOnset, so its
  // marker can be hours adrift of the sleep it dated (on 2026-08-26 it pointed at a 16:33 afternoon
  // event). Harmless while the value was only clamped; wrong the moment it is drawn on a timeline.
  const putDownsBeforeOnset = transitions
    .filter((t) => t.type === TRANSITION.INTO_BED)
    .map((t) => ({ at: t.created_at, idx: txIdx(t.created_at) }))
    .filter((p) => p.idx <= onset && onset - p.idx <= maxSettleMin)
    .sort((a, b) => a.idx - b.idx);
  let onsetTransitionAt = null;
  if (putDownsBeforeOnset.length) {
    let first = putDownsBeforeOnset.length - 1; // the closest put-down before the settle
    while (first > 0 && putDownsBeforeOnset[first].idx - putDownsBeforeOnset[first - 1].idx <= PUTDOWN_EPISODE_GAP_MIN) first--;
    onsetTransitionAt = putDownsBeforeOnset[first].at;
  }

  // Mark minutes that belong to a qualifying awakening after onset. A run bridges short quiet gaps
  // (<= WAKE_GAP_MIN) so intermittent noise/movement — a child fussing on and off, or moving in and out
  // of view — reads as ONE wake rather than being split into sub-threshold stirs. A run qualifies when
  // it contains >= WAKE_ACTIVE_MIN active minutes; it's trimmed to its first/last active minute.
  //
  // Reads `active` everywhere EXCEPT the first POST_ONSET_SOUND_WITNESS_MIN minutes after onset, where
  // it reads the witnessed view for the same reason onset does — see POST_ONSET_SOUND_WITNESS_MIN. This
  // is one view, not a branch inside the run walk, so a run that starts inside the grace and continues
  // past it is still detected as one run (it simply stops discounting sound at the boundary).
  const graceEnd = Math.min(totalMin, onset + POST_ONSET_SOUND_WITNESS_MIN);
  const activeForWake = new Array(totalMin);
  for (let i = 0; i < totalMin; i++) activeForWake[i] = i >= onset && i < graceEnd ? activeForOnset[i] : active[i];

  const inWake = new Array(totalMin).fill(false);
  for (let i = onset; i < totalMin; ) {
    if (!activeForWake[i]) { i++; continue; }
    let last = i;
    let count = 0;
    let k = i;
    while (k < totalMin) {
      if (activeForWake[k]) { last = k; count++; k++; continue; }
      let g = k;
      while (g < totalMin && !activeForWake[g]) g++;
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
  const algoSleepEnd = sleepEnd;
  if (USE_TRANSITION_TIMES && transitionExitIdx != null) {
    // Clamped because the metrics can only count minutes we hold per-minute state for, while the
    // departure scan deliberately looks PAST the window end (a child can sleep past it). The reported
    // wake TIME is not clamped - see wake_at below.
    sleepEnd = Math.min(Math.max(transitionExitIdx, onset), totalMin);
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

  const minuteTime = (i) => toSqlUtc(new Date(analysisStartUtc.getTime() + i * 60000));

  // EMPTY BED — nobody slept here. Distinct from no_data ("we couldn't see"): coverage is fine, we
  // watched all night, there was simply no child in the bed. Without this the algo reports a perfect
  // night for an empty room, because an empty room is quiet and quiet is what it reads as sleep.
  // Three independent signals must ALL hold, and no occupied night on record trips even one:
  // essentially no in-bed movement all night, no awakenings, and not one awake minute. A real child —
  // however still a sleeper — stirs: the quietest occupied night on record still peaked at 0.2883 with
  // 1 awakening and 10 awake minutes.
  if (maxBedPeak < EMPTY_BED_MAX_PEAK && wakeCount === 0 && awake === 0) {
    return {
      ...result,
      status: 'empty',
      // Deliberately no onset/wake/duration: reporting "11h06m asleep, 0 wakes" for a bed nobody was in
      // is the bug being fixed. The night is a real observation, it just isn't a sleep.
    };
  }

  // A movement-only wake of null means "still asleep when the window closed". A transition-derived
  // departure may legitimately fall past the window end and is reported as-is - knowing they got up at
  // 07:10 beats reporting "still asleep".
  const algoWakeAt = algoSleepEnd < totalMin ? minuteTime(algoSleepEnd) : null;
  const transitionWakeAt = transitionExitMs != null ? toSqlUtc(new Date(transitionExitMs)) : null;
  const out = {
    ...result,
    status: 'ok',
    onset_at: minuteTime(onset),
    wake_at: (USE_TRANSITION_TIMES && transitionWakeAt) || (sleepEnd < totalMin ? minuteTime(sleepEnd) : null),
    asleep_minutes: asleep,
    awake_minutes: awake,
    wake_count: wakeCount,
    longest_stretch_minutes: longest,
    // The movement-only figures, kept so the two methods stay comparable night by night.
    onset_at_algo: minuteTime(algoOnset),
    wake_at_algo: algoWakeAt,
  };

  // Periods the child is OUT of the bed — from an out_of_bed event until the next into_bed — used below
  // to classify each room-activity block as the child being out vs someone else in the room (child in bed).
  let outIntervals = [];

  // --- Bed-boundary extras. The onset/wake themselves are computed further up (they define the span
  // the metrics measure) and recorded below; what's left here is the out-of-bed intervals the timeline
  // needs. `transitions`, `txMs`, `txIdx`, `lookahead`, `txEndSql` and `firstQuietRunFrom` are all
  // hoisted above, because the early-bedtime onset guard needs them too. ---
  {
    // Build the child-out intervals: open on an out_of_bed, close on the next into_bed. Consecutive
    // out_of_bed events (e.g. a morning cluster) stay one interval; an interval still open at the end of
    // the analysis means the child was out through to the end.
    // Built from the ADOPTED times only — the child is out of the bed before the night's onset and again
    // after the morning departure, and in it in between. Deliberately NOT from the raw transition stream.
    //
    // It used to pair every out_of_bed with the next into_bed, which made the timeline assert who was in
    // the room on the strength of markers that cannot carry that weight. On 2026-08-26 (owner ground
    // truth: nobody entered Renz's room all night) the parent WALKING AWAY from the bed at 18:50 read as
    // the child leaving it, and four of his own rolls-over read as arrivals — so the night was rendered as
    // "out of bed 18:50-23:12" followed by three visits from "someone in the room". The detector answers
    // "did movement cross the bed boundary"; the timeline was asking it "who was in the room", and one
    // camera channel cannot tell a parent from a child. Until it can, we only claim what is corroborated.
    {
      // Closes at the PUT-DOWN, not at onset: between being placed in the bed and falling asleep the
      // child is in it, settling. Movement in the room during those minutes is somebody else — which is
      // the whole point of showing it (Raffa, 2026-08-26: his mother left the room at 19:20, nine minutes
      // after he went down and six before he was asleep).
      const inBedMs = onsetTransitionAt != null
        ? txMs(onsetTransitionAt)
        : analysisStartUtc.getTime() + onset * 60000;
      if (inBedMs > analysisStartUtc.getTime()) outIntervals.push([analysisStartUtc.getTime(), inBedMs]);
      const upMs = transitionExitMs != null
        ? transitionExitMs
        : (sleepEnd < totalMin ? analysisStartUtc.getTime() + sleepEnd * 60000 : null);
      if (upMs != null) outIntervals.push([upMs, effEndMs + lookahead]);
    }

    // The transition-derived times, recorded whether or not they were adopted. When USE_TRANSITION_TIMES
    // is on these match onset_at/wake_at; the pair worth comparing is then *_algo vs the headline.
    out.onset_at_shadow = transitionOnset != null ? minuteTime(transitionOnset) : minuteTime(algoOnset);
    out.wake_at_shadow = transitionWakeAt || algoWakeAt;


    // Only the two transitions the analysis ACTUALLY ADOPTED — the put-down that began the night's sleep
    // and the corroborated morning departure. Every other marker in the stream is an uncorroborated
    // guess at a boundary crossing, and drawing them all put four impossible "got into bed" markers on
    // one night (there was no intervening "got out of bed" for any of them — see the outIntervals note
    // above). These two are the pair that has matched ground truth to the minute on every night on record,
    // and they are the ones the headline times are built from, so the markers and the numbers now agree
    // by construction instead of contradicting each other.
    if (includeTimeline) {
      out.transitions = [
        onsetTransitionAt && { type: TRANSITION.INTO_BED, at: onsetTransitionAt },
        exitTransitionAt && { type: TRANSITION.OUT_OF_BED, at: exitTransitionAt },
      ].filter(Boolean);
    }
  }
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

    // Outside-the-bed movement grouped into "room activity" events, bridging single-minute gaps. Each is
    // typed by whether it falls inside a child-out interval (out_of_bed→into_bed): 'child_out' = the child
    // themselves out of the bed; 'room' = movement while the child is still in the bed (someone in the
    // room). Shown distinctly from the child's own in-bed stirring/waking.
    // The visible timeline starts at the window — or earlier if the child was already asleep before it
    // opened, so an early bedtime is shown rather than silently cropped. It never starts at index 0,
    // which would prepend the whole (usually empty) lookbehind to every night.
    // Include the adopted put-down itself, not just the minute sleep began: the marker sits at the
    // moment the child was placed in the bed, which is minutes EARLIER than the settle. Without this the
    // bar starts at the settle and clips off the very marker it was widened to show (Raffa, 2026-08-26:
    // put down 19:11, settled 19:26).
    const onsetTxIdx = onsetTransitionAt == null
      ? null
      : Math.floor((txMs(onsetTransitionAt) - analysisStartUtc.getTime()) / 60000);
    const displayStart = Math.max(0, Math.min(onset, preMin, onsetTxIdx == null ? preMin : onsetTxIdx));
    // The span the timeline should actually be drawn over. A configured bedtime is a rough guide, not a
    // rule — real bedtimes move nightly, and nobody is going to edit the setting each evening — so when
    // the child was already asleep before the window opened, the bar has to start at the SLEEP, not at
    // the setting. Without this the segments and markers below are computed over a range the bar doesn't
    // cover, and everything before the window edge is silently dropped: on 2026-08-26 that is exactly why
    // Raffa's 19:11 put-down and his mother leaving at 19:20 never appeared — both were correctly
    // detected, then clipped off the left-hand end of a bar that began at 19:30.
    out.display_start = minuteTime(displayStart);
    out.display_end = minuteTime(totalMin);

    // Typed by where the block's MIDPOINT falls, not by any overlap at all: a block that begins in the
    // same minute the child was put down would otherwise be typed by a few seconds of overlap and label
    // ten minutes of a parent settling them as the child being out of bed.
    const overlapsOut = (a, b) => { const mid = (a + b) / 2; return outIntervals.some(([s, e]) => mid >= s && mid < e); };
    const visits = [];
    for (let i = displayStart; i < totalMin; ) {
      if (!outAt[i]) { i++; continue; }
      let last = i;
      let k = i + 1;
      while (k < totalMin && (outAt[k] || (k + 1 < totalMin && outAt[k + 1]))) { if (outAt[k]) last = k; k++; }
      const vStartMs = analysisStartUtc.getTime() + i * 60000;
      const vEndMs = analysisStartUtc.getTime() + (last + 1) * 60000;
      visits.push({
        start_at: minuteTime(i), end_at: minuteTime(last + 1), minutes: last - i + 1,
        type: overlapsOut(vStartMs, vEndMs) ? 'child_out' : 'room',
      });
      i = last + 1;
    }
    out.visits = visits;

    // Run-length segments across the WHOLE window for the to-scale bar. Each minute is labelled:
    // settling (before onset), asleep (quiet), stir (brief in-bed movement/noise that didn't reach a
    // full awakening), wake (a counted awakening), or awake (morning, after the final wake).
    const label = (i) =>
      i < onset ? 'settling' : i >= sleepEnd ? 'awake' : inWake[i] ? 'wake' : active[i] ? 'stir' : 'asleep';
    const segments = [];
    for (let i = displayStart; i < totalMin; ) {
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

    // Automatic wake clips (roadmap 2.4). These deliberately have no detection_events row — they are
    // recorded WITHOUT alerting — so they can't come from the query above. Returned alongside the
    // wakes so the detail view can put a clip against a wake that never produced an alert, which is
    // more than half of them.
    out.wakeClips = listChildWakeClips(childId, startSql, endSql);
  }
  return out;
}

const upsertNight = db.prepare(
  `INSERT INTO sleep_nights
     (child_id, night_date, window_start, window_end, status, onset_at, wake_at,
      onset_at_shadow, wake_at_shadow, onset_at_algo, wake_at_algo,
      asleep_minutes, awake_minutes, wake_count, longest_stretch_minutes, coverage_minutes,
      avg_temperature, avg_humidity, computed_at)
   VALUES (@child_id, @night_date, @window_start, @window_end, @status, @onset_at, @wake_at,
           @onset_at_shadow, @wake_at_shadow, @onset_at_algo, @wake_at_algo,
           @asleep_minutes, @awake_minutes, @wake_count, @longest_stretch_minutes, @coverage_minutes,
           @avg_temperature, @avg_humidity, datetime('now'))
   ON CONFLICT(child_id, night_date) DO UPDATE SET
     window_start=excluded.window_start, window_end=excluded.window_end, status=excluded.status,
     onset_at=excluded.onset_at, wake_at=excluded.wake_at,
     onset_at_shadow=excluded.onset_at_shadow, wake_at_shadow=excluded.wake_at_shadow,
     onset_at_algo=excluded.onset_at_algo, wake_at_algo=excluded.wake_at_algo,
     asleep_minutes=excluded.asleep_minutes,
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
    const toTimelapse = []; // freshly-closed nights to assemble a memories timelapse for
    const emptyNights = []; // ...and those with nobody in the bed, whose frames get thrown away
    const now = Date.now();
    const notifyOn = db.prepare('SELECT sleep_report_alert_enabled FROM settings WHERE id = ?').get('app')?.sleep_report_alert_enabled;
    for (const kid of kids) {
      if (!childTracksSleep(kid.id)) continue; // sleep tracking off for this child
      const nightDate = lastCompletedNightDate(kid.id); // each child on their own window
      const existing = db.prepare('SELECT status FROM sleep_nights WHERE child_id = ? AND night_date = ?').get(kid.id, nightDate);
      if (existing) continue;
      const summary = computeAndStoreNight(kid.id, nightDate);
      computed++;
      // No one in the bed = no memory worth keeping. The frames are of an empty room, so building a
      // timelapse would spend an FFmpeg pass and disk on nothing, and leave a pointless card on the
      // child's page. Occupancy is only known once the night is scored, so the frames are collected
      // overnight either way and discarded here.
      if (summary.status === 'empty') emptyNights.push({ childId: kid.id, nightDate });
      else toTimelapse.push({ childId: kid.id, nightDate });
      // Only notify if the window closed recently (guards against a mid-day restart re-notifying).
      const endMs = summary.window_end ? new Date(summary.window_end.replace(' ', 'T') + 'Z').getTime() : 0;
      if (endMs && now - endMs <= REPORT_FRESH_MS) fresh.push({ name: kid.name, summary });
    }
    if (computed > 0) logger.info(`[sleep] Computed ${computed} sleep summary(ies).`);
    if (notifyOn && fresh.length > 0) notifySleepReports(fresh);
    // Assemble each freshly-closed night's memories timelapse from the frames the sampler collected
    // overnight. Fire-and-forget (one FFmpeg pass each) and dynamically imported to avoid a static
    // import cycle (timelapse.js imports the window helpers from this module). Runs once per night —
    // the `existing` guard above means a night is only in this list the first time it's computed.
    if (toTimelapse.length || emptyNights.length) {
      import('./timelapse.js')
        .then((m) => {
          for (const t of toTimelapse) m.assembleTimelapse(t.childId, t.nightDate).catch(() => {});
          for (const t of emptyNights) { try { m.discardTimelapseFrames(t.childId, t.nightDate); } catch { /* best effort */ } }
        })
        .catch((e) => logger.error(`[timelapse] assembly trigger import failed: ${e.message}`));
    }
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
