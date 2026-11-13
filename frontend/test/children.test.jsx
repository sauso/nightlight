// The Children tab and a child's detail screen — the pages actually used every day.
//
// Three things here are worth pinning and none of them are cosmetic:
//   1. ROLE GATING ON THE CAMERA ROWS. A caregiver must not be able to tap through to camera settings.
//      The row renders as a <button> for an admin and a plain <div> otherwise, so the difference is
//      visible to a test exactly as it is to a person.
//   2. ALERTS ARE FILTERED TO THIS CHILD'S CAMERAS, client-side, by camera_id. Get that wrong and one
//      child's page shows the other child's room — which is both a bug and a small privacy failure.
//   3. AN UNKNOWN CHILD RENDERS A PLACEHOLDER, NOT A CRASH. `kids` arrives from a context that is empty
//      on first paint, so every deep link hits this branch for a moment before the data lands.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route, useNavigate, useParams } from 'react-router-dom';
import { renderAs, renderAsAdmin, renderAsCaregiver, forEachRole } from './helpers/render.jsx';
import Children from '../src/pages/Children.jsx';
import ChildDetail from '../src/pages/ChildDetail.jsx';
import { api } from '../src/lib/api.js';

const KIDS = [
  { id: 'kid-1', name: 'Child B', birthday: '2023-03-01', color: '#f4c56a', photo: null },
  { id: 'kid-2', name: 'Child A', birthday: null, color: '#7FBFA3', photo: null },
];

// cam-hall belongs to no child: it must never be counted or listed against either of them.
const CAMS = [
  { id: 'cam-a1', name: 'Child B Room', child_id: 'kid-1', statusLevel: 'live' },
  { id: 'cam-a2', name: 'Child B Cot', child_id: 'kid-1', statusLevel: 'offline' },
  { id: 'cam-b1', name: 'Child A Room', child_id: 'kid-2', statusLevel: 'live' },
  { id: 'cam-hall', name: 'Hallway', child_id: null, statusLevel: 'live' },
];

const alert = (cameraId, i = 0) => ({
  id: `ev-${cameraId}-${i}`,
  camera_id: cameraId,
  camera_name: cameraId,
  type: 'motion',
  created_at: '2026-08-30 09:00:00',
});

// Path-aware so the child cards (sleep summary, morning review, timelapses, recordings) each get
// something harmless while the test drives only the alerts feed. The timelapse and recording lists are empty unless
// a test passes some (the two cards render nothing for an empty list).
function mockApi({ alerts = [], timelapses = [], recordings = [] } = {}) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    if (String(path).includes('/cameras/alerts')) return Promise.resolve(alerts);
    if (String(path).includes('/timelapses/child/')) return Promise.resolve(timelapses);
    if (String(path).includes('/recordings/child/')) return Promise.resolve(recordings);
    return Promise.resolve(null);
  });
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'del').mockResolvedValue({});
}

const detailRoutes = <Routes><Route path="/children/:id" element={<ChildDetail />} /></Routes>;
const atChild = (id = 'kid-1') => ({ route: `/children/${id}`, kids: KIDS, cameras: CAMS });

afterEach(() => vi.restoreAllMocks());

// --- the Children tab ---------------------------------------------------------------------------

describe('the Children tab', () => {
  test('shows one card per child, for either role', async () => {
    await forEachRole(async (_name, who) => {
      const { unmount } = renderAs(who, <Children />, { kids: KIDS, cameras: CAMS });
      expect(screen.getByText('Child B')).toBeTruthy();
      expect(screen.getByText('Child A')).toBeTruthy();
      unmount();
    });
  });

  test('counts only the cameras assigned to that child, and pluralises', () => {
    // The unassigned hallway camera is the point: it exists, and it belongs to neither of them.
    renderAsAdmin(<Children />, { kids: KIDS, cameras: CAMS });
    expect(screen.getByText(/2 cameras/)).toBeTruthy();
    expect(screen.getByText(/1 camera(?!s)/)).toBeTruthy();
  });

  test('an age is shown only when a birthday is known', () => {
    renderAsAdmin(<Children />, { kids: KIDS, cameras: CAMS });
    // Child B has a birthday, so his meta line carries an age after the camera count; Child A's does not.
    expect(screen.getByText(/2 cameras ·/)).toBeTruthy();
    expect(screen.getByText(/^1 camera$/)).toBeTruthy();
  });

  test('with no children it says so instead of rendering an empty page', () => {
    renderAsAdmin(<Children />, { kids: [], cameras: [] });
    expect(screen.getByText('No children yet. Add one to start grouping cameras.')).toBeTruthy();
  });

  test('★ only an admin gets Add child; a caregiver is told an admin can add one (#542)', async () => {
    // Adding a child is admin-only on the server; a button that always ends in a refusal reads as a
    // broken app. Both roles, both with and without children.
    const { user, unmount } = renderAsAdmin(
      <Routes><Route path="/" element={<Children />} /><Route path="/children/new" element={<div>add form</div>} /></Routes>,
      { kids: KIDS, cameras: CAMS }
    );
    await user.click(screen.getByRole('button', { name: 'Add child' }));
    expect(await screen.findByText('add form')).toBeTruthy();
    unmount();

    const carer = renderAsCaregiver(<Children />, { kids: KIDS, cameras: CAMS });
    expect(screen.queryByRole('button', { name: 'Add child' })).toBeNull();
    expect(screen.getByText('Child B')).toBeTruthy();
    carer.unmount();

    renderAsCaregiver(<Children />, { kids: [], cameras: [] });
    expect(screen.getByText('No children yet. An admin can add one.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add child' })).toBeNull();
  });
});

// --- a child's detail screen --------------------------------------------------------------------

describe('a child detail screen', () => {
  beforeEach(() => mockApi());

  test('lists only that child\'s cameras', async () => {
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    expect(await screen.findByText('Child B Room')).toBeTruthy();
    expect(screen.getByText('Child B Cot')).toBeTruthy();
    expect(screen.queryByText('Child A Room')).toBeNull();
    expect(screen.queryByText('Hallway')).toBeNull();
  });

  // The hero card is tinted by the band of the night the sleep card shows (index.css `.night--<band>`).
  const withNight = (score) => vi.spyOn(api, 'get').mockImplementation((path) => {
    if (String(path).includes('/cameras/alerts')) return Promise.resolve([]);
    if (String(path).includes('/sleep/live')) {
      return Promise.resolve({ scope: 'last', night: { status: 'ok', night_date: '2026-09-01', onset_at: '2026-09-01 09:10:00', wake_at: '2026-09-01 20:47:00', asleep_minutes: 637, score } });
    }
    return Promise.resolve(null);
  });
  const SCORE = { score: 82, band: 'good', version: 2, provisional: false, low_confidence: false, low_confidence_reasons: [], capped_by: null, early_estimate: false, components: [] };
  // The duration is two elements (the figure and a smaller "asleep"): matched on the element that holds both.
  const asleepText = (text) => screen.findByText((_c, el) => el?.classList?.contains('night__sleep-big') && el.textContent === text);

  test.each([
    ['great', { ...SCORE, score: 91, band: 'great' }],
    ['good', SCORE],
    ['fair', { ...SCORE, score: 60, band: 'fair' }],
    ['low', { ...SCORE, score: 48, band: null }],
    ['early', { ...SCORE, band: null, early_estimate: true }],
  ])('★ the hero card takes the %s tint class while a score of that band is shown', async (band, score) => {
    withNight(score);
    const { container } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(container.querySelector('.night').classList.contains(`night--${band}`)).toBe(true));
    expect(container.querySelector('.night').className).toBe(`night night--${band}`);
  });

  test('★ switching to another child never leaves the previous child\'s tint on the card while the new sleep request is pending', async () => {
    // The route stays the same and only :id changes, so ChildDetail is NOT remounted: its state outlives the child.
    vi.spyOn(api, 'get').mockImplementation((path) => {
      const p = String(path);
      if (p.includes('/cameras/alerts')) return Promise.resolve([]);
      if (p.includes('/children/kid-1/sleep/live')) {
        return Promise.resolve({ scope: 'last', night: { status: 'ok', night_date: '2026-09-01', onset_at: '2026-09-01 09:10:00', wake_at: '2026-09-01 20:47:00', asleep_minutes: 637, score: SCORE } });
      }
      if (p.includes('/children/kid-2/sleep/live')) return new Promise(() => {}); // never settles: the request is pending
      return Promise.resolve(null);
    });
    function Jump() { const go = useNavigate(); return <button type="button" onClick={() => go('/children/kid-2')}>jump</button>; }
    const { container, user } = renderAsAdmin(
      <Routes><Route path="/children/:id" element={<><Jump /><ChildDetail /></>} /></Routes>, atChild('kid-1'));
    await waitFor(() => expect(container.querySelector('.night').className).toBe('night night--good'));
    await user.click(screen.getByRole('button', { name: 'jump' }));
    await waitFor(() => expect(container.querySelector('.night__name').textContent).toBe('Child A')); // the new child's page is up
    expect(container.querySelector('.night').className).toBe('night');
    expect(screen.queryByText(/asleep/)).toBeNull(); // nor does the card still show the previous child's night
  });

  test('★ no score (or a night with none) leaves the hero card as the plain gradient: no tint class', async () => {
    withNight({ score: null, reason: 'in_progress', version: 2 });
    const { container } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    await asleepText('10h 37m asleep');
    expect(container.querySelector('.night').className).toBe('night');
  });

  test('a child with no cameras is told how to assign one, and a caregiver that an admin assigns them', async () => {
    // Assigning is admin-only since #552: telling a caregiver to "assign one" would send them to a
    // Cameras tab that has no control for it.
    const { unmount } = renderAsAdmin(detailRoutes, { ...atChild('kid-1'), cameras: [] });
    expect(await screen.findByText('No cameras assigned yet — assign one from the Cameras tab.')).toBeTruthy();
    unmount();
    renderAsCaregiver(detailRoutes, { ...atChild('kid-1'), cameras: [] });
    expect(await screen.findByText('No cameras assigned yet — an admin can assign one from the Cameras tab.')).toBeTruthy();
  });

  // ★ The role gate. Camera settings are admin-only, so only an admin's tile carries the gear that goes there
  // (ChildCameraTile gets `onSettings` for an admin and nothing for a caregiver).
  test('an admin can get from a camera tile to its settings', async () => {
    const settings = <Routes><Route path="/children/:id" element={<ChildDetail />} /><Route path="/cameras/:id" element={<div>camera settings page</div>} /></Routes>;
    const { user } = renderAsAdmin(settings, atChild('kid-1'));
    await user.click(await screen.findByRole('button', { name: 'Camera settings for Child B Room' }));
    expect(await screen.findByText('camera settings page')).toBeTruthy();
  });

  test('a caregiver sees the same cameras but has no way into their settings', async () => {
    renderAsCaregiver(detailRoutes, atChild('kid-1'));
    expect(await screen.findByText('Child B Room')).toBeTruthy();
    expect(screen.getByText('Child B Cot')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Camera settings for/ })).toBeNull();
    // Watching live is for everyone.
    expect(screen.getAllByRole('button', { name: 'Watch live' })).toHaveLength(2);
  });

  test('a child that has not loaded yet renders a placeholder rather than crashing', async () => {
    // `kids` is empty on first paint, so every deep link passes through this branch.
    renderAsAdmin(detailRoutes, { ...atChild('nobody'), kids: [], camerasLoaded: false });
    expect(await screen.findByText('Loading…')).toBeTruthy();
  });

  test('an unknown child, once the list HAS loaded, says it cannot be found instead of loading forever (#375)', async () => {
    renderAsAdmin(detailRoutes, { ...atChild('nobody'), kids: KIDS });
    expect(await screen.findByText(/couldn’t find this child/)).toBeTruthy();
    expect(screen.queryByText('Loading…')).toBeNull();
  });

  // ★ UI refresh PR C: the age line is the age, or nothing. "Tap to add birthday & photo" is gone; the photo is the avatar's job
  // (a camera badge) and the birthday lives in child settings, one gear away.
  test('★ a child with no birthday shows no age line and no invitation on the age line', async () => {
    const { container } = renderAsAdmin(detailRoutes, atChild('kid-2'));
    await screen.findByText('Child A Room');
    expect(screen.queryByText(/Tap to add birthday/)).toBeNull();
    expect(container.querySelector('.night__age')).toBeNull();
  });

  test('the settings gear has a name and opens the child\'s settings; the avatar still sets the photo', async () => {
    const edit = <Routes><Route path="/children/:id" element={<ChildDetail />} /><Route path="/children/:id/edit" element={<div>child settings</div>} /></Routes>;
    const { user, unmount } = renderAsAdmin(edit, atChild('kid-1'));
    await user.click(await screen.findByRole('button', { name: 'Settings for Child B' }));
    expect(await screen.findByText('child settings')).toBeTruthy();
    unmount();

    // No photo yet: the avatar button goes to the same settings screen (where the photo is set).
    const second = renderAsAdmin(edit, atChild('kid-1'));
    await second.user.click(await screen.findByRole('button', { name: 'Add a photo for Child B' }));
    expect(await screen.findByText('child settings')).toBeTruthy();
  });

  // The quiet birthday line: ONLY when a night has no score because there is no birthday (the server's own reason key) AND the
  // child has none. Each of the other three cases below must stay silent, so an implementation that always (or never) shows
  // it fails here by name.
  describe('"Add a birthday" appears only where a missing birthday is why there is no score', () => {
    const NO_BIRTHDAY_SCORE = { score: null, reason: 'no_duration_reference', version: 2 };
    const live = (night) => vi.spyOn(api, 'get').mockImplementation((path) => {
      if (String(path).includes('/cameras/alerts')) return Promise.resolve([]);
      if (String(path).includes('/sleep/live')) return Promise.resolve({ scope: 'last', night: { status: 'ok', night_date: '2026-09-01', asleep_minutes: 637, ...night } });
      return Promise.resolve(null);
    });
    const NUDGE = /Add a birthday in settings/;

    test('no birthday and that reason: the line is there, and goes to settings', async () => {
      live({ score: NO_BIRTHDAY_SCORE });
      const edit = <Routes><Route path="/children/:id" element={<ChildDetail />} /><Route path="/children/:id/edit" element={<div>child settings</div>} /></Routes>;
      const { user } = renderAsAdmin(edit, atChild('kid-2'));
      await user.click(await screen.findByRole('button', { name: NUDGE }));
      expect(await screen.findByText('child settings')).toBeTruthy();
    });

    test.each([
      ['a birthday is set (the reason is about something else)', 'kid-1', { score: NO_BIRTHDAY_SCORE }],
      ['the night HAS a score', 'kid-2', { score: SCORE }],
      ['a different reason', 'kid-2', { score: { score: null, reason: 'in_progress', version: 2 } }],
      ['the child\'s score switch is off (no score key at all)', 'kid-2', {}],
    ])('silent when %s', async (_why, kid, night) => {
      live(night);
      renderAsAdmin(detailRoutes, atChild(kid));
      await asleepText('10h 37m asleep');
      expect(screen.queryByText(NUDGE)).toBeNull();
    });
  });

  // ★ The morning question lives IN the night card, once. Before this change it was a separate card below the hero titled
  // "Was last night right?" (outside `.night`), so "inside the card" fails on the old code, and so does "only one".
  describe('the morning question inside the night card', () => {
    const PENDING = { state: 'ask', night_date: '2026-09-01', onset_at: '2026-09-01 09:10:00', wake_at: '2026-09-01 20:47:00' }; // 06:47 Melbourne
    const withReview = (pending) => vi.spyOn(api, 'get').mockImplementation((path) => {
      const p = String(path);
      if (p.includes('/cameras/alerts')) return Promise.resolve([]);
      if (p.includes('/review/pending')) return Promise.resolve(pending);
      if (p.includes('/sleep/live')) {
        return Promise.resolve({ scope: 'last', night: { status: 'ok', night_date: '2026-09-01', asleep_minutes: 637, score: SCORE } });
      }
      return Promise.resolve(null);
    });

    test('★ the question appears exactly once, inside the night card, with its two answers', async () => {
      withReview(PENDING);
      const { container } = renderAsAdmin(detailRoutes, atChild('kid-1'));
      const question = await screen.findByText(/Is that right\?/);
      expect(screen.getAllByText(/Is that right\?/)).toHaveLength(1);
      expect(question.closest('.night'), 'inside the night card').not.toBeNull();
      expect(container.querySelectorAll('.night')).toHaveLength(1);
      for (const name of ['That’s right', 'Not quite']) {
        const button = screen.getByRole('button', { name });
        expect(button.closest('.night'), `${name} is inside the card`).not.toBeNull();
      }
      // The standalone card (its old title, its old class) is gone.
      expect(screen.queryByText('Was last night right?')).toBeNull();
      expect(container.querySelector('.review-card')).toBeNull();
    });

    test('★ "Not quite" opens the review screen at the same route the review has always had', async () => {
      withReview(PENDING);
      const routes = (
        <Routes>
          <Route path="/children/:id" element={<ChildDetail />} />
          <Route path="/children/:id/review/:date" element={<ReviewRouteProbe />} />
        </Routes>
      );
      function ReviewRouteProbe() { const { id, date } = useParams(); return <div>review of {id} on {date}</div>; }
      const { user } = renderAsAdmin(routes, atChild('kid-1'));
      await user.click(await screen.findByRole('button', { name: 'Not quite' }));
      expect(await screen.findByText('review of kid-1 on 2026-09-01')).toBeTruthy();
    });

    test('no question while there is nothing to review', async () => {
      withReview({ state: 'none' });
      renderAsAdmin(detailRoutes, atChild('kid-1'));
      await asleepText('10h 37m asleep');
      expect(screen.queryByText(/Is that right\?/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Not quite' })).toBeNull();
    });

    test('the card\'s controls are real buttons with accessible names (their 44px size is a stylesheet rule, checked on the screenshots)', async () => {
      withReview(PENDING);
      renderAsAdmin(detailRoutes, atChild('kid-1'));
      await screen.findByText(/Is that right\?/);
      // The names a screen reader reads: the chevron link carries the score and band, the gear and the dismiss have names.
      expect(screen.getByRole('button', { name: /^View sleep detail and history.*Sleep score 82, Good$/ })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Settings for Child B' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
    });
  });

  test('a child WITH a birthday shows an age instead of the invitation', async () => {
    // Both halves are needed. Asserting only the prompt lets an implementation that ALWAYS prompts
    // pass, which is precisely what a mutant doing that proved.
    // Anchored on the camera name, which appears once — "Child B" itself is in both the page header and
    // the hero, so querying for it is ambiguous.
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    expect(await screen.findByText('Child B Room')).toBeTruthy();
    expect(screen.queryByText(/Tap to add birthday & photo/)).toBeNull();
  });
});

// --- the alerts feed ------------------------------------------------------------------------------

describe('the alerts feed on a child screen', () => {
  // ⚠️ These assert a POSITIVE count, never "the empty message is showing". The empty message is on
  // screen from the very first paint, before the fetch resolves — so `findByText(/No alerts/)` passes
  // instantly whatever the filter does, and removing the filter entirely still left it green. Counting
  // the rows that actually rendered is what discriminates.
  test('shows only alerts from this child\'s cameras', async () => {
    // Three alerts arrive: this child's, the sibling's, and an unassigned camera's. Exactly one is his.
    mockApi({ alerts: [alert('cam-a1'), alert('cam-b1'), alert('cam-hall')] });
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(screen.getAllByText('Motion').length).toBe(1));
  });

  test('a child with no alerts of his own shows the empty state once the feed has loaded', async () => {
    mockApi({ alerts: [alert('cam-b1'), alert('cam-hall')] });
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    // Wait for the request to have been made AND its state update to flush, so this is a statement
    // about the settled screen rather than about the first frame.
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cameras/alerts'));
    await waitFor(() => expect(screen.queryByText('Motion')).toBeNull());
    expect(screen.getByText(/No alerts for Child B yet/)).toBeTruthy();
  });

  test('the feed is capped at 20 however many arrive (and the page shows the newest three until "See all alerts")', async () => {
    mockApi({ alerts: Array.from({ length: 25 }, (_, i) => alert('cam-a1', i)) });
    const { user } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(screen.getAllByText('Motion').length).toBeGreaterThan(0));
    expect(screen.getAllByText('Motion').length).toBe(3);
    await user.click(screen.getByRole('button', { name: 'See all alerts' }));
    expect(screen.getAllByText('Motion').length).toBe(20);
  });

  // ★ The cap and the filter must be crossed in ONE fixture, or their ORDER is untested. The two
  // tests above are disjoint — three alerts (never reaching the cap) and twenty-five all belonging to
  // this child (nothing to filter) — so swapping `.filter().slice(20)` to `.slice(20).filter()` left
  // the whole suite green.
  //
  // That order matters a great deal in practice: /cameras/alerts returns the newest 200 house-wide,
  // both children. Trim first and a restless sibling filling the newest twenty makes this child's page
  // read "No alerts yet" while he has alerts — the exact inverse of the bug this file exists to stop.
  test('a busy sibling cannot push this child out of his own feed', async () => {
    mockApi({
      alerts: [
        ...Array.from({ length: 25 }, (_, i) => alert('cam-b1', i)), // the sibling's night, newest
        alert('cam-a1', 100),
        alert('cam-a1', 101),
      ],
    });
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(screen.getAllByText('Motion').length).toBe(2));
    expect(screen.queryByText(/No alerts for Child B yet/)).toBeNull();
  });

  test('a response that is not a list leaves the page usable', async () => {
    // The server has changed a response shape out from under a running client before, and a page that
    // throws here is a blank screen for someone who cannot reload the app.
    //
    // ⚠️ This does NOT isolate the `Array.isArray` guard. Removing it makes `.filter` throw, which the
    // surrounding try/catch swallows, leaving the feed empty either way — so the two are observably
    // identical here and a mutant dropping the guard survives. Saying so rather than implying a
    // coverage this cannot give.
    mockApi({ alerts: { unexpected: 'shape' } });
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    expect(await screen.findByText('Child B Room')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Motion')).toBeNull());
  });

  test('a failed alerts request leaves the rest of the page intact', async () => {
    // ⚠️ 'Child B Room' is on screen at first paint, so asserting only that would pass whether or not
    // the rejection was ever handled. Wait for the request to have been made AND rejected first, so
    // this is a statement about the settled screen.
    vi.spyOn(api, 'get').mockImplementation((path) =>
      String(path).includes('/cameras/alerts') ? Promise.reject(new Error('offline')) : Promise.resolve(null));
    renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cameras/alerts'));
    // The failure is named, with Retry - NOT worded as a quiet week (#375).
    expect(await screen.findByText('offline')).toBeTruthy();
    expect(screen.queryByText(/No alerts for Child B yet/)).toBeNull();
    // The cameras card still renders — a dead feed must not take the screen down with it.
    expect(screen.getByText('Child B Room')).toBeTruthy();
  });
});

// --- everything below the night card (UI refresh PR D) ------------------------------------------

describe('the child page below the night card', () => {
  const TIMELAPSES = [
    { id: 't-1', night_date: '2026-09-01', duration_s: 42 },
    { id: 't-2', night_date: '2026-08-31', duration_s: 40 },
  ];
  const RECORDINGS = [{ id: 'r-1', status: 'ready', camera_name: 'Child B Room', started_at: '2026-09-02 10:00:00', duration_s: 30 }];
  const FIVE_ALERTS = [1, 2, 3, 4, 5].map((i) => ({ ...alert('cam-a1', i), created_at: `2026-09-0${i} 10:00:00` }));
  const full = () => mockApi({ alerts: FIVE_ALERTS, timelapses: TIMELAPSES, recordings: RECORDINGS });
  // True when `a` comes before `b` in the document: the DOM order IS the phone layout and the keyboard order (the two-column
  // desktop layout is CSS grid placement only, never a reorder).
  const before = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  beforeEach(() => vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`));

  test('★ the sections come in the designed order: night card, camera, timelapse, recent alerts, recordings', async () => {
    full();
    const { container } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    const q = (s) => container.querySelector(s);
    await waitFor(() => expect(q('.recordings-card')).not.toBeNull());
    await waitFor(() => expect(q('.alert-item')).not.toBeNull());
    await waitFor(() => expect(q('.timelapse-card')).not.toBeNull());
    const order = [q('.night'), q('.child-cam'), q('.timelapse-card'), q('.alert-list'), q('.recordings-card')];
    for (let i = 0; i < order.length - 1; i += 1) expect(before(order[i], order[i + 1]), `section ${i} should precede section ${i + 1}`).toBe(true);
  });

  test('★ the old "Cameras · n" heading and the "<child> camera" suffix are gone; the tile carries the status and "Watch live"', async () => {
    full();
    const { container } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    await screen.findByText('Child B Room');
    expect(screen.queryByText(/^Cameras ·/)).toBeNull();
    expect(container.querySelector('.cam-row')).toBeNull();
    // Both of the child's cameras get a tile (one tile each); the offline one says so in words.
    expect(container.querySelectorAll('.child-cam')).toHaveLength(2);
    expect(screen.getByText(/· Offline/)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Watch live' })).toHaveLength(2);
  });

  // ★ ChildDetail is NOT remounted when only :id changes, and the alerts, recordings and timelapse cards keep local state (the
  // expanded "See all alerts", the open Recordings row, the picked night). Keyed by child, that state starts over for the next child.
  test('★ switching child resets "See all alerts" and the Recordings row', async () => {
    const five = (cam) => [1, 2, 3, 4, 5].map((i) => ({ ...alert(cam, i), created_at: `2026-09-0${i} 10:00:00` }));
    mockApi({ alerts: [...five('cam-a1'), ...five('cam-b1')], recordings: RECORDINGS });
    function Jump() { const go = useNavigate(); return <button type="button" onClick={() => go('/children/kid-2')}>jump</button>; }
    const { container, user } = renderAsAdmin(
      <Routes><Route path="/children/:id" element={<><Jump /><ChildDetail /></>} /></Routes>, atChild('kid-1'));
    await waitFor(() => expect(container.querySelectorAll('.alert-item')).toHaveLength(3));
    await user.click(screen.getByRole('button', { name: 'See all alerts' }));
    await user.click(await screen.findByRole('button', { name: /^Recordings/ }));
    expect(container.querySelectorAll('.alert-item')).toHaveLength(5);
    expect(container.querySelector('.rec-strip')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'jump' }));
    await waitFor(() => expect(container.querySelector('.night__name').textContent).toBe('Child A'));
    await waitFor(() => expect(container.querySelectorAll('.alert-item')).toHaveLength(3));
    expect(screen.getByRole('button', { name: 'See all alerts' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: /^Recordings/ })).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.rec-strip')).toBeNull();
  });

  test('★ a disabled camera has no "Watch live" (the Live tab hides it); the others still do', async () => {
    mockApi();
    const cams = CAMS.map((c) => (c.id === 'cam-a2' ? { ...c, disabled: 1 } : c));
    renderAsAdmin(detailRoutes, { ...atChild('kid-1'), cameras: cams });
    await screen.findByText('Child B Cot');
    expect(screen.getAllByRole('button', { name: 'Watch live' })).toHaveLength(1);
    expect(screen.getByText(/· Disabled/)).toBeTruthy();
  });

  test('★ "Watch live" goes to the Live tab', async () => {
    full();
    const routes = <Routes><Route path="/children/:id" element={<ChildDetail />} /><Route path="/" element={<div>the live tab</div>} /></Routes>;
    const { user } = renderAsAdmin(routes, atChild('kid-1'));
    await user.click((await screen.findAllByRole('button', { name: 'Watch live' }))[0]);
    expect(await screen.findByText('the live tab')).toBeTruthy();
  });

  test('★ recent alerts: three rows, a "See all alerts" row, and the rest on request', async () => {
    full();
    const { container, user } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(container.querySelectorAll('.alert-item')).toHaveLength(3));
    expect(screen.getByText('Recent alerts')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'See all alerts' }));
    expect(container.querySelectorAll('.alert-item')).toHaveLength(5);
  });

  test('★ the timelapse has one player and a strip of recent nights as small thumbnails labelled by weekday', async () => {
    full();
    const { container } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(container.querySelectorAll('.timelapse-strip__item')).toHaveLength(2));
    const labels = [...container.querySelectorAll('.timelapse-strip__item')].map((el) => el.textContent);
    expect(labels).toEqual(['Tue', 'Mon']); // 2026-09-01 is a Tuesday, 2026-08-31 a Monday
    expect(container.querySelectorAll('.timelapse-hero')).toHaveLength(1);
  });

  test('★ recordings are one row with the newest time, and the thumbnails open from it', async () => {
    full();
    const { container, user } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    const row = await screen.findByRole('button', { name: /^Recordings/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.rec-strip')).toBeNull();
    await user.click(row);
    expect(container.querySelectorAll('.rec-strip__item')).toHaveLength(1);
  });

  // The quiet empty states: each section that has nothing leaves no placeholder behind, and the ones that explain say so.
  test('★ with nothing to show: no timelapse card, no recordings row, and the alerts card says there are none', async () => {
    mockApi();
    const { container } = renderAsAdmin(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/recordings/child/kid-1'));
    await screen.findByText(/No alerts for Child B yet/);
    expect(container.querySelector('.timelapse-card')).toBeNull();
    expect(container.querySelector('.recordings-card')).toBeNull();
    expect(screen.queryByRole('button', { name: 'See all alerts' })).toBeNull();
    // The alerts card keeps its title even when empty.
    expect(screen.getByText('Recent alerts')).toBeTruthy();
  });

  test('a child with no camera gets no tile, only the explanation', async () => {
    mockApi();
    const { container } = renderAsAdmin(detailRoutes, { ...atChild('kid-1'), cameras: [] });
    await screen.findByText('No cameras assigned yet — assign one from the Cameras tab.');
    expect(container.querySelector('.child-cam')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Watch live' })).toBeNull();
  });

  test('★ a caregiver sees every section an admin sees, and none of the admin-only controls', async () => {
    full();
    const { container } = renderAsCaregiver(detailRoutes, atChild('kid-1'));
    await waitFor(() => expect(container.querySelector('.timelapse-card')).not.toBeNull());
    await waitFor(() => expect(container.querySelector('.recordings-card')).not.toBeNull());
    expect(container.querySelectorAll('.child-cam')).toHaveLength(2);
    expect(container.querySelectorAll('.alert-item')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /Camera settings for/ })).toBeNull();
  });
});
