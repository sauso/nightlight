// The public demo has no credential screen: status selects one fixed guest, while the signed-in app
// keeps explaining that writes are disabled and how much time remains. These tests cover the seams
// between those pieces, including the real fetch wrapper that turns the backend's policy marker into
// calm UI copy.
import React, { StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import App from '../src/App.jsx';
import DemoBanner from '../src/components/DemoBanner.jsx';
import InstallPrompt from '../src/components/InstallPrompt.jsx';
import Login from '../src/pages/Login.jsx';
import { api, setToken } from '../src/lib/api.js';
import { resetDemoStatusForTests } from '../src/lib/demoStatus.js';
import { ADMIN, renderAs } from './helpers/render.jsx';

const realFetch = globalThis.fetch;
const SESSION = { token: 'demo-token', user: { ...ADMIN, username: 'demo-guest' } };
const DEMO = {
  endsAt: '2026-09-21T10:20:00.000Z',
  lobbyUrl: 'https://lobby.example.test/start',
  ready: true,
};

const Probe = () => <div>at {useLocation().pathname}</div>;

function mountLogin() {
  return renderAs(
    null,
    <StrictMode>
      <Probe />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="*" element={<div>signed in</div>} />
      </Routes>
    </StrictMode>,
    { route: '/login' }
  );
}

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  setToken(null);
  resetDemoStatusForTests();
  window.location.hash = '';
});

describe('automatic guest sign-in', () => {
  test('posts the bodyless guest endpoint once and enters as the returned admin', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: DEMO });
    const post = vi.spyOn(api, 'post').mockResolvedValue(SESSION);
    const { auth } = mountLogin();

    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/guest'));
    expect(post).toHaveBeenCalledTimes(1); // StrictMode must not consume a second active-viewer slot.
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('demo-token', SESSION.user));
    expect(await screen.findByText('at /')).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
  });

  test('waits for login to finish before navigating', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: DEMO });
    let finishPost;
    vi.spyOn(api, 'post').mockReturnValue(new Promise((resolve) => { finishPost = resolve; }));
    const { auth } = mountLogin();
    await waitFor(() => expect(api.post).toHaveBeenCalled());

    let finishLogin;
    auth.login.mockImplementation(() => new Promise((resolve) => { finishLogin = resolve; }));
    finishPost(SESSION);
    await waitFor(() => expect(auth.login).toHaveBeenCalled());
    expect(screen.getByText('at /login')).toBeInTheDocument();

    finishLogin();
    expect(await screen.findByText('at /')).toBeInTheDocument();
  });

  test('shows a guest failure without falling back to a credential form', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: DEMO });
    vi.spyOn(api, 'post').mockRejectedValue(new Error('The demo is full - try again in a few minutes.'));
    mountLogin();

    expect(await screen.findByText(/demo is full/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(screen.getByText(/could not be opened/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  test('retries a failed guest sign-in without duplicating the automatic attempt', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: DEMO });
    const post = vi.spyOn(api, 'post')
      .mockRejectedValueOnce(new Error('The demo is full - try again in a few minutes.'))
      .mockResolvedValueOnce(SESSION);
    const { auth } = mountLogin();

    const retry = await screen.findByRole('button', { name: 'Try again' });
    expect(post).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(auth.login).toHaveBeenCalledWith('demo-token', SESSION.user));
    expect(await screen.findByText('at /')).toBeInTheDocument();
  });

  test('keeps the normal sign-in screen when demo is false', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: false });
    const post = vi.spyOn(api, 'post').mockResolvedValue(SESSION);
    mountLogin();

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('persistent demo banner', () => {
  test('counts down in minutes, then links back to the lobby when time expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-21T10:17:01.000Z'));
    vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: DEMO });
    render(<DemoBanner />);

    expect(await screen.findByText(/ends in 3 min/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Get Nightlight' })).toHaveAttribute(
      'href', 'https://github.com/sauso/nightlight'
    );

    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60 * 1000); });
    expect(screen.getByText(/Demo ended/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'start again' })).toHaveAttribute(
      'href', 'https://lobby.example.test/start'
    );
  });

  test('does not offer a start-again link when no lobby URL is configured', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-21T10:20:00.000Z'));
    vi.spyOn(api, 'get').mockResolvedValue({
      needsSetup: false,
      demo: { ...DEMO, lobbyUrl: null },
    });
    render(<DemoBanner />);

    expect(await screen.findByText(/^Demo ended$/i)).toBeInTheDocument();
    // By TEXT, not by role: an <a> with no href has no ARIA "link" role, so a role query passes even when
    // the component wrongly renders the anchor without a URL (the mutant that did exactly that survived
    // the earlier role-based assertion).
    expect(screen.queryByText('start again')).not.toBeInTheDocument();
  });

  test('renders no strip for a normal installation', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: false });
    render(<DemoBanner />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/auth/status'));
    expect(screen.queryByLabelText('Demo status')).not.toBeInTheDocument();
  });

  test('is a DOM sibling after the header in the real signed-in app shell', async () => {
    setToken('session-token');
    window.location.hash = '#/children';
    vi.spyOn(api, 'get').mockImplementation((requestPath) => {
      const p = String(requestPath);
      if (p === '/auth/me') return Promise.resolve(ADMIN);
      if (p === '/auth/status') return Promise.resolve({ needsSetup: false, demo: DEMO });
      if (p.startsWith('/settings')) return Promise.resolve({ app_name: 'Nightlight', timezone: 'UTC' });
      if (p.startsWith('/children')) return Promise.resolve([]);
      if (p.startsWith('/cameras/alerts')) return Promise.resolve([]);
      if (p.startsWith('/cameras')) return Promise.resolve([]);
      if (p.startsWith('/events')) return Promise.resolve({ events: [] });
      return Promise.resolve(null);
    });
    vi.spyOn(api, 'post').mockResolvedValue({});
    vi.spyOn(api, 'put').mockResolvedValue({});

    render(<HashRouter><App /></HashRouter>);
    const banner = await screen.findByLabelText('Demo status');
    const header = screen.getByRole('heading', { name: 'Children' }).closest('header');
    expect(header.nextElementSibling).toBe(banner);
    expect(screen.getAllByLabelText('Demo status')).toHaveLength(1);
    expect(document.querySelector('.app-shell')).not.toBeNull();
  });
});

describe('install prompt in demo mode', () => {
  test('shows no install prompt in a demo even when the browser offers one, on one shared status request', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: DEMO });
    const installEvent = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(installEvent, { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'dismissed' }) });

    render(
      <StrictMode>
        <DemoBanner />
        <InstallPrompt />
      </StrictMode>
    );

    expect(await screen.findByLabelText('Demo status')).toBeInTheDocument();
    // One request for both consumers: the cache is module-level, so StrictMode's effect replay and two
    // components mounted together still make a single call.
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/auth/status');

    await act(async () => { window.dispatchEvent(installEvent); });
    expect(screen.queryByText(/Install this app on your device/i)).not.toBeInTheDocument();
    // Still intercepted, which also suppresses the browser's own install mini-bar in the demo.
    expect(installEvent.defaultPrevented).toBe(true);
  });

  test('an install event that fires BEFORE the status request resolves is not lost outside the demo', async () => {
    // beforeinstallprompt fires once per page load. If InstallPrompt only started listening after
    // /auth/status answered, an early event would vanish and normal installs would lose the prompt.
    let resolveStatus;
    vi.spyOn(api, 'get').mockReturnValue(new Promise((resolve) => { resolveStatus = resolve; }));
    const installEvent = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(installEvent, { prompt: vi.fn(), userChoice: Promise.resolve({ outcome: 'accepted' }) });

    render(<InstallPrompt />);
    await act(async () => { window.dispatchEvent(installEvent); }); // status still pending
    expect(screen.queryByText(/Install this app on your device/i)).not.toBeInTheDocument(); // no flash while unknown

    await act(async () => { resolveStatus({ needsSetup: false, demo: false }); });
    expect(await screen.findByText(/Install this app on your device/i)).toBeInTheDocument();
  });

  test('keeps the normal browser install flow outside the demo', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ needsSetup: false, demo: false });
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const prompt = vi.fn();
    const installEvent = new Event('beforeinstallprompt', { cancelable: true });
    Object.assign(installEvent, {
      prompt,
      userChoice: Promise.resolve({ outcome: 'accepted' }),
    });

    render(<InstallPrompt />);
    await waitFor(() => expect(addEventListener).toHaveBeenCalledWith(
      'beforeinstallprompt', expect.any(Function)
    ));
    await act(async () => { window.dispatchEvent(installEvent); });

    expect(installEvent.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(prompt).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText(/Install this app on your device/i)).not.toBeInTheDocument());
    expect(localStorage.getItem('nightlight_install_dismissed')).toBe('1');
  });
});

test('the fetch wrapper gives blocked demo writes friendly, actionable copy', async () => {
  globalThis.fetch = vi.fn(async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({
      error: 'This is a read-only public demo - that action is disabled here.',
    }),
  }));

  const error = await api.put('/settings', { app_name: 'Changed' }).catch((err) => err);
  expect(error.message).toBe(
    'This demo is read-only, so changes are disabled. You can still explore the sample data.'
  );
  expect(error.status).toBe(403);
});

