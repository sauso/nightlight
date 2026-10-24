// #559: the dialog that asks before an alert or link moves the app to another server. The rules about WHICH
// server may be offered are pinned in test/lib/serverSwitch.test.js; this pins what the person sees and can do:
//   - a saved server: "Switch server?" with the canonical origin only, Stay focused first, Stay (and Escape)
//     change nothing, Switch saves the stored entry once, a failed switch says so INSIDE the dialog;
//   - an unsaved server: a refusal with a single OK and no way to add the server from here;
//   - the native shell's held request is collected on load and on its window event, and an app that cannot
//     answer (iOS, older versions) shows nothing and throws nothing;
//   - it is mounted outside the sign-in gate: it appears while sign-in is still resolving, when the rest of
//     the app renders nothing at all.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HashRouter } from 'react-router-dom';
import ServerSwitchPrompt from '../src/components/ServerSwitchPrompt.jsx';
import App from '../src/App.jsx';
import { api, setToken } from '../src/lib/api.js';
import * as push from '../src/lib/pushNotifications.js';
import { SERVER_REQUEST_EVENT, dismissServerSwitchPrompt, getServerSwitchPrompt } from '../src/lib/nativeBridge.js';

const GOOD = 'https://good.example';

function stubNative({ servers = [], pending = null, takePending } = {}) {
  const ServerConfig = {
    list: vi.fn().mockResolvedValue({ servers, active: window.location.origin }),
    save: vi.fn(async ({ url }) => ({ url })),
    restart: vi.fn().mockResolvedValue(undefined),
    takePending: takePending ?? vi.fn().mockResolvedValue({ server: pending }),
  };
  window.Capacitor = { isNativePlatform: () => true, Plugins: { ServerConfig, BackgroundAudio: { stop: vi.fn().mockResolvedValue(undefined) } } };
  return ServerConfig;
}

// The native shell saying "I am holding a request": the next takePending answers with `server`.
async function nativeRequest(SC, server) {
  SC.takePending.mockResolvedValueOnce({ server });
  await act(async () => { window.dispatchEvent(new Event(SERVER_REQUEST_EVENT)); });
}

beforeEach(() => {
  // No sign-in token, so the advertised-address lookup never runs here (it is covered in the lib test).
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
});

afterEach(() => {
  // The prompt store is module state: close anything a test left open so the next starts clean.
  const open = getServerSwitchPrompt();
  if (open) act(() => dismissServerSwitchPrompt(open.id));
  delete window.Capacitor;
});

describe('★ #559 a saved server: ask first', () => {
  test('★ shows only the canonical origin, focuses Stay, and Stay changes nothing', async () => {
    const SC = stubNative({ servers: [GOOD] });
    render(<ServerSwitchPrompt />);
    await nativeRequest(SC, 'HTTPS://GOOD.EXAMPLE:443/');

    const dialog = await screen.findByRole('dialog', { name: 'Switch server?' });
    expect(within(dialog).getByText(GOOD)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(/GOOD\.EXAMPLE|:443/);
    const stay = within(dialog).getByRole('button', { name: 'Stay' });
    expect(stay).toHaveFocus();

    await userEvent.click(stay);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(SC.save).not.toHaveBeenCalled();
    expect(SC.restart).not.toHaveBeenCalled();
  });

  test('Escape is Stay too', async () => {
    const SC = stubNative({ servers: [GOOD] });
    render(<ServerSwitchPrompt />);
    await nativeRequest(SC, GOOD);
    await screen.findByRole('dialog', { name: 'Switch server?' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(SC.save).not.toHaveBeenCalled();
  });

  test('★ Switch saves the stored entry, once, then restarts', async () => {
    const STORED = 'https://good.example:443';
    const SC = stubNative({ servers: [STORED] });
    render(<ServerSwitchPrompt />);
    await nativeRequest(SC, GOOD);
    const dialog = await screen.findByRole('dialog', { name: 'Switch server?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Switch' }));
    await waitFor(() => expect(SC.restart).toHaveBeenCalledTimes(1));
    expect(SC.save).toHaveBeenCalledTimes(1);
    expect(SC.save).toHaveBeenCalledWith({ url: STORED });
  });

  test('a switch that fails says so inside the dialog, which stays open to retry or stay', async () => {
    const SC = stubNative({ servers: [GOOD] });
    SC.save.mockRejectedValue(new Error('unreachable'));
    render(<ServerSwitchPrompt />);
    await nativeRequest(SC, GOOD);
    const dialog = await screen.findByRole('dialog', { name: 'Switch server?' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Switch' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/couldn’t switch/i);
    expect(within(dialog).getByRole('button', { name: 'Stay' })).toBeEnabled();
    expect(SC.restart).not.toHaveBeenCalled();
  });
});

describe('★ #559 an unsaved server: refuse', () => {
  test('★ a single OK, no way to add or switch from here, and OK changes nothing', async () => {
    const SC = stubNative({ servers: ['http://good.example', 'https://good.example.evil'] });
    render(<ServerSwitchPrompt />);
    await nativeRequest(SC, GOOD);

    const dialog = await screen.findByRole('dialog', { name: 'Server not saved in this app' });
    expect(within(dialog).getByText(GOOD)).toBeInTheDocument();
    // The header's ✕ (the Modal's own close) and OK: nothing else.
    const names = within(dialog).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent);
    expect(names.sort()).toEqual(['Close', 'OK']);
    expect(within(dialog).getByRole('button', { name: 'OK' })).toHaveFocus();

    await userEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(SC.save).not.toHaveBeenCalled();
  });
});

describe('★ #559 collecting the native shell\'s held request', () => {
  test('★ once on load (a cold start fires no event) and again on each event', async () => {
    const SC = stubNative({ servers: [GOOD], pending: GOOD });
    render(<ServerSwitchPrompt />);
    expect(await screen.findByRole('dialog', { name: 'Switch server?' })).toBeInTheDocument();
    expect(SC.takePending).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: 'Stay' }));
    await nativeRequest(SC, 'https://other.example');
    expect(SC.takePending).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('dialog', { name: 'Server not saved in this app' })).toBeInTheDocument();
  });

  test('★ an app without takePending: nothing shown, nothing thrown, on load or on the event', async () => {
    const takePending = vi.fn().mockRejectedValue(new Error('not implemented'));
    stubNative({ servers: [GOOD], takePending });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ServerSwitchPrompt />);
    await act(async () => { window.dispatchEvent(new Event(SERVER_REQUEST_EVENT)); });
    await waitFor(() => expect(takePending).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  });

  test('the listener goes away with the component', async () => {
    const SC = stubNative({ servers: [GOOD] });
    const { unmount } = render(<ServerSwitchPrompt />);
    await waitFor(() => expect(SC.takePending).toHaveBeenCalledTimes(1));
    unmount();
    window.dispatchEvent(new Event(SERVER_REQUEST_EVENT));
    expect(SC.takePending).toHaveBeenCalledTimes(1);
  });
});

describe('★ #559 mounted outside the sign-in gate', () => {
  afterEach(() => {
    setToken(null);
    window.location.hash = '';
  });

  test('★ the dialog appears while sign-in is still resolving, when the rest of the app shows nothing', async () => {
    vi.spyOn(push, 'initPushNotifications').mockResolvedValue(undefined);
    // /auth/me never answers, so Shell stays on its "render nothing" branch for the whole test.
    vi.spyOn(api, 'get').mockImplementation((p) => (String(p).startsWith('/auth/me') ? new Promise(() => {}) : Promise.resolve({})));
    setToken('a-token');
    stubNative({ servers: [GOOD], pending: GOOD });
    render(<HashRouter><App /></HashRouter>);
    expect(await screen.findByRole('dialog', { name: 'Switch server?' })).toBeInTheDocument();
    expect(document.querySelector('.app-shell, .login-page, form')).toBeNull();
  });
});
