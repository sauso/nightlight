// The /tv route and how the app gets there (src/App.jsx), with the REAL shell and providers over a mocked API, the
// way appShell.test.jsx does it. Players are stubbed: this file is about routing, not video.
//
//   * a signed-in user who lands on `/` in the native app on a TV goes to /tv, ONCE per launch;
//   * a phone (the shell says "not a TV", or has no such method) never does, and neither does a browser;
//   * `?tv=1` in the hash route opens /tv in any browser, and survives the sign-in detour;
//   * /tv is for any signed-in user (a caregiver too), is NOT behind the admin gate, and sends a signed-out visitor to login;
//   * /tv does NOT keep LiveMonitor mounted behind it (one set of WebRTC sessions, not two);
//   * the remote's Back leaves the app from /tv (useHardwareBack), and closes a full-screen tile first.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { HashRouter, useNavigate } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import App from '../src/App.jsx';
import { api, setToken } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';
import * as push from '../src/lib/pushNotifications.js';

vi.mock('../src/components/WhepPlayer.jsx', async () => {
  const React = await import('react');
  return { default: (props) => React.createElement('div', { 'data-testid': `whep-${props.mediamtxPath}`, 'data-muted': String(props.muted) }) };
});
vi.mock('../src/components/HlsPlayer.jsx', async () => {
  const React = await import('react');
  return { default: (props) => React.createElement('div', { 'data-testid': `hls-${props.mediamtxPath}` }) };
});

// Lets a test move the router the way a link would, without a full page load.
let go;
function NavProbe() {
  go = useNavigate();
  return null;
}
const app = () => <HashRouter><NavProbe /><App /></HashRouter>;

const ADMIN = { id: 'u1', username: 'nacho', role: 'admin', first_name: 'Nacho' };
const CAREGIVER = { id: 'u2', username: 'nanny', role: 'caregiver' };
const SETTINGS = { app_name: 'Nightlight', timezone: 'Australia/Melbourne', temp_unit: 'C' };
const CAMERAS = [
  { id: 'c1', name: 'Nursery', mediamtx_path: 'p1', status: { ready: true } },
  { id: 'c2', name: 'Playroom', mediamtx_path: 'p2', status: { ready: false } },
];

function mockApi(me) {
  vi.spyOn(api, 'get').mockImplementation((path) => {
    const p = String(path);
    if (p.startsWith('/auth/me')) return me ? Promise.resolve(me) : Promise.reject(Object.assign(new Error('401'), { status: 401 }));
    if (p === '/auth/status') return Promise.resolve({ needsSetup: false, demo: false });
    if (p.startsWith('/settings')) return Promise.resolve(SETTINGS);
    if (p.startsWith('/children')) return Promise.resolve([]);
    if (p.startsWith('/cameras')) return Promise.resolve(CAMERAS);
    return Promise.resolve(null);
  });
  vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'post').mockResolvedValue({});
}

// The shell the app is running in: 'tv', 'phone' (a native app that says no), 'old' (a native app without the method) or 'browser'.
function shell(kind) {
  vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(kind !== 'browser');
  vi.spyOn(nativeBridge, 'isTelevision').mockImplementation(async () => kind === 'tv');
}

beforeEach(() => {
  vi.spyOn(nativeBridge, 'hasActiveBackgroundAudio').mockReturnValue(false);
  vi.spyOn(push, 'initPushNotifications').mockResolvedValue(undefined);
  vi.spyOn(nativeBridge, 'syncTailscaleEndpoint').mockImplementation(() => Promise.resolve(null));
});
afterEach(() => {
  vi.restoreAllMocks();
  setToken(null);
  window.location.hash = '';
  delete window.Capacitor;
});

async function boot(route = '/') {
  window.location.hash = `#${route}`;
  const view = render(app());
  await waitFor(() => expect(document.querySelector('.app-shell, .tv-screen, .login-page, form')).toBeTruthy());
  return view;
}
const onTv = () => document.querySelector('.tv-screen');
const onLive = () => document.querySelector('.live-monitor--active');

describe('★ landing on / in the TV app', () => {
  test('a signed-in user on a TV ends up on /tv, with no phone grid and no nav bar', async () => {
    setToken('t');
    shell('tv');
    mockApi(ADMIN);
    await boot('/');
    await waitFor(() => expect(onTv()).toBeTruthy());
    expect(window.location.hash).toBe('#/tv');
    expect(await screen.findByText('Nursery')).toBeTruthy();
    // WHY the TV route is not inside the shell with LiveMonitor: that screen stays mounted and would hold a second
    // set of WebRTC sessions open behind the TV's own.
    expect(document.querySelector('.live-monitor')).toBeNull();
    expect(document.querySelector('.bottom-nav')).toBeNull();
    // ...and the stubbed players show only ONE player per camera (the TV's), not a second set from the phone grid.
    expect(screen.getAllByTestId('whep-p1')).toHaveLength(1);
  });

  test('★ ONCE per launch: going to / by hand afterwards is not bounced back', async () => {
    setToken('t');
    shell('tv');
    mockApi(ADMIN);
    await boot('/');
    await waitFor(() => expect(onTv()).toBeTruthy());
    act(() => { go('/'); });
    await waitFor(() => expect(onLive()).toBeTruthy());
    expect(onTv()).toBeNull();
    expect(window.location.hash).toBe('#/');
  });

  test('the first screen is not the phone grid even for a moment (no live monitor is ever mounted on a TV)', async () => {
    setToken('t');
    shell('tv');
    mockApi(ADMIN);
    const seen = new Set();
    const watcher = new MutationObserver(() => { if (document.querySelector('.live-monitor')) seen.add('live-monitor'); });
    watcher.observe(document.body, { childList: true, subtree: true });
    await boot('/');
    await waitFor(() => expect(onTv()).toBeTruthy());
    watcher.disconnect();
    expect([...seen]).toEqual([]);
  });

  test('a caregiver on a TV gets /tv as well (it is not an admin screen)', async () => {
    setToken('t');
    shell('tv');
    mockApi(CAREGIVER);
    await boot('/');
    await waitFor(() => expect(onTv()).toBeTruthy());
    expect(await screen.findByText('Nursery')).toBeTruthy();
  });

  test('a signed-out TV is sent to the sign-in form, then to /tv', async () => {
    shell('tv');
    mockApi(null);
    await boot('/');
    expect(await screen.findByLabelText(/username/i)).toBeTruthy();
    expect(onTv()).toBeNull();
    api.post.mockResolvedValue({ token: 'tok', user: ADMIN });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/username/i), 'nacho');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onTv()).toBeTruthy());
    expect(window.location.hash).toBe('#/tv');
  });
});

describe('★ everyone else is untouched', () => {
  test.each([
    ['a phone (the shell says it is not a TV)', 'phone'],
    ['an app built before the TV method existed', 'old'],
    ['a browser', 'browser'],
  ])('%s stays on the live grid at /', async (_label, kind) => {
    setToken('t');
    shell(kind);
    mockApi(ADMIN);
    await boot('/');
    await waitFor(() => expect(onLive()).toBeTruthy());
    expect(onTv()).toBeNull();
    expect(window.location.hash).toBe('#/');
  });

  test('a browser never asks the shell at all', async () => {
    setToken('t');
    shell('browser');
    mockApi(ADMIN);
    await boot('/');
    await waitFor(() => expect(onLive()).toBeTruthy());
    expect(nativeBridge.isTelevision).not.toHaveBeenCalled();
  });

  test('a native app waits for the shell\'s answer before drawing anything, so a phone loses nothing and a TV never draws the grid', async () => {
    setToken('t');
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
    let answer;
    vi.spyOn(nativeBridge, 'isTelevision').mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    mockApi(ADMIN);
    window.location.hash = '#/';
    const { container } = render(app());
    await waitFor(() => expect(nativeBridge.isTelevision).toHaveBeenCalled());
    expect(container.querySelector('.app-shell')).toBeNull();
    await act(async () => { answer(false); });
    await waitFor(() => expect(onLive()).toBeTruthy());
  });

  test('a TV deep link to another screen is left alone (only a landing on / is redirected)', async () => {
    setToken('t');
    shell('tv');
    mockApi(ADMIN);
    await boot('/cameras');
    expect(onTv()).toBeNull();
    expect(window.location.hash).toBe('#/cameras');
  });
});

describe('★ ?tv=1 opens the TV screen in any browser', () => {
  test('signed in: #/?tv=1 goes to /tv', async () => {
    setToken('t');
    shell('browser');
    mockApi(ADMIN);
    await boot('/?tv=1');
    await waitFor(() => expect(onTv()).toBeTruthy());
    expect(window.location.hash).toBe('#/tv');
  });

  test('a plain #/ (no query) in a browser does not', async () => {
    setToken('t');
    shell('browser');
    mockApi(ADMIN);
    await boot('/');
    await waitFor(() => expect(onLive()).toBeTruthy());
    expect(onTv()).toBeNull();
  });

  test('only the value 1 counts', async () => {
    setToken('t');
    shell('browser');
    mockApi(ADMIN);
    await boot('/?tv=0');
    await waitFor(() => expect(onLive()).toBeTruthy());
    expect(onTv()).toBeNull();
  });

  test('★ signed out: the sign-in detour (which drops the query) still ends on /tv', async () => {
    shell('browser');
    mockApi(null);
    await boot('/?tv=1');
    await screen.findByLabelText(/username/i);
    api.post.mockResolvedValue({ token: 'tok', user: ADMIN });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/username/i), 'nacho');
    await user.type(screen.getByLabelText(/password/i), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(onTv()).toBeTruthy());
  });
});

describe('/tv itself', () => {
  test('★ a signed-out visitor to /tv is sent to the normal login (the existing guard)', async () => {
    shell('browser');
    mockApi(null);
    await boot('/tv');
    expect(await screen.findByLabelText(/username/i)).toBeTruthy();
    expect(onTv()).toBeNull();
  });

  test.each([['admin', ADMIN], ['caregiver', CAREGIVER]])('a %s can open /tv directly', async (_role, me) => {
    setToken('t');
    shell('browser');
    mockApi(me);
    await boot('/tv');
    await waitFor(() => expect(onTv()).toBeTruthy());
    expect(await screen.findByText('Nursery')).toBeTruthy();
  });

  test('★ read-only through the real shell: only GETs are issued (no api write)', async () => {
    setToken('t');
    shell('browser');
    mockApi(ADMIN);
    await boot('/tv');
    await screen.findByText('Nursery');
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyUp(window, { key: 'Enter' });
    expect(api.put).not.toHaveBeenCalled();
    // The only POST allowed is none: nothing the TV does posts. (Sign-in is posted before this point; none here.)
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('★ the remote\'s Back (useHardwareBack)', () => {
  function nativeApp() {
    let backButton;
    const exitApp = vi.fn();
    window.Capacitor = {
      Plugins: { App: { addListener: vi.fn((name, fn) => { if (name === 'backButton') backButton = fn; return Promise.resolve({ remove: vi.fn() }); }), exitApp } },
    };
    return { exitApp, back: () => backButton() };
  }

  test('from the TV grid Back leaves the app: /tv is a root, there is nothing behind it to step back to', async () => {
    setToken('t');
    shell('tv');
    mockApi(ADMIN);
    const { exitApp, back } = nativeApp();
    await boot('/');
    await waitFor(() => expect(onTv()).toBeTruthy());
    await screen.findByText('Nursery');
    await waitFor(() => expect(window.Capacitor.Plugins.App.addListener).toHaveBeenCalled());
    const before = window.location.hash;
    act(() => { back(); });
    expect(exitApp).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe(before);
  });

  test('★ in full screen Back closes full screen and does NOT exit; the next Back exits', async () => {
    setToken('t');
    shell('tv');
    mockApi(ADMIN);
    const { exitApp, back } = nativeApp();
    await boot('/');
    await screen.findByText('Nursery');
    await waitFor(() => expect(window.Capacitor.Plugins.App.addListener).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: 'ContextMenu' });
    expect(document.querySelector('.tv-tile--full')).toBeTruthy();
    act(() => { back(); });
    expect(document.querySelector('.tv-tile--full')).toBeNull();
    expect(exitApp).not.toHaveBeenCalled();
    // The echo guard swallows a duplicate report of the same press; a later one leaves the app.
    await new Promise((resolve) => { setTimeout(resolve, 450); });
    act(() => { back(); });
    expect(exitApp).toHaveBeenCalledTimes(1);
  });

  test('on a drill-in screen Back still steps back through history (unchanged for everyone else)', async () => {
    setToken('t');
    shell('phone');
    mockApi(ADMIN);
    const { exitApp, back } = nativeApp();
    await boot('/');
    await waitFor(() => expect(onLive()).toBeTruthy());
    await waitFor(() => expect(window.Capacitor.Plugins.App.addListener).toHaveBeenCalled());
    act(() => { go('/children'); });
    await waitFor(() => expect(onLive()).toBeNull());
    act(() => { back(); });
    // Wait for the SHELL to be back on the live screen (not just the address): the Back handler reads the router's location.
    await waitFor(() => expect(onLive()).toBeTruthy());
    expect(exitApp).not.toHaveBeenCalled();
    act(() => { back(); });
    expect(exitApp).toHaveBeenCalledTimes(1);
  });
});
