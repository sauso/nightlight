// The words for the sleep score (sleep score plan, phase 2). The server sends KEYS (a band, a component, a reason);
// this file is the only place that turns them into text, for the child's card (SleepSummaryCard.jsx) and the sleep
// detail page (SleepScoreCard.jsx). Pure functions, so they are tested without rendering anything.
//
// THREE RULES, each of them a decision and not an accident:
//   1. DESCRIPTIVE ONLY. Nothing here gives advice, names a cause, or mentions sleep stages (no REM, deep or light
//      sleep): the score is an estimate from a camera and a microphone, and docs/sleep-tracking.md says the same.
//   2. AN UNKNOWN KEY NEVER THROWS. A tab left open across a deploy can be handed a reason or a component this build
//      has never heard of. Every lookup has a neutral fallback, and an unknown component is skipped by the caller
//      (componentName returns null), so an older page keeps working against a newer server.
//   3. NO NUMBER FROM THE FORMULA IS REPEATED HERE (the 40-point cap, the 7 nights, the 15 minutes). Those live in
//      the server's SCORE_CONFIG and the docs; a retuned formula must not leave this wording stating the old value.
//
// Nothing here assumes a locale, a clock format or a timezone: durations are plain minutes, and the one clock time
// (consistency) goes through lib/homeTime.js like every other time on these screens.

import { formatInZone, resolveZone, zonesDiffer, TIME } from './homeTime.js';

// The night's score object when it carries a NUMBER, else null. The one test for "is there a ring to draw":
// `score` absent (the child's "Show sleep score" switch is off), `null` (scoring failed on the server) and
// `{ score: null, reason }` (no score for this night, with the reason) all have no ring.
export function scoreOf(night) {
  const s = night?.score;
  return s && typeof s === 'object' && typeof s.score === 'number' && Number.isFinite(s.score) ? s : null;
}
// The score the night card draws, and therefore the one whose "Why this score?" sheet exists: none while the night is
// still in progress, whatever a stale response carries. SleepDetail decides whether the page keeps its own facts grid
// with THIS same function, so the grid shows exactly when the card has no sheet to hold those facts.
export function sheetScoreOf(night) {
  return night?.in_progress ? null : scoreOf(night);
}

// The server's band key, worded. Under the lowest band the server sends null and the number stands alone.
const BAND_WORDS = { great: 'Great', good: 'Good', fair: 'Fair' };

// The band word, or null. ⚠️ Never on an early estimate, whatever `band` says: until the child has a usual of their
// own the score is measured against an age figure of a different quantity (sleepScore.js AGE_NIGHT_SLEEP_HOURS), and
// a word would claim more than that supports. The server already sends `band: null` then; this is the second lock.
export function bandWord(score) {
  if (!score || score.early_estimate) return null;
  return BAND_WORDS[score.band] ?? null;
}

// The band as a COLOUR key for the ring: 'great' | 'good' | 'fair' | 'low' | 'early', or null for "no colour".
// (index.css: --band-<key> and --band-<key>-ring; docs/design-language.md, "Band colours".)
//   - 'early' for an early estimate, whatever `band` says (the same second lock as bandWord): the ring goes neutral and
//     its track dashed, so a provisional number does not look like a verdict.
//   - the server's own band key when it is great, good or fair. The 85/70/55 edges live ONLY in the server's
//     SCORE_CONFIG.bands; they are deliberately NOT repeated here, so a retuned server cannot leave the colours
//     disagreeing with the word beside the ring.
//   - 'low' when the server sent `band: null` for a numeric score: that IS the server's "under the lowest edge, the
//     number stands alone", and it gets a colour of its own (a soft rose, not red) while still having no word.
//   - null for a band key this build does not know (a newer server that added one) and for no number at all. Guessing
//     'low' for an unknown key would colour a possibly GOOD night rose; null keeps today's neutral periwinkle ring, and
//     the number and the server's words still say how the night went. Same rule as the unknown reason keys above.
const COLOUR_BANDS = ['great', 'good', 'fair'];
// The server's SCORE_CONFIG.bands uses these edges. A factor has no band key in the response, so the sheet
// mirrors them here in one place; changing the server edges requires changing this tested display mapping too.
export const FACTOR_BAND_EDGES = Object.freeze({ great: 85, good: 70, fair: 55 });
// A factor score is 0 to 100 by construction (sleepScore.js curveAt). A value outside it can only be a newer or
// faulty server, so what is printed and what picks the band is held inside the range rather than showing "101/100".
// Null for anything that is not a finite number (the factor then reads as not counted).
export function clampFactorScore(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}
export function bandOfValue(value) {
  value = clampFactorScore(value);
  if (value == null) return null;
  if (value >= FACTOR_BAND_EDGES.great) return 'great';
  if (value >= FACTOR_BAND_EDGES.good) return 'good';
  if (value >= FACTOR_BAND_EDGES.fair) return 'fair';
  return 'low';
}
export function bandOf(score) {
  if (!score || typeof score.score !== 'number' || !Number.isFinite(score.score)) return null;
  if (score.early_estimate) return 'early';
  if (COLOUR_BANDS.includes(score.band)) return score.band;
  return score.band === null ? 'low' : null;
}

// What sits beside the number: the band word, "Early estimate", or nothing.
export function scoreQualifier(score) {
  if (!score) return null;
  if (score.early_estimate) return 'Early estimate';
  return bandWord(score);
}

// The score as one spoken phrase, for an aria-label: "82, Good", "64, early estimate", or "48".
export function scoreLabel(score) {
  if (!score) return '';
  const n = Math.round(score.score);
  if (score.early_estimate) return `${n}, early estimate`;
  const word = bandWord(score);
  return word ? `${n}, ${word}` : String(n);
}

// --- units ---------------------------------------------------------------------------------------------------------

// Minutes as "10h 5m" / "45m": the same form the two sleep screens already print (fmtDur in SleepDetail.jsx and
// SleepSummaryCard.jsx). Rounded first, because a usual is a median and can be a half minute.
export function minutesText(min) {
  if (typeof min !== 'number' || !Number.isFinite(min)) return null;
  const whole = Math.max(0, Math.round(min));
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const percentText = (frac) => (typeof frac === 'number' && Number.isFinite(frac) ? `${Math.round(frac * 100)}%` : null);
const oneDecimal = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : null);

// A clock time the server sends as minutes since 12:00 noon (so an evening and the next morning sit on one line:
// 19:30 is 450, 07:00 is 1140). It is already a WALL-CLOCK time in the timezone the night was measured in, so it is
// printed as it is (built in UTC and formatted in UTC: no zone can move it), in the viewer's own 12 or 24 hour form.
export function clockText(minutesSinceNoon) {
  if (typeof minutesSinceNoon !== 'number' || !Number.isFinite(minutesSinceNoon)) return null;
  const d = new Date(Date.UTC(2000, 0, 1, 12, 0) + Math.round(minutesSinceNoon) * 60000);
  return formatInZone(d, 'UTC', TIME) || null;
}

// --- the five parts ------------------------------------------------------------------------------------------------

const COMPONENT_NAMES = {
  duration: 'Duration',
  continuity: 'Continuity',
  settling: 'Settling',
  restlessness: 'Restlessness',
  consistency: 'Consistency',
};

// The part's name, or null for one this build does not know: the breakdown skips it (rule 2 above).
export const componentName = (key) => COMPONENT_NAMES[key] ?? null;

// The smaller figures inside continuity and consistency, named for a "not counted" line.
const TERM_NAMES = {
  efficiency: 'share of the night asleep',
  longest_share: 'longest stretch',
  wake_count: 'wake-ups',
  onset: 'time asleep',
  wake: 'time up',
};

// Why a part (or one figure inside it) is not in the score. Keys are sleepScore.js's `reason` values.
const UNAVAILABLE = {
  no_in_bed: 'No put-down was detected for this night.',
  in_bed_hidden: 'The put-down time is not known well enough for this night.',
  no_baseline: 'Not enough recent nights yet to know what is usual.',
  missing: 'This was not measured for this night.',
  span_corrected: 'The times for this night were corrected, so this measurement no longer fits them.',
  unwatched: 'Part of the night was not observed.',
  no_timezone: 'The timezone this night was measured in is not known.',
  wake_unconfirmed: 'The time up is not certain for this night.',
};
export const UNAVAILABLE_FALLBACK = 'Not available for this night.';
export const unavailableText = (reason) => UNAVAILABLE[reason] ?? UNAVAILABLE_FALLBACK;

// Why a night has no score at all. Keys are scoreNight's no-score `reason` values. An unknown one gets no sentence:
// the caller still says "No score yet".
const NO_SCORE = {
  in_progress: 'The night is still in progress.',
  not_ok: 'No sleep was worked out for this night.',
  promoted_from_empty: 'The times for this night were entered by hand, so its wake-ups were never measured.',
  no_sleep_measured: 'No sleep was measured for this night.',
  no_duration_reference: 'It needs about a week of tracked nights, or a birthday in this child’s settings.',
  under_12_months_no_baseline: 'Under 12 months, it needs about a week of tracked nights first.',
};
export const noScoreText = (reason) => NO_SCORE[reason] ?? '';

// A night that is still going has no score and no whole-night summary YET, and the cards say WHEN they arrive instead of
// "No score yet" (UI refresh PR H, the approved design): "Score and night summary after 7:00 AM". The time is the END OF THE
// NIGHT WINDOW in the app's configured zone (home time, never the browser's: docs/design-language.md), because that is when
// the night stops changing; the server may still recheck it for a few hours after (SleepScoreCard's "may still change" note).
//
// `night` is the night object of either card. Null unless the night is in progress, carries a score OBJECT (so the child's
// "Show sleep score" switch being off stays silent: promising a score that will never be shown would be a lie) and has a
// readable window end. The callers fall back to what they said before when this is null, so an older server or a night
// without a window end changes nothing.
export function pendingNightText(night, zone) {
  if (!night?.in_progress) return null;
  if (!night.score || typeof night.score !== 'object') return null;
  const s = night.window_end;
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return null;
  // The short zone name rides along when this device sits in another zone than the home one, like every other time of day
  // (useHomeTime): "after 7:00 AM GMT+10" says WHICH 7:00 to someone looking at the card from abroad.
  const home = resolveZone(zone);
  const at = formatInZone(d, home, TIME, zonesDiffer(home));
  return at ? `Score and night summary after ${at}` : null;
}

// One part's own figures in human units: what was measured and, where there is one, the child's usual.
// '' when there is nothing sensible to say (an unknown part, a missing value): the bar and its score still show.
export function componentDetail(c) {
  if (!c || typeof c !== 'object') return '';
  const usual = (text) => (text ? ` Usual: ${text}.` : '');
  switch (c.key) {
    case 'duration': {
      const value = minutesText(c.value);
      if (!value) return '';
      // WHICH comparison it was (sleepScore.js `basis`): minutes asleep against the child's usual minutes asleep,
      // or, before there is a usual, the whole span against a published figure for the child's age.
      if (c.basis === 'span_vs_age') {
        const ref = minutesText(c.usual);
        return `${value} from falling asleep to waking. Early estimate: compared with a published figure for this age`
          + `${ref ? ` (${ref})` : ''}, until there are enough nights to know what is usual.`;
      }
      if (c.basis === 'asleep_vs_usual') return `${value} asleep.${usual(minutesText(c.usual))}`;
      return `${value}.`;
    }
    case 'continuity': {
      const value = percentText(c.value);
      const lead = value ? `Asleep for ${value} of the observed time between falling asleep and waking.${usual(percentText(c.usual))} ` : '';
      return `${lead}Also counts the longest unbroken stretch and the number of wake-ups.`;
    }
    case 'settling': {
      const value = minutesText(c.value);
      return value ? `${value} from being put down to falling asleep.${usual(minutesText(c.usual))}` : '';
    }
    case 'restlessness': {
      const value = oneDecimal(c.value);
      return value ? `${value} stirring minutes per hour asleep.${usual(oneDecimal(c.usual))}` : '';
    }
    case 'consistency': {
      const terms = Array.isArray(c.terms) ? c.terms : [];
      const line = (key, verb) => {
        const t = terms.find((x) => x && x.key === key && x.available);
        const at = t ? clockText(t.value) : null;
        if (!at) return '';
        const u = clockText(t.usual);
        return `${verb} ${at}${u ? ` (usual ${u})` : ''}.`;
      };
      return [line('onset', 'Fell asleep'), line('wake', 'Got up')].filter(Boolean).join(' ');
    }
    default:
      return '';
  }
}

// The figures INSIDE an available part that were left out, each with its reason: "Longest stretch not counted: …".
// Only known terms; `no_baseline` on a term of a part that still scored is not worth a line of its own.
export function droppedTerms(c) {
  if (!c || !c.available || !Array.isArray(c.terms)) return [];
  return c.terms
    .filter((t) => t && t.available === false && TERM_NAMES[t.key] && t.reason !== 'no_baseline')
    .map((t) => {
      const name = TERM_NAMES[t.key];
      return `${name.charAt(0).toUpperCase()}${name.slice(1)} not counted: ${unavailableText(t.reason).replace(/\.$/, '').replace(/^./, (ch) => ch.toLowerCase())}.`;
    });
}

// Why a score is marked low confidence, as one sentence. Unknown reasons are left out; with none known the
// sentence is still said, without a list.
export function lowConfidenceText(score) {
  if (!score || !score.low_confidence) return '';
  const reasons = Array.isArray(score.low_confidence_reasons) ? score.low_confidence_reasons : [];
  const unwatched = minutesText(score.unwatched_minutes);
  const parts = [];
  if (reasons.includes('low_coverage')) parts.push('the camera did not watch enough of the sleep window');
  if (reasons.includes('unwatched')) parts.push(unwatched ? `${unwatched} of the night were not observed` : 'part of the night was not observed');
  if (reasons.includes('wake_unconfirmed')) parts.push('the time up is not certain');
  return parts.length ? `Low confidence: ${parts.join('; ')}.` : 'Low confidence: parts of this night were not measured well.';
}

// The line for a capped score, naming the part. '' when nothing capped it or the part is not one this build knows.
export function cappedText(score) {
  const name = score ? componentName(score.capped_by) : null;
  return name ? `Held down by ${name.toLowerCase()}: the overall score cannot sit far above that part.` : '';
}
