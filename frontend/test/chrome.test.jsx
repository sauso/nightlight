// The app's chrome: NavBar, PushBanner, ErrorBoundary, About, and CameraReportButton.
//
// Small components, all at 0–20%, and three of them are the ones that matter most when something has
// already gone wrong:
//   1. ErrorBoundary IS THE LAST LINE. Without it a render-time throw anywhere unmounts the whole app
//      to a blank white screen with no way back but killing the process — on a device someone is
//      glancing at half-asleep. It must catch, keep the app alive, AND show the real error text,
//      because a recurrence on a phone with no console is only diagnosable from a screenshot.
//   2. PushBanner is the ONLY way a foreground alert is seen at all. Android delivers an FCM message
//      to the JS layer instead of the tray while the app is open, so a banner that fails to appear
//      means the alert is silently swallowed.
//   3. NavBar's active state is PREFIX matching for the hubs and EXACT for Live — a hub must stay lit
//      on its sub-pages, and "/" must not light up on every route.
//   4. About shows the build provenance that tells you whether you are looking at staging or prod.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import NavBar from '../src/components/NavBar.jsx';
import PushBanner from '../src/components/PushBanner.jsx';
import ErrorBoundary from '../src/components/ErrorBoundary.jsx';
import About from '../src/pages/About.jsx';
import CameraReportButton from '../src/components/CameraReportButton.jsx';
import { api } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';

afterEach(() => vi.restoreAllMocks());

// --- NavBar -------------------------------------------------------------------------------------

describe('NavBar', () => {
  const at = (route) => render(<MemoryRouter initialEntries={[route]}><NavBar /></MemoryRouter>);
  const tab = (name) => screen.getByRole('link', { name });

  test('renders all four destinations with their targets', () => {
    at('/');
    expect(tab('Live')).toHaveAttribute('href', '/');
    expect(tab('Children')).toHaveAttribute('href', '/children');
    expect(tab('Cameras')).toHaveAttribute('href', '/cameras');
    expect(tab('Settings')).toHaveAttribute('href', '/settings');
  });

  test('Live is EXACT — it lights on / and on nothing else', () => {
    const home = at('/');
    expect(tab('Live')).toHaveClass('active');
    home.unmount();
    // `exact: true` is what stops "/" prefix-matching every route in the app, which would leave Live
    // permanently lit and the bar useless as a position indicator.
    at('/children/kid-1');
    expect(tab('Live')).not.toHaveClass('active');
  });

  test('a hub stays lit on its own sub-pages, and only that hub', () => {
    // Prefix matching is the point: /children/kid-1 belongs to the Children hub. Without it the bar
    // goes blank the moment you tap into anything, which reads as "I have left the app".
    at('/children/kid-1');
    expect(tab('Children')).toHaveClass('active');
    expect(tab('Live')).not.toHaveClass('active');
    expect(tab('Cameras')).not.toHaveClass('active');
    expect(tab('Settings')).not.toHaveClass('active');
  });

  test('Settings owns Account and About as well as its own sub-pages', () => {
    for (const route of ['/settings', '/settings/push/ntfy', '/account', '/about']) {
      const { unmount } = at(route);
      expect(tab('Settings')).toHaveClass('active');
      unmount();
    }
  });

  test('a prefix match needs the slash — /camerasomething is NOT the Cameras hub', () => {
    // `pathname.startsWith(p + '/')`, not `startsWith(p)`. Without the slash any future route whose
    // name merely begins with an existing tab's would light up the wrong tab.
    at('/camerasomething');
    expect(tab('Cameras')).not.toHaveClass('active');
  });

  test('an unknown route lights nothing rather than defaulting to Live', () => {
    at('/nowhere');
    for (const name of ['Live', 'Children', 'Cameras', 'Settings']) {
      expect(tab(name)).not.toHaveClass('active');
    }
  });
});

// --- PushBanner ---------------------------------------------------------------------------------

describe('PushBanner', () => {
  const push = (detail) =>
    act(() => { window.dispatchEvent(new CustomEvent('nightlight:push', { detail })); });
  const ALERT = { title: 'Motion', body: 'Raffa Room', cameraId: 'cam-a' };

  test('renders nothing until a push arrives', () => {
    const { container } = renderAsAdmin(<PushBanner />);
    expect(container.querySelector('.push-banner')).toBeNull();
  });

  test('shows the alert title and body, announced as an alert', () => {
    renderAsAdmin(<PushBanner />);
    push(ALERT);
    const banner = screen.getByRole('alert');
    // role="alert" is what makes a screen reader announce it — the whole point of the component is
    // that the message is not silently swallowed.
    expect(banner).toHaveTextContent('Motion');
    expect(banner).toHaveTextContent('Raffa Room');
  });

  test('a second push replaces the first and restarts the dismiss timer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAsAdmin(<PushBanner />);
      push(ALERT);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByRole('alert')).toBeInTheDocument();

      push({ title: 'Sound', body: 'Renz Room' });
      expect(screen.getByRole('alert')).toHaveTextContent('Sound');
      // 5 s of the first alert's 6 s had already elapsed. If the timer were not restarted, the new
      // alert would vanish after 1 s — visible for a sixth of the time it should be.
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('auto-dismisses after 6 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderAsAdmin(<PushBanner />);
      push(ALERT);
      await act(async () => { await vi.advanceTimersByTimeAsync(5900); });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('tapping the banner navigates to Live and dismisses it', async () => {
    const user = userEvent.setup();
    renderAsAdmin(<PushBanner />);
    push(ALERT);
    await user.click(screen.getByRole('alert'));
    expect(window.location.hash).toBe('#/');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('Enter and Space open it too — it is keyboard-reachable', async () => {
    const user = userEvent.setup();
    for (const key of ['{Enter}', ' ']) {
      const { unmount } = renderAsAdmin(<PushBanner />);
      push(ALERT);
      const banner = screen.getByRole('alert');
      expect(banner).toHaveAttribute('tabindex', '0');
      banner.focus();
      await user.keyboard(key);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      unmount();
    }
  });

  test('the close button dismisses WITHOUT navigating', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/settings';
    renderAsAdmin(<PushBanner />);
    push(ALERT);
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // ⚠️ The close button sits INSIDE the clickable banner, so without stopPropagation the dismiss
    // also fires the banner's open handler and yanks the user to Live — the opposite of "dismiss".
    expect(window.location.hash).toBe('#/settings');
  });

  test('unmounting removes the listener, so a later push does not resurrect it', () => {
    const { unmount } = renderAsAdmin(<PushBanner />);
    unmount();
    push(ALERT);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

// --- ErrorBoundary ------------------------------------------------------------------------------

describe('ErrorBoundary', () => {
  const Boom = ({ err }) => { throw err; };
  let consoleError;

  beforeEach(() => {
    // React logs the caught error itself; silencing keeps the run readable without hiding assertions.
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  test('renders its children untouched when nothing throws', () => {
    render(<ErrorBoundary><div>the app</div></ErrorBoundary>);
    expect(screen.getByText('the app')).toBeInTheDocument();
  });

  test('catches a render-time throw and keeps something on screen', () => {
    render(<ErrorBoundary><Boom err={new Error('cameras is undefined')} /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  test('shows the REAL error message, not a generic one', () => {
    render(<ErrorBoundary><Boom err={new Error('cameras is undefined')} /></ErrorBoundary>);
    // ⚠️ This is the whole diagnostic value: on a phone with no reachable console, a screenshot of
    // this screen is the only evidence that will ever exist.
    expect(screen.getByText(/cameras is undefined/)).toBeInTheDocument();
    expect(screen.getByText('Error details')).toBeInTheDocument();
  });

  test('a thrown non-Error still produces readable text rather than [object Object]', () => {
    // eslint-disable-next-line no-throw-literal
    render(<ErrorBoundary><Boom err={'a bare string'} /></ErrorBoundary>);
    expect(screen.getByText(/a bare string/)).toBeInTheDocument();
  });

  test('it logs the component stack for anyone who CAN reach a console', () => {
    render(<ErrorBoundary><Boom err={new Error('kaboom')} /></ErrorBoundary>);
    expect(consoleError.mock.calls.some((c) => c[0] === 'Uncaught render error:')).toBe(true);
  });

  test('Reload actually reloads', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, reload } });
    try {
      render(<ErrorBoundary><Boom err={new Error('kaboom')} /></ErrorBoundary>);
      await user.click(screen.getByRole('button', { name: 'Reload' }));
      expect(reload).toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });
});

// --- About --------------------------------------------------------------------------------------

describe('About', () => {
  test('shows the app name from settings and the version from the server', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ version: '0.29.0' });
    renderAsAdmin(<About />, { settings: { app_name: 'Nursery' } });
    expect(screen.getByText('Nursery')).toBeInTheDocument();
    expect(await screen.findByText(/Version 0\.29\.0/)).toBeInTheDocument();
  });

  test('shows a placeholder version until /about answers', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    renderAsAdmin(<About />);
    expect(screen.getByText(/Version …/)).toBeInTheDocument();
  });

  test('a failed /about degrades to "unknown" rather than hanging on the placeholder', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    renderAsAdmin(<About />);
    expect(await screen.findByText(/Version unknown/)).toBeInTheDocument();
  });

  test('shows build provenance — branch, short sha and build date', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({
      version: '0.29.0',
      gitRef: 'dev',
      gitSha: '38c9e45abcdef0123456789',
      buildTime: '2026-09-01T00:00:00Z',
    });
    renderAsAdmin(<About />);
    // ⚠️ This line is how anyone tells a staging instance from production at a glance, so the sha
    // must be the SHORT one and it must actually be seven characters of the real sha.
    const line = await screen.findByText(/^dev · 38c9e45 · built/);
    expect(line).toBeInTheDocument();
  });

  test('omits the provenance line entirely when the server sends no build info', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ version: '0.29.0' });
    renderAsAdmin(<About />);
    await screen.findByText(/Version 0\.29\.0/);
    expect(screen.queryByText(/ · built /)).not.toBeInTheDocument();
  });

  test('shows partial provenance rather than nothing when only some fields exist', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ version: '0.29.0', gitRef: 'main' });
    renderAsAdmin(<About />);
    expect(await screen.findByText('main')).toBeInTheDocument();
  });

  test('every outbound link opens safely, for either role', () => {
    vi.spyOn(api, 'get').mockResolvedValue({ version: '0.29.0' });
    const { unmount } = renderAsAdmin(<About />);
    const links = screen.getAllByRole('link');
    expect(links.length).toBeGreaterThanOrEqual(5); // 4 links + donate
    for (const a of links) {
      expect(a).toHaveAttribute('target', '_blank');
      // Without rel=noreferrer the opened page keeps a window.opener handle back into the app.
      expect(a).toHaveAttribute('rel', 'noreferrer');
    }
    unmount();

    renderAsCaregiver(<About />);
    // About is not admin-gated — a caregiver needs the version to report a problem too.
    expect(screen.getByRole('link', { name: /Donate via PayPal/ })).toBeInTheDocument();
  });

  test('carries the safety disclaimer', () => {
    vi.spyOn(api, 'get').mockResolvedValue({ version: '0.29.0' });
    renderAsAdmin(<About />);
    expect(screen.getByText('Not a safety device.')).toBeInTheDocument();
  });
});

// --- CameraReportButton -------------------------------------------------------------------------

describe('CameraReportButton', () => {
  const PAYLOAD = { ip: '192.0.2.10', port: 554, username: 'admin', password: 'hunter2' };

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:nightlight/2');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
  });

  test('posts the entered camera details and offers the report as a download', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ codecs: ['h264'] });
    const clicks = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = () => clicks.push(el.download);
      return el;
    });

    const { user } = renderAsAdmin(<CameraReportButton payload={PAYLOAD} />);
    await user.click(screen.getByRole('button', { name: /Generate camera report/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/cameras/probe-report', PAYLOAD));
    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0]).toMatch(/^nightlight-camera-report-.*\.json$/);
    expect(clicks[0]).not.toContain(':');
  });

  test('a second tap while building is ignored', async () => {
    let release;
    vi.spyOn(api, 'post').mockImplementation(() => new Promise((r) => { release = r; }));
    const { user } = renderAsAdmin(<CameraReportButton payload={PAYLOAD} />);
    await user.click(screen.getByRole('button', { name: /Generate camera report/ }));
    await user.click(screen.getByRole('button', { name: /Building report…/ }));
    expect(api.post).toHaveBeenCalledTimes(1);
    release({});
    await screen.findByRole('button', { name: /Downloaded ✓/ });
  });

  test('a failed probe shows the reason and re-arms the button', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Camera refused the connection'));
    const { user } = renderAsAdmin(<CameraReportButton payload={PAYLOAD} />);
    await user.click(screen.getByRole('button', { name: /Generate camera report/ }));
    expect(await screen.findByText('Camera refused the connection')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Generate camera report/ })).toBeEnabled();
  });

  test('an error with no message still says something', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error(''));
    const { user } = renderAsAdmin(<CameraReportButton payload={PAYLOAD} />);
    await user.click(screen.getByRole('button', { name: /Generate camera report/ }));
    expect(await screen.findByText('Failed to build the report')).toBeInTheDocument();
  });

  test('the native app saves to Downloads, falls back to sharing, and reports both', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ codecs: ['h264'] });
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
    vi.spyOn(nativeBridge, 'hasFileExport').mockReturnValue(true);
    const toDownloads = vi.spyOn(nativeBridge, 'saveToDownloads').mockResolvedValue(true);
    vi.spyOn(nativeBridge, 'saveTextFile').mockResolvedValue(true);

    const { user, unmount } = renderAsAdmin(<CameraReportButton payload={PAYLOAD} />);
    await user.click(screen.getByRole('button', { name: /Generate camera report/ }));
    expect(await screen.findByText('Saved to your Downloads folder.')).toBeInTheDocument();
    unmount();

    toDownloads.mockResolvedValue(false);
    const second = renderAsAdmin(<CameraReportButton payload={PAYLOAD} />);
    await second.user.click(screen.getByRole('button', { name: /Generate camera report/ }));
    expect(await screen.findByText('Shared — pick "Save to Files" to keep a copy.')).toBeInTheDocument();
  });

  test('an old app is told to update; a device that refuses both routes is told that instead', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({});
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
    const hasExport = vi.spyOn(nativeBridge, 'hasFileExport').mockReturnValue(false);
    vi.spyOn(nativeBridge, 'saveToDownloads').mockResolvedValue(false);
    vi.spyOn(nativeBridge, 'saveTextFile').mockResolvedValue(false);

    const { user, unmount } = renderAsAdmin(<CameraReportButton payload={PAYLOAD} />);
    await user.click(screen.getByRole('button', { name: /Generate camera report/ }));
    expect(await screen.findByText(/Update to the latest app version/)).toBeInTheDocument();
    unmount();

    hasExport.mockReturnValue(true);
    const second = renderAsAdmin(<CameraReportButton payload={PAYLOAD} />);
    await second.user.click(screen.getByRole('button', { name: /Generate camera report/ }));
    expect(await screen.findByText("Couldn't save the file on this device.")).toBeInTheDocument();
  });
});
