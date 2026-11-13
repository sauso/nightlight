// ★ THE NIGHT SUMMARY'S WORDS (sleep score plan, phase 3, Design 5). The server (backend/src/lib/nightSummary.js) picks
// WHICH facts to say, as keys and raw parameters; this file is the only place that turns them into sentences, for the
// sleep detail page (SleepScoreCard.jsx) and the child's card (SleepSummaryCard.jsx). Pure functions, so the whole
// library is tested without rendering anything (test/nightSummaryPhrases.test.js, which runs EVERY variant of EVERY key
// through the guardrails below).
//
// THE VOICE, each part a decision and not an accident:
//   1. DESCRIPTIVE ONLY. What was measured, and how it compares with this child's own recent nights. Never a cause,
//      advice, a diagnosis, praise or blame, and never a sleep stage (no REM, deep or light sleep): the score and the
//      summary come from a camera and a microphone, and docs/sleep-tracking.md says so.
//   2. Calm, short, past tense, one sentence under about 90 characters, no emoji, no exclamation marks. "A child" or
//      "they", never a name: the page knows the child's name and no default phrase needs it (`childName` is accepted
//      and filled into a `{childName}` token should a phrase ever want it). The bed is "bed", never crib or cot.
//   3. A PLURAL NEVER READS WRONG. A count of 0 or 1 gets its own group (`zero`, `one`) where the noun is part of the
//      sentence, and a comparison puts the number last ("...than usual: 3"), so "1 wake-ups" cannot be built.
//
// HOW A SENTENCE IS CHOSEN. Each key has 2 to 4 variants per group. The variant is `hash(seed + key) % variants.length`
// with a small fixed string hash: no randomness, no clock. The server's `seed` is (child, night date), so the wording
// for a night is the same on every render and every refetch, differs between nights, and a phrase added to the library
// later changes the wording only for the keys it was added to. An UNKNOWN key (a tab left open across a deploy of a
// newer server) is skipped without a sound; an unknown or missing headline falls back to the neutral line; a parameter
// that cannot be formatted drops that one observation. Nothing here ever throws on server data.
//
// Nothing here assumes a locale, a timezone, a clock format or a temperature unit: times go through lib/homeTime.js in
// the HOME zone and the viewer's own 12 or 24 hour form (as every other sleep screen does), temperatures arrive as
// degrees Celsius and are shown in the household's unit (`settings.temp_unit`), durations are "7h 30m".

import { formatInZone, TIME } from './homeTime.js';
import { minutesText } from './sleepScoreText.js';

// --- the words -------------------------------------------------------------------------------------------------------
// An entry is { groups: { all: [...] } } or { by: '<selector>', groups: { <group>: [...], ... } } where the selector
// (PHRASE_SELECTORS) names the group a night's params fall in. Placeholders are {param} names the server declares for
// that key (backend/src/lib/nightSummaryKeys.js); the test fails on any other.

const plain = (...variants) => ({ groups: { all: variants } });

export const HEADLINE_PHRASES = Object.freeze({
  // "Settled" and "typical" say how the night held together, not how many wake-ups there were: a count that is
  // ordinary in one room (the score's curves were tuned on two cameras in one house) is not "few" in another.
  // HEADLINES ARE SHORT ON PURPOSE (about 38 characters at most): on the child's card one line is all there is, and
  // beside the score ring on a 375px screen about 35 characters fit before it is cut with an ellipsis.
  settled: plain(
    'A settled night overall.',
    'Steady through most of the night.',
    'A steady, settled night.',
  ),
  typical: plain(
    'A fairly steady night overall.',
    'Steady, with some waking or stirring.',
    'A mostly even night overall.',
  ),
  mixed: plain(
    'A mixed night overall.',
    'Some measures steady, some not.',
    'Steadier and less steady parts.',
  ),
  unsettled: plain(
    'Lots of waking or stirring overnight.',
    'Sleep was often interrupted.',
    'A restless night overall.',
  ),
  // No score, or a night the score cannot judge (too little of it was watched, times entered by hand): only a plain
  // line, never a judgement.
  neutral_last_night: plain(
    'Sleep as measured overnight.',
    'What was measured overnight.',
    'A look at what was measured.',
  ),
  neutral_so_far: plain(
    'Sleep so far tonight, as measured.',
    'Measured so far; the night goes on.',
    'The night so far, as measured.',
  ),
});

const COMPARE = (more, less, same) => ({ by: 'direction', groups: { more, less, about_the_same: same } });

export const OBSERVATION_PHRASES = Object.freeze({
  total_sleep: plain(
    'Asleep for {minutes} in total.',
    'A total of {minutes} asleep.',
    'Time asleep came to {minutes}.',
    'Total time asleep was {minutes}.',
  ),
  total_sleep_vs_usual: COMPARE(
    [
      'Asleep for {minutes}, more than the usual {usual_minutes}.',
      '{minutes} asleep, longer than the usual {usual_minutes}.',
      'Time asleep was {minutes}, above the usual {usual_minutes}.',
    ],
    [
      'Asleep for {minutes}, less than the usual {usual_minutes}.',
      '{minutes} asleep, shorter than the usual {usual_minutes}.',
      'Time asleep was {minutes}, under the usual {usual_minutes}.',
    ],
    [
      'Asleep for {minutes}, about the usual {usual_minutes}.',
      '{minutes} asleep, close to the usual {usual_minutes}.',
      'Time asleep was {minutes}, in line with the usual {usual_minutes}.',
    ],
  ),
  wake_ups: {
    by: 'count',
    groups: {
      zero: ['No wake-ups were counted overnight.', 'There were no wake-ups counted during the night.'],
      one: ['One wake-up was counted overnight.', 'There was one wake-up during the night.'],
      other: [
        '{count} wake-ups were counted overnight.',
        'There were {count} wake-ups during the night.',
        'The night had {count} wake-ups.',
      ],
    },
  },
  wake_ups_vs_usual: COMPARE(
    [
      'There were more wake-ups than usual: {count}, against about {usual_count}.',
      'Wake-ups came to {count}, more than the usual {usual_count}.',
      'The count of wake-ups was {count}, above the usual {usual_count}.',
    ],
    [
      'There were fewer wake-ups than usual: {count}, against about {usual_count}.',
      'Wake-ups came to {count}, fewer than the usual {usual_count}.',
      'The count of wake-ups was {count}, below the usual {usual_count}.',
    ],
    [
      'The number of wake-ups was {count}, about the usual {usual_count}.',
      'Wake-ups came to {count}, close to the usual {usual_count}.',
      'The count of wake-ups was {count}, in line with the usual {usual_count}.',
    ],
  ),
  longest_stretch: plain(
    'The longest unbroken stretch was {minutes}.',
    'Longest stretch without waking: {minutes}.',
    'The longest run of sleep lasted {minutes}.',
  ),
  longest_stretch_vs_usual: COMPARE(
    [
      // The server compares the stretch's SHARE of the night with the child's usual share (the score's own measure), so
      // the sentence says "share of the night": a shorter stretch in a shorter night can be a larger share (Codex review
      // of PR #1052).
      'The longest unbroken stretch was {minutes}, a larger share of the night than usual.',
      'Longest stretch without waking: {minutes}, a larger share of the night than usual.',
      'The longest run of sleep lasted {minutes}, a bigger part of the night than usual.',
    ],
    [
      'The longest unbroken stretch was {minutes}, a smaller share of the night than usual.',
      'Longest stretch without waking: {minutes}, a smaller share of the night than usual.',
      'The longest run of sleep lasted {minutes}, a smaller part of the night than usual.',
    ],
    [
      'The longest unbroken stretch was {minutes}, about the usual share of the night.',
      'Longest stretch without waking: {minutes}, about the usual share of the night.',
      'The longest run of sleep lasted {minutes}, about the usual part of the night.',
    ],
  ),
  settling_time: plain(
    'From being put down to falling asleep took {minutes}.',
    'Falling asleep took {minutes} after being put down.',
    '{minutes} passed between being put down and falling asleep.',
  ),
  wake_clustering: plain(
    '{count} of the wake-ups came between {from_at} and {to_at}.',
    'Most wake-ups were close together, {count} of them between {from_at} and {to_at}.',
    '{count} wake-ups fell in the window from {from_at} to {to_at}.',
  ),
  room_activity_near_wakes: plain(
    'Movement outside the bed was seen around {count} of the {wakes} wake-ups.',
    'Around {count} of the {wakes} wake-ups, movement outside the bed was seen.',
    '{count} of the {wakes} wake-ups had movement outside the bed nearby.',
  ),
  temperature_range: {
    by: 'temperature',
    groups: {
      range: [
        'The room stayed between {min_c} and {max_c}.',
        'Room temperature ranged from {min_c} to {max_c}.',
        'The room measured {min_c} to {max_c} overnight.',
      ],
      // The two ends read the same once rounded to a whole degree: one figure, not "between 20° and 20°".
      single: [
        'The room measured about {max_c} overnight.',
        'Room temperature held near {max_c}.',
        'The room stayed around {max_c}.',
      ],
    },
  },
  reduced_coverage: {
    by: 'unwatched',
    groups: {
      without_unwatched: [
        'The camera watched about {coverage_percent} of the sleep window.',
        'Only about {coverage_percent} of the sleep window was watched.',
        'Coverage was about {coverage_percent} of the sleep window.',
      ],
      with_unwatched: [
        'About {coverage_percent} of the window was watched; {unwatched_minutes} of sleep went unobserved.',
        'Watched for about {coverage_percent} of the window, with {unwatched_minutes} of sleep time unobserved.',
        '{unwatched_minutes} of sleep time was not observed, with about {coverage_percent} of the window watched.',
      ],
    },
  },
  building_baseline: plain(
    'There are not yet enough recent nights to say what is usual.',
    'Not enough recent nights yet to know what is usual.',
    'What is usual for this child is still being worked out.',
  ),
  no_sleep_detected: plain(
    'No sleep was detected for this night.',
    'The camera and microphone did not pick up any sleep.',
    'No clear sleep was measured overnight.',
  ),
  times_entered_by_hand: plain(
    'The times for this night were entered by hand.',
    'These times were entered by hand, not measured.',
    'Asleep and up times were entered by hand for this night.',
  ),
  sleep_span: plain(
    'Asleep from {onset_at} to {wake_at}.',
    'Sleep ran from {onset_at} to {wake_at}.',
    'The times entered were {onset_at} asleep and {wake_at} up.',
  ),
  nobody_in_bed: plain(
    'This night was marked as having no one in the bed.',
    'No one was in the bed, as noted for this night.',
    'The bed was noted as empty for this night.',
  ),
  // A night still in progress (phase 4): "so far" in every variant, because the figure is not final, and descriptive
  // only, because half a night is not a night to compare. No "overnight" (the night is still going) and no "usual".
  total_sleep_so_far: plain(
    'Asleep for {minutes} so far.',
    'A total of {minutes} asleep so far.',
    'Time asleep so far is {minutes}.',
  ),
  wake_ups_so_far: {
    by: 'count',
    groups: {
      // COUNTED, in every zero variant: a wake-up in progress right now is not counted until it ends, so "no wake-ups so
      // far" could sit beside "awake since 2:10 AM" and contradict it.
      zero: ['No wake-ups have been counted so far.', 'So far, no wake-ups have been counted.'],
      one: ['One wake-up has been counted so far.', 'There has been one wake-up so far.'],
      other: [
        '{count} wake-ups have been counted so far.',
        'There have been {count} wake-ups so far.',
        'So far there have been {count} wake-ups.',
      ],
    },
  },
  longest_stretch_so_far: plain(
    'The longest unbroken stretch so far is {minutes}.',
    'Longest stretch without waking so far: {minutes}.',
    'The longest run of sleep so far has lasted {minutes}.',
  ),
});

// --- formatting ------------------------------------------------------------------------------------------------------

// 'YYYY-MM-DD HH:MM:SS' (UTC, as the database stores it) -> a Date, or null.
function utcDate(s) {
  if (typeof s !== 'string' || !s) return null;
  const d = new Date(`${s.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
const wholeNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v)) : null);

// Every parameter the server can send, but `direction` (which picks a group and is never printed), and how it reads.
// `opts`: { zone, tempUnit }. A formatter returns null for a value it cannot read; the observation is then dropped.
export const PARAM_FORMATTERS = Object.freeze({
  minutes: (v) => minutesText(v),
  usual_minutes: (v) => minutesText(v),
  unwatched_minutes: (v) => minutesText(v),
  count: wholeNumber,
  usual_count: wholeNumber, // a usual is a median and can be 1.5: "about 2" is as exact as a camera's count is
  wakes: wholeNumber,
  from_at: (v, o) => { const d = utcDate(v); return d ? formatInZone(d, o.zone, TIME) || null : null; },
  to_at: (v, o) => { const d = utcDate(v); return d ? formatInZone(d, o.zone, TIME) || null : null; },
  onset_at: (v, o) => { const d = utcDate(v); return d ? formatInZone(d, o.zone, TIME) || null : null; },
  wake_at: (v, o) => { const d = utcDate(v); return d ? formatInZone(d, o.zone, TIME) || null : null; },
  // Degrees Celsius in, the household's unit out, a whole degree: a room reading to a tenth of a degree says more
  // than the sensor knows, and a sentence is not a chart (the detail page's climate track shows the tenths).
  min_c: (v, o) => temperatureText(v, o.tempUnit),
  max_c: (v, o) => temperatureText(v, o.tempUnit),
  coverage_percent: (v) => (typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : null),
});

function temperatureText(celsius, unit) {
  if (typeof celsius !== 'number' || !Number.isFinite(celsius)) return null;
  const f = unit === 'F';
  return `${Math.round(f ? (celsius * 9) / 5 + 32 : celsius)}°${f ? 'F' : 'C'}`;
}

// Which group of an entry a night's params fall in. `text` is the formatted params (so "the same once rounded" is
// decided on what is printed). Returns a group name; a name the entry does not have drops the observation.
export const PHRASE_SELECTORS = Object.freeze({
  direction: (params) => params.direction,
  count: (params) => (params.count === 0 ? 'zero' : params.count === 1 ? 'one' : 'other'),
  temperature: (_params, text) => (text.min_c === text.max_c ? 'single' : 'range'),
  unwatched: (params) => (params.unwatched_minutes > 0 ? 'with_unwatched' : 'without_unwatched'),
});

// --- choosing ------------------------------------------------------------------------------------------------------------

// FNV-1a, 32 bit, over the UTF-16 code units: small, fixed, and the same in every browser. Not for security.
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// The index of the variant for this night and key: a pure function of its inputs, so the wording never changes
// between renders. The key is part of the hash so two observations on one night do not all pick "the third".
export function variantIndex(seed, key, length) {
  if (!Number.isInteger(length) || length < 1) return 0;
  return hash(`${seed ?? ''}|${key}`) % length;
}

function fill(template, text, childName) {
  return template
    .replace(/\{(\w+)\}/g, (whole, name) => (name === 'childName' ? (childName ?? '') : (text[name] ?? whole)))
    .trim();
}

// One entry's sentence, or null when it cannot be said (unreadable params, a group the entry lacks).
function sentence(entry, key, params, seed, opts) {
  if (!entry || !params || typeof params !== 'object') return null;
  const text = {};
  for (const [name, value] of Object.entries(params)) {
    if (name === 'direction') continue;
    // A parameter this build has never heard of (a newer server added one to a key it knew) is ignored: the templates
    // only name the ones they were written for. One that is known but unreadable drops the observation.
    const format = PARAM_FORMATTERS[name];
    if (!format) continue;
    const out = format(value, opts);
    if (out == null) return null; // say nothing rather than a half sentence
    text[name] = out;
  }
  const select = entry.by ? PHRASE_SELECTORS[entry.by] : null;
  const group = select ? select(params, text) : 'all';
  const variants = entry.groups[group];
  if (!Array.isArray(variants) || variants.length === 0) return null;
  const line = fill(variants[variantIndex(seed, key, variants.length)], text, opts.childName);
  // A placeholder left unfilled means the template asked for a parameter the server did not send: not shown.
  return /\{\w+\}/.test(line) ? null : line;
}

// The headline's sentence. An unknown or missing key falls back to the neutral line, so a newer server's new class
// still shows something true rather than nothing or a crash.
export function headlineText(summary, opts = {}) {
  if (!summary || typeof summary !== 'object') return null;
  const key = summary.headline && typeof summary.headline === 'object' ? summary.headline.key : null;
  const known = typeof key === 'string' && Object.hasOwn(HEADLINE_PHRASES, key);
  const use = known ? key : 'neutral_last_night';
  return sentence(HEADLINE_PHRASES[use], use, {}, summary.seed, opts);
}

// The whole summary as text: { headline, observations: [string] }, or null when the night carries no usable summary
// (`summary` absent or null: an older server, a failure, or a night with nothing to say), and the caller shows what it
// always showed. Unknown observation keys are skipped.
//   opts: { zone, tempUnit, childName }.
export function nightSummaryText(summary, opts = {}) {
  const headline = headlineText(summary, opts);
  if (!headline) return null;
  const observations = [];
  for (const o of Array.isArray(summary.observations) ? summary.observations : []) {
    if (!o || typeof o.key !== 'string' || !Object.hasOwn(OBSERVATION_PHRASES, o.key)) continue;
    const line = sentence(OBSERVATION_PHRASES[o.key], o.key, o.params ?? {}, summary.seed, opts);
    if (line) observations.push(line);
  }
  return { headline, observations };
}

// The sleep page joins the two related end-of-night measurements into one sentence. These are fixed
// variants, selected by the same seed/key hash as the observation library; unpaired facts keep their
// existing sentences so a newer server or a partial night never produces a broken clause.
export const BLURB_PHRASES = Object.freeze({
  stretch_settle: [
    'The longest stretch was {minutes}, and settling took {settle_minutes}.',
    'The longest stretch lasted {minutes}; settling took {settle_minutes}.',
  ],
  stretch_settle_more: [
    'The longest stretch was {minutes}, a larger share than usual; settling took {settle_minutes}.',
    'A {minutes} stretch made up more of the night than usual; settling took {settle_minutes}.',
  ],
  stretch_settle_less: [
    'The longest stretch was {minutes}, a smaller share than usual; settling took {settle_minutes}.',
    'A {minutes} stretch made up less of the night than usual; settling took {settle_minutes}.',
  ],
  stretch_settle_about_the_same: [
    'The longest stretch was {minutes}, about the usual share; settling took {settle_minutes}.',
    'A {minutes} stretch was about the usual share of the night; settling took {settle_minutes}.',
  ],
});

export function nightBlurbText(summary, opts = {}) {
  const base = nightSummaryText(summary, opts);
  if (!base) return null;
  const entries = Array.isArray(summary.observations) ? summary.observations : [];
  const stretch = entries.find((o) => o?.key === 'longest_stretch' || o?.key === 'longest_stretch_vs_usual');
  const settle = entries.find((o) => o?.key === 'settling_time');
  // Validate the whole observation first: a null usual or other required param must never be
  // smuggled into a merged sentence just because its minutes field happens to be present.
  const stretchValid = stretch && sentence(OBSERVATION_PHRASES[stretch.key], stretch.key, stretch.params ?? {}, summary.seed, opts);
  const settleValid = settle && sentence(OBSERVATION_PHRASES.settling_time, 'settling_time', settle.params ?? {}, summary.seed, opts);
  const stretchText = stretchValid && PARAM_FORMATTERS.minutes(stretch.params.minutes);
  const settleText = settleValid && PARAM_FORMATTERS.minutes(settle.params.minutes);
  const mergeKey = stretch?.key === 'longest_stretch_vs_usual' ? `stretch_settle_${stretch.params?.direction}` : 'stretch_settle';
  const variants = BLURB_PHRASES[mergeKey];
  const merged = stretchText && settleText && variants
    ? fill(variants[variantIndex(summary.seed, mergeKey, variants.length)],
      { minutes: stretchText, settle_minutes: settleText }, opts.childName)
    : null;
  const lines = [];
  for (const o of entries) {
    if (!o || typeof o.key !== 'string' || !Object.hasOwn(OBSERVATION_PHRASES, o.key)) continue;
    if (merged && o === settle) continue;
    if (merged && o === stretch) { lines.push(merged); continue; }
    const line = sentence(OBSERVATION_PHRASES[o.key], o.key, o.params ?? {}, summary.seed, opts);
    if (line) lines.push(line);
  }
  return lines.slice(0, 3);
}
