// The sleep score on screen (sleep score plan, phase 2): the ring on the child's card, the card and breakdown sheet
// on the sleep detail page, and the wording behind both (src/lib/sleepScoreText.js).
//
// WHAT IS PINNED, and each sits where two plausible implementations part ways:
//   no number, no ring ............ `score` absent (the child's switch is off), null (scoring failed), and
//                                   `{ score: null }` (in progress, no score) all leave the card as it was;
//   the score is SPOKEN ........... the card's button has an aria-label that hides its contents, and the ring is
//                                   decorative, so the label must carry the number and the band;
//   an early estimate has no band . even if a server sent one;
//   a missing part says why ....... by its `reason`, in words;
//   a newer server cannot crash an older tab: an unknown reason or component key gets a neutral line or is skipped;
//   the ring follows the night on screen (the detail page's "Show with today's settings" re-fetch).
//
// Behaviour only: no CSS selectors, pixel values or stylesheet text are asserted (CLAUDE.md, proportionate
// testing 7). Fixture names and ids are made up: the repo is public.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, within, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import SleepSummaryCard from '../src/components/SleepSummaryCard.jsx';
import SleepScoreCard from '../src/components/SleepScoreCard.jsx';
import SleepDetail from '../src/pages/SleepDetail.jsx';
import { api } from '../src/lib/api.js';
import {
  scoreOf, bandWord, bandOf, scoreLabel, unavailableText, UNAVAILABLE_FALLBACK, noScoreText, componentName, componentDetail,
  lowConfidenceText, cappedText, minutesText, clockText,
} from '../src/lib/sleepScoreText.js';

afterEach(() => vi.restoreAllMocks());

// A score as the server sends it (backend/src/lib/sleepScore.js scoreNight): 82, "good", every part available.
const part = (key, score, extra = {}) => ({ key, score, weight: 20, available: true, reason: null, value: null, usual: null, ...extra });
const SCORE = {
  score: 82,
  band: 'good',
  version: 2,
  provisional: false,
  low_confidence: false,
  low_confidence_reasons: [],
  capped_by: null,
  early_estimate: false,
  unwatched_minutes: 0,
  components: [
    part('duration', 90, { value: 600, usual: 615.5, basis: 'asleep_vs_usual' }),
    part('continuity', 77, { value: 0.8, usual: 0.9 }),
    part('settling', 80, { value: 30, usual: 20 }),
    part('restlessness', 100, { value: 1.5, usual: 2 }),
    // 450 minutes after noon is 19:30; 1140 is 07:00 the next morning.
    part('consistency', 92, { terms: [part('onset', 100, { value: 450, usual: 460 }), part('wake', 83, { value: 1140, usual: 1110 })] }),
  ],
};
const NO_SCORE = { score: null, reason: 'in_progress', version: 2 };

// ------------------------------------------------ the wording --------------------------------------------------

describe('sleepScoreText', () => {
  test('scoreOf: only a night whose score carries a number has one', () => {
    expect(scoreOf({ score: SCORE })).toBe(SCORE);
    expect(scoreOf({ score: NO_SCORE })).toBe(null);
    expect(scoreOf({ score: null })).toBe(null);
    expect(scoreOf({})).toBe(null); // the child's "Show sleep score" switch is off: the key is absent
    expect(scoreOf(null)).toBe(null);
  });

  test('the spoken label: number and band word, the number alone under the lowest band, "early estimate" in place of a word', () => {
    expect(scoreLabel({ ...SCORE, score: 91, band: 'great' })).toBe('91, Great');
    expect(scoreLabel(SCORE)).toBe('82, Good');
    expect(scoreLabel({ ...SCORE, score: 60, band: 'fair' })).toBe('60, Fair');
    expect(scoreLabel({ ...SCORE, score: 48, band: null })).toBe('48');
    expect(scoreLabel({ ...SCORE, score: 64, band: null, early_estimate: true })).toBe('64, early estimate');
  });

  test('an early estimate never gets a band word, even when the server sent one; an unknown band key gets none', () => {
    expect(bandWord(SCORE)).toBe('Good'); // precondition: this band does have a word
    expect(bandWord({ ...SCORE, early_estimate: true })).toBe(null);
    expect(scoreLabel({ ...SCORE, early_estimate: true })).toBe('82, early estimate');
    expect(bandWord({ ...SCORE, band: 'superb' })).toBe(null);
  });

  // The ring's colour key. It follows the SERVER's band key and repeats none of its edges (85/70/55): the fixtures below
  // deliberately carry scores that DISAGREE with those edges, so an implementation that re-derived the band from the
  // number in the browser would fail here.
  test('★ bandOf: the server\'s great, good and fair keys; low for a number the server gave no band; early beats the band', () => {
    expect(bandOf({ ...SCORE, score: 91, band: 'great' })).toBe('great');
    expect(bandOf({ ...SCORE, score: 82, band: 'good' })).toBe('good');
    expect(bandOf({ ...SCORE, score: 60, band: 'fair' })).toBe('fair');
    expect(bandOf({ ...SCORE, score: 48, band: null })).toBe('low');
    // The server's key wins over the number: a retuned server cannot leave the colour disagreeing with the word.
    expect(bandOf({ ...SCORE, score: 99, band: 'fair' })).toBe('fair');
    expect(bandOf({ ...SCORE, score: 10, band: 'great' })).toBe('great');
    // An early estimate is 'early' even when the server sent a band (and a low number under no band).
    expect(bandOf({ ...SCORE, score: 90, band: 'great', early_estimate: true })).toBe('early');
    expect(bandOf({ ...SCORE, score: 40, band: null, early_estimate: true })).toBe('early');
  });

  test('bandOf: no score, no number, and a band key this build does not know all give no colour (never a guessed rose)', () => {
    expect(bandOf(null)).toBe(null);
    expect(bandOf(undefined)).toBe(null);
    expect(bandOf({ score: null, reason: 'in_progress' })).toBe(null);
    expect(bandOf({ score: Number.NaN, band: 'good' })).toBe(null);
    expect(bandOf({ score: 3, band: 'good' })).toBe('good'); // precondition: a number plus a known key does colour
    // A newer server's band: unknown, so neutral. 'low' here would paint a possibly good night rose.
    expect(bandOf({ ...SCORE, band: 'superb' })).toBe(null);
    expect(bandOf({ ...SCORE, band: undefined })).toBe(null);
    // ...even when the number is a low one: the browser does not re-derive "low" from the score, only from the server's null.
    expect(bandOf({ ...SCORE, score: 20, band: 'superb' })).toBe(null);
    expect(bandOf({ ...SCORE, score: 20, band: undefined })).toBe(null);
  });

  test('every reason the server can give for a missing part has its own sentence; an unknown one gets the neutral line', () => {
    const known = ['no_in_bed', 'in_bed_hidden', 'no_baseline', 'missing', 'span_corrected', 'unwatched', 'no_timezone', 'wake_unconfirmed'];
    const lines = known.map(unavailableText);
    expect(new Set(lines).size).toBe(8); // eight different sentences
    expect(lines).not.toContain(UNAVAILABLE_FALLBACK);
    expect(unavailableText('no_in_bed')).toBe('No put-down was detected for this night.');
    expect(unavailableText('a_reason_from_next_year')).toBe('Not available for this night.');
    expect(unavailableText(undefined)).toBe('Not available for this night.');
  });

  test('every no-score reason has a sentence; an unknown one has none (the page still says "No score yet")', () => {
    const known = ['in_progress', 'not_ok', 'promoted_from_empty', 'no_sleep_measured', 'no_duration_reference', 'under_12_months_no_baseline'];
    expect(known.map(noScoreText).filter(Boolean)).toHaveLength(6);
    expect(noScoreText('in_progress')).toBe('The night is still in progress.');
    expect(noScoreText('something_new')).toBe('');
  });

  test('an unknown component has no name (the breakdown skips it) and no detail', () => {
    expect(componentName('duration')).toBe('Duration');
    expect(componentName('dream_quality')).toBe(null);
    expect(componentDetail({ key: 'dream_quality', score: 50, available: true, value: 3 })).toBe('');
    expect(componentDetail(null)).toBe('');
  });

  test('figures are in human units, and duration says which comparison it was', () => {
    expect(minutesText(605)).toBe('10h 5m');
    expect(minutesText(45)).toBe('45m');
    expect(minutesText(615.5)).toBe('10h 16m'); // a usual is a median and can be a half minute
    expect(componentDetail(SCORE.components[0])).toBe('10h 0m asleep. Usual: 10h 16m.');
    expect(componentDetail(part('duration', 87, { value: 660, usual: 684, basis: 'span_vs_age' })))
      .toBe('11h 0m from falling asleep to waking. Early estimate: compared with a published figure for this age (11h 24m), until there are enough nights to know what is usual.');
    expect(componentDetail(SCORE.components[2])).toBe('30m from being put down to falling asleep. Usual: 20m.');
    expect(componentDetail(SCORE.components[3])).toBe('1.5 stirring minutes per hour asleep. Usual: 2.0.');
    expect(componentDetail(SCORE.components[1])).toMatch(/^Asleep for 80% of the observed time between falling asleep and waking\. Usual: 90%\./);
  });

  test('a clock time is the wall-clock time the server sent, whatever zone the browser is in', () => {
    // The suite runs in Pacific/Auckland (vite.config.js). 450 minutes after noon is 19:30 on the night's own clock;
    // formatting it in the browser's zone would print a different hour. Either clock form is accepted.
    expect(clockText(450)).toMatch(/\b7:30\b|\b19:30\b/);
    expect(clockText(1140)).toMatch(/\b7:00\b|\b07:00\b/);
    expect(clockText(null)).toBe(null);
  });

  test('low confidence names the reasons it knows, with the unwatched minutes; a cap names the part', () => {
    expect(lowConfidenceText(SCORE)).toBe(''); // precondition: not low confidence, so no line
    expect(lowConfidenceText({ ...SCORE, low_confidence: true, low_confidence_reasons: ['unwatched', 'wake_unconfirmed'], unwatched_minutes: 25 }))
      .toBe('Low confidence: 25m of the night were not observed; the time up is not certain.');
    expect(lowConfidenceText({ ...SCORE, low_confidence: true, low_confidence_reasons: ['brand_new_reason'] }))
      .toBe('Low confidence: parts of this night were not measured well.');
    expect(cappedText(SCORE)).toBe('');
    expect(cappedText({ ...SCORE, capped_by: 'continuity' })).toBe('Held down by continuity: the overall score cannot sit far above that part.');
    expect(cappedText({ ...SCORE, capped_by: 'dream_quality' })).toBe('');
  });
});

// ------------------------------------------------ the child's card ---------------------------------------------

describe('SleepSummaryCard: the ring and the spoken score', () => {
  const OK_NIGHT = {
    status: 'ok',
    night_date: '2026-09-01',
    onset_at: '2026-09-01 09:10:00',
    wake_at: '2026-09-01 20:47:00',
    asleep_minutes: 637,
    wake_count: 2,
    longest_stretch_minutes: 300,
  };
  const show = (night, scope = 'last') => {
    vi.spyOn(api, 'get').mockResolvedValue({ scope, night });
    return renderAsAdmin(<SleepSummaryCard childId="kid-1" />);
  };
  const PLAIN_LABEL = 'View sleep detail and history';
  // The duration is two elements ("10h 37m" and a smaller "asleep"): matched on the element that holds both.
  const asleep = (text) => screen.findByText((_c, el) => el?.classList?.contains('night__sleep-big') && el.textContent === text);

  test('a scored night: the ring shows the number, and the button says the score and band', async () => {
    show({ ...OK_NIGHT, score: SCORE });
    await asleep('10h 37m asleep');
    expect(screen.getByText('82')).toBeInTheDocument();
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('View sleep detail and history. Sleep score 82, Good');
    // "Last night" is the label (a docs screenshot run waits for it), now without the date.
    expect(screen.getByText('Last night')).toBeInTheDocument();
  });

  // ★ Colour is never the only signal: the band word is DRAWN in the ring, beside the number (the design's "82 / Good"), not only
  // spoken by the button's name. Under the lowest band there is no word, and an early estimate says "Early".
  test.each([
    ['great', { score: 91, band: 'great' }, 'Great'],
    ['good', { score: 82, band: 'good' }, 'Good'],
    ['fair', { score: 60, band: 'fair' }, 'Fair'],
    ['low', { score: 48, band: null }, null],
    ['early', { score: 64, band: 'good', early_estimate: true }, 'Early'],
  ])('★ the ring draws the %s word beside its number', async (_band, over, word) => {
    const { container } = show({ ...OK_NIGHT, score: { ...SCORE, ...over } });
    await asleep('10h 37m asleep');
    const words = [...container.querySelectorAll('svg.score-ring .score-ring__word')].map((t) => t.textContent);
    expect(words).toEqual(word ? [word] : []);
    expect(container.querySelector('svg.score-ring .score-ring__num').textContent).toBe(String(over.score));
  });

  test('under the lowest band the label carries the number alone; an early estimate says so and names no band', async () => {
    const first = show({ ...OK_NIGHT, score: { ...SCORE, score: 48, band: null } });
    await asleep('10h 37m asleep');
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('View sleep detail and history. Sleep score 48');
    first.unmount();
    vi.restoreAllMocks();
    show({ ...OK_NIGHT, score: { ...SCORE, score: 64, band: 'good', early_estimate: true } });
    await asleep('10h 37m asleep');
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('View sleep detail and history. Sleep score 64, early estimate');
  });

  // The ring's classes, for every band: the child card sits on the fixed dark card, so it asks for the dark surface.
  test.each([
    ['great', { score: 91, band: 'great' }, false],
    ['good', { score: 82, band: 'good' }, false],
    ['fair', { score: 60, band: 'fair' }, false],
    ['low', { score: 48, band: null }, false],
    ['early', { score: 64, band: 'good', early_estimate: true }, true],
  ])('★ the child card\'s ring carries the %s band class, and a dashed track only for an early estimate', async (band, over, dashed) => {
    const { container } = show({ ...OK_NIGHT, score: { ...SCORE, ...over } });
    await asleep('10h 37m asleep');
    const ring = container.querySelector('svg.score-ring');
    expect(ring.getAttribute('class')).toContain('score-ring--dark');
    expect(ring.classList.contains(`score-ring--${band}`)).toBe(true);
    expect(ring.getAttribute('class').match(/score-ring--(great|good|fair|low|early)/g)).toEqual([`score-ring--${band}`]);
    expect(Boolean(ring.querySelector('.score-ring__track').getAttribute('stroke-dasharray'))).toBe(dashed);
  });

  test('the card tells its parent the band, and clears it when the score goes (so the hero tint never outlives the ring)', async () => {
    const onBand = vi.fn();
    vi.spyOn(api, 'get').mockResolvedValue({ scope: 'last', night: { ...OK_NIGHT, score: { ...SCORE, score: 60, band: 'fair' } } });
    const { unmount } = renderAsAdmin(<SleepSummaryCard childId="kid-1" onBand={onBand} />);
    await asleep('10h 37m asleep');
    expect(onBand).toHaveBeenLastCalledWith('fair');
    unmount();
    expect(onBand).toHaveBeenLastCalledWith(null);
  });

  test('a night with no score reports no band', async () => {
    const onBand = vi.fn();
    vi.spyOn(api, 'get').mockResolvedValue({ scope: 'last', night: { ...OK_NIGHT, score: NO_SCORE } });
    renderAsAdmin(<SleepSummaryCard childId="kid-1" onBand={onBand} />);
    await asleep('10h 37m asleep');
    expect(onBand).not.toHaveBeenCalledWith(expect.any(String));
  });

  // Each of these is a night that must look exactly as it did before the score existed.
  test.each([
    ['the switch is off (no score key)', OK_NIGHT, 'last'],
    ['scoring failed (score: null)', { ...OK_NIGHT, score: null }, 'last'],
    ['the night has no score (score.score null)', { ...OK_NIGHT, score: { score: null, reason: 'no_duration_reference', version: 2 } }, 'last'],
    ['the night is in progress', { ...OK_NIGHT, wake_at: null, score: NO_SCORE }, 'tonight'],
  ])('no ring and the old label when %s', async (_name, night, scope) => {
    show(night, scope);
    await asleep(scope === 'tonight' ? '10h 37m asleep so far' : '10h 37m asleep');
    const button = screen.getByRole('button');
    expect(button.getAttribute('aria-label')).toBe(PLAIN_LABEL);
    expect(button.querySelector('svg text')).toBe(null); // the ring is the only svg with text in it
    // The estimate disclaimer is the sleep page's footer now, not part of this card.
    expect(screen.queryByText(/Estimated from movement/)).not.toBeInTheDocument();
  });

  test('a score object on a night that is not `ok` draws no ring', async () => {
    // Not something the server sends today; the card must not draw a ring beside "No clear sleep detected".
    show({ ...OK_NIGHT, status: 'no_sleep', score: SCORE });
    await screen.findByText('No clear sleep detected overnight.');
    expect(screen.queryByText('82')).not.toBeInTheDocument();
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(PLAIN_LABEL);
  });
});

// ------------------------------------------------ the detail page card -----------------------------------------

describe('SleepScoreCard: the detail page card and the breakdown sheet', () => {
  const NIGHT = { status: 'ok', night_date: '2026-09-01' };
  const show = (night) => renderAsAdmin(<SleepScoreCard night={night} />);
  // The part a row is for: the name its text starts with (the score or "Not counted" follows it with no space).
  const PART_NAMES = ['Duration', 'Continuity', 'Settling', 'Restlessness', 'Consistency'];
  const rowName = (li) => PART_NAMES.find((n) => li.textContent.startsWith(n)) ?? li.textContent;
  const open = async (user) => {
    await user.click(screen.getByRole('button', { name: /How this is scored/ }));
    return screen.getByRole('dialog');
  };

  test.each([
    ['great', { score: 91, band: 'great' }, false],
    ['good', { score: 82, band: 'good' }, false],
    ['fair', { score: 60, band: 'fair' }, false],
    ['low', { score: 48, band: null }, false],
    ['early', { score: 64, band: 'good', early_estimate: true }, true],
  ])('★ the detail card\'s ring carries the %s band class on the themed-card surface; dashed track only when early', (band, over, dashed) => {
    const { container } = show({ ...NIGHT, score: { ...SCORE, ...over } });
    const ring = container.querySelector('svg.score-ring');
    expect(ring.classList.contains('score-ring--card')).toBe(true);
    expect(ring.getAttribute('class').match(/score-ring--(great|good|fair|low|early)/g)).toEqual([`score-ring--${band}`]);
    expect(Boolean(ring.querySelector('.score-ring__track').getAttribute('stroke-dasharray'))).toBe(dashed);
    expect(ring.getAttribute('aria-hidden')).toBe('true');
  });

  test('a band key from a newer server leaves the ring uncoloured (today\'s neutral arc), not rose', () => {
    const { container } = show({ ...NIGHT, score: { ...SCORE, score: 90, band: 'superb' } });
    expect(container.querySelector('svg.score-ring').getAttribute('class')).toBe('score-ring score-ring--card');
  });

  test('a scored night: a real button named with the score, the band word beside the ring, and the sheet on a tap', async () => {
    const { user } = show({ ...NIGHT, score: SCORE });
    const button = screen.getByRole('button', { name: 'Sleep score 82, Good. How this is scored' });
    expect(within(button).getByText('How this is scored')).toBeInTheDocument();
    expect(within(button).getByText('Good')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); // precondition: closed until asked for
    const dialog = await open(user);
    expect(within(dialog).getByRole('heading', { name: 'Sleep score 82, Good' })).toBeInTheDocument();
    // One row per part, with its own score and figures.
    expect(within(dialog).getAllByRole('listitem').map((li) => rowName(li)))
      .toEqual(['Duration', 'Continuity', 'Settling', 'Restlessness', 'Consistency']);
    expect(within(dialog).getByText('10h 0m asleep. Usual: 10h 16m.')).toBeInTheDocument();
    expect(within(dialog).getByText('About the sleep score')).toBeInTheDocument();
    expect(within(dialog).getByText(/not a medical measurement/)).toBeInTheDocument();
    // Nothing that is not true of this score.
    expect(within(dialog).queryByText(/may still change/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Low confidence/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Held down/)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/no longer available/)).not.toBeInTheDocument();
  });

  test('tonight, in progress: the so-far facts show under the Night summary, with only the existing "No score yet" line and no ring or comparison', () => {
    const { container } = show({
      ...NIGHT,
      in_progress: true,
      score: { score: null, reason: 'in_progress', version: 2 },
      summary: {
        headline: { key: 'neutral_so_far' },
        observations: [
          { key: 'total_sleep_so_far', params: { minutes: 275 } },
          { key: 'wake_ups_so_far', params: { count: 0 } },
          { key: 'longest_stretch_so_far', params: { minutes: 130 } },
        ],
        seed: 'child-a|2026-09-01',
      },
      live: { state: 'awake', since: '2026-09-02 02:10:00' },
    });
    expect(screen.getByText('Night summary')).toBeInTheDocument();
    const items = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/4h 35m.*so far|so far.*4h 35m/);
    expect(items[1]).toMatch(/counted/);
    expect(items[2]).toMatch(/2h 10m/);
    // The one score line there ever was: "No score yet" and the reason. No ring figure, no button, nothing about "usual".
    expect(screen.getByText('No score yet. The night is still in progress.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(container.querySelector('svg text')).toBe(null);
    expect(container.textContent).not.toMatch(/usual/i);
    // The live state is not drawn by this card (a later design change does that): its time appears nowhere.
    expect(container.textContent).not.toMatch(/awake since|asleep since/i);
  });

  test('a part that could not be measured is listed as not counted, with its reason in words', async () => {
    const components = SCORE.components.map((c) => (c.key === 'settling'
      ? { ...c, score: null, available: false, reason: 'no_in_bed', value: null }
      : c));
    const { user } = show({ ...NIGHT, score: { ...SCORE, components } });
    const dialog = await open(user);
    const row = within(dialog).getAllByRole('listitem').find((li) => li.textContent.startsWith('Settling'));
    expect(row.textContent).toBe('SettlingNot countedNo put-down was detected for this night.');
  });

  test('a figure dropped inside a part that still scored gets its own line', async () => {
    const components = SCORE.components.map((c) => (c.key === 'continuity'
      ? { ...c, terms: [part('efficiency', 80), { ...part('longest_share', null), available: false, reason: 'unwatched' }, part('wake_count', 80)] }
      : c));
    const { user } = show({ ...NIGHT, score: { ...SCORE, components } });
    const dialog = await open(user);
    expect(within(dialog).getByText('Longest stretch not counted: part of the night was not observed.')).toBeInTheDocument();
  });

  test('keys from a newer server do not break an older page: an unknown part is skipped, an unknown reason gets the neutral line', async () => {
    const components = [
      ...SCORE.components.filter((c) => c.key !== 'restlessness'),
      { key: 'restlessness', score: null, weight: 15, available: false, reason: 'a_reason_from_next_year', value: null, usual: null },
      { key: 'dream_quality', score: 40, weight: 10, available: true, reason: null, value: { nested: true }, usual: 'x', terms: 'not a list' },
    ];
    const { user } = show({ ...NIGHT, score: { ...SCORE, capped_by: 'dream_quality', low_confidence: true, low_confidence_reasons: ['new_reason'], components } });
    const dialog = await open(user);
    const names = within(dialog).getAllByRole('listitem').map((li) => rowName(li));
    expect(names).toEqual(['Duration', 'Continuity', 'Settling', 'Consistency', 'Restlessness']);
    expect(within(dialog).getByText('Not available for this night.')).toBeInTheDocument();
    expect(within(dialog).queryByText(/Held down/)).not.toBeInTheDocument();
    expect(within(dialog).getByText('Low confidence: parts of this night were not measured well.')).toBeInTheDocument();
  });

  test('a capped, provisional, low-confidence score says each of the three', async () => {
    const { user } = show({
      ...NIGHT,
      score: { ...SCORE, capped_by: 'duration', provisional: true, low_confidence: true, low_confidence_reasons: ['low_coverage'] },
    });
    const dialog = await open(user);
    expect(within(dialog).getByText('Held down by duration: the overall score cannot sit far above that part.')).toBeInTheDocument();
    expect(within(dialog).getByText('This score may still change.')).toBeInTheDocument();
    expect(within(dialog).getByText('Low confidence: the camera did not watch enough of the sleep window.')).toBeInTheDocument();
  });

  test('an early estimate shows the number with "Early estimate" and no band word, even if one was sent', () => {
    show({ ...NIGHT, score: { ...SCORE, score: 64, band: 'good', early_estimate: true } });
    const button = screen.getByRole('button', { name: 'Sleep score 64, early estimate. How this is scored' });
    expect(within(button).getByText('Early estimate')).toBeInTheDocument();
    expect(within(button).queryByText('Good')).not.toBeInTheDocument();
  });

  test('a score lent by the saved night says the timeline is gone and where the score comes from', () => {
    show({ status: 'no_data', night_date: '2026-09-01', score: SCORE, score_source: 'stored' });
    expect(screen.getByText('The timeline for this night is no longer available. The score comes from the saved night.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /How this is scored/ })).toBeInTheDocument();
  });

  test('no score: "No score yet" with the reason, and no button; an unknown reason leaves the plain line', () => {
    const first = show({ ...NIGHT, score: { score: null, reason: 'promoted_from_empty', version: 2 } });
    expect(screen.getByText('No score yet. The times for this night were entered by hand, so its wake-ups were never measured.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    first.unmount();
    show({ ...NIGHT, score: { score: null, reason: 'something_new', version: 3 } });
    expect(screen.getByText('No score yet.')).toBeInTheDocument();
  });

  test.each([
    ['the switch is off (no score key)', { status: 'ok', night_date: '2026-09-01' }],
    ['scoring failed (score: null)', { status: 'ok', night_date: '2026-09-01', score: null }],
    ['tracking is off', { status: 'off', score: { score: null, reason: 'not_ok', version: 2 } }],
    ['there is no night', null],
  ])('renders nothing at all when %s', (_name, night) => {
    const { container } = show(night);
    expect(container.textContent).toBe('');
  });
});

// ------------------------------------------------ on the real page ---------------------------------------------

describe('SleepDetail: the score follows the night on screen', () => {
  const KID = { id: 'kid-1', name: 'Child A' };
  const BASE = {
    night_date: '2026-08-30', status: 'ok', in_progress: false,
    onset_at: '2026-08-30 09:30:00', wake_at: '2026-08-30 20:15:00',
    window_start: '2026-08-30 09:00:00', window_end: '2026-08-30 21:00:00',
    asleep_minutes: 600, coverage_minutes: 720, wakes: [], visits: [], alerts: [], wakeClips: [],
  };
  const CTX = { v: 1, camera_id: 'cam-a', tz: 'Europe/Berlin', window: { start: '19:30', end: '07:00' }, algo: '1' };
  const view = (applied) => ({
    applied, stored: CTX, current: { ...CTX, camera_id: 'cam-b' }, camera_names: { stored: 'Cam one', current: 'Cam two' }, algo_differs: false,
  });
  function mount(nightFor) {
    vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('/sleep/')) return Promise.resolve(nightFor(path));
      return Promise.resolve(null);
    });
    return renderAsAdmin(
      <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
      { kids: [KID], route: '/children/kid-1/sleep' }
    );
  }

  test('switching to today\'s settings re-reads the night, and the ring shows THAT night\'s score', async () => {
    const saved = { ...BASE, scoring_view: view('stored'), score: SCORE };
    const today = { ...BASE, scoring_view: view('current'), score: { ...SCORE, score: 57, band: 'fair' } };
    const { user } = mount((path) => (path.includes('context=current') ? today : saved));
    expect(await screen.findByRole('button', { name: 'Sleep score 82, Good. How this is scored' })).toBeInTheDocument();
    // The page's estimate line covers the score while one is shown, and the timeline keeps its title.
    expect(screen.getByText(/the sleep score included — a sleep-pattern guide, not a medical measurement\./)).toBeInTheDocument();
    expect(screen.getByText('Timeline', { exact: true })).toBeInTheDocument();
    // The switch is in the page's "⋯" menu (UI refresh PR E).
    await user.click(await screen.findByRole('button', { name: /more options for this night/i }));
    await user.click(await screen.findByRole('menuitem', { name: 'Show with today’s settings' }));
    expect(await screen.findByRole('button', { name: 'Sleep score 57, Fair. How this is scored' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sleep score 82/ })).not.toBeInTheDocument();
  });

  test('with the switch off (no score key) the page has no score card and the estimate line does not mention a score', async () => {
    mount(() => BASE);
    await screen.findByText('Timeline', { exact: true });
    await waitFor(() => expect(screen.getByText(/Estimated from movement & sound over the night\s+window — a sleep-pattern guide/)).toBeInTheDocument());
    expect(screen.queryByText('Sleep score')).not.toBeInTheDocument();
    expect(screen.queryByText(/No score yet/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /How this is scored/ })).not.toBeInTheDocument();
  });
});
