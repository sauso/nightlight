// Heart rate and breathing on the child's sleep card and the sleep detail page (owner request 2026-11-14).
//
// The server adds `night.vitals` ({ hr, rr } summaries, plus `series` on the detail read) only for a child whose radar measured
// them (backend/test/sleep-vitals-route.test.js). What the screen does with it is pinned here:
//   - the card: one line with the averages and the same words in the button's name, one figure when only one is present, and
//     NOTHING (the card as it was) without them;
//   - the hold-and-scroll bubble: the values at the scrubbed minute, and none when the nearest point is further than 5 minutes;
//   - the two thin tracks: hidden under two points, the line BROKEN (a second sub-path) across a hole over 10 minutes, a caption
//     from the server's summary and the "sensor estimate" note;
//   - the temperature track, drawn by the shared LineTrack, is exactly what the old ClimateTrack drew for a fixed series.
// Fixture names and ids are made up: the repo is public.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, fireEvent, cleanup } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import SleepDetail from '../src/pages/SleepDetail.jsx';
import SleepSummaryCard from '../src/components/SleepSummaryCard.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------------- the card

const OK_NIGHT = {
  status: 'ok', night_date: '2026-03-10', onset_at: '2026-03-10 09:10:00', wake_at: '2026-03-10 20:47:00',
  asleep_minutes: 637, wake_count: 2, longest_stretch_minutes: 300,
};
const HR = { avg: 82, min: 71, max: 103, minutes: 400 };
const RR = { avg: 21, min: 16, max: 28, minutes: 400 };

const showCard = (night, scope = 'last') => {
  vi.spyOn(api, 'get').mockResolvedValue({ scope, night });
  return renderAsAdmin(<SleepSummaryCard childId="kid-1" />);
};
const cardName = () => screen.getByRole('button').getAttribute('aria-label');
const vitalsLine = (container) => container.querySelector('.night__vitals');

describe('the sleep summary card', () => {
  test('both figures: one line under the card text, and the button\'s name says them after everything else', async () => {
    const { container } = showCard({ ...OK_NIGHT, vitals: { hr: HR, rr: RR } });
    await screen.findByText('Last night');
    expect(vitalsLine(container).textContent).toBe('82 bpm avg21/min avg');
    expect(cardName()).toBe(
      'Last night 10h 37m asleep. View sleep detail and history. Average heart rate 82 beats per minute, average breathing 21 breaths per minute (sensor estimate)'
    );
  });

  test('only one figure present: only that one is drawn and named', async () => {
    const { container, unmount } = showCard({ ...OK_NIGHT, vitals: { hr: HR, rr: null } });
    await screen.findByText('Last night');
    expect(vitalsLine(container).textContent).toBe('82 bpm avg');
    expect(cardName()).toMatch(/\. Average heart rate 82 beats per minute \(sensor estimate\)$/);
    expect(cardName()).not.toMatch(/breathing/);
    unmount();
    const second = showCard({ ...OK_NIGHT, vitals: { hr: null, rr: RR } });
    await screen.findByText('Last night');
    expect(vitalsLine(second.container).textContent).toBe('21/min avg');
    expect(cardName()).toMatch(/\. Average breathing 21 breaths per minute \(sensor estimate\)$/);
    expect(cardName()).not.toMatch(/heart/);
  });

  test('no vitals, or both null: the card and its name are exactly as they were', async () => {
    const without = showCard({ ...OK_NIGHT });
    await screen.findByText('Last night');
    expect(vitalsLine(without.container)).toBeNull();
    expect(cardName()).toBe('Last night 10h 37m asleep. View sleep detail and history');
    without.unmount();
    const empty = showCard({ ...OK_NIGHT, vitals: { hr: null, rr: null } });
    await screen.findByText('Last night');
    expect(vitalsLine(empty.container)).toBeNull();
    expect(cardName()).toBe('Last night 10h 37m asleep. View sleep detail and history');
  });

  test('a night that is not ok shows no vitals line, whatever it carries', async () => {
    const { container } = showCard({ ...OK_NIGHT, status: 'no_sleep', vitals: { hr: HR, rr: RR } });
    await screen.findByText('No clear sleep detected overnight.');
    expect(vitalsLine(container)).toBeNull();
    expect(cardName()).not.toMatch(/heart rate/);
  });

  test('tonight, in progress: the same line (so far), and a caregiver sees the same', async () => {
    const { container } = (() => {
      vi.spyOn(api, 'get').mockResolvedValue({ scope: 'tonight', night: { ...OK_NIGHT, wake_at: null, vitals: { hr: HR, rr: RR } } });
      return renderAsCaregiver(<SleepSummaryCard childId="kid-1" />);
    })();
    await screen.findByText('Tonight · so far');
    expect(vitalsLine(container).textContent).toBe('82 bpm avg21/min avg');
  });
});

// ------------------------------------------------------------------------------------------------ the detail page

const KID = { id: 'kid-1', name: 'Child B' };
// The window is 09:00Z to 21:00Z, 720 minutes: with a 720px-wide bar, a pointer at clientX = N is N minutes after 09:00Z.
const NIGHT = {
  night_date: '2026-08-30', status: 'ok', in_progress: false,
  onset_at: '2026-08-30 09:30:00', wake_at: '2026-08-30 20:15:00',
  window_start: '2026-08-30 09:00:00', window_end: '2026-08-30 21:00:00',
  total_sleep_minutes: 645, coverage_minutes: 720, wakes: [], visits: [], alerts: [], wakeClips: [],
};
const pt = (hhmm, hr, rr) => ({ t: `2026-08-30 ${hhmm}:00`, hr, rr });

function mockSleep(night) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
    if (path.includes('/sleep/insights')) return Promise.resolve(null);
    if (path.includes('/sleep?nights=')) return Promise.resolve({ nights: [{ night_date: '2026-08-30', score: null }] });
    if (path.includes('/sleep/')) return Promise.resolve(night);
    return Promise.resolve(null);
  });
}
const mount = (render = renderAsAdmin, settings = {}) =>
  render(<Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
    { kids: [KID], settings: { timezone: 'Australia/Melbourne', ...settings }, route: '/children/kid-1/sleep' });

const SERIES = [
  pt('12:00', 84, 22), pt('12:05', 86, null), pt('12:10', 88, 24), pt('18:00', 70, 18), pt('18:05', 72, 19),
];
const withVitals = (series = SERIES, summary = { hr: HR, rr: RR }) => ({ ...NIGHT, vitals: { ...summary, series } });
// The stroke path of one track: the second <path> of its svg (the first is the filled area).
const strokeD = (container, cls) => container.querySelector(`${cls} .sleep-climate__chart path:nth-of-type(2)`)?.getAttribute('d');
const subPaths = (d) => (d.match(/M/g) || []).length;

describe('the hold-and-scroll bubble', () => {
  const scrub = async (night, clientX) => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, right: 720, bottom: 30, width: 720, height: 30, x: 0, y: 0, toJSON() {} });
    mockSleep(night);
    const { container } = mount();
    await screen.findByText('Wake-ups');
    fireEvent.mouseMove(container.querySelector('.sleep-tl__bar'), { clientX });
    return container;
  };
  const rows = (container) => ({
    hr: container.querySelector('.sleep-tl__tip-hr')?.textContent ?? null,
    rr: container.querySelector('.sleep-tl__tip-rr')?.textContent ?? null,
  });

  test('at a scrubbed minute the nearest point\'s heart rate and breathing show beside the time and state', async () => {
    // 12:02 is 182 minutes in; the 12:00 point is two minutes away.
    const container = await scrub(withVitals(), 182);
    expect(container.querySelector('.sleep-tl__tip')).toBeTruthy();
    expect(rows(container)).toEqual({ hr: '84 bpm', rr: '22/min' });
  });

  test('each is the nearest point that HAS that value: a point without breathing does not blank it', async () => {
    // 12:06 (186): the nearest heart-rate point is 12:05 (86); the nearest breathing point is 12:10 (24, four minutes) not
    // the 12:05 one (which has none).
    const container = await scrub(withVitals(), 186);
    expect(rows(container)).toEqual({ hr: '86 bpm', rr: '24/min' });
  });

  test('within 5 minutes of a point it shows, beyond 5 it does not (the bubble itself still does)', async () => {
    // 12:14 is four minutes from the 12:10 point; 12:16 is six. Kills: a wider or missing reach.
    expect(rows(await scrub(withVitals(), 194))).toEqual({ hr: '88 bpm', rr: '24/min' });
    vi.restoreAllMocks();
    cleanup(); // the first render is still mounted, and "Wake-ups" would be found in it before the second one loads
    const far = await scrub(withVitals(), 196);
    expect(far.querySelector('.sleep-tl__tip'), 'the bubble still shows').toBeTruthy();
    expect(rows(far)).toEqual({ hr: null, rr: null });
  });

  test('a point never shows BEFORE its own time by more than 5 minutes: one reading at 12:04, scrubbed at 11:55, shows none', async () => {
    // The server stamps a point at the mean time of its valid minutes (backend/test/nightVitals.test.js), so 12:04 is the
    // reading's real time. Kills: the server stamping the bucket start (12:00), which this bubble would show nine minutes
    // earlier; here it pins the lookup's reach to the point's own time. 11:55 is 175 minutes in, 12:00 is 180.
    const only = withVitals([pt('12:04', 84, 22)]);
    expect(rows(await scrub(only, 175))).toEqual({ hr: null, rr: null });
    vi.restoreAllMocks();
    cleanup();
    expect(rows(await scrub(only, 180))).toEqual({ hr: '84 bpm', rr: '22/min' });
  });

  test('no vitals on the night: the bubble has no such rows', async () => {
    const container = await scrub(NIGHT, 182);
    expect(container.querySelector('.sleep-tl__tip')).toBeTruthy();
    expect(rows(container)).toEqual({ hr: null, rr: null });
  });
});

describe('the heart-rate and breathing tracks', () => {
  const open = async (night, render, settings) => {
    mockSleep(night);
    const view = mount(render, settings);
    await screen.findByText('Wake-ups');
    return view.container;
  };

  test('two tracks with the server\'s summary in the caption, one note, in this order after the timeline', async () => {
    const container = await open(withVitals());
    expect(container.querySelector('.sleep-climate--hr .sleep-climate__caption').textContent).toBe('avg 82 bpm · 71–103');
    expect(container.querySelector('.sleep-climate--rr .sleep-climate__caption').textContent).toBe('avg 21/min · 16–28');
    expect(container.querySelector('.sleep-climate--hr .sleep-climate__label').textContent).toBe(' Heart rate');
    expect(container.querySelector('.sleep-climate--rr .sleep-climate__label').textContent).toBe(' Breathing');
    expect(screen.getAllByText('Sensor estimates from the radar, not for medical use.')).toHaveLength(1);
    // The end labels are the data's own whole numbers: heart rate 70..88, not a widened range.
    const hi = container.querySelector('.sleep-climate--hr .sleep-climate__hi').textContent;
    const lo = container.querySelector('.sleep-climate--hr .sleep-climate__lo').textContent;
    expect([hi, lo]).toEqual(['88', '70']);
  });

  test('no summary (readings in the span but none between onset and wake): the caption is the drawn range, without "avg"', async () => {
    // Kills: the empty caption the track had when the server sent `hr: null` / `rr: null` with a non-empty series.
    const container = await open(withVitals(SERIES, { hr: null, rr: null }));
    const hrCaption = container.querySelector('.sleep-climate--hr .sleep-climate__caption').textContent;
    const rrCaption = container.querySelector('.sleep-climate--rr .sleep-climate__caption').textContent;
    expect([hrCaption, rrCaption]).toEqual(['70–88 bpm', '18–24/min']);
    expect(hrCaption + rrCaption).not.toMatch(/avg/);
    // One role with a summary and the other without: each uses its own.
    vi.restoreAllMocks();
    cleanup();
    const mixed = await open(withVitals(SERIES, { hr: HR, rr: null }));
    expect(mixed.querySelector('.sleep-climate--hr .sleep-climate__caption').textContent).toBe('avg 82 bpm · 71–103');
    expect(mixed.querySelector('.sleep-climate--rr .sleep-climate__caption').textContent).toBe('18–24/min');
  });

  test('a caregiver sees the same tracks', async () => {
    const container = await open(withVitals(), renderAsCaregiver);
    expect(container.querySelector('.sleep-climate--hr')).toBeTruthy();
    expect(container.querySelector('.sleep-climate--rr')).toBeTruthy();
  });

  test('a track with fewer than two points is not drawn; with none at all, neither is the note', async () => {
    const oneHr = await open(withVitals([pt('12:00', 84, 22), pt('12:05', null, 23), pt('12:10', null, 24)]));
    expect(oneHr.querySelector('.sleep-climate--hr'), 'one heart-rate point').toBeNull();
    expect(oneHr.querySelector('.sleep-climate--rr'), 'three breathing points').toBeTruthy();
    expect(oneHr.querySelector('.sleep-climate--rr').className, 'the only track has its own divider').not.toMatch(/--next/);
    expect(screen.getAllByText(/not for medical use/)).toHaveLength(1);
  });

  test('no series, an empty series or no vitals: nothing', async () => {
    for (const night of [NIGHT, withVitals([]), { ...NIGHT, vitals: { hr: HR, rr: RR } }, withVitals([pt('12:00', 84, 22)])]) {
      vi.restoreAllMocks();
      cleanup();
      const container = await open(night);
      expect(container.querySelector('.sleep-climate--hr')).toBeNull();
      expect(container.querySelector('.sleep-climate--rr')).toBeNull();
      expect(screen.queryByText(/not for medical use/)).toBeNull();
    }
  });

  test('a hole over 10 minutes breaks the line into two sub-paths; 10 minutes or less does not', async () => {
    // Points at 12:00, 12:05, 12:10 (one run), then 18:00, 18:05 (a second).
    const broken = await open(withVitals());
    expect(subPaths(strokeD(broken, '.sleep-climate--hr'))).toBe(2);
    expect(subPaths(strokeD(broken, '.sleep-climate--rr'))).toBe(2);
    // Exactly ten minutes between two points (one empty bucket) is bridged; eleven is a hole.
    vi.restoreAllMocks();
    cleanup();
    const bridged = await open(withVitals([pt('12:00', 80, 20), pt('12:10', 82, 21)]));
    expect(subPaths(strokeD(bridged, '.sleep-climate--hr'))).toBe(1);
    vi.restoreAllMocks();
    cleanup();
    const hole = await open(withVitals([pt('12:00', 80, 20), pt('12:05', 81, 20), pt('12:16', 82, 21), pt('12:21', 83, 21)]));
    expect(subPaths(strokeD(hole, '.sleep-climate--hr'))).toBe(2);
  });

  test('a flat series is not pinned to an edge, and its labels are the data\'s own whole number', async () => {
    const container = await open(withVitals([pt('12:00', 82, 20), pt('12:05', 82, 20), pt('12:10', 82, 20)]));
    const d = strokeD(container, '.sleep-climate--hr');
    const ys = [...d.matchAll(/ ([\d.]+)(?= |$)/g)].map((m) => Number(m[1]));
    expect(new Set(ys).size, 'one height').toBe(1);
    expect(ys[0]).toBeGreaterThan(5);
    expect(ys[0]).toBeLessThan(31); // the track is 36 high with a 5 margin each side: not on either edge
    expect(container.querySelector('.sleep-climate--hr .sleep-climate__hi').textContent).toBe('82');
    expect(container.querySelector('.sleep-climate--hr .sleep-climate__lo').textContent).toBe('82');
  });
});

describe('the temperature track, now drawn by the shared LineTrack', () => {
  // The expected strings were computed ONCE from the OLD ClimateTrack formula (origin/dev cce89134) for this series and window,
  // and pasted here: the extraction must not move a pixel. 09:00Z..21:00Z; readings at 10:00, 12:00, 15:00 and 18:00.
  const CLIMATE = {
    temp_avg: 20.8, temp_min: 19.5, temp_max: 22.5, humidity_avg: 55,
    series: [
      { t: '2026-08-30 10:00:00', temperature: 20.0 }, { t: '2026-08-30 12:00:00', temperature: 22.5 },
      { t: '2026-08-30 15:00:00', temperature: 21.0 }, { t: '2026-08-30 18:00:00', temperature: 19.5 },
    ],
  };
  const OLD_LINE = 'M8.33 35.00 L25.00 5.00 L50.00 23.00 L75.00 41.00';
  const OLD_AREA = 'M8.33 35.00 L25.00 5.00 L50.00 23.00 L75.00 41.00 L75.00 46 L8.33 46 Z';

  test('Celsius: the same line, area, labels and caption as before', async () => {
    mockSleep({ ...NIGHT, climate: CLIMATE });
    const { container } = mount();
    await screen.findByText('Wake-ups');
    const track = container.querySelector('.sleep-climate:not(.sleep-climate--hr):not(.sleep-climate--rr)');
    const paths = track.querySelectorAll('.sleep-climate__chart path');
    expect(paths[0].getAttribute('d')).toBe(OLD_AREA);
    expect(paths[1].getAttribute('d')).toBe(OLD_LINE);
    expect(paths[0].getAttribute('fill')).toBe('var(--sleep-temp)');
    expect(paths[1].getAttribute('stroke')).toBe('var(--sleep-temp)');
    expect(track.querySelector('.sleep-climate__chart svg').getAttribute('height')).toBe('46');
    expect(track.querySelector('.sleep-climate__hi').textContent).toBe('22.5°C');
    expect(track.querySelector('.sleep-climate__lo').textContent).toBe('19.5°C');
    expect(track.querySelector('.sleep-climate__caption').textContent).toBe('avg 20.8°C · 19.5–22.5°C · 55% humidity');
    expect(track.querySelector('.sleep-climate__label').textContent).toBe(' Room temperature');
  });

  test('Fahrenheit: the same geometry (the conversion is linear), the labels in °F', async () => {
    mockSleep({ ...NIGHT, climate: CLIMATE });
    const { container } = mount(renderAsAdmin, { temp_unit: 'F' });
    await screen.findByText('Wake-ups');
    const track = container.querySelector('.sleep-climate');
    expect(track.querySelectorAll('.sleep-climate__chart path')[1].getAttribute('d')).toBe(OLD_LINE);
    expect(track.querySelector('.sleep-climate__hi').textContent).toBe('72.5°F');
    expect(track.querySelector('.sleep-climate__lo').textContent).toBe('67.1°F');
  });

  test('the temperature line never breaks, however long a gap between readings (only the vitals tracks do)', async () => {
    mockSleep({ ...NIGHT, climate: { ...CLIMATE, series: [CLIMATE.series[0], CLIMATE.series[3]] } });
    const { container } = mount();
    await screen.findByText('Wake-ups');
    expect(subPaths(container.querySelectorAll('.sleep-climate__chart path')[1].getAttribute('d'))).toBe(1);
  });
});
