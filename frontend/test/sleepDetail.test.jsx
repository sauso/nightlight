// The sleep detail screen itself — the date navigator and the states its body can be in.
//
// (`sleepDetailHelpers.test.jsx` covers the exported pure helpers. This file is the component around
// them: which night it asks for, how it moves between nights, and what it says when there isn't one.)
//
// ★ WHY. Two classes of failure, both silent:
//
//  1. **Every date on this screen is a LOCAL calendar date in the APP's timezone**, not the browser's
//     and not UTC. "Last night" is a different day either side of midnight, and this repo has already
//     shipped a review window anchored on a literal `04:00Z` — midday only in Melbourne, and on a
//     default install (`timezone` defaults to `'UTC'`) it hid every morning transition. A screen that
//     asked for the wrong night would render a perfectly convincing "No sleep data for this night".
//     These tests set the app timezone AWAY from the suite's own clock so the two cannot agree by
//     accident.
//  2. **Only the latest night can still be changing**, so only it is polled. Polling an old night
//     would be pointless traffic; NOT polling the live one leaves "tonight · so far" frozen at
//     whatever it was when the screen opened, which reads as sleep tracking having stopped.
//
// The five empty states are each a different message on purpose — "tracking is off", "no data",
// "no sleep detected" and "nobody in the bed" mean quite different things, and collapsing them would
// send someone to check the wrong thing.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import SleepDetail, { addDays } from '../src/pages/SleepDetail.jsx';
import { api } from '../src/lib/api.js';

const KID = { id: 'kid-1', name: 'Raffa' };

// A complete night, as the detail endpoint returns it. Times are naive UTC, exactly as SQLite stores
// them. 2026-08-30 09:30Z is 19:30 on the 30th in Melbourne — deliberately an evening that is a
// DIFFERENT calendar day in some zones, so a screen formatting in the wrong one is visible.
const NIGHT = {
  night_date: '2026-08-30',
  status: 'ok',
  in_progress: false,
  onset_at: '2026-08-30 09:30:00',
  wake_at: '2026-08-30 20:15:00',
  window_start: '2026-08-30 09:00:00',
  window_end: '2026-08-30 21:00:00',
  total_sleep_minutes: 645,
  coverage_minutes: 720,
  wakes: [],
  visits: [],
  alerts: [],
  wakeClips: [],
};

// Route the three GETs this screen makes. A single mockResolvedValue would let a test pass while the
// component asked for the wrong night entirely — which is the bug class this file is about.
function mockSleep({ live = { scope: 'last', night: { night_date: '2026-08-30' } }, night = NIGHT, insights = null } = {}) {
  const get = vi.fn((path) => {
    if (path.includes('/sleep/live')) return Promise.resolve(live);
    if (path.includes('/sleep/insights')) return Promise.resolve(insights);
    if (path.includes('/sleep/')) return Promise.resolve(typeof night === 'function' ? night(path) : night);
    return Promise.resolve(null);
  });
  vi.spyOn(api, 'get').mockImplementation(get);
  return get;
}

// tz is the APP timezone, which is NOT the suite's clock (Pacific/Auckland) — see the header.
const mount = (tz = 'Australia/Melbourne') =>
  renderAsAdmin(
    <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
    { kids: [KID], settings: { timezone: tz }, route: '/children/kid-1/sleep' }
  );

// The path of the last detail request, which is where the requested night date shows up.
const lastNightPath = (get) =>
  get.mock.calls.map((c) => c[0]).filter((p) => p.includes('/sleep/') && !p.includes('live') && !p.includes('insights')).at(-1);

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('which night it opens on', () => {
  test('the night the server calls live', async () => {
    const get = mockSleep({ live: { scope: 'tonight', night: { night_date: '2026-08-30' } } });
    mount();
    await waitFor(() => expect(lastNightPath(get)).toBe('/children/kid-1/sleep/2026-08-30?detail=1'));
  });

  test('★★ and when the server cannot say, YESTERDAY in the app timezone', async () => {
    // The fallback is `todayLocal - 1`, and `todayLocal` is computed with Intl in `settings.timezone`.
    // Under the suite's Pacific/Auckland clock those are different dates for part of every day, so a
    // fallback computed from the browser instead would ask for the wrong night — and get back a
    // convincing "No sleep data for this night".
    // ⚠️ Etc/GMT+12 (UTC−12), not Melbourne. The suite's own clock is Pacific/Auckland (UTC+12), and
    // Melbourne shares Auckland's calendar date for 22 hours of every day — so a mutant computing
    // "today" in the BROWSER's zone agrees with the app's almost always, and survived. Etc/GMT+12 is
    // a full 24 hours behind Auckland, so its local date is never the same one: the mutant now has
    // nowhere to hide, whatever time of day the suite runs.
    const tz = 'Etc/GMT+12';
    vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path.includes('/sleep/live')) return Promise.reject(new Error('no live night'));
      return Promise.resolve(NIGHT);
    });
    mount(tz);

    const todayThere = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const expected = new Date(`${todayThere}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() - 1);
    const wanted = expected.toISOString().slice(0, 10);

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/children/kid-1/sleep/${wanted}?detail=1`));
  });

  test('a live night ahead of yesterday raises the browsable maximum', async () => {
    // The picker's max is normally yesterday, but when a window is open right now the night in
    // progress is browsable too — otherwise the screen would open on a night it refused to show.
    const tz = 'Australia/Melbourne';
    const todayThere = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    mockSleep({ live: { scope: 'tonight', night: { night_date: todayThere } }, night: { ...NIGHT, in_progress: true } });
    mount(tz);

    const picker = await screen.findByLabelText('Pick a night');
    expect(picker.getAttribute('max')).toBe(todayThere);
  });
});

describe('moving between nights', () => {
  test('the arrows step one night at a time', async () => {
    const get = mockSleep();
    const { user } = mount();
    await waitFor(() => expect(lastNightPath(get)).toContain('2026-08-30'));

    await user.click(screen.getByLabelText('Previous night'));
    await waitFor(() => expect(lastNightPath(get)).toContain('2026-08-29'));
    await user.click(screen.getByLabelText('Next night'));
    await waitFor(() => expect(lastNightPath(get)).toContain('2026-08-30'));
  });

  test('★ you cannot go past the latest night', async () => {
    // The next arrow is disabled at the maximum. Without it the screen would ask for a night that
    // does not exist yet and show "no data" for tomorrow.
    mockSleep();
    mount();
    await waitFor(() => expect(screen.getByLabelText('Next night').disabled).toBe(true));
    expect(screen.getByLabelText('Previous night').disabled).toBe(false);
  });

  test('★ nor back beyond the history window', async () => {
    // Nights are kept for a bounded number of days; walking past that would page through empty
    // screens with nothing to say why.
    mockSleep();
    const { user } = mount();
    const picker = await screen.findByLabelText('Pick a night');
    const min = picker.getAttribute('min');
    expect(min, 'the picker publishes the same floor the arrow enforces').toBeTruthy();

    // ⚠️ THE EXACT FLOOR, not merely "earlier than today". `HISTORY_DAYS` is 30 and the window is
    // INCLUSIVE of both ends, so the floor is max − 29. Asserting only `min < max` let two mutants
    // through the whole suite: changing the constant, and dropping the `- 1` — and that second one is
    // precisely the PR #229 class, an inclusive/exclusive slip that would offer a 31st night the
    // underlying activity_samples retention does not cover, which reads as data silently missing.
    expect(min).toBe(addDays(picker.getAttribute('max'), -29));

    // Walk to the floor and confirm the arrow gives out there rather than one step later.
    for (let i = 0; i < 40 && !screen.getByLabelText('Previous night').disabled; i += 1) {
      await user.click(screen.getByLabelText('Previous night'));
    }
    expect(screen.getByLabelText('Pick a night').value).toBe(min);
  });

  test('picking a date from the calendar loads that night', async () => {
    // fireEvent, not user.type: a native date input is typed segment-by-segment and jsdom has no
    // date-picker UI, so typing produces a string of intermediate values rather than one change.
    const get = mockSleep();
    mount();
    const picker = await screen.findByLabelText('Pick a night');
    fireEvent.change(picker, { target: { value: '2026-08-25' } });
    await waitFor(() => expect(lastNightPath(get)).toContain('2026-08-25'));
  });

  test('★ an empty date from the picker is ignored rather than clearing the screen', async () => {
    // Clearing a native date input fires a change with ''. Accepting it would set `date` to empty and
    // leave the screen stuck on "Loading night…" with no night to load.
    const get = mockSleep();
    mount();
    const picker = await screen.findByLabelText('Pick a night');
    await waitFor(() => expect(lastNightPath(get)).toContain('2026-08-30'));
    fireEvent.change(picker, { target: { value: '' } });
    expect(screen.getByLabelText('Pick a night').value).toBe('2026-08-30');
  });
});

describe('★ only the live night is polled', () => {
  // Under fake timers the two chained fetches (live night, then that night's detail) settle over
  // several microtask turns, so "let everything settle" needs more than a single tick — and counting
  // BEFORE it has settled is what makes a polling test pass or fail for the wrong reason.
  const settle = async () => { for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(1); };
  const detailCalls = (get) => get.mock.calls.filter(([p]) => p.includes('/sleep/') && !p.includes('live') && !p.includes('insights')).length;

  // ⚠️ The polled night has to be TODAY in the app timezone, not a fixed date in the past. Polling
  // runs only while `date === maxDate`, and maxDate is at least yesterday-local — so a hard-coded
  // 2026-08-30 fixture is simply an old night, and the test would "prove" the live night is not
  // polled. That is the same trap as picking a fixture without checking what it exercises.
  const TZ = 'Australia/Melbourne';
  const todayThere = () =>
    new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

  test('the latest night refreshes on its own', async () => {
    // "Tonight · so far" has to keep moving. Frozen numbers on a live night read as tracking having
    // stopped, and there is nothing on screen that would say otherwise.
    vi.useFakeTimers();
    const live = { scope: 'tonight', night: { night_date: todayThere() } };
    const get = mockSleep({ live, night: { ...NIGHT, night_date: todayThere(), in_progress: true } });
    mount(TZ);
    await settle();
    const before = detailCalls(get);
    expect(before, 'the night has been fetched once before we start counting').toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(detailCalls(get), 'polled after two minutes').toBeGreaterThan(before);
  });

  test('★★ an older night does NOT — it cannot change any more', async () => {
    // The discriminating half. A completed night is finished; polling it would be traffic every two
    // minutes for a screen that can never differ.
    vi.useFakeTimers();
    const get = mockSleep();
    mount();
    await settle();

    // Step back one night, off the maximum, then let plenty of poll windows pass.
    fireEvent.click(screen.getByLabelText('Previous night'));
    await settle();
    const settled = detailCalls(get);
    expect(settled, 'the older night was fetched').toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(detailCalls(get), 'a finished night is asked for once').toBe(settled);
  });
});

describe('what it shows for a night', () => {
  test('the sleep range is rendered in the APP timezone', async () => {
    // 09:30Z is 19:30 in Melbourne and 21:30 in Auckland (the suite's own clock). Formatting in the
    // browser's zone instead of the configured one is the exact mutation this suite's timezone pin
    // exists to expose — and it would put a wrong bedtime in front of a parent.
    mockSleep();
    mount('Australia/Melbourne');
    expect(await screen.findByText(/7:30\s*pm/i)).toBeTruthy();
  });

  test('and follows the configured timezone when it changes', async () => {
    mockSleep();
    mount('UTC');
    expect(await screen.findByText(/9:30\s*am/i)).toBeTruthy();
  });

  test('a night in progress is badged "so far"', async () => {
    // Otherwise the totals read as a finished night's, and they are not — they are "so far".
    mockSleep({ night: { ...NIGHT, in_progress: true, wake_at: null } });
    mount();
    expect(await screen.findByText('so far')).toBeTruthy();
  });

  test('a live night still asleep says so rather than showing a wake time', async () => {
    mockSleep({ night: { ...NIGHT, in_progress: true, wake_at: null } });
    mount();
    expect(await screen.findByText(/asleep since .* \(ongoing\)/)).toBeTruthy();
  });
});

describe('★ the empty states each say a different thing', () => {
  // Collapsing these would send someone to check the wrong thing entirely: "tracking is off" is a
  // setting they can change, "no data" is a coverage problem, and "no one in the bed" is neither.
  const cases = [
    ['off', /Sleep tracking is off for this child/],
    ['no_data', /No sleep data for this night/],
    ['no_sleep', /No clear sleep detected/],
    ['empty', /No one in the bed for this night/],
  ];

  for (const [status, pattern] of cases) {
    test(`status "${status}"`, async () => {
      mockSleep({ night: { ...NIGHT, status, coverage_minutes: 720 } });
      mount();
      expect(await screen.findByText(pattern)).toBeTruthy();
    });
  }

  test('a null night reads as no data, not as an error', async () => {
    mockSleep({ night: null });
    mount();
    expect(await screen.findByText(/No sleep data for this night/)).toBeTruthy();
  });

  test('★ a failed request also reads as no data rather than a blank screen', async () => {
    // The catch sets `null`, which lands on the same message. Not ideal — it cannot distinguish "no
    // night" from "could not ask" — but it is pinned because the alternative it must never do is stay
    // on "Loading night…" forever.
    vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      return Promise.reject(new Error('boom'));
    });
    mount();
    expect(await screen.findByText(/No sleep data for this night/)).toBeTruthy();
    expect(screen.queryByText('Loading night…')).toBeNull();
  });

  test('it says "Loading night…" while it waits', async () => {
    let resolveNight;
    vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      return new Promise((r) => { resolveNight = r; });
    });
    mount();
    expect(await screen.findByText('Loading night…')).toBeTruthy();
    resolveNight(NIGHT);
    await waitFor(() => expect(screen.queryByText('Loading night…')).toBeNull());
  });
});

describe('the header', () => {
  test('points back at the child by name', async () => {
    mockSleep();
    mount();
    expect(await screen.findByLabelText('Back to Raffa')).toBeTruthy();
  });

  test('still offers a way back when the child has not loaded yet', async () => {
    // `kids` is empty until the context resolves; a back link that rendered nothing would strand
    // someone on a sub-page with no way out.
    mockSleep();
    renderAsAdmin(
      <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
      { kids: [], settings: { timezone: 'UTC' }, route: '/children/kid-1/sleep' }
    );
    expect(await screen.findByLabelText('Back to Child')).toBeTruthy();
  });

  test('carries the caveat that this is an estimate', async () => {
    // It is a guide, not a medical measurement, and saying so on the screen is deliberate.
    mockSleep();
    mount();
    expect(await screen.findByText(/not a medical measurement/)).toBeTruthy();
  });
});

describe('what a night lists', () => {
  test('★ an alert is listed against the WAKE it happened during', async () => {
    // Alerts are not a flat list on this screen — each one is attached to the wake whose window
    // contains it (`alertsInRange`). That is the whole value of the section: "she woke at 2:05 and
    // here is the sound that went with it". An alert rendered loose, or against the wrong wake, would
    // tell a parent the wrong story about their night.
    mockSleep({
      night: {
        ...NIGHT,
        wake_count: 1,
        wakes: [{ start_at: '2026-08-30 14:00:00', end_at: '2026-08-30 14:20:00', minutes: 20 }],
        alerts: [{ id: 'a1', type: 'sound', camera_name: 'Nursery', detail: '+9 dB', created_at: '2026-08-30 14:05:00' }],
      },
    });
    const { user } = mount('Australia/Melbourne');
    // Collapsed, the wake advertises how many alerts it carries — that badge is what tells you the
    // row is worth opening, and a wake with no alerts is deliberately not expandable at all.
    const badge = await screen.findByText(/1 alert$/);
    expect(badge).toBeTruthy();
    expect(screen.queryByText(/\+9 dB/), 'the detail waits until the row is opened').toBeNull();

    await user.click(screen.getByRole('button', { expanded: false }));
    const row = (await screen.findByText(/\+9 dB/)).closest('.sleep-wakes__alert');
    expect(row, 'the alert sits inside the wake it belongs to').toBeTruthy();
    expect(within(row).getByText(/Nursery/)).toBeTruthy();
  });

  test('an alert outside every wake is not attached to one', async () => {
    // The other half of `alertsInRange`. A 6pm alert, hours before the first wake, must not be
    // pinned to it — that would invent a cause for a wake-up that had nothing to do with it.
    mockSleep({
      night: {
        ...NIGHT,
        wake_count: 1,
        wakes: [{ start_at: '2026-08-30 14:00:00', end_at: '2026-08-30 14:20:00', minutes: 20 }],
        alerts: [{ id: 'a1', type: 'sound', camera_name: 'Nursery', detail: '+9 dB', created_at: '2026-08-30 10:00:00' }],
      },
    });
    mount('Australia/Melbourne');
    await screen.findByText(/Wake-ups · 1/);
    expect(screen.queryByText(/1 alert$/), 'no alert is attributed to this wake').toBeNull();
    expect(screen.queryByText(/\+9 dB/)).toBeNull();
  });

  test('a night with no wakes reports zero rather than leaving the stat blank', async () => {
    // The count is always shown — a blank where "0" belongs reads as a missing measurement rather
    // than an undisturbed night, which is the single best thing this screen can tell you.
    mockSleep({ night: { ...NIGHT, wake_count: 0 } });
    mount();
    const stat = (await screen.findByText('Wake-ups')).closest('.sleep-stat');
    expect(within(stat).getByText('0')).toBeTruthy();
  });

  test('coverage is reported as a percentage of the window', async () => {
    // 720 minutes covered out of a 12-hour window is 100%. Coverage is how someone tells a quiet
    // night from a night the cameras missed, so a wrong denominator here is actively misleading.
    mockSleep();
    mount();
    expect(await screen.findByText(/100%/)).toBeTruthy();
  });

  test('★ a live night measures coverage against elapsed time, not the whole window', async () => {
    // Against the full window, a live night would report ~50% coverage at midnight and look broken.
    // `as_of` is what makes the number honest while the night is still running.
    mockSleep({
      night: {
        ...NIGHT, in_progress: true, wake_at: null,
        as_of: '2026-08-30 15:00:00', coverage_minutes: 360,
      },
    });
    mount();
    expect(await screen.findByText(/100%/)).toBeTruthy();
  });
});
