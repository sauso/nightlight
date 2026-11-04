import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import TailscaleCard from '../src/components/TailscaleCard.jsx';
import { useTailscale } from '../src/lib/useTailscale.js';
import { videoTestMessage } from '../src/lib/tailscaleCopy.js';
import { probeLowLatency } from '../src/lib/webrtcProbe.js';
import { api } from '../src/lib/api.js';

const demo = vi.hoisted(() => ({ value: null }));
vi.mock('../src/lib/demoStatus.js', () => ({ useDemoStatus: () => demo.value }));
vi.mock('../src/lib/webrtcProbe.js', () => ({ probeLowLatency: vi.fn() }));

const base = { enabled: false, state: 'off', blocker: null, hostname: 'nightlight', login_url: null,
  dns_name: null, serve: { enabled: false, consent_url: null }, video_address_pending: false, last_error: null };
const waiting = { ...base, enabled: true, state: 'needs-sign-in' };
const connected = { ...base, enabled: true, state: 'connected', dns_name: 'nightlight.example.ts.net',
  addresses: ['100.101.102.103'] };
const ready = { ...connected, serve: { enabled: true, consent_url: null } };
const camera = { id: 'cam', status: { ready: true }, mediamtx_path: 'camera', disabled: false };

function card(view = base, options = {}) {
  vi.spyOn(api, 'get').mockImplementation(async (path) => path === '/remote-access/tailscale' ? view : { demo: false });
  vi.spyOn(api, 'put').mockResolvedValue({ ...view, enabled: true, state: 'starting' });
  vi.spyOn(api, 'post').mockResolvedValue(view);
  return renderAsAdmin(<TailscaleCard {...options} />, { cameras: [camera] });
}

beforeEach(() => { demo.value = null; });
afterEach(() => { vi.useRealTimers(); });

test.each([
  [base, 'Turn on Tailscale'],
  [{ ...base, enabled: true, state: 'starting' }, 'Retry'],
  [waiting, 'Sign in with Tailscale'],
  [{ ...waiting, login_url: 'https://login.tailscale.com/a/token' }, 'Open Tailscale sign-in'],
  [connected, 'Turn on the secure address'],
  [ready, 'Open'],
  [{ ...base, enabled: true, state: 'error' }, 'Retry'],
])('state %s offers its next step', async (view, label) => {
  card(view);
  expect(await screen.findByText(label)).toBeInTheDocument();
});

test.each([
  ['host_network', "Nightlight can't use Tailscale while it shares your server's network."],
  ['no_admin', 'Create your admin account first.'],
  ['not_installed', "This version of Nightlight doesn't include Tailscale."],
  ['unexpected_code', "Tailscale can't be turned on right now."],
])('blocker %s is explained without exposing its code', async (blocker, sentence) => {
  card({ ...base, blocker });
  expect(await screen.findByText((content) => content.startsWith(sentence))).toBeInTheDocument();
  expect(screen.queryByText(blocker)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Turn on Tailscale' })).toBeNull();
});

test('turning on sends the boolean setting', async () => {
  const view = card();
  await view.user.click(await screen.findByRole('button', { name: 'Turn on Tailscale' }));
  expect(api.put).toHaveBeenCalledWith('/remote-access/tailscale', { enabled: true });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Retry' })));
});

test.each([
  ['busy', 'Tailscale is finishing another step. Try again in a moment.'],
  ['cli_failed', "Couldn't turn on the secure address."],
])('a %s action refusal uses plain copy', async (code, sentence) => {
  const view = card(connected);
  vi.spyOn(api, 'post').mockRejectedValueOnce(Object.assign(new Error(code), { status: 409, data: { code } }));
  await view.user.click(await screen.findByRole('button', { name: 'Turn on the secure address' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(sentence);
  expect(screen.queryByText(code)).toBeNull();
});

test('sign-in is an HTTPS link with a local QR, while a script URL is not linked', async () => {
  const view = card({ ...waiting, login_url: 'https://login.tailscale.com/a/token' });
  const link = await screen.findByRole('link', { name: 'Open Tailscale sign-in' });
  expect(link).toHaveAttribute('href', 'https://login.tailscale.com/a/token');
  expect(screen.getByRole('img', { name: 'Scan to sign in to Tailscale' })).toBeInTheDocument();
  view.unmount();
  card({ ...waiting, login_url: 'javascript:alert(1)' });
  expect(await screen.findByRole('button', { name: 'Sign in with Tailscale' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Open Tailscale sign-in' })).toBeNull();
});

test('a rejected HTTPS action shows only a safe approval link and a retry', async () => {
  const view = card(connected);
  vi.spyOn(api, 'post').mockRejectedValueOnce(Object.assign(new Error('conflict'), {
    data: { code: 'consent_required', consent_url: 'https://login.tailscale.com/admin/dns' }, status: 409,
  }));
  await view.user.click(await screen.findByRole('button', { name: 'Turn on the secure address' }));
  expect(await screen.findByRole('link', { name: 'Open Tailscale approval' })).toHaveAttribute('href', 'https://login.tailscale.com/admin/dns');
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
});

test('a connected probe proves Tailscale only on the tailnet origin', async () => {
  vi.mocked(probeLowLatency).mockResolvedValue({ outcome: 'connected' });
  const view = card(ready);
  await view.user.click(await screen.findByRole('button', { name: 'Check it works' }));
  expect(await screen.findByText("This page isn't open through Tailscale, so this doesn't prove it works away from home. Open your secure address from your phone over Tailscale to check.")).toBeInTheDocument();
  expect(screen.queryByText('Low latency video works through Tailscale.')).toBeNull();
  expect(videoTestMessage({ outcome: 'connected' }, true)).toBe('Low latency video works through Tailscale.');
  expect(videoTestMessage({ outcome: 'failed' }, true)).toContain("Couldn't connect.");
  expect(videoTestMessage({ outcome: 'timeout' }, false)).toContain('Standard (HLS) video still works.');
});

test('rename restores HTTPS Serve after changing the hostname', async () => {
  const view = card(ready);
  fireEvent.click(await screen.findByText('Advanced'));
  fireEvent.change(screen.getByRole('textbox', { name: 'Rename this device' }), { target: { value: 'second-device' } });
  await view.user.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(api.post.mock.calls.map((call) => call[1])).toEqual([
    { action: 'hostname', hostname: 'second-device' }, { action: 'serve-enable' },
  ]);
});

test.each([
  ['logout', 'Log out of Tailscale', 'Log out'],
  ['reset', "Reset this device's Tailscale identity", 'Reset identity'],
])('%s requires confirmation and cancelling sends nothing', async (action, opener, confirm) => {
  const view = card(ready);
  fireEvent.click(await screen.findByText('Advanced'));
  await view.user.click(screen.getByRole('button', { name: opener }));
  const dialog = screen.getByRole('dialog');
  if (action === 'reset') expect(dialog).toHaveTextContent('copied installation');
  await view.user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(api.post).not.toHaveBeenCalled();
  await view.user.click(screen.getByRole('button', { name: opener }));
  await view.user.click(within(screen.getByRole('dialog')).getByRole('button', { name: confirm }));
  expect(api.post).toHaveBeenCalledWith('/remote-access/tailscale/actions', { action });
});

test('reset remains available after turning Tailscale off', async () => {
  const view = card(base);
  fireEvent.click(await screen.findByText('Advanced'));
  await view.user.click(screen.getByRole('button', { name: "Reset this device's Tailscale identity" }));
  expect(screen.getByRole('dialog')).toHaveTextContent('copied installation');
  expect(api.post).not.toHaveBeenCalled();
});

// Turning Tailscale off from a page that arrived through Tailscale cuts the branch the admin is sitting on.
test('a confirmation warns when this page is open through Tailscale', async () => {
  const view = card({ ...ready, dns_name: window.location.hostname });
  fireEvent.click(await screen.findByText('Advanced'));
  await view.user.click(screen.getByRole('button', { name: 'Turn off Tailscale' }));
  expect(screen.getByRole('dialog')).toHaveTextContent('You are viewing this page through Tailscale');
});

test('a confirmation from another origin has no such warning', async () => {
  const view = card(ready);
  fireEvent.click(await screen.findByText('Advanced'));
  await view.user.click(screen.getByRole('button', { name: 'Turn off Tailscale' }));
  expect(screen.getByRole('dialog')).not.toHaveTextContent('You are viewing this page through Tailscale');
});

test('turning off the secure address also needs confirmation', async () => {
  const view = card(ready);
  fireEvent.click(await screen.findByText('Advanced'));
  await view.user.click(screen.getByRole('button', { name: 'Turn off the secure address' }));
  await view.user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(api.post).not.toHaveBeenCalled();
});

test('the demo disables every change and open link', async () => {
  demo.value = { endsAt: 'later' };
  card(ready);
  fireEvent.click(await screen.findByText('Advanced'));
  for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled();
  expect(screen.queryByRole('link', { name: 'Open' })).toBeNull();
  expect(screen.getByText('This demo is read-only, so changes are disabled.')).toBeInTheDocument();
});

test('Copy writes the secure address', async () => {
  const view = card(ready);
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  await view.user.click(await screen.findByRole('button', { name: 'Copy' }));
  expect(writeText).toHaveBeenCalledWith('https://nightlight.example.ts.net/');
});

test('a pending video address offers Apply now', async () => {
  const pending = { ...ready, video_address_pending: true };
  const view = card(pending);
  expect(await screen.findByText('Low latency video: updating. Viewers reconnect once.')).toBeInTheDocument();
  await view.user.click(screen.getByRole('button', { name: 'Apply now' }));
  expect(api.post).toHaveBeenCalledWith('/remote-access/tailscale/actions', { action: 'apply-video-address' });
});

test('the video check waits for a ready camera', async () => {
  vi.spyOn(api, 'get').mockImplementation(async () => ready);
  renderAsAdmin(<TailscaleCard />, { cameras: [] });
  expect(await screen.findByText('No camera is running yet, so there is nothing to test. Add or start a camera first.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Check it works' })).toBeDisabled();
});

test('a failed refresh keeps the last good view', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValueOnce(ready).mockRejectedValueOnce(new Error('offline'));
  const hook = renderHook(() => useTailscale());
  await waitFor(() => expect(hook.result.current.view).toEqual(ready));
  await act(async () => { await hook.result.current.load(); });
  expect(hook.result.current.view).toEqual(ready);
  expect(hook.result.current.error).toBe("Couldn't load Tailscale details.");
  expect(get).toHaveBeenCalledTimes(2);
});

test.each([
  [{ ...base, enabled: true, state: 'starting' }, 3000],
  [{ ...waiting, login_url: 'https://login.tailscale.com/a/token' }, 3000],
  [{ ...ready, video_address_pending: true }, 15000],
])('polls %s every %s ms and stops while hidden or unmounted', async (view, interval) => {
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  const get = vi.spyOn(api, 'get').mockResolvedValue(view);
  vi.useFakeTimers();
  const hook = renderHook(() => useTailscale());
  await act(async () => {});
  expect(get).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(interval); });
  expect(get).toHaveBeenCalledTimes(2);
  hidden = true;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => { await vi.advanceTimersByTimeAsync(interval * 2); });
  expect(get).toHaveBeenCalledTimes(2);
  hidden = false;
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  hook.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(interval); });
  expect(get).toHaveBeenCalledTimes(2);
});

// Codex review of #978 (verified): the server also says 'not pending' before it has found the address, so a ready line
// built on that flag claimed more than was known.
test('nothing claims video is ready when no update is waiting', async () => {
  card(ready);
  await screen.findByText('Your secure address');
  expect(screen.queryByText(/Low latency video: ready/)).toBeNull();
  expect(screen.queryByText(/Low latency video: updating/)).toBeNull();
});

// Codex review of #978 (verified): the sign-in link replaces the button inside the same state, and focus fell to <body>.
test('keyboard focus follows the card to the sign-in link', async () => {
  const view = card(waiting);
  api.post.mockResolvedValue({ ...waiting, login_url: 'https://login.tailscale.com/a/token' });
  await view.user.click(await screen.findByRole('button', { name: 'Sign in with Tailscale' }));
  const link = await screen.findByRole('link', { name: 'Open Tailscale sign-in' });
  await waitFor(() => expect(link).toHaveFocus());
});

test('in the demo a failed load offers no Retry', async () => {
  demo.value = { demo: true };
  vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
  renderAsAdmin(<TailscaleCard />, { cameras: [camera] });
  await screen.findByText(/Couldn.t load Tailscale details/);
  expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
});

// MEASURED 2026-11-04: a reset on a tailnet that still held the old entry produced the name nightlight-staging-1,
// while the saved setting stayed nightlight-staging.
test('rename starts from the name the device really has', async () => {
  const view = card({ ...ready, hostname: 'nightlight-staging', dns_name: 'nightlight-staging-1.example.ts.net' });
  fireEvent.click(await screen.findByText('Advanced'));
  expect(screen.getByLabelText('Rename this device')).toHaveValue('nightlight-staging-1');
  expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  await view.user.clear(screen.getByLabelText('Rename this device'));
  await view.user.type(screen.getByLabelText('Rename this device'), 'nightlight-staging');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});
