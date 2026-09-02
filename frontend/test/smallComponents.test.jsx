// The small shared components — AppHeader, BackLink, CameraRow, DetectionRow, AlertList — and the
// route table in App.jsx.
//
// These are small enough to look not worth testing, which is exactly why several of them were the
// last things in the front end under 80%. What they carry is not small:
//   1. BackLink DECIDES WHERE "BACK" GOES. A page reachable from two places (a camera opened from a
//      child, or from the Cameras tab) must return to where you actually came from. It reads
//      `location.state.from` and falls back to the page's default parent — get it wrong and the back
//      button silently teleports people.
//   2. DetectionRow IS KEYBOARD-OPERABLE ONLY IF onClick EXISTS. It is a <div role="button">, so
//      `tabIndex` and the Enter/Space handler are the only things making it reachable at all; and a
//      NON-clickable row must not advertise itself as a button.
//   3. AlertList's relative times are the ROUNDING that decides "just now" vs "1m ago".
//   4. App.jsx's route table is the ONLY place role gating is applied to whole screens — and it is
//      where the shipped 403-for-everyone bug would have been visible.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { renderAs, renderAsAdmin, renderAsCaregiver, ADMIN, CAREGIVER } from './helpers/render.jsx';
import AppHeader from '../src/components/AppHeader.jsx';
import BackLink from '../src/components/BackLink.jsx';
import CameraRow from '../src/components/CameraRow.jsx';
import DetectionRow from '../src/components/DetectionRow.jsx';
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
    await user.click(screen.getByRole('button', { name: 'Go to Live' }));
    expect(await screen.findByText('live')).toBeInTheDocument();
  });

  test('a sub-page shows a labelled back affordance INSTEAD of the logo', () => {
    at('/settings/logs', <AppHeader title="Logs" back={{ to: '/settings', label: 'Settings' }} />);
    expect(screen.getByRole('button', { name: 'Back to Settings' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to Live' })).not.toBeInTheDocument();
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
        <Route path="/children/kid-1" element={<><div>child page</div><Nav to="/cameras/cam-a" from={{ to: '/children/kid-1', label: 'Raffa' }} /></>} />
        <Route path="/cameras" element={<><div>cameras tab</div><Nav to="/cameras/cam-a" /></>} />
        <Route path="/cameras/cam-a" element={<BackLink fallback={{ to: '/cameras', label: 'Cameras' }} />} />
      </Routes>
    </MemoryRouter>
  );

  test('returns to where you actually came from when an origin was supplied', async () => {
    const user = userEvent.setup();
    app('/children/kid-1');
    await user.click(screen.getByRole('button', { name: 'go' }));
    // ⚠️ The label is the tell: "‹ Raffa", not "‹ Cameras". A back button that reads the right word
    // but navigates to the fallback would pass a label-only assertion, so click it too.
    await user.click(screen.getByRole('button', { name: 'Back to Raffa' }));
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

// --- CameraRow ----------------------------------------------------------------------------------

describe('CameraRow', () => {
  const CAM = { id: 'cam-a', name: 'Raffa Room', statusLevel: 'live' };

  test('online, offline and disabled are three distinct states', () => {
    const a = render(<CameraRow cam={CAM} />);
    expect(screen.getByText('Online')).toHaveClass('status-badge--ok');
    a.unmount();

    const b = render(<CameraRow cam={{ ...CAM, statusLevel: 'offline' }} />);
    expect(screen.getByText('Offline')).toHaveClass('status-badge--bad');
    b.unmount();

    // ⚠️ Disabled beats live: a camera someone switched off is not "Online" just because its last
    // known status was. The order of the ternary is what makes that true.
    render(<CameraRow cam={{ ...CAM, statusLevel: 'live', disabled: 1 }} />);
    expect(screen.getByText('Disabled')).toHaveClass('status-badge--off');
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
  });

  test('only the live dot appears when the camera is actually live', () => {
    const a = render(<CameraRow cam={CAM} />);
    expect(a.container.querySelector('.cam-thumb__dot')).not.toBeNull();
    expect(a.container.querySelector('.cam-thumb')).not.toHaveClass('off');
    a.unmount();
    const b = render(<CameraRow cam={{ ...CAM, disabled: 1 }} />);
    expect(b.container.querySelector('.cam-thumb__dot')).toBeNull();
    expect(b.container.querySelector('.cam-thumb')).toHaveClass('off');
  });

  test('shows only the capabilities the camera actually has', () => {
    const { unmount } = render(<CameraRow cam={{ ...CAM, detect_motion_enabled: 1, ptz_supported: 1 }} />);
    expect(screen.getByText('MOTION')).toBeInTheDocument();
    expect(screen.getByText('PTZ')).toBeInTheDocument();
    expect(screen.queryByText('SOUND')).not.toBeInTheDocument();
    expect(screen.queryByText('TALK')).not.toBeInTheDocument();
    unmount();

    render(<CameraRow cam={{ ...CAM, detect_sound_enabled: 1, talk_configured: 1 }} />);
    expect(screen.getByText('SOUND')).toBeInTheDocument();
    expect(screen.getByText('TALK')).toBeInTheDocument();
    expect(screen.queryByText('MOTION')).not.toBeInTheDocument();
  });

  test('an assigned child appears as a chip, with a photo or an initial', () => {
    const { unmount, container } = render(<CameraRow cam={CAM} child={{ name: 'raffa', color: '#f4c56a' }} />);
    // The initial is upper-cased regardless of how the name was typed.
    expect(container.querySelector('.cam-chip__mini').textContent).toBe('R');
    unmount();

    const withPhoto = render(<CameraRow cam={CAM} child={{ name: 'Raffa', photo: 'data:image/png;base64,x' }} />);
    expect(withPhoto.container.querySelector('.cam-chip__mini img')).not.toBeNull();
  });

  test('a child with no name at all falls back to ? rather than throwing', () => {
    const { container } = render(<CameraRow cam={CAM} child={{ name: '' }} />);
    expect(container.querySelector('.cam-chip__mini').textContent).toBe('?');
  });

  test('it is a BUTTON only when it does something', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const { unmount, container } = render(<CameraRow cam={CAM} onClick={onClick} />);
    await user.click(screen.getByRole('button'));
    expect(onClick).toHaveBeenCalled();
    expect(container.querySelector('svg')).not.toBeNull(); // the chevron hints it goes somewhere
    unmount();

    // ⚠️ A caregiver gets the read-only form. Rendering a <button> that does nothing is worse than a
    // <div>: it is focusable, it looks tappable, and it lies about what the screen can do.
    const plain = render(<CameraRow cam={CAM} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(plain.container.querySelector('svg')).toBeNull();
  });
});

// --- DetectionRow -------------------------------------------------------------------------------

describe('DetectionRow', () => {
  const Icon = (p) => <svg {...p} data-testid="icon" />;

  test('a clickable row is announced as a button and reachable by keyboard', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<DetectionRow Icon={Icon} label="Motion" sub="On · 50" right="›" onClick={onClick} />);
    const row = screen.getByRole('button', { name: /Motion/ });
    expect(row).toHaveAttribute('tabindex', '0');
    expect(row).toHaveClass('det-row--clickable');

    // ⚠️ It is a <div>, so without tabIndex + this handler the row is invisible to a keyboard. Tab to
    // it rather than calling focus(), so the test proves it is actually in the tab order.
    await user.tab();
    expect(row).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  test('an unrelated key does nothing', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<DetectionRow Icon={Icon} label="Motion" onClick={onClick} />);
    await user.tab();
    await user.keyboard('{Escape}a{ArrowDown}');
    expect(onClick).not.toHaveBeenCalled();
  });

  test('a NON-clickable row advertises nothing it cannot do', () => {
    const { container } = render(<DetectionRow Icon={Icon} label="Motion" right={<span>off</span>} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const row = container.querySelector('.det-row');
    expect(row).not.toHaveAttribute('tabindex');
    expect(row).not.toHaveClass('det-row--clickable');
  });

  test('renders as a <label> when asked, so it can wrap a Switch', () => {
    const { container } = render(<DetectionRow as="label" Icon={Icon} label="Motion" right={<input type="checkbox" />} />);
    // The cog sheet quick-toggles in place; a <label> is what makes the whole row hit the switch.
    expect(container.querySelector('label.det-row')).not.toBeNull();
  });

  test('the sub-line is omitted entirely when there is none', () => {
    const { container } = render(<DetectionRow Icon={Icon} label="Motion" />);
    expect(container.querySelector('.camera-tile__sub')).toBeNull();
  });
});

// --- AlertList ----------------------------------------------------------------------------------

describe('AlertList', () => {
  const base = (over = {}) => ({
    id: 'ev-1',
    camera_name: 'Raffa Room',
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
    expect(screen.getByText(/Motion · \+12 dB over ambient/)).toBeInTheDocument();
  });

  test('relative times round the way the code says they do', () => {
    // ⚠️ THE CLOCK MUST BE FROZEN. `created_at` is stored to whole seconds, so building a fixture
    // from a live `Date.now()` loses the sub-second remainder and a "59 seconds ago" row lands on
    // either 59 or 60 depending on when in the second the test ran — i.e. it straddles the exact
    // boundary it exists to pin, and fails roughly half the time.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'));
    try {
    const ago = (s) => new Date(Date.now() - s * 1000).toISOString().slice(0, 19).replace('T', ' ');
    render(
      <AlertList
        alerts={[
          base({ id: 'a', created_at: ago(20) }),
          base({ id: 'b', created_at: ago(59) }),
          base({ id: 'c', created_at: ago(75) }),
          base({ id: 'd', created_at: ago(90) }),
          base({ id: 'e', created_at: ago(3 * 3600) }),
          base({ id: 'f', created_at: ago(50 * 3600) }),
        ]}
      />
    );
    // ⚠️ BOTH SIDES of the "just now" cut, and both sides of the minute rounding.
    // 20 s and 59 s are "just now" (`s < 60`); 75 s must NOT be — it is the only case that pins the
    // cut from ABOVE, and without it widening the bound to `s < 90` survives the whole suite (found
    // by an adversarial review, 2026-09-02, against an earlier version of this comment that claimed
    // both boundaries were covered when only one was).
    // 75 s rounds to 1m and 90 s rounds to 2m — that pair is what separates `Math.round` from
    // `Math.floor` on the minutes, since floor would call both of them 1m.
    expect(screen.getAllByText('just now')).toHaveLength(2);
    expect(screen.getByText('1m ago')).toBeInTheDocument();
    expect(screen.getByText('2m ago')).toBeInTheDocument();
    expect(screen.getByText('3h ago')).toBeInTheDocument();
    expect(screen.getByText('2d ago')).toBeInTheDocument();
    } finally {
      // ⚠️ try/finally, not a trailing call: a failed assertion above would otherwise leave fake
      // timers installed for the REST OF THE FILE, and every later test that awaits a userEvent
      // click then hangs to its 5 s timeout. One bad assertion turned into five red tests.
      vi.useRealTimers();
    }
  });

  test('the seconds are ROUNDED, not floored — a fraction over the minute is not "just now"', () => {
    // ⚠️ The clock is deliberately offset by 600 ms. `created_at` is stored to whole seconds, so
    // freezing the clock on an exact second (as the test above must, to pin the 59/60 cut) makes the
    // elapsed time an exact multiple of 1000 — and `Math.round` and `Math.floor` can then never
    // disagree. That is a fixture that cannot discriminate: the fix for one flake removed the
    // ability to test this line at all, and the mutant survived until a review found it.
    // Here elapsed is 59.6 s: rounded it is 60 (so "1m ago"), floored it is 59 (so "just now").
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T10:00:00.600Z'));
    try {
      const created = new Date(Date.now() - 59 * 1000).toISOString().slice(0, 19).replace('T', ' ');
      render(<AlertList alerts={[base({ id: 'x', created_at: created })]} />);
      expect(screen.getByText('1m ago')).toBeInTheDocument();
      expect(screen.queryByText('just now')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a snapshot becomes a play button only when the clip is READY', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    const { unmount } = render(<AlertList alerts={[base({ snapshot: 1, clip_status: 'ready' })]} />);
    expect(screen.getByRole('button', { name: 'Play clip from Raffa Room' })).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Play clip from Raffa Room' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('the delete action is offered only when the caller can handle the change', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    const user = userEvent.setup();
    const alerts = [base({ snapshot: 1, clip_status: 'ready' })];
    const { unmount } = render(<AlertList alerts={alerts} />);
    await user.click(screen.getByRole('button', { name: /Play clip/ }));
    // Without `onChanged` the list has no way to refresh itself, so offering a delete would leave a
    // row on screen pointing at a clip that no longer exists.
    expect(screen.queryByRole('button', { name: 'Delete clip' })).not.toBeInTheDocument();
    unmount();

    render(<AlertList alerts={alerts} onChanged={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Play clip/ }));
    expect(await screen.findByRole('button', { name: 'Delete clip' })).toBeInTheDocument();
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
