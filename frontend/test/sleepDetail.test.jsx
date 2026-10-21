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
import { screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver, renderAs, forEachRole } from './helpers/render.jsx';
import SleepDetail, { addDays } from '../src/pages/SleepDetail.jsx';
import NightReview from '../src/pages/NightReview.jsx';
import { api } from '../src/lib/api.js';

const KID = { id: 'kid-1', name: 'Child B' };

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

// The path of the last detail request, which is where the requested night date shows up. Since #361 PR 4a every
// one ends `&context=auto` (the page's default settings view; the block "#361 PR 4a" below tests the view itself).
const lastNightPath = (get) =>
  get.mock.calls.map((c) => c[0]).filter((p) => p.includes('/sleep/') && !p.includes('live') && !p.includes('insights')).at(-1);

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('which night it opens on', () => {
  // ⚠️ THE CLOCK IS PINNED FOR THIS WHOLE GROUP (#534, 2026-10-02: CI had been red on every PR since
  // 2026-10-01). The newest night the screen allows is the later of the live night and YESTERDAY by the
  // real clock, so a fixture that names a fixed "future" date stops being in the future the day the real
  // date reaches it. `never past the newest browsable night` asked for 2026-09-30 against a live night of
  // 2026-08-30 and began returning 09-30 once yesterday WAS 09-30. Nothing in the app was wrong; the
  // fixture had a shelf life. The `moving between nights` group below was fixed the same way on 2026-09-29.
  //
  // Same instant as that group, for the same reason (NIGHT's times assume Melbourne's +10, which changes
  // in October, so a derived date would exercise a different offset by season): 02:00Z on the 31st is noon
  // there, so yesterday is 2026-08-30 and the newest browsable night is exactly the live night. Only `Date`
  // is faked, so waitFor keeps working; the afterEach at the top of the file restores it.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-31T02:00:00Z'));
  });

  test('the night the server calls live', async () => {
    const get = mockSleep({ live: { scope: 'tonight', night: { night_date: '2026-08-30' } } });
    mount();
    await waitFor(() => expect(lastNightPath(get)).toBe('/children/kid-1/sleep/2026-08-30?detail=1&context=auto'));
  });

  // ★ `?date=` — how saving a review returns you to the night you just corrected.
  //
  // Without it the screen always opened on the LIVE night, so correcting a backlog of older nights
  // meant re-picking the date after every save. These three tests pin the whole contract, because the
  // dangerous half is the clamp: a screen that honoured any date in the URL would happily load a night
  // past the one the picker allows, or a malformed one, and render a convincing "no sleep data".
  const mountAt = (route, tz = 'Australia/Melbourne') =>
    renderAsAdmin(
      <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
      { kids: [KID], settings: { timezone: tz }, route }
    );

  test('★ a date in the query string wins over the live night', async () => {
    const get = mockSleep({ live: { scope: 'tonight', night: { night_date: '2026-08-30' } } });
    mountAt('/children/kid-1/sleep?date=2026-08-24');
    await waitFor(() => expect(lastNightPath(get)).toBe('/children/kid-1/sleep/2026-08-24?detail=1&context=auto'));
  });

  // ⚠️⚠️ THE SHAPE HERE IS THE ROUTE'S, NOT A CONVENIENT ONE. `GET /children/:id/review/:date`
  // returns `{ computed, review, transitions }` — the saved times live under `review`.
  //
  // ★ This is not a detail, it is the bug this fixture exists to prevent recurring: the first version
  // of the receipt read the times from the ROOT of the response, and the first version of this test
  // mocked that same wrong shape. Both agreed, both were green, and the receipt never appeared in the
  // real app. Only e2e — which talks to an actual server — could tell them apart. A mock is only
  // evidence to the extent it matches what the server really sends.
  const REVIEW_RESPONSE = {
    child_id: 'kid-1',
    night_date: '2026-08-24',
    computed: { status: 'ok', onset_at: '2026-08-24 09:28:00', wake_at: '2026-08-24 20:14:00' },
    review: { true_onset_at: '2026-08-24 09:30:00', true_wake_at: '2026-08-24 20:15:00' },
    transitions: [],
  };

  // ★★ THE RECEIPT MUST FOLLOW THE SAVE. e2e caught the absence of this when the first attempt at the
  // `?date=` navigation shipped: the confirmation "Thanks — that's recorded" lives on the CHILD page,
  // and routing here instead dropped it. A save that shows nothing is indistinguishable from one that
  // failed — the report that caused the receipt to exist at all. Unit tests could not see it, because
  // each screen passed its own tests; only crossing the seam exposed it.
  test('★★ arriving from a save shows the receipt for that night', async () => {
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'tonight', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('/review/')) return Promise.resolve(REVIEW_RESPONSE);
      if (path.includes('/sleep/')) return Promise.resolve(NIGHT);
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    mountAt('/children/kid-1/sleep?date=2026-08-24&saved=1');

    await waitFor(() => expect(screen.getByText('Thanks — that’s recorded')).toBeVisible());
    // The receipt must be for the night just corrected, so it reads back the times that were saved.
    await waitFor(() => expect(get.mock.calls.map((c) => c[0])).toContain('/children/kid-1/review/2026-08-24'));
  });

  test('★★ and without the saved flag there is no receipt', async () => {
    // Browsing to an old night must not claim you just recorded something. Asserting the absence
    // matters as much as the presence: a receipt that shows on every visit is a lie, not a courtesy.
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'tonight', night: { night_date: '2026-08-30' } });
      if (path.includes('/review/')) return Promise.resolve(REVIEW_RESPONSE);
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('/sleep/')) return Promise.resolve(NIGHT);
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    mountAt('/children/kid-1/sleep?date=2026-08-24');

    // Wait for the night itself to have been requested, so the absence below is a real absence rather
    // than a screen that simply has not finished loading yet.
    await waitFor(() => expect(lastNightPath(get)).toBe('/children/kid-1/sleep/2026-08-24?detail=1&context=auto'));
    expect(screen.queryByText('Thanks — that’s recorded')).toBeNull();
    expect(get.mock.calls.map((c) => c[0]).some((p) => p.includes('/review/'))).toBe(false);
  });

  // ★ THE R4 REGRESSION TEST. A flag-only save has NEITHER `true_onset_at` NOR `true_wake_at` — that is
  // the whole point of the flag, it carries no times — so the original gate
  // `r?.review?.true_onset_at || r?.review?.true_wake_at` is false here and the receipt shows nothing,
  // which reads exactly like a failed save (the class of bug the receipt exists to prevent in the first
  // place). Gating on `nobody_in_bed` too is what this test pins.
  test('★ arriving from a FLAG-ONLY save still shows the receipt (R4) — a flag carries no times', async () => {
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'tonight', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('/review/')) {
        return Promise.resolve({
          child_id: 'kid-1',
          night_date: '2026-08-24',
          computed: { status: 'ok', onset_at: '2026-08-24 09:28:00', wake_at: '2026-08-24 20:14:00' },
          review: { true_onset_at: null, true_wake_at: null, nobody_in_bed: 1 },
          transitions: [],
        });
      }
      if (path.includes('/sleep/')) return Promise.resolve({ ...NIGHT, night_date: '2026-08-24', status: 'empty', corrected: true, nobody_in_bed: true });
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    mountAt('/children/kid-1/sleep?date=2026-08-24&saved=1');

    expect(await screen.findByText('Thanks — that’s recorded')).toBeVisible();
    expect(screen.getByText('You said no one was in the bed. Tap to change it.')).toBeInTheDocument();
  });

  // ★ Plan review R1 (2026-09-30). An in-bed-only save has neither true_onset_at nor true_wake_at, so the
  // old gate showed no receipt at all, and reading the raw times would have said "asleep — to —". It must
  // read back the put-down they gave, with the detector's asleep and wake times from the same response.
  test('★ arriving from an IN-BED-ONLY save shows "in bed …, asleep … to …" with the resolved times', async () => {
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'tonight', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('/review/')) {
        return Promise.resolve({
          ...REVIEW_RESPONSE,
          review: { true_onset_at: null, true_wake_at: null, true_in_bed_at: '2026-08-24 08:49:00', nobody_in_bed: 0 },
        });
      }
      if (path.includes('/sleep/')) return Promise.resolve(NIGHT);
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    mountAt('/children/kid-1/sleep?date=2026-08-24&saved=1');

    expect(await screen.findByText('Thanks — that’s recorded')).toBeVisible();
    // 08:49Z / 09:28Z / 20:14Z are 6:49 pm, 7:28 pm and 6:14 am in Melbourne (the locale is pinned to
    // en-AU in test/setup.js, so this exact string is deterministic).
    expect(screen.getByText('You said in bed 6:49 pm, asleep 7:28 pm to 6:14 am. Tap to change it.')).toBeInTheDocument();
  });

  // ★ A RECEIPT MUST NOT OUTLIVE THE CORRECTION IT QUOTES. Arriving from a save and pressing "Recompute this
  // night" is the natural way to meet the locked dialog, and "Remove my correction" there deletes the very
  // times the receipt reads back. Without `onCorrectionRemoved` the "Thanks — that's recorded" card stayed
  // up, saying the removed times had been recorded. Crosses the seam the unit tests cannot: the callback is
  // wired in SleepDetail, not in RecomputeNight.
  test('★ removing the correction from the locked Recompute dialog drops the "that\'s recorded" receipt', async () => {
    const corrected = { ...NIGHT, night_date: '2026-08-24', corrected: true };
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'tonight', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('/review/')) return Promise.resolve(REVIEW_RESPONSE);
      if (path.includes('stored=1')) return Promise.resolve({ night: { ...NIGHT, night_date: '2026-08-24' }, locked: true });
      if (path.includes('/sleep/')) return Promise.resolve(corrected);
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    const put = vi.spyOn(api, 'put').mockResolvedValue({ review: {} });
    const { user } = mountAt('/children/kid-1/sleep?date=2026-08-24&saved=1');

    expect(await screen.findByText('Thanks — that’s recorded')).toBeVisible();
    await user.click(await screen.findByRole('button', { name: /recompute this night/i }));
    await user.click(await screen.findByRole('button', { name: /^remove my correction$/i }));
    await user.click(await screen.findByRole('button', { name: /^remove my correction$/i }));

    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText('Thanks — that’s recorded')).toBeNull());
  });

  // ★ A SLOW RECEIPT FETCH MUST NOT BRING BACK A RECEIPT THAT WAS JUST REMOVED (#679, from the #678 review).
  // The page reads the review for the receipt on arrival; if that GET is still in flight when the person
  // opens Recompute and removes the correction, `onCorrectionRemoved` clears the receipt and the OLDER
  // response then lands and sets it again, quoting times that no longer exist. The effect's own `alive`
  // guard cannot see this: it only flips on cleanup (a date or id change), not on a removal.
  //
  // The receipt fetch is held by hand (the FIRST `/review/` GET; the dialog's own read before its PUT is
  // the second and answers at once), so the order is exactly the bad one: removal first, stale answer
  // after. The answer carries the removed times, as a real one would.
  test('★ a receipt fetch still in flight when the correction is removed does not bring the receipt back', async () => {
    const corrected = { ...NIGHT, night_date: '2026-08-24', corrected: true };
    let reviewReads = 0;
    let releaseReceipt;
    let removed = false;
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'tonight', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('/review/')) {
        reviewReads += 1;
        if (reviewReads === 1) return new Promise((resolve) => { releaseReceipt = () => resolve(REVIEW_RESPONSE); });
        return Promise.resolve(REVIEW_RESPONSE);
      }
      if (path.includes('stored=1')) return Promise.resolve({ night: { ...NIGHT, night_date: '2026-08-24' }, locked: !removed });
      if (path.includes('/sleep/')) return Promise.resolve(corrected);
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    const put = vi.spyOn(api, 'put').mockImplementation(() => { removed = true; return Promise.resolve({ review: {} }); });
    const { user } = mountAt('/children/kid-1/sleep?date=2026-08-24&saved=1');

    await user.click(await screen.findByRole('button', { name: /recompute this night/i }));
    // The receipt's GET is the one still pending: no receipt yet, and it has been asked for exactly once.
    expect(reviewReads).toBe(1);
    expect(screen.queryByText('Thanks — that’s recorded')).toBeNull();
    await user.click(await screen.findByRole('button', { name: /^remove my correction$/i }));
    await user.click(await screen.findByRole('button', { name: /^remove my correction$/i }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    // The dialog has finished (the locked notice goes once its refresh has read the unlocked row).
    await waitFor(() => expect(screen.queryByText(/This night is locked because you corrected it/)).toBeNull());

    // NOW the older read answers. It must be ignored.
    await act(async () => { releaseReceipt(); });
    expect(screen.queryByText('Thanks — that’s recorded')).toBeNull();
  });

  test('★ but never past the newest browsable night', async () => {
    // With the clock pinned (above) the newest night is 2026-08-30, so 08-31 is exactly ONE day past it:
    // the picker could not reach it, and a URL must not either. One day, not a month, so a clamp widened
    // by a day fails here. (#534 — the old fixture asked for 2026-09-30 and went stale with the real clock.)
    const get = mockSleep({ live: { scope: 'tonight', night: { night_date: '2026-08-30' } } });
    mountAt('/children/kid-1/sleep?date=2026-08-31');
    await waitFor(() => expect(lastNightPath(get)).toBe('/children/kid-1/sleep/2026-08-30?detail=1&context=auto'));
  });

  // The other side of the same boundary: the newest night itself IS allowed. Without it, a clamp that
  // became `<` instead of `<=` would pass the test above. The live night is set a day EARLIER than the
  // newest browsable night so the answer cannot be the live-night fallback by coincidence.
  test('★ and the newest browsable night itself is honoured', async () => {
    const get = mockSleep({ live: { scope: 'tonight', night: { night_date: '2026-08-29' } } });
    mountAt('/children/kid-1/sleep?date=2026-08-30');
    await waitFor(() => expect(lastNightPath(get)).toBe('/children/kid-1/sleep/2026-08-30?detail=1&context=auto'));
  });

  test('★ and a malformed date falls back rather than requesting it', async () => {
    const get = mockSleep({ live: { scope: 'tonight', night: { night_date: '2026-08-30' } } });
    mountAt('/children/kid-1/sleep?date=yesterday');
    await waitFor(() => expect(lastNightPath(get)).toBe('/children/kid-1/sleep/2026-08-30?detail=1&context=auto'));
    // Asserting the fallback alone would pass if the component simply ignored the param on a later
    // render; this pins that the bad value was never requested at all.
    expect(get.mock.calls.map((c) => c[0]).some((p) => p.includes('yesterday'))).toBe(false);
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

    await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/children/kid-1/sleep/${wanted}?detail=1&context=auto`));
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
  // ⚠️ THE CLOCK IS PINNED FOR THIS WHOLE GROUP (2026-09-29, CI went red on a PR that touched no
  // frontend). The fixture night is a fixed 2026-08-30, but the screen's maximum comes from the REAL
  // clock — yesterday in the app timezone, or the live night if later — and its floor is 29 nights
  // before that. Once real time moved on, the fixture stopped being the latest night, and on
  // 2026-09-29 it fell exactly ON the floor, so `Previous night` was disabled and both the arrows
  // test and the latest-night test failed. Nothing in the app was wrong; the fixtures had a shelf life.
  //
  // Pinned to a fixed instant rather than derived from now on purpose: NIGHT's times assume
  // Melbourne's +10, and Melbourne changes offset in October, so a derived date would exercise a
  // different offset by season. Only `Date` is faked (timers stay real, so waitFor and userEvent
  // keep working); the afterEach at the top of the file restores it.
  // 02:00Z on the 31st is noon there, so 2026-08-30 is "yesterday".
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-31T02:00:00Z'));
  });

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
    //
    // ⚠️ The wait is for the night's own request, NOT for `Next night` to be disabled: that arrow is
    // ALSO disabled before anything has loaded (no maximum yet), so the old wait passed on the loading
    // state and proved nothing about the latest night. The request is made in the same step that sets
    // the maximum, so once it appears both arrows are in their real state.
    const get = mockSleep();
    mount();
    await waitFor(() => expect(lastNightPath(get)).toContain('2026-08-30'));
    expect(screen.getByLabelText('Next night').disabled).toBe(true);
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
    // ⚠️ fireEvent, not user.click, ONLY for this loop. `userEvent` simulates a full pointer sequence
    // with a delay between events, and doing that up to 40 times — each one re-rendering the screen —
    // pushed this test past the 5 s timeout on a loaded machine. It failed in roughly 1 run in 10,
    // and promoting the front-end job to a blocking gate turned that into an intermittent merge
    // blocker. Nothing here is about pointer semantics; the click that IS about that is the one in
    // the test above, which stays a `user.click`.
    for (let i = 0; i < 40 && !screen.getByLabelText('Previous night').disabled; i += 1) {
      fireEvent.click(screen.getByLabelText('Previous night'));
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

  // Issue #501: "In bed" and "Asleep" as two times, on a night with a real gap between them (a bedtime
  // story), and ONLY then — both branches, since a fixture that always had a gap would pass even if
  // the condition were deleted.
  test('a story night shows "In bed" as its own stat, before the asleep range, in the APP timezone', async () => {
    mockSleep({ night: { ...NIGHT, in_bed_at: '2026-08-30 09:13:41' } }); // 19:13 Melbourne, 17 min before sleep
    mount();
    const stat = (await screen.findByText('In bed')).closest('.sleep-stat');
    expect(within(stat).getByText(/7:13\s*pm/i)).toBeTruthy();
    const labels = [...document.querySelectorAll('.sleep-stat__label')].map((n) => n.textContent);
    expect(labels.slice(0, 2)).toEqual(['In bed', 'Asleep from → to']);
  });

  test.each([
    ['no put-down was found', null],
    ['the put-down is the same minute as sleep', '2026-08-30 09:30:00'],
    ['the put-down carries seconds past the floored onset', '2026-08-30 09:30:40'],
  ])('no "In bed" stat when %s', async (_why, inBed) => {
    mockSleep({ night: { ...NIGHT, in_bed_at: inBed } });
    mount();
    await screen.findByText('Wake-ups');
    expect(screen.queryByText('In bed')).toBeNull();
  });

  test('no "In bed" stat on a night whose onset was corrected LATER than the computed put-down', async () => {
    // Computed put-down 19:13, the person said asleep at 19:45 (algorithm: 19:30). A full gap, so only
    // the corrected-onset guard in showsInBed keeps the stale put-down off the page.
    mockSleep({
      night: {
        ...NIGHT, in_bed_at: '2026-08-30 09:13:41', algo_onset_at: NIGHT.onset_at,
        onset_at: '2026-08-30 09:45:00', corrected: true,
      },
    });
    mount();
    await screen.findByText('Wake-ups');
    expect(screen.queryByText('In bed')).toBeNull();
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

  // A detector-empty night and a PARENT-flagged one share `status: 'empty'`, but the honest claims they
  // can make differ (the detector one really did watch the whole window; the flagged one is a parent
  // overruling the detector, and the cameras may have seen something else entirely) — and only the
  // flagged one can be undone, so only it may reach the review form at all. `nobody_in_bed: true` is
  // what a real `asNobodyInBed` overlay carries (sleepReviews.js) — see the next test for why `corrected`
  // alone is not a safe stand-in for it here.
  test('a PARENT-flagged empty night says so, and stays reachable to undo — unlike a detector-empty one', async () => {
    mockSleep({ night: { ...NIGHT, status: 'empty', corrected: true, nobody_in_bed: true, coverage_minutes: 720 } });
    mount();
    expect(await screen.findByText('You said no one was in the bed for this night.')).toBeInTheDocument();
    // The false claim a detector-empty night is allowed to make ("the cameras watched...") must not
    // survive onto a night that is actually a parent's statement, not a coverage report.
    expect(screen.queryByText(/cameras watched the whole window/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change what you told us about this night/i })).toBeInTheDocument();
  });

  test('a genuine detector-empty night keeps the old copy, and offers the review as an uncorrected night', async () => {
    mockSleep({ night: { ...NIGHT, status: 'empty', coverage_minutes: 720 } });
    mount();
    expect(await screen.findByText(/No one in the bed for this night. The cameras watched the whole window/)).toBeInTheDocument();
    expect(screen.queryByText('You said no one was in the bed for this night.')).not.toBeInTheDocument();
    // Until #355 this asserted NO button: the "reverse error" (detector says empty, child was really there)
    // had no correction path. #355 is that path, so the night now reads like any night nobody has answered.
    expect(screen.getByRole('button', { name: /was this night right/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change what you told us/i })).not.toBeInTheDocument();
  });

  // #355 (PR #721 review, Codex P1): a detector-empty night that a parent gives both times becomes a scored
  // night, but the only ways into the review were the morning card (which offers `ok` nights only) and this
  // button, shown only on a night that was ALREADY corrected. So the new behaviour was unreachable from the
  // app. Mounted on the real review route so pressing the button has to land on a screen with both times.
  test('★ #355: a detector-empty night offers the review, and opening it offers both times', async () => {
    const EMPTY = { ...NIGHT, status: 'empty', coverage_minutes: 720, onset_at: null, wake_at: null };
    // GET /review/:date for that night: the detector worked out no times, nobody has answered.
    const REVIEW = { child_id: 'kid-1', night_date: '2026-08-30', computed: { status: 'empty', onset_at: null, wake_at: null }, review: null, transitions: [] };
    vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('/review/')) return Promise.resolve(REVIEW);
      if (path.includes('/sleep/')) return Promise.resolve(EMPTY);
      return Promise.resolve(null);
    });
    const { user } = renderAsAdmin(
      <Routes>
        <Route path="/children/:id/sleep" element={<SleepDetail />} />
        <Route path="/children/:id/review/:date" element={<NightReview />} />
      </Routes>,
      { kids: [KID], settings: { timezone: 'Australia/Melbourne' }, route: '/children/kid-1/sleep' }
    );
    await user.click(await screen.findByRole('button', { name: /was this night right/i }));
    // A night with no times opens on "Add the times" (NightReview's no-opinion branch), which shows both.
    await user.click(await screen.findByRole('button', { name: /add the times/i }));
    expect(screen.getByLabelText('Fell asleep')).toBeEnabled();
    expect(screen.getByLabelText('Got up for the day')).toBeEnabled();
  });

  test('…but not while that empty night is still in progress (the same rule as an `ok` night)', async () => {
    mockSleep({ night: { ...NIGHT, status: 'empty', in_progress: true, coverage_minutes: 720 } });
    mount();
    expect(await screen.findByText(/No one in the bed for this night/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /was this night right/i })).not.toBeInTheDocument();
  });

  // ★ REGRESSION (code-review finding, 2026-09-29): a plain TIME correction on a night that was already
  // `status: 'empty'` ALSO sets `corrected: true` (sleepReviews.js's OTHER `applyCorrection` branch —
  // not `asNobodyInBed`, which is the only path that sets `nobody_in_bed`). Keying this copy on
  // `corrected` alone told a parent who had only typed a time that they had said no one was in the bed
  // at all — false. `nobody_in_bed` is absent here on purpose, mirroring that branch's real output.
  test('a TIME correction on an already-empty night is NOT read as "no one was in the bed"', async () => {
    mockSleep({ night: { ...NIGHT, status: 'empty', corrected: true, coverage_minutes: 720 } });
    mount();
    expect(await screen.findByText(/No one in the bed for this night. The cameras watched the whole window/)).toBeInTheDocument();
    expect(screen.queryByText('You said no one was in the bed for this night.')).not.toBeInTheDocument();
    // Still reachable to change, same as any other corrected night — only the WORDING was wrong.
    expect(screen.getByRole('button', { name: /change what you told us about this night/i })).toBeInTheDocument();
  });

  test('a null night reads as no data, not as an error', async () => {
    mockSleep({ night: null });
    mount();
    expect(await screen.findByText(/No sleep data for this night/)).toBeTruthy();
  });

  test('★ a failed request says it could not load, with Retry - not "no data", not "Loading…" forever (#375)', async () => {
    // It used to set `null`, the same value as "no night recorded", so an outage read as "it predates
    // tracking". The other thing it must never do is stay on "Loading night…" forever.
    vi.spyOn(api, 'get').mockImplementation((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      return Promise.reject(new Error('boom'));
    });
    mount();
    expect(await screen.findByText(/Couldn’t load this night/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.queryByText(/No sleep data for this night/)).toBeNull();
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

// #521: Recompute used to be unreachable on any `empty` night, because that branch returns before the
// `ok`-night render where the control lives. Same component as on an `ok` night, so these tests only pin
// what is different here: that it is REACHABLE, that the two-step flow (press previews, second press
// applies) and the locked dialog survive the move, and that it stays admin-only.
describe('#521 Recompute is reachable on an empty night', () => {
  const EMPTY = { ...NIGHT, status: 'empty', coverage_minutes: 720, onset_at: null, wake_at: null };
  // What is SAVED for that night: an earlier, scored pass. Differs from the empty night, so the dialog has
  // something to offer.
  const SAVED = { night_date: '2026-08-30', status: 'ok', onset_at: '2026-08-30 09:30:00', wake_at: '2026-08-30 20:15:00',
    asleep_minutes: 600, awake_minutes: 20, wake_count: 1 };

  // Routes by query, because the dialog asks for three different things of the same path.
  function mockEmpty({ night = EMPTY, locked = false } = {}) {
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('stored=1')) return Promise.resolve({ night: SAVED, locked });
      return Promise.resolve(night); // the page's own read, and the post-store re-fetch
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    return get;
  }
  const storeCalls = (get) => get.mock.calls.map((c) => c[0]).filter((p) => p.includes('store=1') && !p.includes('stored=1'));

  test('★ a detector-empty night offers it; the first press PREVIEWS and writes nothing, the second applies', async () => {
    const get = mockEmpty();
    mount();
    const btn = await screen.findByRole('button', { name: /recompute this night/i });
    fireEvent.click(btn);
    // Step 1: the dialog opens on the saved-vs-now comparison, and nothing has been stored yet.
    expect(await screen.findByRole('button', { name: /save the new numbers/i })).toBeInTheDocument();
    expect(storeCalls(get)).toHaveLength(0);
    // Step 2: only this press writes (the route's allowDowngrade / lock refusals are the server's call).
    fireEvent.click(screen.getByRole('button', { name: /save the new numbers/i }));
    await waitFor(() => expect(storeCalls(get)).toHaveLength(1));
  });

  test('a PARENT-flagged night opens on "locked" and offers no way to store', async () => {
    const get = mockEmpty({ night: { ...EMPTY, corrected: true, nobody_in_bed: true }, locked: true });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: /recompute this night/i }));
    expect(await screen.findByText(/This night is locked because you corrected it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save the new numbers/i })).not.toBeInTheDocument();
    expect(storeCalls(get)).toHaveLength(0);
    // The note under the button must not talk about "times" on a night that has none.
    expect(screen.getByText(/Your answer that no one was in the bed is kept/)).toBeInTheDocument();
    expect(screen.queryByText(/These times are the ones you told us/)).not.toBeInTheDocument();
  });

  test('★ still admin-only: a caregiver sees the empty night and no Recompute control', async () => {
    mockEmpty();
    renderAsCaregiver(
      <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
      { kids: [KID], settings: { timezone: 'Australia/Melbourne' }, route: '/children/kid-1/sleep' }
    );
    expect(await screen.findByText(/No one in the bed for this night/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
  });

  // Since #361 PR 3 a no_data / no_sleep night CAN show it, but only for a night whose saved settings are usable and
  // differ from today's (the block below). This server answers `?stored=1` with no `contexts` (an older backend),
  // so the three cards must look exactly as they did.
  test('it is not added to the other empty states (no_data, no_sleep, off) without usable, differing saved settings', async () => {
    for (const status of ['no_data', 'no_sleep', 'off']) {
      mockEmpty({ night: { ...NIGHT, status } });
      const { unmount } = mount();
      await screen.findByText(/No sleep data|No clear sleep|tracking is off/);
      expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
    }
  });
});

// #361 PR 3, plan R1: the night the stored-settings re-score exists for is exactly the one that reads "No sleep
// data" today (its camera turned off, moved or demoted since it was saved), and SleepDetail returned that card
// before any Recompute was rendered, so the feature was unreachable in its motivating case. These cross the
// SleepDetail -> RecomputeNight seam the component tests cannot: the page must render the control on those cards,
// and the control must decide, from the server's `contexts`, whether to show anything at all.
describe('#361 PR 3: Recompute on a night today\'s settings cannot score', () => {
  const CTX_SAVED = { v: 1, camera_id: 'cam-a', tz: 'Australia/Melbourne', window: { start: '19:30', end: '07:00' }, algo: '1' };
  const CTX_NOW = { ...CTX_SAVED, camera_id: 'cam-b' };
  const contextsWith = (differs) => ({
    stored_state: 'ok', stored: CTX_SAVED, current: differs ? CTX_NOW : CTX_SAVED, differs,
    camera_names: { stored: 'Bed cam', current: differs ? 'Door cam' : 'Bed cam' },
  });
  const SAVED = { night_date: '2026-08-30', status: 'ok', onset_at: '2026-08-30 09:30:00', wake_at: '2026-08-30 20:15:00',
    asleep_minutes: 600, awake_minutes: 20, wake_count: 1, scoring_context: JSON.stringify(CTX_SAVED) };

  function mockUnscored({ status = 'no_data', contexts = contextsWith(true) } = {}) {
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      if (path.includes('?stored=1')) return Promise.resolve({ night: SAVED, locked: false, contexts });
      return Promise.resolve({ ...NIGHT, status, onset_at: null, wake_at: null, coverage_minutes: status === 'no_data' ? 0 : 700 });
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    return get;
  }
  const storedReads = (get) => get.mock.calls.map((c) => c[0]).filter((p) => p.includes('?stored=1'));

  test('★ an admin sees it on a no_data night whose saved settings differ, and the dialog offers the stored settings', async () => {
    mockUnscored();
    const { user } = mount();
    expect(await screen.findByText(/No sleep data for this night/)).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /recompute this night/i }));
    expect(await screen.findByText(/Today’s settings find no data for this night/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /use the settings this night was saved with/i })).not.toBeChecked();
    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
  });

  test('…and on a no_sleep night', async () => {
    mockUnscored({ status: 'no_sleep' });
    mount();
    expect(await screen.findByText(/No clear sleep detected/)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /recompute this night/i })).toBeInTheDocument();
  });

  test('not when the saved settings are the same as today\'s (nothing to choose)', async () => {
    const get = mockUnscored({ contexts: contextsWith(false) });
    mount();
    await screen.findByText(/No sleep data for this night/);
    await waitFor(() => expect(storedReads(get)).toHaveLength(1));
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
  });

  test('not for a caregiver, who also causes no read of the saved row', async () => {
    const get = mockUnscored();
    renderAsCaregiver(
      <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
      { kids: [KID], settings: { timezone: 'Australia/Melbourne' }, route: '/children/kid-1/sleep' }
    );
    await screen.findByText(/No sleep data for this night/);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
    expect(storedReads(get)).toHaveLength(0);
  });

  test('not on an `off` night (tracking is off: nothing is scored either way)', async () => {
    const get = mockUnscored({ status: 'off' });
    mount();
    await screen.findByText(/Sleep tracking is off for this child/);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /recompute this night/i })).not.toBeInTheDocument();
    expect(storedReads(get)).toHaveLength(0);
  });
});

// #361 PR 4a: a FINISHED night whose saved settings differ from today's is shown with the saved ones, and the page
// says so, with a switch to today's. The server decides (it answers `scoring_view` only when that applies); these
// pin what the page does with it: the line for every status but `off` (plan R3), the wording, the switch and its
// requests, that the view is per night and never remembered (plan R5), that the 2-minute refresh keeps it (R9), and
// that a Recompute save takes the page back to its default view (R4). The clock is pinned as in "moving between
// nights", so 2026-08-30 is the newest browsable night (and so the one that is refreshed every 2 minutes).
describe('#361 PR 4a: a finished night shown with the settings it was saved with', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-31T02:00:00Z'));
  });

  const CTX_SAVED = { v: 1, camera_id: 'cam-a', tz: 'Australia/Melbourne', window: { start: '19:30', end: '07:00' }, algo: '1' };
  const CTX_NOW = { ...CTX_SAVED, camera_id: 'cam-b', window: { start: '20:00', end: '07:00' } };
  const view = (applied, extra = {}) => ({
    applied, stored: CTX_SAVED, current: CTX_NOW, camera_names: { stored: 'Bed cam', current: 'Door cam' }, algo_differs: false, ...extra,
  });
  const SAVED_LINE = 'Worked out with the settings this night was saved with (Bed cam, 19:30–07:00, Australia/Melbourne), using today’s detection rules.';
  const TODAY_LINE = 'Showing today’s settings (Door cam, 20:00–07:00, Australia/Melbourne). The saved summary for this night keeps the settings it was saved with.';
  const TO_TODAY = 'Show with today’s settings';
  const TO_SAVED = 'Show with the settings this night was saved with';
  const STORED_VIEW = { ...NIGHT, scoring_view: view('stored') };
  const TODAY_VIEW = { ...NIGHT, onset_at: '2026-08-30 10:10:00', scoring_view: view('current') };

  // Answers by the view the page asks for (`context=current` or the default), plus anything `extra` claims first.
  function mockViews({ auto = STORED_VIEW, current = TODAY_VIEW, extra } = {}) {
    const get = vi.fn((path) => {
      if (path.includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { night_date: '2026-08-30' } });
      if (path.includes('/sleep/insights')) return Promise.resolve(null);
      const claimed = extra?.(path);
      if (claimed !== undefined) return claimed;
      if (path.includes('context=current')) return Promise.resolve(current);
      if (path.includes('/sleep/')) return Promise.resolve(auto);
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'get').mockImplementation(get);
    return get;
  }
  // The page's own night reads (not ?stored=1, the Recompute preview or a store).
  const nightPaths = (get) => get.mock.calls.map((c) => c[0]).filter((p) => /\/sleep\/\d{4}-\d{2}-\d{2}\?detail=1&context=/.test(p));
  // The 2-minute refresh, captured so a test can fire it (as loadStates.test.jsx does).
  function captureRefresh() {
    const box = { fire: null };
    const realSet = globalThis.setInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation((fn, ms, ...a) => {
      if (ms === 2 * 60 * 1000) { box.fire = fn; return 0; }
      return realSet(fn, ms, ...a);
    });
    return box;
  }

  for (const status of ['ok', 'no_data', 'no_sleep', 'empty']) {
    test(`★ a "${status}" night shown with its saved settings says so, with the switch to today's`, async () => {
      mockViews({ auto: { ...STORED_VIEW, status, coverage_minutes: 720 } });
      mount();
      expect(await screen.findByText(SAVED_LINE)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: TO_TODAY })).toBeInTheDocument();
    });
  }

  test('an `off` night has no line and no switch, even if a server sent the settings (plan R3)', async () => {
    mockViews({ auto: { ...STORED_VIEW, status: 'off' } });
    mount();
    expect(await screen.findByText(/Sleep tracking is off for this child/)).toBeInTheDocument();
    expect(screen.queryByText(SAVED_LINE)).toBeNull();
    expect(screen.queryByRole('button', { name: TO_TODAY })).toBeNull();
  });

  test('a night without `scoring_view` (today\'s settings, or nothing to choose) has no line and no switch', async () => {
    mockViews({ auto: NIGHT });
    mount();
    await screen.findByText('Wake-ups');
    expect(screen.queryByRole('button', { name: TO_TODAY })).toBeNull();
    expect(screen.queryByRole('button', { name: TO_SAVED })).toBeNull();
    expect(screen.queryByText(/Worked out with the settings|Showing today’s settings/)).toBeNull();
  });

  test('★ a saved camera that no longer exists: that is the line, in place of the "No sleep data" text', async () => {
    mockViews({
      auto: {
        ...NIGHT, status: 'no_data', onset_at: null, wake_at: null, coverage_minutes: 0,
        scoring: { source: 'stored', algo: '1', current_algo: '1', algo_differs: false, problem: 'camera_deleted' },
        scoring_view: view('stored', { camera_names: { stored: null, current: 'Door cam' } }),
      },
    });
    mount();
    expect(await screen.findAllByText('The camera this night was measured from no longer exists, so it can’t be worked out with those settings.')).toHaveLength(1);
    expect(screen.queryByText(/No sleep data for this night/)).toBeNull();
    expect(screen.getByRole('button', { name: TO_TODAY })).toBeInTheDocument();
  });

  test('the deleted-camera settings switch keeps the same focused button after showing today', async () => {
    mockViews({
      auto: {
        ...NIGHT, status: 'no_data', onset_at: null, wake_at: null, coverage_minutes: 0,
        scoring: { problem: 'camera_deleted' }, scoring_view: view('stored'),
      },
    });
    const { user } = mount();
    const button = await screen.findByRole('button', { name: TO_TODAY });
    button.focus();
    expect(document.activeElement).toBe(button);
    await user.click(button);
    expect(await screen.findByText(TODAY_LINE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: TO_SAVED })).toBe(button);
    expect(document.activeElement).toBe(button);
  });

  test('a night first worked out under earlier rules says its numbers can differ from the card', async () => {
    mockViews({ auto: { ...NIGHT, scoring_view: view('stored', { algo_differs: true }) } });
    mount();
    expect(await screen.findByText(`${SAVED_LINE} It was first worked out under earlier detection rules, so the numbers can differ from the child’s card.`)).toBeInTheDocument();
  });

  test('★ the switch asks for today\'s settings, and back', async () => {
    const get = mockViews();
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: TO_TODAY }));
    expect(await screen.findByText(TODAY_LINE)).toBeInTheDocument();
    expect(nightPaths(get).at(-1)).toBe('/children/kid-1/sleep/2026-08-30?detail=1&context=current');
    // The numbers are today's too (TODAY_VIEW's 10:10Z is 8:10 pm in Melbourne).
    expect(screen.getByText(/8:10\s*pm/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: TO_SAVED }));
    expect(await screen.findByText(SAVED_LINE)).toBeInTheDocument();
    expect(nightPaths(get).at(-1)).toBe('/children/kid-1/sleep/2026-08-30?detail=1&context=auto');
  });

  test('a failed switch can be retried from the same button while the saved night stays visible', async () => {
    let currentReads = 0;
    const get = mockViews({
      extra: (path) => {
        if (!path.includes('context=current')) return undefined;
        currentReads += 1;
        return currentReads === 1 ? Promise.reject(new Error('Temporary failure')) : Promise.resolve(TODAY_VIEW);
      },
    });
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: TO_TODAY }));
    expect(await screen.findByText(/Couldn’t refresh this night\. Showing what we had\./i)).toBeInTheDocument();
    expect(screen.getByText(SAVED_LINE)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: TO_TODAY }));
    expect(await screen.findByText(TODAY_LINE)).toBeInTheDocument();
    expect(currentReads).toBe(2);
    expect(nightPaths(get).slice(-2)).toEqual([
      '/children/kid-1/sleep/2026-08-30?detail=1&context=current',
      '/children/kid-1/sleep/2026-08-30?detail=1&context=current',
    ]);
  });

  // ★ Plan R5. Without a reset the 08-29 request carries 'current'. With a reset done only by a setState in the reset
  // effect (the plan's literal wording), the same commit's fetch still reads the old value, so ONE 08-29 request goes
  // out with 'current' before the re-render corrects it. And without forgetting the choice, coming back to 08-30
  // would bring 'current' back.
  test('★ the view is per night: no request for another night carries it, and coming back does not restore it', async () => {
    const get = mockViews();
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: TO_TODAY }));
    await screen.findByText(TODAY_LINE);
    await user.click(screen.getByLabelText('Previous night'));
    await waitFor(() => expect(nightPaths(get).some((p) => p.includes('/2026-08-29?'))).toBe(true));
    await act(async () => {});
    const for29 = nightPaths(get).filter((p) => p.includes('/2026-08-29?'));
    expect(for29).toEqual(['/children/kid-1/sleep/2026-08-29?detail=1&context=auto']);
    await user.click(screen.getByLabelText('Next night'));
    await waitFor(() => expect(nightPaths(get).at(-1)).toBe('/children/kid-1/sleep/2026-08-30?detail=1&context=auto'));
    expect(await screen.findByText(SAVED_LINE)).toBeInTheDocument();
  });

  test('★ the 2-minute refresh keeps the view the page is in', async () => {
    const refresh = captureRefresh();
    const get = mockViews();
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: TO_TODAY }));
    await screen.findByText(TODAY_LINE);
    const before = nightPaths(get).length;
    await act(async () => { refresh.fire(); });
    expect(nightPaths(get).slice(before)).toEqual(['/children/kid-1/sleep/2026-08-30?detail=1&context=current']);
    expect(screen.getByText(TODAY_LINE)).toBeInTheDocument();
  });

  test('★ a Recompute save from today\'s settings takes the page back to its default view (and its refresh with it)', async () => {
    const refresh = captureRefresh();
    const contexts = { stored_state: 'ok', stored: CTX_SAVED, current: CTX_NOW, differs: true, camera_names: { stored: 'Bed cam', current: 'Door cam' } };
    const get = mockViews({
      extra: (path) => {
        if (path.includes('?stored=1')) return Promise.resolve({ night: { ...NIGHT, asleep_minutes: 1 }, locked: false, contexts });
        if (path.includes('context=current&raw=1')) return Promise.resolve({ ...NIGHT, onset_at: '2026-08-30 10:10:00' });
        if (path.includes('store=1')) return Promise.resolve({ ...NIGHT, stored: true });
        return undefined;
      },
    });
    const { user } = mount();
    await user.click(await screen.findByRole('button', { name: TO_TODAY }));
    await screen.findByText(TODAY_LINE);
    await user.click(screen.getByRole('button', { name: /recompute this night/i }));
    await user.click(await screen.findByRole('button', { name: /save the new numbers/i }));
    expect(await screen.findByText(SAVED_LINE)).toBeInTheDocument();
    const stores = get.mock.calls.map((c) => c[0]).filter((p) => /[?&]store=1/.test(p));
    expect(stores).toEqual(['/children/kid-1/sleep/2026-08-30?store=1&detail=1']);
    // The view itself is back to the default, not only the night on screen: the next refresh asks for it.
    const before = nightPaths(get).length;
    await act(async () => { refresh.fire(); });
    expect(nightPaths(get).slice(before)).toEqual(['/children/kid-1/sleep/2026-08-30?detail=1&context=auto']);
  });
});

describe('the header', () => {
  test('points back at the child by name', async () => {
    mockSleep();
    mount();
    expect(await screen.findByLabelText('Back to Child B')).toBeTruthy();
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

  test('★ an alert AT THE MOMENT OF WAKING attaches to the morning wake (roadmap §1.5 Gap A)', async () => {
    // Closes the client/server seam: the backend now emits one extra row spanning [wake_at, window_end)
    // for the morning wake itself (sleepAnalysis.js), specifically so an alert firing at the exact
    // instant the child got up has a wake to attach to — previously the wakes[] array only ever held
    // mid-night awakenings, and a wake-up alert at wake_at rendered nowhere. This fixture is shaped
    // exactly like what the fixed backend now sends, not a hand-picked shortcut.
    mockSleep({
      night: {
        ...NIGHT,
        wake_count: 0, // the STORED metric counts only mid-night arousals — deliberately untouched by
        // this fix, and deliberately allowed to differ from the section title below by exactly one on a
        // night with a real wake_at (see the comment above the morning-wake row in sleepAnalysis.js).
        wakes: [{ start_at: '2026-08-30 20:15:00', end_at: '2026-08-30 21:00:00', minutes: 45 }],
        alerts: [{ id: 'a1', type: 'motion', camera_name: 'Nursery', detail: '4.2%', created_at: '2026-08-30 20:15:00' }],
      },
    });
    const { user } = mount('Australia/Melbourne');
    const badge = await screen.findByText(/1 alert$/);
    expect(badge).toBeTruthy();

    await user.click(screen.getByRole('button', { expanded: false }));
    const row = (await screen.findByText(/4\.2%/)).closest('.sleep-wakes__alert');
    expect(row, 'the wake-up alert sits inside the morning wake it belongs to').toBeTruthy();
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

  test('a night with a data gap shows the "No data" legend entry (issue #442)', async () => {
    // hasGap follows the same conditional-legend pattern as hasRoom/hasChildOut — shipped with no
    // test covering either branch (adversarial review finding).
    mockSleep({
      night: { ...NIGHT, segments: [{ state: 'gap', from_at: NIGHT.onset_at, to_at: NIGHT.wake_at, minutes: 5 }] },
    });
    mount();
    expect(await screen.findByText('No data')).toBeTruthy();
  });

  test('...and is absent on an ordinary night with no gap', async () => {
    mockSleep({
      night: { ...NIGHT, segments: [{ state: 'asleep', from_at: NIGHT.onset_at, to_at: NIGHT.wake_at, minutes: 5 }] },
    });
    mount();
    await screen.findByText('Wake-ups');
    expect(screen.queryByText('No data')).toBeNull();
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

// #365: the temperature insight shows no verdict until BOTH groups (cooler, warmer) have enough nights.
// The server decides (verdict 'not_enough_nights' + min_group_nights); this is what the card does with it.
describe('★ the temperature insight with too few nights in a group (#365)', () => {
  const half = (nights, avg_temp, avg_wakes) => ({ nights, avg_temp, avg_wakes, avg_asleep_minutes: 600 });
  const base = {
    status: 'ok', nights_analyzed: 21, min_group_nights: 10, temp_wake_r: 1, temp_asleep_r: -1, temp_spread: 2,
    overall: { avg_temp: 21, min_temp: 20, max_temp: 22, avg_humidity: null },
  };
  const mountAs = (who) =>
    renderAs(who, <Routes><Route path="/children/:id/sleep" element={<SleepDetail />} /></Routes>,
      { kids: [KID], settings: { timezone: 'Australia/Melbourne' }, route: '/children/kid-1/sleep' });

  test('says "not enough nights yet" with the counts, and shows no verdict or comparison, for both roles', async () => {
    await forEachRole(async (_name, who) => {
      mockSleep({ insights: { ...base, verdict: 'not_enough_nights', cooler: half(9, 19, 1), warmer: half(10, 22, 6) } });
      const { unmount } = mountAs(who);
      const card = (await screen.findByText(/Not enough nights yet/)).closest('.sleep-insight');
      expect(card.textContent).toMatch(/needs 10 of each/);
      expect(card.textContent).toMatch(/9 cooler and 10 warmer/);
      expect(within(card).queryByText(/tend to mean more wake-ups|saw fewer wake-ups|No clear link/)).toBeNull();
      expect(within(card).queryByText(/Cooler nights/), 'no averages to read as a finding').toBeNull();
      unmount();
      vi.restoreAllMocks();
    });
  });

  // A group with NO nights arrives as null, not as { nights: 0 } (sleepAnalysis.js: `cool.length ? half(cool) :
  // null`). That is reachable: most nights at the median and a few a degree above it give an empty cooler group
  // and no 'flat'. The card must print 0 for the missing half and the real count for the other, and still show
  // nothing to compare. Both null cannot come with this verdict from today's server (a one-degree spread puts a
  // night on at least one side of the median), but the card should not depend on that. Admin only: the role
  // does not reach this branch, and the test above already runs it for both roles.
  const expectCountsOnly = async (groups, counts) => {
    mockSleep({ insights: { ...base, verdict: 'not_enough_nights', ...groups } });
    mount();
    const card = (await screen.findByText(/Not enough nights yet/)).closest('.sleep-insight');
    expect(card.textContent).toMatch(/needs 10 of each/);
    expect(card.textContent).toMatch(counts);
    expect(card.querySelector('.sleep-insight__cmp'), 'no comparison columns').toBeNull();
    expect(within(card).queryByText(/Cooler nights|Warmer nights|wake-ups avg|°C/), 'no averages to read as a finding').toBeNull();
    expect(within(card).queryByText(/tend to mean more wake-ups|saw fewer wake-ups|No clear link/)).toBeNull();
  };

  test('a missing cooler group (null) counts as 0 nights, next to the real warmer count, with no comparison', async () => {
    await expectCountsOnly({ cooler: null, warmer: half(7, 22, 6) }, /so far 0 cooler and 7 warmer\./);
  });

  test('a missing warmer group (null) counts as 0 nights, next to the real cooler count, with no comparison', async () => {
    await expectCountsOnly({ cooler: half(4, 19, 1), warmer: null }, /so far 4 cooler and 0 warmer\./);
  });

  test('both groups missing (null) count as 0 and 0, with no comparison', async () => {
    await expectCountsOnly({ cooler: null, warmer: null }, /so far 0 cooler and 0 warmer\./);
  });

  test('at the minimum the same card shows the verdict and the comparison as before', async () => {
    await forEachRole(async (_name, who) => {
      mockSleep({ insights: { ...base, verdict: 'warm_more_wakes', cooler: half(10, 19, 1), warmer: half(10, 22, 6) } });
      const { unmount } = mountAs(who);
      expect(await screen.findByText(/Warmer nights tend to mean more wake-ups/)).toBeTruthy();
      expect(screen.getByText(/Cooler nights/)).toBeTruthy();
      expect(screen.queryByText(/Not enough nights yet/)).toBeNull();
      unmount();
      vi.restoreAllMocks();
    });
  });
});
