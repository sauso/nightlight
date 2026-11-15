// The small shared components — AppHeader, BackLink, ChildCameraTile, AlertList (whose clip
// delete is admin-only since #538) — and the
// route table in App.jsx.
//
// These are small enough to look not worth testing, which is exactly why several of them were the
// last things in the front end under 80%. What they carry is not small:
//   1. BackLink DECIDES WHERE "BACK" GOES. A page reachable from two places (a camera opened from a
//      child, or from the Cameras tab) must return to where you actually came from. It reads
//      `location.state.from` and falls back to the page's default parent — get it wrong and the back
//      button silently teleports people.
//   2. (DetectionRow's keyboard test lived here until #1076 replaced it with NavRow, a real <button>: navRow.test.jsx.)
//   3. AlertList's row time is the CLOCK TIME in HOME time, with the day only when it is not today (the HOME zone's today).
//   4. App.jsx's route table is the ONLY place role gating is applied to whole screens — and it is
//      where the shipped 403-for-everyone bug would have been visible.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderAs, renderAsAdmin, renderAsCaregiver, ADMIN, CAREGIVER } from './helpers/render.jsx';
import AppHeader from '../src/components/AppHeader.jsx';
import BackLink from '../src/components/BackLink.jsx';
import ChildCameraTile from '../src/components/ChildCameraTile.jsx';
import AlertList from '../src/components/AlertList.jsx';
import { Protected, AdminProtected } from '../src/App.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

// --- AppHeader + BackLink -----------------------------------------------------------------------

describe('AppHeader', () => {
  const at = (route, ui) => render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);

  test('a top-level page shows the logo, which goes to Live', async () => {
    const user = userEvent.setup();
    at('/children', (
      <Routes>
        <Route path="/children" element={<AppHeader title="Children" />} />
        <Route path="/" element={<div>live</div>} />
      </Routes>
    ));
    expect(screen.getByRole('heading', { name: 'Children' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to (dark|light) mode/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Go to Live' }));
    expect(await screen.findByText('live')).toBeInTheDocument();
  });

  test('a sub-page shows a labelled back affordance INSTEAD of the logo', () => {
    at('/settings/logs', <AppHeader title="Logs" back={{ to: '/settings', label: 'Settings' }} />);
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to Live' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to (dark|light) mode/ })).not.toBeInTheDocument();
  });

  test('Live can opt into the theme toggle', () => {
    at('/', <AppHeader title="Live" showThemeToggle />);
    expect(screen.getByRole('button', { name: /Switch to (dark|light) mode/ })).toBeInTheDocument();
  });

  test('keeps a long back label in the accessible name and title', () => {
    const label = 'Camera settings';
    at('/settings/camera', <AppHeader title="Camera controls" back={{ to: '/settings', label }} showDemoBanner={false} />);
    const back = screen.getByRole('button', { name: `Back to ${label}` });
    expect(back).toHaveAttribute('aria-label', `Back to ${label}`);
    expect(back).toHaveAttribute('title', label);
  });
});

describe('BackLink', () => {
  // A page that can be reached from two places, so the back target is a real decision.
  const Nav = ({ to, from }) => {
    const navigate = useNavigate();
    return <button onClick={() => navigate(to, from ? { state: { from } } : undefined)}>go</button>;
  };
  const app = (start) => render(
    <MemoryRouter initialEntries={[start]}>
      <Routes>
        <Route path="/children/kid-1" element={<><div>child page</div><Nav to="/cameras/cam-a" from={{ to: '/children/kid-1', label: 'Child B' }} /></>} />
        <Route path="/cameras" element={<><div>cameras tab</div><Nav to="/cameras/cam-a" /></>} />
        <Route path="/cameras/cam-a" element={<BackLink fallback={{ to: '/cameras', label: 'Cameras' }} />} />
      </Routes>
    </MemoryRouter>
  );

  test('returns to where you actually came from when an origin was supplied', async () => {
    const user = userEvent.setup();
    app('/children/kid-1');
    await user.click(screen.getByRole('button', { name: 'go' }));
    // ⚠️ The label is the tell: "‹ Child B", not "‹ Cameras". A back button that reads the right word
    // but navigates to the fallback would pass a label-only assertion, so click it too.
    await user.click(screen.getByRole('button', { name: 'Back to Child B' }));
    expect(await screen.findByText('child page')).toBeInTheDocument();
  });

  test('falls back to the page default on a direct link or refresh, where there is no origin', async () => {
    const user = userEvent.setup();
    app('/cameras');
    await user.click(screen.getByRole('button', { name: 'go' }));
    await user.click(screen.getByRole('button', { name: 'Back to Cameras' }));
    expect(await screen.findByText('cameras tab')).toBeInTheDocument();
  });

  test('renders nothing at all when there is neither an origin nor a fallback', () => {
    const { container } = render(<MemoryRouter><BackLink /></MemoryRouter>);
    expect(container).toBeEmptyDOMElement();
  });
});

// --- ChildCameraTile ----------------------------------------------------------------------------

describe('ChildCameraTile', () => {
  const CAM = { id: 'cam-a', name: 'Child B Room', statusLevel: 'live' };

  // ★ Status is never only a colour: the dot is a mark, the words are the signal.
  test('online, offline and disabled are three distinct states, each said in words except the normal one', () => {
    const a = render(<ChildCameraTile cam={CAM} />);
    expect(a.container.querySelector('.child-cam')).toHaveClass('child-cam--online');
    expect(screen.queryByText(/Offline|Disabled/)).not.toBeInTheDocument();
    // The normal case adds no visible word, but a screen reader still hears it.
    expect(a.container.querySelector('.child-cam__sr').textContent).toMatch(/online/);
    a.unmount();

    const b = render(<ChildCameraTile cam={{ ...CAM, statusLevel: 'offline' }} />);
    expect(b.container.querySelector('.child-cam')).toHaveClass('child-cam--offline');
    expect(screen.getByText(/· Offline/)).toBeInTheDocument();
    b.unmount();

    // ⚠️ Disabled beats live: a camera someone switched off is not "online" just because its last known status was.
    const c = render(<ChildCameraTile cam={{ ...CAM, statusLevel: 'live', disabled: 1 }} />);
    expect(c.container.querySelector('.child-cam')).toHaveClass('child-cam--disabled');
    expect(screen.getByText(/· Disabled/)).toBeInTheDocument();
    expect(c.container.querySelector('.child-cam__sr')).toBeNull();
  });

  // The Live tab hides disabled cameras (LiveMonitor filters them out), so "Watch live" there would open a page without this camera.
  test('★ a disabled camera is not offered "Watch live"; an online and an offline one are', () => {
    const a = render(<ChildCameraTile cam={{ ...CAM, disabled: 1 }} onWatch={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Watch live' })).not.toBeInTheDocument();
    a.unmount();
    const b = render(<ChildCameraTile cam={{ ...CAM, statusLevel: 'offline' }} onWatch={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Watch live' })).toBeInTheDocument();
    b.unmount();
    render(<ChildCameraTile cam={CAM} onWatch={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Watch live' })).toBeInTheDocument();
  });

  // The detection line (owner, 2026-11-13: the badges came back as words). Same two fields the old MOTION/SOUND badges read.
  describe('the detection line', () => {
    const line = (container) => container.querySelector('.child-cam__detect')?.textContent;

    test.each([
      [1, 1, 'Motion on · Sound on'],
      [1, 0, 'Motion on · Sound off'],
      [0, 1, 'Motion off · Sound on'],
      [0, 0, 'Motion off · Sound off'],
    ])('★ motion %s, sound %s reads "%s" (words, never colour alone)', (m, s, text) => {
      const { container } = render(<ChildCameraTile cam={{ ...CAM, detect_motion_enabled: m, detect_sound_enabled: s }} />);
      expect(line(container)).toBe(text);
    });

    test('a disabled camera says nothing about detection (nothing runs on it; the chip says Disabled)', () => {
      const { container } = render(<ChildCameraTile cam={{ ...CAM, disabled: 1, detect_motion_enabled: 1, detect_sound_enabled: 1 }} />);
      expect(line(container)).toBeUndefined();
    });

    test('a camera carrying neither field (an unknown state, not "off") shows no line', () => {
      const { container } = render(<ChildCameraTile cam={CAM} />);
      expect(line(container)).toBeUndefined();
    });

    test('an offline camera still shows what it is set to', () => {
      const { container } = render(<ChildCameraTile cam={{ ...CAM, statusLevel: 'offline', detect_motion_enabled: 1, detect_sound_enabled: 0 }} />);
      expect(line(container)).toBe('Motion on · Sound off');
    });
  });

  test('"Watch live" does what it is given, and the camera name is on the tile', async () => {
    const user = userEvent.setup();
    const onWatch = vi.fn();
    render(<ChildCameraTile cam={CAM} onWatch={onWatch} />);
    expect(screen.getByText('Child B Room')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Watch live' }));
    expect(onWatch).toHaveBeenCalledTimes(1);
  });

  // ⚠️ The camera-settings gear exists only when the caller passes onSettings (ChildDetail does so for an admin). A control a
  // caregiver can see but that can only end in a redirect is worse than none.
  test('the settings gear is there only when a handler is given', async () => {
    const user = userEvent.setup();
    const a = render(<ChildCameraTile cam={CAM} onWatch={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /settings/i })).not.toBeInTheDocument();
    a.unmount();

    const onSettings = vi.fn();
    render(<ChildCameraTile cam={CAM} onWatch={vi.fn()} onSettings={onSettings} />);
    await user.click(screen.getByRole('button', { name: 'Camera settings for Child B Room' }));
    expect(onSettings).toHaveBeenCalledTimes(1);
  });
});

// --- AlertList ----------------------------------------------------------------------------------

describe('AlertList', () => {
  const base = (over = {}) => ({
    id: 'ev-1',
    camera_name: 'Child B Room',
    type: 'motion',
    created_at: new Date(Date.now() - 5 * 60000).toISOString().slice(0, 19).replace('T', ' '),
    ...over,
  });

  test('renders nothing when there is nothing to show', () => {
    const a = render(<AlertList alerts={[]} />);
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    const b = render(<AlertList alerts={undefined} />);
    expect(b.container).toBeEmptyDOMElement();
  });

  test('labels motion and sound, and falls back to the raw type for anything else', () => {
    render(<AlertList alerts={[base(), base({ id: 'ev-2', type: 'sound' }), base({ id: 'ev-3', type: 'doorbell' })]} />);
    expect(screen.getByText(/^Motion/)).toBeInTheDocument();
    expect(screen.getByText(/^Sound/)).toBeInTheDocument();
    expect(screen.getByText(/^doorbell/)).toBeInTheDocument();
  });

  test('appends the detail when the alert has one', () => {
    render(<AlertList alerts={[base({ detail: '+12 dB over ambient' })]} />);
    expect(screen.getByText(/\+12 dB over ambient/)).toBeInTheDocument();
  });

  // Clock times (UI refresh PR D): the row says WHEN in the home timezone, not "3h ago". One instant is used throughout,
  // 2026-08-31 02:00 UTC = 2:00 pm on 31 Aug in Auckland (the suite's device zone) = 7:00 pm on 30 Aug in Los Angeles.
  describe('the clock time on a row', () => {
    const AT = base({ id: 'x', created_at: '2026-08-31 02:00:00' });
    const NOW_SAME_DAY = '2026-08-31T03:00:00Z'; // 3:00 pm on 31 Aug in Auckland
    const NOW_NEXT_DAY = '2026-09-01T03:00:00Z'; // 3:00 pm on 1 Sept in Auckland
    const at = (now, tz) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      return renderAsAdmin(<AlertList alerts={[AT]} />, { settings: { timezone: tz } });
    };
    afterEach(() => vi.useRealTimers());

    test('★ an alert from today shows the clock time alone, in HOME time', () => {
      at(NOW_SAME_DAY, 'Pacific/Auckland');
      expect(document.querySelector('time').textContent).toBe('2:00 pm');
    });

    test('★ an alert from an earlier day carries the day, so three alerts across quiet days are not ambiguous', () => {
      at(NOW_NEXT_DAY, 'Pacific/Auckland');
      expect(document.querySelector('time').textContent).toBe('Mon, 31 Aug, 2:00 pm');
    });

    test('★ "today" is the HOME zone\'s today, not the device\'s', () => {
      // The clock is 10:00 UTC on 31 Aug: 10 pm on 31 Aug in Auckland (the device), so the alert (2 pm that day) is from today
      // there; but 3 am on 31 Aug in Los Angeles, where the alert (7 pm on 30 Aug) is from YESTERDAY. With home = Los Angeles
      // the row must carry the day; a "today" worked out in the device's zone would drop it.
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-08-31T10:00:00Z'));
      const la = renderAsAdmin(<AlertList alerts={[AT]} />, { settings: { timezone: 'America/Los_Angeles' } });
      expect(document.querySelector('time').textContent).toBe('Sun, 30 Aug, 7:00 pm GMT-7');
      la.unmount();
      renderAsAdmin(<AlertList alerts={[AT]} />, { settings: { timezone: 'Pacific/Auckland' } });
      expect(document.querySelector('time').textContent).toBe('2:00 pm');
    });

    test('no relative wording is left on the row', () => {
      at(NOW_SAME_DAY, 'Pacific/Auckland');
      expect(screen.queryByText(/ago|just now/)).not.toBeInTheDocument();
    });
  });

  test('★ a row WITH a clip is one button that carries the kind and the time; a row without one is not a button and has no chevron', () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    const { container } = render(
      <AlertList alerts={[base({ id: 'c', snapshot: 1, clip_status: 'ready' }), base({ id: 'n', type: 'sound' })]} />
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveClass('alert-item--btn');
    expect(buttons[0].textContent).toContain('Motion'); // the whole row, not just the thumbnail
    expect(buttons[0].querySelector('time')).not.toBeNull();
    const rows = container.querySelectorAll('.alert-item');
    expect(rows[0].querySelector('.alert-item__chev')).not.toBeNull();
    expect(rows[1].querySelector('.alert-item__chev')).toBeNull();
  });

  test('★ each clip row opens ITS OWN clip, not the first or the last', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    const user = userEvent.setup();
    render(
      <AlertList
        alerts={[
          base({ id: 'ev-a', camera_name: 'Room A', snapshot: 1, clip_status: 'ready' }),
          base({ id: 'ev-b', camera_name: 'Room B', snapshot: 1, clip_status: 'ready' }),
        ]}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Play clip from Room B' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('video').getAttribute('src')).toBe('http://host/cameras/alerts/ev-b/clip');
  });

  // A null or garbage created_at used to reach toISOString(), a RangeError that blanks the whole child page. The row is drawn
  // without a time; the rest of the row (kind, detail) still shows.
  test.each([['null', null], ['garbage', 'not a date']])('★ a %s timestamp draws the row without a time instead of throwing', (_n, created_at) => {
    const { container } = render(<AlertList alerts={[base({ id: 'bad', created_at, detail: 'loud' }), base({ id: 'ok' })]} />);
    const rows = container.querySelectorAll('.alert-item');
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('time')).toBeNull();
    expect(rows[0].textContent).toContain('Motion');
    expect(rows[0].querySelector('.alert-item__meta').textContent).toBe('loud'); // no stray leading "·"
    expect(rows[1].querySelector('time')).not.toBeNull();
  });

  describe('"See all alerts"', () => {
    const FIVE = [1, 2, 3, 4, 5].map((i) => base({ id: `e${i}`, created_at: `2026-09-0${i} 10:00:00` }));
    const rows = (container) => container.querySelectorAll('.alert-item').length;

    test('★ with a preview count, only that many rows show and "See all alerts" reveals the rest in place', async () => {
      const user = userEvent.setup();
      const { container } = render(<AlertList alerts={FIVE} previewCount={3} />);
      expect(rows(container)).toBe(3);
      const more = screen.getByRole('button', { name: 'See all alerts' });
      expect(more).toHaveAttribute('aria-expanded', 'false');
      await user.click(more);
      expect(rows(container)).toBe(5);
      expect(screen.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
      await user.click(screen.getByRole('button', { name: 'Show fewer' }));
      expect(rows(container)).toBe(3);
    });

    test('★ it is offered only when there is more to see: three alerts or fewer have no such row', () => {
      render(<AlertList alerts={FIVE.slice(0, 3)} previewCount={3} />);
      expect(screen.queryByRole('button', { name: /See all alerts|Show fewer/ })).not.toBeInTheDocument();
    });

    test('without a preview count every alert shows and there is no such row', () => {
      const { container } = render(<AlertList alerts={FIVE} />);
      expect(rows(container)).toBe(5);
      expect(screen.queryByRole('button', { name: 'See all alerts' })).not.toBeInTheDocument();
    });
  });

  test('a snapshot becomes a play button only when the clip is READY', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    const { unmount } = render(<AlertList alerts={[base({ snapshot: 1, clip_status: 'ready' })]} />);
    expect(screen.getByRole('button', { name: 'Play clip from Child B Room' })).toBeInTheDocument();
    unmount();

    // Pending shows a REC badge but is NOT playable — there is no file yet.
    render(<AlertList alerts={[base({ snapshot: 1, clip_status: 'pending' })]} />);
    expect(screen.queryByRole('button', { name: /Play clip/ })).not.toBeInTheDocument();
    expect(screen.getByText('REC')).toBeInTheDocument();
  });

  test('an alert with no snapshot still renders, with an icon in place of the thumbnail', () => {
    const { container } = render(<AlertList alerts={[base()]} />);
    expect(container.querySelector('.alert-item__thumb--empty')).not.toBeNull();
    expect(container.querySelector('img.alert-item__thumb')).toBeNull();
  });

  test('opening a clip mounts the player and closing it takes it away', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    const user = userEvent.setup();
    render(<AlertList alerts={[base({ snapshot: 1, clip_status: 'ready' })]} title="Recent activity" />);
    expect(screen.getByText('Recent activity')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Play clip from Child B Room' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the delete action is offered only when the caller can handle the change', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    const alerts = [base({ snapshot: 1, clip_status: 'ready' })];
    const first = renderAsAdmin(<AlertList alerts={alerts} />);
    await first.user.click(screen.getByRole('button', { name: /Play clip/ }));
    // Without `onChanged` the list has no way to refresh itself, so offering a delete would leave a
    // row on screen pointing at a clip that no longer exists — even for an admin.
    expect(screen.queryByRole('button', { name: 'Delete clip' })).not.toBeInTheDocument();
    first.unmount();

    const second = renderAsAdmin(<AlertList alerts={alerts} onChanged={vi.fn()} />);
    await second.user.click(screen.getByRole('button', { name: /Play clip/ }));
    expect(await screen.findByRole('button', { name: 'Delete clip' })).toBeInTheDocument();
  });

  test('★ a caregiver can play a clip but is never offered the delete (#538)', async () => {
    // Deleting a clip is admin-only on the server. Even with `onChanged`, a caregiver's player must not
    // carry a button that can only end in a refusal. Rendered with NO auth provider as well: that is
    // nobody signed in, so nobody is an admin.
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    const alerts = [base({ snapshot: 1, clip_status: 'ready' })];
    const carer = renderAsCaregiver(<AlertList alerts={alerts} onChanged={vi.fn()} />);
    await carer.user.click(screen.getByRole('button', { name: /Play clip/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete clip' })).not.toBeInTheDocument();
    carer.unmount();

    const user = userEvent.setup();
    render(<AlertList alerts={alerts} onChanged={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Play clip/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete clip' })).not.toBeInTheDocument();
  });

  test('the timestamp carries a machine-readable dateTime, not just prose', () => {
    const { container } = render(<AlertList alerts={[base()]} />);
    const t = container.querySelector('time');
    expect(t.getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(t.getAttribute('title')).toBeTruthy(); // the exact time on hover
  });
});

// --- App.jsx route guards -----------------------------------------------------------------------

describe('Protected / AdminProtected', () => {
  const guarded = (Guard) => (
    <Routes>
      <Route path="/" element={<Guard><div>secret</div></Guard>} />
      <Route path="/login" element={<div>login screen</div>} />
    </Routes>
  );

  test('neither renders anything while auth is still resolving', () => {
    // ⚠️ Returning null rather than redirecting is the whole point: AuthContext resolves
    // asynchronously, so every page refresh passes through this state. Redirecting here would bounce
    // a signed-in user to the login screen on every reload.
    for (const Guard of [Protected, AdminProtected]) {
      const { container, unmount } = renderAs(null, guarded(Guard), { loading: true });
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  test('a signed-out visitor is sent to login by both', async () => {
    for (const Guard of [Protected, AdminProtected]) {
      const { unmount } = renderAs(null, guarded(Guard));
      expect(await screen.findByText('login screen')).toBeInTheDocument();
      unmount();
    }
  });

  test('Protected lets either role through', async () => {
    for (const who of [ADMIN, CAREGIVER]) {
      const { unmount } = renderAs(who, guarded(Protected));
      expect(screen.getByText('secret')).toBeInTheDocument();
      unmount();
    }
  });

  test('AdminProtected lets an admin through and sends a caregiver HOME, not to login', async () => {
    const a = renderAsAdmin(guarded(AdminProtected));
    expect(screen.getByText('secret')).toBeInTheDocument();
    a.unmount();

    renderAsCaregiver(
      <Routes>
        <Route path="/" element={<div>home</div>} />
        <Route path="/settings/general" element={<AdminProtected><div>secret</div></AdminProtected>} />
      </Routes>,
      { route: '/settings/general' }
    );
    // ⚠️ Home, not login. Sending a signed-in caregiver to the login screen would read as "you have
    // been signed out" — this is the exact class of bug that shipped once as an admin-only route
    // 403-ing every caller, invisible until someone clicked it.
    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });
});
