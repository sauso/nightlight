// The night summary's words and where they appear (sleep score plan, phase 3): the phrase library
// (src/lib/nightSummaryPhrases.js), the night card blurb on the sleep detail page and the headline on the
// child's card. The selection of WHICH facts to say is the server's (backend/test/night-summary.test.js).
//
// THE GUARDRAIL SUITE runs over EVERY variant of EVERY key, so a phrase added later is checked without anyone
// remembering to: no banned term, no exclamation mark, no "night timeline" (the card was once titled that and the
// docs screenshot run waited for it; it now waits for the exact title "Timeline", e2e/walkthrough/capture.mjs, and the ban stays so
// no summary phrase can ever be mistaken for the title), no emoji, every {placeholder} one of the params the server declares for that key, and short.
// The server's key table (backend/src/lib/nightSummaryKeys.js, which has no imports so this test can load it) is the
// single list both sides are held to: a key added on one side only fails a test here.
//
// Behaviour only: no CSS selectors, pixels or stylesheet text (CLAUDE.md, proportionate testing 7). The wording
// literals pinned below are for one seed, to prove the pieces fit; the guardrails, not the literals, are what keeps
// the library honest, and a deliberate rewording updates the literals.
//
// Fixture names and ids are made up: the repo is public.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import SleepScoreCard from '../src/components/SleepScoreCard.jsx';
import SleepSummaryCard from '../src/components/SleepSummaryCard.jsx';
import { api } from '../src/lib/api.js';
import {
  HEADLINE_PHRASES, OBSERVATION_PHRASES, BLURB_PHRASES, PARAM_FORMATTERS, PHRASE_SELECTORS, variantIndex, nightSummaryText, nightBlurbText, headlineText,
} from '../src/lib/nightSummaryPhrases.js';
import { HEADLINE_KEYS, OBSERVATION_PARAMS, DIRECTIONS } from '../../backend/src/lib/nightSummaryKeys.js';

afterEach(() => vi.restoreAllMocks());

// Every (kind, key, group, variant) of the library, flat.
const ALL = [];
for (const [key, entry] of Object.entries(HEADLINE_PHRASES)) {
  for (const [group, variants] of Object.entries(entry.groups)) variants.forEach((text, i) => ALL.push({ kind: 'headline', key, group, i, text }));
}
for (const [key, entry] of Object.entries(OBSERVATION_PHRASES)) {
  for (const [group, variants] of Object.entries(entry.groups)) variants.forEach((text, i) => ALL.push({ kind: 'observation', key, group, i, text }));
}
for (const [key, variants] of Object.entries(BLURB_PHRASES)) {
  variants.forEach((text, i) => ALL.push({ kind: 'blurb', key, group: 'all', i, text }));
}
const label = (p) => `${p.kind} ${p.key}/${p.group}[${p.i}]: "${p.text}"`;

// Words the summary must never use. Whole words, any case. "should" and "because" are advice and cause; "ideal", "safe",
// "healthy", "badly" and "poor" are verdicts; "parent", "mum" and "dad" name a person the camera cannot tell from anyone
// else; "REM", "deep sleep" and "light sleep" are sleep stages the app does not measure; "crib" and "cot" are not the
// app's word for the bed.
const BANNED = ['ideal', 'safe', 'healthy', 'badly', 'poor', 'because', 'parent', 'mum', 'dad', 'deep sleep', 'REM', 'light sleep', 'should', 'crib', 'cot',
  // Pronouns: the project never guesses one for a child, and "them"/"their" would also read as about a person (owner
  // rule; found by review of PR #1063 in the one variant that said "3 of them").
  'he', 'she', 'they', 'them', 'their', 'his', 'her', 'him', 'hers'];
const bannedRe = (word) => new RegExp(`(^|[^\\p{L}])${word.replace(/ /g, '\\s+')}($|[^\\p{L}])`, 'iu');

describe('the guardrails, over every variant of every key', () => {
  test('precondition: the library is not empty, and every key has 2 to 4 variants in every group', () => {
    expect(ALL.length).toBeGreaterThan(60);
    const perGroup = new Map();
    for (const p of ALL) perGroup.set(`${p.kind}/${p.key}/${p.group}`, (perGroup.get(`${p.kind}/${p.key}/${p.group}`) ?? 0) + 1);
    for (const [where, n] of perGroup) expect([where, n >= 2 && n <= 4]).toEqual([where, true]);
  });

  test('no banned term, no exclamation mark, no "night timeline", no emoji, under 120 characters', () => {
    // Precondition: the matcher can fail (it is not vacuous).
    expect(bannedRe('should').test('You should rest')).toBe(true);
    expect(bannedRe('cot').test('A scotch')).toBe(false);
    expect(bannedRe('REM').test('the rem phase')).toBe(true);
    for (const p of ALL) {
      for (const word of BANNED) expect([label(p), word, bannedRe(word).test(p.text)]).toEqual([label(p), word, false]);
      expect([label(p), p.text.includes('!')]).toEqual([label(p), false]);
      expect([label(p), /night\s+timeline/i.test(p.text)]).toEqual([label(p), false]);
      expect([label(p), /\p{Extended_Pictographic}/u.test(p.text)]).toEqual([label(p), false]);
      expect([label(p), p.text.length < 120]).toEqual([label(p), true]);
      // One sentence, ending in a full stop.
      expect([label(p), /^[^.]+\.$/.test(p.text.replace(/\{\w+\}/g, 'x').replace(/\d/g, 'x'))]).toEqual([label(p), true]);
    }
  });

  test('a headline is short enough for the child\'s card: under 40 characters (one line, beside the ring, at 375px)', () => {
    const headlines = ALL.filter((p) => p.kind === 'headline');
    expect(headlines.length).toBe(18); // precondition: six keys, three variants each
    for (const p of headlines) expect([label(p), p.text.length < 40]).toEqual([label(p), true]);
  });

  test('every {placeholder} is a param the server declares for that key; a headline has none; no phrase needs the child\'s name', () => {
    for (const p of ALL) {
      const names = [...p.text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const allowed = p.kind === 'headline' ? [] : p.kind === 'blurb'
        ? ['minutes', 'settle_minutes', 'usual_minutes'] : OBSERVATION_PARAMS[p.key].filter((n) => n !== 'direction');
      for (const name of names) expect([label(p), allowed.includes(name)]).toEqual([label(p), true]);
    }
    // Precondition: the check can fail.
    expect(ALL.some((p) => /\{\w+\}/.test(p.text))).toBe(true);
  });

  test('the library and the server\'s table list exactly the same keys (a key added on one side only fails here)', () => {
    expect(Object.keys(HEADLINE_PHRASES).sort()).toEqual([...HEADLINE_KEYS].sort());
    expect(Object.keys(OBSERVATION_PHRASES).sort()).toEqual(Object.keys(OBSERVATION_PARAMS).sort());
  });

  test('every param the server can send (but direction, which picks a group) has a formatter, and no formatter is for a param nobody sends', () => {
    const declared = new Set(Object.values(OBSERVATION_PARAMS).flat().filter((n) => n !== 'direction'));
    expect([...declared].sort()).toEqual(Object.keys(PARAM_FORMATTERS).sort());
  });

  test('a key with a direction param has the three direction groups, and every group of a selector is one it can pick', () => {
    const possible = { direction: DIRECTIONS, count: ['zero', 'one', 'other'], temperature: ['range', 'single'], unwatched: ['with_unwatched', 'without_unwatched'] };
    expect(Object.keys(PHRASE_SELECTORS).sort()).toEqual(Object.keys(possible).sort());
    for (const [key, entry] of Object.entries(OBSERVATION_PHRASES)) {
      const hasDirection = OBSERVATION_PARAMS[key].includes('direction');
      expect([key, entry.by === 'direction']).toEqual([key, hasDirection]);
      const groups = Object.keys(entry.groups).sort();
      expect([key, groups]).toEqual([key, entry.by ? [...possible[entry.by]].sort() : ['all']]);
    }
    for (const entry of Object.values(HEADLINE_PHRASES)) expect(Object.keys(entry.groups)).toEqual(['all']);
  });
});

describe('choosing a variant', () => {
  test('variantIndex is a pure function of seed and key: same in, same out, with a pinned value so a changed hash is a deliberate act', () => {
    expect(variantIndex('child-a|2026-03-10', 'total_sleep', 4)).toBe(1);
    expect(variantIndex('child-a|2026-03-11', 'total_sleep', 4)).toBe(2);
    for (let i = 0; i < 5; i++) expect(variantIndex('child-a|2026-03-10', 'total_sleep', 4)).toBe(1);
    expect(variantIndex('child-a|2026-03-10', 'total_sleep', 1)).toBe(0);
    expect(variantIndex('x', 'k', 0)).toBe(0); // an empty list is the caller's problem, not a NaN
  });

  test('changing the seed can change the pick, and so can the key (so two lines on one night do not all take the same slot)', () => {
    const bySeed = new Set(Array.from({ length: 40 }, (_, d) => variantIndex(`child-a|2026-03-${String(d + 1).padStart(2, '0')}`, 'total_sleep', 4)));
    expect(bySeed.size).toBe(4);
    const byKey = new Set(Object.keys(OBSERVATION_PHRASES).map((k) => variantIndex('child-a|2026-03-10', k, 3)));
    expect(byKey.size).toBeGreaterThan(1);
  });

  test('the wording is the same on every render and does not depend on randomness or the clock', () => {
    const summary = { headline: { key: 'settled' }, observations: [{ key: 'total_sleep', params: { minutes: 480 } }], seed: 'child-a|2026-03-10' };
    const first = nightSummaryText(summary, { zone: 'Europe/Berlin' });
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    try {
      expect(nightSummaryText(summary, { zone: 'Europe/Berlin' })).toEqual(first);
      Math.random.mockReturnValue(0);
      expect(nightSummaryText(summary, { zone: 'Europe/Berlin' })).toEqual(first);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a different night can read differently: across forty seeds the headline takes every one of its variants', () => {
    const texts = new Set(Array.from({ length: 40 }, (_, d) => headlineText({ headline: { key: 'typical' }, seed: `child-a|${d}` })));
    expect(texts.size).toBe(HEADLINE_PHRASES.typical.groups.all.length);
  });
});

describe('what the library does with what the server sends', () => {
  const SEED = 'child-a|2026-03-10';
  const SUMMARY = {
    headline: { key: 'typical' },
    observations: [
      { key: 'total_sleep_vs_usual', params: { minutes: 600, usual_minutes: 640, direction: 'less' } },
      { key: 'wake_ups', params: { count: 3 } },
      { key: 'wake_clustering', params: { count: 3, from_at: '2026-03-11 01:00:00', to_at: '2026-03-11 02:37:00' } },
      { key: 'temperature_range', params: { min_c: 19.2, max_c: 21.4 } },
    ],
    seed: SEED,
  };

  test('the whole summary, in Celsius and a Berlin clock: a literal sentence for each line', () => {
    const t = nightSummaryText(SUMMARY, { zone: 'Europe/Berlin', tempUnit: 'C' });
    expect(t.headline).toBe('Steady, with some waking or stirring.');
    expect(t.observations).toEqual([
      'Asleep for 10h 0m, less than the usual 10h 40m.',
      '3 wake-ups were counted overnight.',
      expect.stringMatching(/^Most wake-ups were close together, with 3 between (2:00 am|02:00) and (3:37 am|03:37)\.$/i),
      'Room temperature ranged from 19°C to 21°C.',
    ]);
  });

  test('times are in the HOME zone, not the browser\'s (the suite runs in Pacific/Auckland): the same instant reads differently by zone', () => {
    const at = (zone) => nightSummaryText(SUMMARY, { zone }).observations[2];
    expect(at('Europe/Berlin')).toMatch(/\b(2:00|02:00)\b/); // 01:00 UTC is 02:00 in Berlin in March
    expect(at('Australia/Melbourne')).toMatch(/\b(12:00|12:00)\b/); // and noon in Melbourne (UTC+11 until April)
    expect(at('Australia/Melbourne')).not.toEqual(at('Europe/Berlin'));
  });

  test('temperatures follow the household\'s unit and are whole degrees: Fahrenheit converts the reading, not a difference', () => {
    const t = (min_c, max_c, tempUnit) => nightSummaryText({ ...SUMMARY, observations: [{ key: 'temperature_range', params: { min_c, max_c } }] }, { tempUnit }).observations[0];
    expect(t(19.2, 21.4, 'F')).toBe('Room temperature ranged from 67°F to 71°F.');
    expect(t(19.2, 21.4, 'C')).toBe('Room temperature ranged from 19°C to 21°C.');
    expect(t(19.2, 21.4, undefined)).toContain('21°C'); // no setting: Celsius, the app's default
    // Two ends that read the same once rounded say one figure.
    const same = t(19.6, 20.4, 'C');
    expect(same.match(/20°C/g)).toHaveLength(1);
    expect(same).not.toMatch(/ to | and /);
    expect(t(19.6, 20.4, 'F')).toMatch(/67°F.*69°F/); // 67.3 and 68.7 differ in Fahrenheit
  });

  test('a count of zero, one and many each read right, in every variant: never "1 wake-ups"', () => {
    const line = (count, seed) => nightSummaryText({ headline: { key: 'typical' }, seed, observations: [{ key: 'wake_ups', params: { count } }] }, {}).observations[0];
    const seeds = Array.from({ length: 30 }, (_, i) => `child-a|${i}`);
    for (const seed of seeds) {
      expect(line(0, seed)).toMatch(/\bno wake-ups\b/i);
      expect(line(1, seed)).toMatch(/\bone wake-up\b/i);
      expect(line(1, seed)).not.toMatch(/wake-ups/);
      expect(line(3, seed)).toMatch(/\b3 wake-ups\b/);
    }
  });

  test('the direction picks the sentence: more, less and about the same each say so, in every variant', () => {
    const line = (direction, seed) => nightSummaryText({
      headline: { key: 'typical' }, seed, observations: [{ key: 'total_sleep_vs_usual', params: { minutes: 600, usual_minutes: 640, direction } }],
    }, {}).observations[0];
    for (let i = 0; i < 30; i++) {
      const seed = `child-a|${i}`;
      expect(line('more', seed)).toMatch(/more than|longer than|above/);
      expect(line('less', seed)).toMatch(/less than|shorter than|under/);
      expect(line('about_the_same', seed)).toMatch(/about the usual|close to|in line with/);
    }
  });

  test('reduced coverage says the unwatched minutes only when there were some', () => {
    const line = (unwatched_minutes, seed) => nightSummaryText({
      headline: { key: 'neutral_last_night' }, seed, observations: [{ key: 'reduced_coverage', params: { coverage_percent: 69, unwatched_minutes } }],
    }, {}).observations[0];
    for (let i = 0; i < 20; i++) {
      expect(line(0, `c|${i}`)).toContain('69%');
      expect(line(0, `c|${i}`)).not.toMatch(/\bunobserved\b|not observed/);
      expect(line(25, `c|${i}`)).toMatch(/25m/);
    }
  });

  test('a newer server cannot break an older page: an unknown observation is skipped, an unknown headline falls back to the neutral line, an unknown param is ignored', () => {
    const t = nightSummaryText({
      headline: { key: 'a_class_from_next_year' }, seed: SEED,
      observations: [
        { key: 'dream_quality', params: { score: 3 } },
        { key: 'total_sleep', params: { minutes: 480, brand_new_param: 'x' } },
        null,
        { key: 'wake_ups' }, // a known key whose params are missing: the sentence cannot be filled, so it is dropped
        { key: 'toString', params: {} }, // an inherited name is not a key
      ],
    }, {});
    expect(HEADLINE_PHRASES.neutral_last_night.groups.all).toContain(t.headline);
    expect(t.observations).toHaveLength(1);
    expect(t.observations[0]).toMatch(/8h 0m/);
    // Not summaries at all: nothing to show, and no throw. An object with no usable headline still gets the neutral line.
    for (const bad of [null, undefined, 'x', 3]) expect(nightSummaryText(bad, {})).toBe(null);
    expect(HEADLINE_PHRASES.neutral_last_night.groups.all).toContain(nightSummaryText({ headline: null }, {}).headline);
    expect(nightSummaryText({}, {}).observations).toEqual([]);
  });

  test('an observation whose param cannot be read is dropped, and the others stay', () => {
    const t = nightSummaryText({
      headline: { key: 'typical' }, seed: SEED,
      observations: [
        { key: 'total_sleep', params: { minutes: 'lots' } },
        { key: 'sleep_span', params: { onset_at: 'not a time', wake_at: '2026-03-11 06:00:00' } },
        { key: 'total_sleep', params: { minutes: 480 } },
      ],
    }, { zone: 'Europe/Berlin' });
    expect(t.observations).toHaveLength(1);
    expect(t.observations[0]).toMatch(/8h 0m/);
  });

  test('a name is never printed: no default phrase needs one, whatever childName is passed', () => {
    const everyKey = Object.entries(OBSERVATION_PARAMS).map(([key, names]) => ({
      key,
      params: Object.fromEntries(names.map((n) => [n, n === 'direction' ? 'more' : /_at$/.test(n) ? '2026-03-11 01:00:00' : 5])),
    }));
    for (let i = 0; i < 12; i++) {
      const t = nightSummaryText({ headline: { key: HEADLINE_KEYS[i % HEADLINE_KEYS.length] }, seed: `c|${i}`, observations: everyKey }, { zone: 'UTC', childName: 'ZZ_NAME' });
      expect(JSON.stringify(t)).not.toContain('ZZ_NAME');
      expect(t.observations).toHaveLength(everyKey.length); // and every key can be filled from its declared params
    }
  });
});

// The three "so far" keys a night still in progress carries (phase 4). The guardrails above already run over their
// variants; these add what is specific to them: every variant says "so far", none compares with a usual or says the
// night is over ("overnight"), and a count of 0 and 1 read right.
describe('the "so far" keys of a night in progress', () => {
  const SO_FAR = ['total_sleep_so_far', 'wake_ups_so_far', 'longest_stretch_so_far'];

  test('the keys are in the server\'s table, with raw params and no direction (a so-far fact is never a comparison)', () => {
    for (const key of SO_FAR) {
      expect(Object.hasOwn(OBSERVATION_PARAMS, key)).toBe(true);
      expect(OBSERVATION_PARAMS[key]).not.toContain('direction');
      expect(Object.hasOwn(OBSERVATION_PHRASES, key)).toBe(true);
    }
    expect(OBSERVATION_PARAMS.total_sleep_so_far).toEqual(['minutes']);
    expect(OBSERVATION_PARAMS.wake_ups_so_far).toEqual(['count']);
    expect(OBSERVATION_PARAMS.longest_stretch_so_far).toEqual(['minutes']);
  });

  test('every variant says "so far", and none says "overnight", "usual", "than" or "night timeline"', () => {
    const mine = ALL.filter((p) => SO_FAR.includes(p.key));
    expect(mine.length).toBeGreaterThanOrEqual(3 * 2); // precondition: the variants are really there
    for (const p of mine) {
      expect([label(p), /so far/i.test(p.text)]).toEqual([label(p), true]);
      expect([label(p), /overnight|usual|\bthan\b|night\s+timeline/i.test(p.text)]).toEqual([label(p), false]);
    }
  });

  test('a count of zero, one and many each read right in every variant, and say so far', () => {
    const line = (count, seed) => nightSummaryText({ headline: { key: 'neutral_so_far' }, seed, observations: [{ key: 'wake_ups_so_far', params: { count } }] }, {}).observations[0];
    for (let i = 0; i < 30; i++) {
      const seed = `child-a|${i}`;
      expect(line(0, seed)).toMatch(/\bno wake-ups\b/i);
      expect(line(1, seed)).toMatch(/\bone wake-up\b/i);
      expect(line(1, seed)).not.toMatch(/wake-ups/);
      expect(line(3, seed)).toMatch(/\b3 wake-ups\b/);
    }
  });

  test('every zero-count variant says the wake-ups are COUNTED (a wake-up in progress is not counted yet, so "no wake-ups" alone could contradict "awake since")', () => {
    const zero = OBSERVATION_PHRASES.wake_ups_so_far.groups.zero;
    expect(zero.length).toBeGreaterThanOrEqual(2); // precondition: there are variants to check
    for (const text of zero) expect([text, /\bcounted\b/i.test(text)]).toEqual([text, true]);
    // And what a reader is actually shown, for many seeds.
    for (let i = 0; i < 30; i++) {
      const line = nightSummaryText({ headline: { key: 'neutral_so_far' }, seed: `child-a|${i}`, observations: [{ key: 'wake_ups_so_far', params: { count: 0 } }] }, {}).observations[0];
      expect(line).toMatch(/\bcounted\b/);
    }
  });

  test('a so-far summary reads as plain sentences, in a literal pin for one seed', () => {
    const t = nightSummaryText({
      headline: { key: 'neutral_so_far' }, seed: 'child-a|2026-03-10',
      observations: [
        { key: 'total_sleep_so_far', params: { minutes: 275 } },
        { key: 'wake_ups_so_far', params: { count: 2 } },
        { key: 'longest_stretch_so_far', params: { minutes: 130 } },
      ],
    }, {});
    expect(t.headline).toMatch(/so far/i);
    expect(t.observations).toHaveLength(3);
    expect(t.observations[0]).toMatch(/4h 35m/);
    expect(t.observations[1]).toMatch(/\b2 wake-ups\b/);
    expect(t.observations[2]).toMatch(/2h 10m/);
  });

  test('a so-far key with a missing param is dropped, not printed as a half sentence', () => {
    const t = nightSummaryText({ headline: { key: 'neutral_so_far' }, seed: 's', observations: [{ key: 'total_sleep_so_far', params: {} }, { key: 'longest_stretch_so_far', params: { minutes: null } }] }, {});
    expect(t.observations).toEqual([]);
  });
});

// ------------------------------------------------ on screen --------------------------------------------------------

const SCORE = {
  score: 82, band: 'good', version: 2, provisional: false, low_confidence: false, low_confidence_reasons: [], capped_by: null,
  early_estimate: false, unwatched_minutes: 0,
  components: [{ key: 'duration', score: 90, weight: 35, available: true, reason: null, value: 600, usual: 615, basis: 'asleep_vs_usual' }],
};
const SUMMARY = {
  headline: { key: 'typical' },
  observations: [
    { key: 'total_sleep_vs_usual', params: { minutes: 600, usual_minutes: 640, direction: 'less' } },
    { key: 'wake_ups', params: { count: 3 } },
  ],
  seed: 'child-a|2026-03-10',
};
const HEADLINE = 'Steady, with some waking or stirring.';
const FIRST = 'Asleep for 10h 0m, less than the usual 10h 40m.';
const SECOND = '3 wake-ups were counted overnight.';

describe('the sleep-page blurb', () => {
  test('joins a typical stretch and settling into a third sentence, with deterministic variants', () => {
    const summary = { ...SUMMARY, observations: [...SUMMARY.observations,
      { key: 'longest_stretch', params: { minutes: 190 } },
      { key: 'settling_time', params: { minutes: 12 } }] };
    const first = nightBlurbText(summary);
    expect(first).toHaveLength(3);
    expect(first[0]).toContain('10h 0m');
    expect(first[1]).toContain('3 wake-ups');
    expect(first[2]).toMatch(/3h 10m.*12m/);
    expect(nightBlurbText(summary)).toEqual(first);
  });

  test('an unmergeable pair falls back to the individual phrase, and unknown or null facts are skipped', () => {
    const summary = { ...SUMMARY, observations: [
      { key: 'longest_stretch_vs_usual', params: { minutes: 190, direction: null } },
      { key: 'settling_time', params: { minutes: 12 } },
      { key: 'new_server_fact', params: { minutes: 2 } },
    ] };
    expect(nightBlurbText(summary)).toHaveLength(1);
    expect(nightBlurbText(summary)[0]).toMatch(/12m/);
    const alone = { ...summary, observations: [{ key: 'longest_stretch', params: { minutes: 190 } }] };
    expect(nightBlurbText(alone)[0]).toMatch(/3h 10m/);
    const nullSettle = { ...alone, observations: [...alone.observations, { key: 'settling_time', params: { minutes: null } }] };
    expect(nightBlurbText(nullSettle)).toEqual(nightBlurbText(alone));
  });
});

describe('the blurb beside a heading that already shows the time asleep (durationShown)', () => {
  test('the comparison is kept and the figure is not restated, for every direction', () => {
    for (const direction of ['more', 'less', 'about_the_same']) {
      const summary = { ...SUMMARY, observations: [
        { key: 'total_sleep_vs_usual', params: { minutes: 600, usual_minutes: 640, direction } },
        { key: 'wake_ups', params: { count: 3 } }] };
      const lines = nightBlurbText(summary, { durationShown: true });
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('10h 40m'); // the usual is the new information
      expect(lines[0]).not.toContain('10h 0m'); // the shown duration is not repeated
      expect(lines[1]).toBe(SECOND);
      // Without the flag nothing changes: the child's own wording stays complete.
      expect(nightBlurbText(summary)[0]).toContain('10h 0m');
    }
  });

  test('a plain total, and a so-far total, are left to the heading; an unreadable comparison falls back and never throws', () => {
    const summary = { ...SUMMARY, observations: [
      { key: 'total_sleep', params: { minutes: 600 } },
      { key: 'total_sleep_so_far', params: { minutes: 275 } },
      { key: 'wake_ups', params: { count: 3 } }] };
    expect(nightBlurbText(summary, { durationShown: true })).toEqual([SECOND]);
    const bad = { ...SUMMARY, observations: [{ key: 'total_sleep_vs_usual', params: { minutes: 600, usual_minutes: null, direction: 'less' } }] };
    expect(nightBlurbText(bad, { durationShown: true })).toEqual([]);
  });

  test('no pronoun for the child in any sentence the blurb can make (guardrail twin of the library list)', () => {
    for (const [key, variants] of Object.entries(BLURB_PHRASES)) {
      for (const text of variants) expect([key, /\b(he|she|they|them|their|his|her|him|hers)\b/i.test(text)]).toEqual([key, false]);
    }
  });
});

describe('the night card blurb on the detail page', () => {
  const NIGHT = { status: 'ok', night_date: '2026-03-10' };
  const show = (night) => renderAsAdmin(<SleepScoreCard night={night} />);

  test('with the time asleep in the heading, the blurb does not say it again', () => {
    const { container } = show({ ...NIGHT, asleep_minutes: 600, score: SCORE, summary: SUMMARY });
    expect(container.querySelector('.sleep-night-card__duration').textContent).toBe('10h 0m asleep');
    const blurb = container.querySelector('.sleep-night-card__blurb').textContent;
    expect(blurb).not.toContain('10h 0m');
    expect(blurb).toContain('10h 40m');
  });

  test('with a summary and score the night card has a flowing blurb and opens the sheet', () => {
    const { container } = show({ ...NIGHT, score: SCORE, summary: SUMMARY });
    expect(container.querySelector('.sleep-night-card__blurb').textContent).toBe(`${FIRST} ${SECOND}`);
    expect(screen.getByRole('button', { name: 'Sleep score 82, Good. Why this score?' })).toBeInTheDocument();
  });

  test('with the switch off (a summary and no score key): the sentences alone, no ring, no button, no "No score yet"', () => {
    const { container } = show({ ...NIGHT, summary: SUMMARY });
    expect(container.querySelector('.sleep-night-card__blurb').textContent).toBe(`${FIRST} ${SECOND}`);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelector('svg text')).toBe(null);
    expect(screen.queryByText(/No score yet/)).not.toBeInTheDocument();
  });

  test('a night with no score keeps its reason under the summary', () => {
    show({ ...NIGHT, score: { score: null, reason: 'promoted_from_empty', version: 2 },
      summary: { headline: { key: 'neutral_last_night' }, observations: [{ key: 'times_entered_by_hand', params: {} }], seed: 'child-a|2026-03-10' } });
    expect(screen.getByText('No score yet. The times for this night were entered by hand, so its wake-ups were never measured.')).toBeInTheDocument();
  });

  test('no summary (an older server, or a failure): keep the score without inventing a blurb', () => {
    const first = show({ ...NIGHT, score: SCORE, summary: null });
    expect(screen.getByRole('button', { name: 'Sleep score 82, Good. Why this score?' })).toBeInTheDocument();
    first.unmount();
    const second = show({ ...NIGHT, score: SCORE }); // the key is absent altogether
    expect(screen.getByRole('button', { name: /Why this score/ })).toBeInTheDocument();
    second.unmount();
    const empty = show({ ...NIGHT, summary: null });
    expect(empty.container.querySelector('.score-ring')).toBeNull();
  });

  test('an unusable summary (no headline object) falls back the same way', () => {
    show({ ...NIGHT, score: SCORE, summary: { observations: 'x' } });
    // The headline falls back, but without observations there is no invented blurb.
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  test('tracking off shows nothing, summary or not', () => {
    const { container } = show({ status: 'off', score: SCORE, summary: SUMMARY });
    expect(container.textContent).toBe('');
  });
});

describe('the headline on the child\'s card', () => {
  const OK_NIGHT = {
    status: 'ok', night_date: '2026-03-10', onset_at: '2026-03-10 09:10:00', wake_at: '2026-03-10 20:47:00',
    asleep_minutes: 637, wake_count: 2, longest_stretch_minutes: 300,
  };
  // The duration is two elements (the figure and a smaller "asleep"): matched on the element that holds both.
  const asleep = (text) => screen.findByText((_c, el) => el?.classList?.contains('night__sleep-big') && el.textContent === text);
  const show = (night, scope = 'last') => {
    vi.spyOn(api, 'get').mockResolvedValue({ scope, night });
    return renderAsAdmin(<SleepSummaryCard childId="kid-1" />);
  };

  test('one headline line under the duration, "Last night" is the label, the observations are not repeated, and the label says the headline then the score', async () => {
    show({ ...OK_NIGHT, score: SCORE, summary: SUMMARY });
    await asleep('10h 37m asleep');
    expect(screen.getAllByText(HEADLINE)).toHaveLength(1);
    expect(screen.queryByText(FIRST)).not.toBeInTheDocument();
    expect(screen.getByText('Last night')).toBeInTheDocument();
    expect(screen.getByRole('button').getAttribute('aria-label'))
      .toBe('View sleep detail and history. Steady, with some waking or stirring. Sleep score 82, Good');
  });

  test('with the switch off the headline is still there and the label has no score', async () => {
    show({ ...OK_NIGHT, summary: SUMMARY });
    await asleep('10h 37m asleep');
    expect(screen.getByText(HEADLINE)).toBeInTheDocument();
    expect(screen.getByRole('button').getAttribute('aria-label'))
      .toBe('View sleep detail and history. Steady, with some waking or stirring');
  });

  test('a night in progress shows its "so far" line', async () => {
    show({ ...OK_NIGHT, wake_at: null, summary: { headline: { key: 'neutral_so_far' }, observations: [], seed: 'child-a|2026-03-10' } }, 'tonight');
    await screen.findByText(/asleep so far/);
    expect(screen.getByText('Sleep so far tonight, as measured.')).toBeInTheDocument();
  });

  test('no summary: the card is as it was, with no extra line and the old label', async () => {
    show({ ...OK_NIGHT, summary: null });
    await asleep('10h 37m asleep');
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('View sleep detail and history');
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
  });

  test('a night that is not ok shows no headline, whatever it carries', async () => {
    show({ ...OK_NIGHT, status: 'no_sleep', summary: SUMMARY });
    await screen.findByText('No clear sleep detected overnight.');
    expect(screen.queryByText(HEADLINE)).not.toBeInTheDocument();
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('View sleep detail and history');
  });

  test('no phrase on either screen contains "night timeline" (the old card title; the docs screenshot run now waits for the exact title "Timeline")', async () => {
    show({ ...OK_NIGHT, score: SCORE, summary: SUMMARY });
    await asleep('10h 37m asleep');
    expect(document.body.textContent).not.toMatch(/night\s+timeline/i);
  });
});
