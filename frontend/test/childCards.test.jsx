// SleepSummaryCard and TimelapseCard — the two cards on a child's detail page that were still under
// half covered.
//
// SleepSummaryCard is the one worth care. It renders SEVEN distinct states off one endpoint, and the
// differences between them are the whole point:
//   * `off` (tracking disabled) sends you to SETTINGS, every other state to the sleep detail page;
//   * `no_data` and `empty` look similar and mean opposite things — "we saw nothing" vs "we watched
//     all night and the bed was empty". Conflating them is how this card used to invent a full
//     night's sleep out of an empty bed;
//   * `tonight` vs a completed night changes every string on the card, because "asleep since 19:10"
//     and "19:10 – 06:47" are different claims;
//   * a CORRECTED night must say so, or a card showing a person's own times is indistinguishable
//      from a detector that suddenly got it right — and the "estimated from movement & sound"
//      disclaimer would then be a lie about where the number came from.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver, renderAs, ADMIN, CAREGIVER } from './helpers/render.jsx';
import SleepSummaryCard from '../src/components/SleepSummaryCard.jsx';
import TimelapseCard from '../src/components/TimelapseCard.jsx';
import { api } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';

afterEach(() => vi.restoreAllMocks());

// --- SleepSummaryCard ---------------------------------------------------------------------------

describe('SleepSummaryCard', () => {
  const TZ = 'Australia/Melbourne';
  const live = (payload) => vi.spyOn(api, 'get').mockResolvedValue(payload);
  const show = (opts) => renderAsAdmin(<SleepSummaryCard childId="kid-1" />, { settings: { timezone: TZ }, ...opts });

  // ⚠️ THESE TESTS MUST NOT ASSERT THIS MACHINE'S LOCALE. The card formats with
  // `Intl.DateTimeFormat([])` — an empty locale list, i.e. whatever the runtime default is. vite.config
  // pins the suite's TIMEZONE (deliberately, and for good reasons written up there) but nothing pins
  // the locale, which comes from the OS via ICU and is not settable from vitest on Windows. So
  // "7:10 pm" here is "19:10" on an en-GB machine and "Tue, 1 Sept" is "Tue, Sep 1" on en-US, and
  // asserting either verbatim writes a test that fails on a colleague's laptop for no real reason.
  // `hhmm` matches the same instant in 12- and 24-hour form and nothing else: the \b stops "9:10"
  // matching inside "19:10", which is what would make this sloppy instead of tolerant.
  const hhmm = (h24, min) => {
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const mm = String(min).padStart(2, '0'); // minutes are always two digits in both forms
    return new RegExp(`\\b${h12}:${mm}\\b|\\b${String(h24).padStart(2, '0')}:${mm}\\b`);
  };
  const soon = () => document.querySelector('.night__soon').textContent;
  const head = () => document.querySelector('.night__sleep-head').textContent;

  const OK_NIGHT = {
    status: 'ok',
    night_date: '2026-09-01',
    onset_at: '2026-09-01 09:10:00', // 19:10 Melbourne
    wake_at: '2026-09-01 20:47:00', // 06:47 next morning, Melbourne
    asleep_minutes: 637,
    wake_count: 2,
    longest_stretch_minutes: 300,
  };

  test('shows a loading state before the endpoint answers', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    show();
    expect(screen.getByText('Loading sleep…')).toBeInTheDocument();
  });

  test('a completed night shows the range, wake count and longest stretch in the APP timezone', async () => {
    live({ scope: 'last_night', night: OK_NIGHT });
    show();
    expect(await screen.findByText('10h 37m asleep')).toBeInTheDocument();
    expect(head()).toMatch(/^Last night · Tue,/);
    // ⚠️ 09:10Z is 19:10 in Melbourne and 09:10 in UTC. The card must format in `settings.timezone`,
    // not the browser's — a review window anchored on a literal UTC hour has shipped here before.
    expect(soon()).toMatch(hhmm(19, 10));
    expect(soon()).toMatch(hhmm(6, 47));
    expect(soon()).toMatch(/2 wake-ups · longest 5h 0m/);
  });

  test('the SAME night formats differently under a different configured timezone', async () => {
    live({ scope: 'last_night', night: OK_NIGHT });
    renderAsAdmin(<SleepSummaryCard childId="kid-1" />, { settings: { timezone: 'UTC' } });
    // The default install is UTC. If the card ignored the setting, this and the test above could not
    // both pass — which is exactly what makes the pair discriminating rather than decorative.
    await screen.findByText('10h 37m asleep');
    expect(soon()).toMatch(hhmm(9, 10));
    expect(soon()).toMatch(hhmm(20, 47));
    expect(soon()).not.toMatch(hhmm(19, 10));
  });

  test('pluralises one wake-up correctly and omits absent detail', async () => {
    live({ scope: 'last_night', night: { ...OK_NIGHT, wake_count: 1, longest_stretch_minutes: null } });
    show();
    expect(await screen.findByText(/1 wake-up(?!s)/)).toBeInTheDocument();
    expect(screen.queryByText(/longest/)).not.toBeInTheDocument();
  });

  test('a zero wake count is shown, not hidden', async () => {
    // `wake_count != null`, not a truthiness check: "0 wake-ups" is a real and good result, and
    // dropping it silently would make a perfect night look like a night with missing data.
    live({ scope: 'last_night', night: { ...OK_NIGHT, wake_count: 0 } });
    show();
    expect(await screen.findByText(/0 wake-ups/)).toBeInTheDocument();
  });

  test('durations under an hour drop the hours part', async () => {
    live({ scope: 'last_night', night: { ...OK_NIGHT, asleep_minutes: 47 } });
    show();
    expect(await screen.findByText('47m asleep')).toBeInTheDocument();
  });

  test('a night still in progress reads "so far", not as a finished range', async () => {
    live({ scope: 'tonight', night: { ...OK_NIGHT, wake_at: null } });
    show();
    expect(await screen.findByText('Tonight · so far')).toBeInTheDocument();
    expect(screen.getByText('10h 37m asleep so far')).toBeInTheDocument();
    expect(soon()).toMatch(/^asleep since /);
    expect(soon()).toMatch(hhmm(19, 10));
  });

  test('an in-progress night after a morning wake says "awake since"', async () => {
    live({ scope: 'tonight', night: OK_NIGHT });
    show();
    await screen.findByText('Tonight · so far');
    expect(soon()).toMatch(/^awake since /);
    expect(soon()).toMatch(hhmm(6, 47));
  });

  test('a completed night with no wake says how far the window ran, not that it is still going', async () => {
    live({ scope: 'last_night', night: { ...OK_NIGHT, wake_at: null, window_end: '2026-09-01 21:00:00' } });
    show();
    await screen.findByText('10h 37m asleep');
    expect(soon()).toMatch(/^from .* · still asleep at /);
    expect(soon()).toMatch(hhmm(19, 10));
    expect(soon()).toMatch(hhmm(7, 0));
  });

  test('"no one in the bed" is NOT the same as "no data"', async () => {
    // ⚠️ THE DISTINCTION THAT MATTERS. `empty` means the cameras watched all night and the bed stayed
    // empty; `no_data` means nothing was recorded. Conflating them is how this card once invented a
    // full night's sleep for an empty bed.
    live({ scope: 'last_night', night: { status: 'empty', night_date: '2026-09-01' } });
    const { unmount } = show();
    expect(await screen.findByText('No one in the bed — nothing to report for this night.')).toBeInTheDocument();
    expect(head()).toMatch(/^Last night · Tue,/);
    unmount();

    live({ scope: 'last_night', night: { status: 'no_data' } });
    show();
    expect(await screen.findByText(/Once a camera with motion or sound detection runs overnight/)).toBeInTheDocument();
    expect(screen.queryByText(/No one in the bed/)).not.toBeInTheDocument();
  });

  test('an empty bed reads differently mid-night than after the night', async () => {
    live({ scope: 'tonight', night: { status: 'empty' } });
    show();
    expect(await screen.findByText('No one in the bed.')).toBeInTheDocument();
  });

  test('no clear sleep reads as "not asleep yet" tonight and "none detected" afterwards', async () => {
    live({ scope: 'tonight', night: { status: 'no_sleep' } });
    const { unmount } = show();
    expect(await screen.findByText('Not asleep yet.')).toBeInTheDocument();
    unmount();

    live({ scope: 'last_night', night: { status: 'no_sleep', night_date: '2026-09-01' } });
    show();
    expect(await screen.findByText('No clear sleep detected overnight.')).toBeInTheDocument();
  });

  test('a night with no data yet, mid-night, says tracking is under way', async () => {
    live({ scope: 'tonight', night: null });
    show();
    expect(await screen.findByText(/Tracking tonight/)).toBeInTheDocument();
  });

  test('a failed request degrades to the same empty message rather than a broken card', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    show();
    expect(await screen.findByText(/Once a camera with motion or sound detection runs overnight/)).toBeInTheDocument();
  });

  test('a CORRECTED night says so, and drops the estimate disclaimer', async () => {
    live({ scope: 'last_night', night: { ...OK_NIGHT, corrected: 1 } });
    const { unmount } = show();
    expect(await screen.findByText('You corrected this')).toBeInTheDocument();
    // ⚠️ Leaving the disclaimer on a corrected night would be a lie about where the number came from:
    // these are the times a PERSON gave, not an estimate from movement and sound.
    expect(screen.queryByText(/Estimated from movement/)).not.toBeInTheDocument();
    unmount();

    live({ scope: 'last_night', night: OK_NIGHT });
    show();
    expect(await screen.findByText(/Estimated from movement & sound — not a medical measurement\./)).toBeInTheDocument();
    expect(screen.queryByText('You corrected this')).not.toBeInTheDocument();
  });

  describe('where the card goes when tapped', () => {
    const routes = (
      <Routes>
        <Route path="/" element={<SleepSummaryCard childId="kid-1" />} />
        <Route path="/children/kid-1/sleep" element={<div>sleep detail</div>} />
        <Route path="/children/kid-1/edit" element={<div>child settings</div>} />
      </Routes>
    );

    test('tracking OFF sends you to settings, and says so in its label', async () => {
      live({ scope: 'off' });
      const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
      expect(await screen.findByText('Sleep tracking is off')).toBeInTheDocument();
      const btn = screen.getByRole('button', { name: 'Turn on sleep tracking in settings' });
      await user.click(btn);
      expect(await screen.findByText('child settings')).toBeInTheDocument();
    });

    test('every other state — including no data at all — goes to the sleep detail page', async () => {
      // Clickable even with nothing to show, so the date picker there is still reachable.
      live({ scope: 'last_night', night: { status: 'no_data' } });
      const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
      await user.click(await screen.findByRole('button', { name: 'View sleep detail and history' }));
      expect(await screen.findByText('sleep detail')).toBeInTheDocument();
    });

    test('a caregiver gets the same card and the same destination', async () => {
      live({ scope: 'last_night', night: OK_NIGHT });
      const { user } = renderAsCaregiver(routes, { settings: { timezone: TZ } });
      await user.click(await screen.findByRole('button', { name: 'View sleep detail and history' }));
      expect(await screen.findByText('sleep detail')).toBeInTheDocument();
    });
  });

  describe('staying current', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    test('re-reads every three minutes so a morning wake appears without a reload', async () => {
      live({ scope: 'tonight', night: { ...OK_NIGHT, wake_at: null } });
      show();
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
      api.get.mockResolvedValue({ scope: 'tonight', night: OK_NIGHT });
      await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60 * 1000); });
      await waitFor(() => expect(soon()).toMatch(/^awake since /));
      expect(soon()).toMatch(hhmm(6, 47));
    });

    test('unmounting stops the polling', async () => {
      live({ scope: 'tonight', night: OK_NIGHT });
      const { unmount } = show();
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000); });
      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });
});

// --- TimelapseCard ------------------------------------------------------------------------------

describe('TimelapseCard', () => {
  const ROWS = [
    { id: 't-1', night_date: '2026-09-01', duration_s: 42 },
    { id: 't-2', night_date: '2026-08-31', duration_s: null },
  ];
  const list = (rows) => vi.spyOn(api, 'get').mockResolvedValue(rows);

  // Locale-tolerant, for the reason spelled out in the SleepSummaryCard block above: this card
  // labels its nights with `toLocaleDateString([], ...)`, which renders "Tue, 1 Sept" here and
  // "Tue, Sep 1" on an en-US machine. Matching the day number and the month separately pins the
  // right night without pinning this developer's OS.
  const SEP1 = /^Play .*1.*Sep.* timelapse$/;
  const AUG31 = /^Play .*31.*Aug.* timelapse$/;

  beforeEach(() => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    vi.spyOn(api, 'del').mockResolvedValue({});
  });

  test('renders nothing until a timelapse exists', async () => {
    list([]);
    const { container } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/timelapses/child/kid-1'));
    expect(container.querySelector('.timelapse-card')).toBeNull();
  });

  test('a malformed response is treated as none', async () => {
    vi.spyOn(api, 'get').mockResolvedValue('nope');
    const { container } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(container.querySelector('.timelapse-card')).toBeNull();
  });

  test('the hero is the NEWEST night, with its duration', async () => {
    list(ROWS);
    renderAsAdmin(<TimelapseCard childId="kid-1" />);
    const hero = await screen.findByRole('button', { name: SEP1 });
    expect(hero.textContent).toMatch(/1.*Sep/);
    expect(hero.textContent).toMatch(/· 42s$/);
  });

  test('a single timelapse shows no picker strip', async () => {
    list([ROWS[0]]);
    const { container } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await screen.findByRole('button', { name: SEP1 });
    expect(container.querySelector('.timelapse-strip')).toBeNull();
  });

  test('picking an older night moves the hero to it', async () => {
    list(ROWS);
    const { user, container } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await screen.findByRole('button', { name: SEP1 });
    const strip = container.querySelectorAll('.timelapse-strip__item');
    expect(strip).toHaveLength(2);
    expect(strip[0]).toHaveClass('timelapse-strip__item--active');

    await user.click(strip[1]);
    expect(screen.getByRole('button', { name: AUG31 })).toBeInTheDocument();
    expect(container.querySelectorAll('.timelapse-strip__item')[1]).toHaveClass('timelapse-strip__item--active');
  });

  test('an unparseable night date is shown raw rather than as Invalid Date', async () => {
    list([{ id: 't-9', night_date: 'garbage' }]);
    renderAsAdmin(<TimelapseCard childId="kid-1" />);
    expect(await screen.findByRole('button', { name: 'Play garbage timelapse' })).toBeInTheDocument();
  });

  test('the hero opens the player', async () => {
    list(ROWS);
    const { user } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await user.click(await screen.findByRole('button', { name: SEP1 }));
    expect((await screen.findByRole('dialog')).getAttribute('aria-label') ?? document.querySelector('.modal-card__head h2').textContent).toMatch(/^Timelapse · .*1.*Sep/);
  });

  test('ONLY an admin can delete a timelapse', async () => {
    list(ROWS);
    const a = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await a.user.click(await screen.findByRole('button', { name: SEP1 }));
    expect(await screen.findByRole('button', { name: 'Delete timelapse' })).toBeInTheDocument();
    a.unmount();

    list(ROWS);
    const c = renderAsCaregiver(<TimelapseCard childId="kid-1" />);
    await c.user.click(await screen.findByRole('button', { name: SEP1 }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Delete timelapse' })).not.toBeInTheDocument();
    // A caregiver still gets the player and the download.
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  test('the delete confirmation says it CANNOT be rebuilt — the source frames are gone', async () => {
    list(ROWS);
    const { user } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await user.click(await screen.findByRole('button', { name: SEP1 }));
    await user.click(await screen.findByRole('button', { name: 'Delete timelapse' }));
    // ⚠️ Deliberately stronger than the clip player's wording: a clip's alert and snapshot survive,
    // and a recording could in principle be re-made — a timelapse is the only copy that will ever
    // exist, because its frames are deleted as soon as it is assembled.
    expect(screen.getByText(/It can’t be rebuilt — the frames it was made from are gone\./)).toBeInTheDocument();
    expect(api.del).not.toHaveBeenCalled();

    api.get.mockResolvedValue([ROWS[1]]);
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/timelapses/t-1'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The hero falls back to what is left rather than pointing at a deleted row.
    expect(await screen.findByRole('button', { name: AUG31 })).toBeInTheDocument();
  });

  test('a failed delete keeps the player open with a retry', async () => {
    list(ROWS);
    api.del.mockRejectedValue(new Error('busy'));
    const { user } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await user.click(await screen.findByRole('button', { name: SEP1 }));
    await user.click(await screen.findByRole('button', { name: 'Delete timelapse' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Couldn’t delete — try again.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test('a refresh KEEPS the night you were looking at, if it survived', async () => {
    list(ROWS);
    const { user, container } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await screen.findByRole('button', { name: SEP1 });
    await user.click(container.querySelectorAll('.timelapse-strip__item')[1]); // pick the older night
    expect(screen.getByRole('button', { name: AUG31 })).toBeInTheDocument();

    // Deleting a DIFFERENT row triggers a reload. The selection must not silently jump back to the
    // newest night — the user is looking at a specific one.
    await user.click(screen.getByRole('button', { name: AUG31 }));
    await user.click(await screen.findByRole('button', { name: 'Delete timelapse' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('button', { name: AUG31 })).toBeInTheDocument();
  });
});
