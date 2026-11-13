// SleepSummaryCard and TimelapseCard — the two cards on a child's detail page that were still under
// half covered.
//
// SleepSummaryCard is the one worth care. It renders SEVEN distinct states off one endpoint, and the
// differences between them are the whole point:
//   * `off` (tracking disabled) sends you to SETTINGS, every other state to the sleep detail page;
//   * `no_data` and `empty` look similar and mean opposite things — "we saw nothing" vs "we watched
//     all night and the bed was empty". Conflating them is how this card used to invent a full
//     night's sleep out of an empty bed;
//   * `tonight` vs a completed night changes the label and the duration ("Tonight · so far", "asleep so far");
//   * since the UI refresh (PR C) a scored night shows ONLY the label, the duration, the ring and one headline: the time
//     range, counts, put-down line, "You corrected this" and the estimate disclaimer moved to the sleep page, and the tests
//     below pin their absence (the tests that pinned them on this card were replaced).
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver, renderAs, ADMIN, CAREGIVER } from './helpers/render.jsx';
import { nameStartsWithPrinted, accessibleName } from './helpers/accessibleName.js';
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

  // The card formats with `Intl.DateTimeFormat([])` — an empty locale list, i.e. whatever the runtime
  // default is, which comes from the OS through ICU. **test/setup.js pins that**, for the same reason
  // vite.config.js pins the timezone, and after ten tests here passed locally and failed in CI on
  // nothing but en-AU vs en-US. So exact strings are safe now.
  //
  // `hhmm` stays value-based anyway, and deliberately: what these tests are actually claiming is that
  // the card renders a particular INSTANT in the configured timezone. Asserting the instant says that;
  // asserting "7:10 pm" says it only as long as nobody touches the pin. The \b is what keeps it from
  // being sloppy rather than tolerant — it stops "9:10" matching inside "19:10", which is precisely
  // the pair the timezone test below turns on.
  const hhmm = (h24, min) => {
    const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
    const mm = String(min).padStart(2, '0'); // minutes are always two digits in both forms
    return new RegExp(`\\b${h12}:${mm}\\b|\\b${String(h24).padStart(2, '0')}:${mm}\\b`);
  };
  const soon = () => document.querySelector('.night__soon').textContent;
  // The duration is two elements ("10h 37m" and a smaller "asleep"), so it is matched on the element that holds both.
  const asleep = (text) => screen.findByText((_c, el) => el?.classList?.contains('night__sleep-big') && el.textContent === text);
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

  // ★ UI refresh PR C (2026-11-13, the approved design): a scored night's card holds the label, the duration, the ring and ONE
  // headline, and nothing else. The time range, wake-up count, longest stretch, "In bed ... Asleep ..." line and the estimate
  // disclaimer are on the sleep page now (sleepDetail.test.jsx covers them there), so the tests that pinned them on this card
  // are replaced by the one below, which pins their ABSENCE with every one of those fields present in the fixture.
  test('★ a completed night shows the label and the duration, and none of the detail the sleep page owns', async () => {
    live({ scope: 'last_night', night: { ...OK_NIGHT, in_bed_at: '2026-09-01 08:47:12', corrected: 1 } });
    show();
    expect(await asleep('10h 37m asleep')).toBeInTheDocument();
    // The label no longer carries the date ("Last night · Tue, 1 Sept"): the card is always the latest night.
    expect(head()).toBe('Last night');
    const card = document.querySelector('.night__sleep').textContent;
    // The fixture has an onset (19:10 Melbourne), a wake (6:47), 2 wake-ups, a 5h longest stretch, a put-down and a correction;
    // none of them may reach the card, in either clock form.
    expect(card).not.toMatch(hhmm(19, 10));
    expect(card).not.toMatch(hhmm(6, 47));
    expect(card).not.toMatch(hhmm(18, 47));
    expect(card).not.toMatch(/wake-up|longest|In bed|Asleep |still asleep/);
    expect(document.querySelector('.night__soon')).toBeNull();
    expect(document.querySelector('.night__est')).toBeNull();
    expect(screen.queryByText('You corrected this')).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated from movement/)).not.toBeInTheDocument();
    // No bullet list of observations either.
    expect(document.querySelector('.night__sleep li, .night__sleep ul')).toBeNull();
  });

  test('durations under an hour drop the hours part', async () => {
    live({ scope: 'last_night', night: { ...OK_NIGHT, asleep_minutes: 47 } });
    show();
    expect(await asleep('47m asleep')).toBeInTheDocument();
  });

  test('a night still in progress reads "so far", with no range', async () => {
    live({ scope: 'tonight', night: { ...OK_NIGHT, wake_at: null } });
    show();
    expect(await screen.findByText('Tonight · so far')).toBeInTheDocument();
    expect(await asleep('10h 37m asleep so far')).toBeInTheDocument();
    expect(document.querySelector('.night__sleep').textContent).not.toMatch(/asleep since|awake since/);
  });

  test('"no one in the bed" is NOT the same as "no data"', async () => {
    // ⚠️ THE DISTINCTION THAT MATTERS. `empty` means the cameras watched all night and the bed stayed
    // empty; `no_data` means nothing was recorded. Conflating them is how this card once invented a
    // full night's sleep for an empty bed.
    live({ scope: 'last_night', night: { status: 'empty', night_date: '2026-09-01' } });
    const { unmount } = show();
    expect(await screen.findByText('No one in the bed — nothing to report for this night.')).toBeInTheDocument();
    expect(head()).toBe('Last night · Tue, 1 Sept');
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

  test('a PARENT-flagged empty night says "You said", not the detector-empty wording', async () => {
    // `nobody_in_bed` distinguishes them, deliberately NOT `corrected` (code-review finding, see the
    // next test): the detector-empty wording is a coverage claim ("the cameras watched...", implied by
    // "No one in the bed"), which is honest for a night the DETECTOR scored empty but not for one a
    // parent flagged after the detector said something else entirely. `nobody_in_bed: true` is what a
    // real `asNobodyInBed` overlay carries (sleepReviews.js).
    live({ scope: 'last_night', night: { status: 'empty', corrected: true, nobody_in_bed: true, night_date: '2026-09-01' } });
    show();
    expect(await screen.findByText('You said no one was in the bed.')).toBeInTheDocument();
    expect(screen.queryByText(/nothing to report for this night/)).not.toBeInTheDocument();
  });

  // ★ REGRESSION (code-review finding, 2026-09-29): a plain TIME correction on a night that was already
  // `status: 'empty'` also sets `corrected: true` (sleepReviews.js's OTHER `applyCorrection` branch —
  // not `asNobodyInBed`, the only path that sets `nobody_in_bed`). Keying this copy on `corrected` alone
  // told a parent who had only typed a time that they had said no one was in the bed at all — false.
  test('a TIME correction on an already-empty night is NOT read as "no one was in the bed"', async () => {
    live({ scope: 'last_night', night: { status: 'empty', corrected: true, night_date: '2026-09-01' } });
    show();
    expect(await screen.findByText('No one in the bed — nothing to report for this night.')).toBeInTheDocument();
    expect(screen.queryByText('You said no one was in the bed.')).not.toBeInTheDocument();
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

  // The headline, one line, with the observations list that the server also sends kept OFF the card (it is on the sleep page).
  test('★ the night summary is ONE headline line on the card, never the observations list', async () => {
    const summary = {
      headline: { key: 'typical' },
      observations: [
        { key: 'total_sleep_vs_usual', params: { minutes: 600, usual_minutes: 640, direction: 'less' } },
        { key: 'wake_ups', params: { count: 3 } },
      ],
      seed: 'child-a|2026-03-10',
    };
    live({ scope: 'last_night', night: { ...OK_NIGHT, summary } });
    show();
    await asleep('10h 37m asleep');
    const line = document.querySelector('.night__headline');
    expect(line, 'a headline line').not.toBeNull();
    expect(line.textContent).toBe('Steady, with some waking or stirring.');
    expect(document.querySelectorAll('.night__headline')).toHaveLength(1);
    // Observations read "Asleep for 10h 0m, less than the usual 10h 40m." and "3 wake-ups were counted overnight.": neither may appear on the card.
    expect(document.querySelector('.night__sleep').textContent).not.toMatch(/wake-ups were counted|less than the usual/);
    expect(document.querySelector('.night__sleep li')).toBeNull();
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
      const btn = screen.getByRole('button', { name: 'Sleep tracking is off. Turn on sleep tracking in settings' });
      await user.click(btn);
      expect(await screen.findByText('child settings')).toBeInTheDocument();
    });

    test('every other state — including no data at all — goes to the sleep detail page', async () => {
      // Clickable even with nothing to show, so the date picker there is still reachable.
      live({ scope: 'last_night', night: { status: 'no_data' } });
      const { user } = renderAsAdmin(routes, { settings: { timezone: TZ } });
      await user.click(await screen.findByRole('button', { name: /^Once a camera with motion or sound detection runs overnight\. View sleep detail and history$/ }));
      expect(await screen.findByText('sleep detail')).toBeInTheDocument();
    });

    test('a caregiver gets the same card and the same destination', async () => {
      live({ scope: 'last_night', night: OK_NIGHT });
      const { user } = renderAsCaregiver(routes, { settings: { timezone: TZ } });
      await user.click(await screen.findByRole('button', { name: /^Last night .* asleep\. View sleep detail and history$/ }));
      expect(await screen.findByText('sleep detail')).toBeInTheDocument();
    });
  });

  // ★ Label in name (WCAG 2.5.3) for the states without a score: the name opens with what the card prints, and is short before the
  // destination. Each fails on the old names, which began "View sleep detail and history" (or "Turn on sleep tracking in settings").
  describe('★ the button’s name starts with the text it prints, in every state', () => {
    const button = () => screen.getByRole('button');

    test('loading', async () => {
      vi.spyOn(api, 'get').mockReturnValue(new Promise(() => {}));
      show();
      await screen.findByText('Loading sleep…');
      expect(accessibleName(button())).toBe('Loading sleep. View sleep detail and history');
    });

    test('tracking off', async () => {
      live({ scope: 'off' });
      show();
      await screen.findByText('Sleep tracking is off');
      expect(accessibleName(button())).toBe('Sleep tracking is off. Turn on sleep tracking in settings');
    });

    test('no data, last night: the name is the opening of the printed sentence and short', async () => {
      live({ scope: 'last_night', night: { status: 'no_data' } });
      show();
      await screen.findByText(/^Once a camera with motion or sound detection runs overnight/);
      const name = accessibleName(button());
      const before = name.split('. View sleep detail')[0];
      expect(before.length).toBeLessThan(60);
      expect(document.querySelector('.night__soon').textContent.startsWith(before)).toBe(true);
    });

    test('no data, tonight', async () => {
      live({ scope: 'tonight', night: { status: 'no_data' } });
      show();
      await screen.findByText('Tonight');
      expect(accessibleName(button())).toBe('Tonight. View sleep detail and history');
    });

    test('tonight with a duration says "so far" once', async () => {
      live({ scope: 'tonight', night: { ...OK_NIGHT, wake_at: null } });
      show();
      await asleep('10h 37m asleep so far');
      const name = accessibleName(button());
      expect(name.startsWith('Tonight 10h 37m asleep so far. View sleep detail')).toBe(true);
      expect(name.match(/so far/g)).toHaveLength(1);
    });
  });

  describe('staying current', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    test('re-reads every three minutes so a night in progress stays current without a reload', async () => {
      live({ scope: 'tonight', night: { ...OK_NIGHT, wake_at: null, asleep_minutes: 300 } });
      show();
      expect(await asleep('5h 0m asleep so far')).toBeInTheDocument();
      expect(api.get).toHaveBeenCalledTimes(1);
      api.get.mockResolvedValue({ scope: 'tonight', night: { ...OK_NIGHT, wake_at: null, asleep_minutes: 480 } });
      await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60 * 1000); });
      expect(await asleep('8h 0m asleep so far')).toBeInTheDocument();
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

  // Exact strings, which are safe ONLY because test/setup.js pins the suite's locale.
  // ⚠️ These were regexes first, written to be "locale-tolerant" — and they still failed in CI,
  // because `/Play .*1.*Sep.*/` quietly assumes day-BEFORE-month and en-US renders "Tue, Sep 1".
  // That is why the locale is pinned rather than worked around: a half-tolerant matcher reads as
  // careful while being exactly as machine-specific as the exact string it replaced.
  // The hero's name opens with the text printed on it, duration included (WCAG 2.5.3): "Tue, 1 Sept · 42s".
  const SEP1 = 'Tue, 1 Sept · 42s, play timelapse';
  const AUG31 = 'Mon, 31 Aug, play timelapse';

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
    expect(hero.textContent).toBe('Tue, 1 Sept · 42s');
    // ★ Label in name (WCAG 2.5.3): the name opens with the printed text, duration included. Fails on "Play Tue, 1 Sept timelapse".
    expect(nameStartsWithPrinted(hero)).toBe(true);
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

  // UI refresh PR D: the strip's tiles are small thumbnails labelled by WEEKDAY only; the full date is the accessible name.
  test('★ the strip tiles are labelled by weekday, and the full date is their accessible name', async () => {
    list(ROWS);
    const { container } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await screen.findByRole('button', { name: SEP1 });
    const tiles = [...container.querySelectorAll('.timelapse-strip__item')];
    expect(tiles.map((t) => t.textContent)).toEqual(['Tue', 'Mon']);
    expect(screen.getByRole('button', { name: 'Tue, 1 Sept timelapse' })).toBe(tiles[0]);
    expect(screen.getByRole('button', { name: 'Mon, 31 Aug timelapse' })).toBe(tiles[1]);
    // ★ Label in name (WCAG 2.5.3): what a tile PRINTS is how its name begins. Fails on the old "Show Tue, 1 Sept timelapse".
    for (const tile of tiles) expect(nameStartsWithPrinted(tile)).toBe(true);
    // The thumbnail is decoration: the date is not announced twice.
    expect(tiles[0].querySelector('img')).toHaveAttribute('alt', '');
    expect(tiles[0]).toHaveAttribute('aria-pressed', 'true');
    expect(tiles[1]).toHaveAttribute('aria-pressed', 'false');
  });

  test('an unparseable night date is shown raw rather than as Invalid Date', async () => {
    list([{ id: 't-9', night_date: 'garbage' }]);
    renderAsAdmin(<TimelapseCard childId="kid-1" />);
    expect(await screen.findByRole('button', { name: 'garbage, play timelapse' })).toBeInTheDocument();
  });

  test('an unparseable date in a strip tile leaves the date part out rather than saying "garbage, garbage timelapse"', async () => {
    list([{ id: 't-9', night_date: 'garbage' }, { id: 't-8', night_date: 'rubbish' }]);
    renderAsAdmin(<TimelapseCard childId="kid-1" />);
    expect(await screen.findByRole('button', { name: 'garbage timelapse' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'rubbish timelapse' })).toBeInTheDocument();
  });

  test('the hero opens the player', async () => {
    list(ROWS);
    const { user } = renderAsAdmin(<TimelapseCard childId="kid-1" />);
    await user.click(await screen.findByRole('button', { name: SEP1 }));
    expect(await screen.findByRole('dialog')).toHaveAccessibleName('Timelapse · Tue, 1 Sept');
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
