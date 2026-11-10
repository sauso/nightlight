import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import { AdminProtected } from '../src/App.jsx';
import SettingsRemoteAccess from '../src/pages/SettingsRemoteAccess.jsx';
import { api, setToken } from '../src/lib/api.js';
import { resetIceServersCache } from '../src/lib/iceServers.js';

const setup = {
  app_port: 4000, webrtc_udp_port: 8189, public_host_set: true,
  public_hosts: [{ host: 'example.org', kind: 'name', addresses: ['203.0.113.7'], error: null, behind_cloudflare: false }],
  advertised_hosts: ['203.0.113.7', '192.168.1.50'],
  stun: { enabled: true, servers: ['stun:stun.example.org'] }, trust_proxy: 'loopback',
  client: { network: 'remote' },
};
const camera = { id: 'c1', mediamtx_path: 'cam', disabled: false, status: { ready: true } };
const tailscale = { enabled: false, state: 'off', blocker: null, hostname: 'nightlight', serve: { enabled: false, consent_url: null }, video_address_pending: false };
let peers;
let requests;
let protocol;
let postResponse;
class Peer {
  constructor() { this.connectionState = 'new'; this.closed = false; peers.push(this); }
  addTransceiver() {}
  createOffer() { return Promise.resolve({ sdp: 'offer' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  getStats() { return Promise.resolve(new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { remoteCandidateId: 'remote' }],
    ['remote', { protocol, candidateType: 'host' }],
  ])); }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange(); }
  fail() { this.connectionState = 'failed'; this.onconnectionstatechange(); }
  close() { this.closed = true; this.connectionState = 'closed'; }
}
function mockSetup(data = setup, tailscaleView = tailscale) {
  vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path === '/remote-access' ? data : path === '/remote-access/tailscale' ? tailscaleView : { stunServers: [] }));
}
function renderPage(data = setup, cameras = [camera], tailscaleView = tailscale) {
  mockSetup(data, tailscaleView);
  return renderAsAdmin(<SettingsRemoteAccess />, { cameras });
}
async function run() {
  await openAdvanced();
  const button = await screen.findByRole('button', { name: 'Test from this device' });
  fireEvent.click(button);
  await waitFor(() => expect(requests.some((r) => r.options.method === 'POST')).toBe(true));
}
async function openAdvanced() {
  const summary = await screen.findByText('Use your own domain or port forward (advanced)');
  if (!summary.closest('details').open) fireEvent.click(summary);
}
beforeEach(() => {
  peers = []; requests = []; protocol = 'udp'; postResponse = null;
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('fetch', vi.fn((url, options) => {
    requests.push({ url, options });
    return options.method === 'POST'
      ? postResponse || Promise.resolve({ ok: true, headers: { get: () => '/live/cam/whep/session' }, text: async () => 'answer' })
      : Promise.resolve({ ok: true });
  }));
  setToken('token'); resetIceServersCache();
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetIceServersCache(); setToken(null); });

test('admin sees Tailscale first and the four own-domain cards when expanded', async () => {
  renderPage();
  expect(await screen.findByRole('button', { name: 'Turn on Tailscale' })).toBeInTheDocument();
  expect(screen.getByText('Your own-domain setup is working and stays as it is.')).toBeInTheDocument();
  expect(screen.getByText('Use your own domain or port forward (advanced)').closest('details').open).toBe(false);
  await openAdvanced();
  const titles = ["Where you're connecting from", 'Your setup', 'Setup checklist', 'Test Low latency video from this device'];
  for (const title of titles) {
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  }
  expect([...document.querySelectorAll('.remote-advanced > section h2')].map((heading) => heading.textContent)).toEqual(titles);
  expect(screen.queryByRole('heading', { name: 'Before watching from outside' })).toBeNull();
  expect(screen.queryByText(/Viewers who arrive over Tailscale show as/)).toBeNull();
  expect(requests).toHaveLength(0);
});

test('route guard turns a caregiver away without loading details', async () => {
  mockSetup();
  renderAsCaregiver(<Routes><Route path="/settings/remote-access" element={<AdminProtected><SettingsRemoteAccess /></AdminProtected>} /><Route path="/" element={<h1>Live</h1>} /></Routes>, { route: '/settings/remote-access' });
  expect(await screen.findByRole('heading', { name: 'Live' })).toBeInTheDocument();
  expect(api.get).not.toHaveBeenCalledWith('/remote-access');
});

test.each([
  ['home', "You're on your home network. From here this page can't prove your port forwards work: open it from mobile data to check."],
  ['vpn', "You're connected through a VPN (such as Tailscale). Remote access through your router isn't being tested from here."],
  ['remote', "You're outside your home network. A successful test below shows your port forwards work."],
  ['unknown', "Nightlight can't tell where you're connecting from."],
])('%s network explains the limit', async (network, sentence) => {
  renderPage({ ...setup, client: { network } });
  expect(await screen.findByText(sentence)).toBeInTheDocument();
});

test.each([
  ['tailscale', 'Tailscale', "This looks like a connection through your private Tailscale address. If so, your router isn't involved and the port-forward test below doesn't apply."],
  ['proxy', 'Unknown', "Nightlight received a forwarded address it doesn't trust, usually from a reverse proxy that TRUST_PROXY doesn't list, so it can't tell where you are."],
  [null, 'Unknown', "Nightlight can't tell where you're connecting from."],
])('#962 %s connection shows its own badge and guidance', async (via, badge, sentence) => {
  renderPage({ ...setup, client: { network: 'unknown', via } });
  await openAdvanced();
  const section = screen.getByRole('heading', { name: "Where you're connecting from" }).closest('section');
  expect(section.querySelector('.status-badge')).toHaveTextContent(badge);
  expect(section).toHaveTextContent(sentence);
  if (via === 'proxy') expect(section.querySelector(`a[href*="trust_proxy"]`)).not.toBeNull();
  else expect(section.textContent).not.toContain('TRUST_PROXY');
});

test('#962 the ready Tailscale card confirms this device without opening advanced', async () => {
  // The line is driven by the page's own origin being the device's .ts.net name (exact), not by the server's `via` guess.
  const readyTailscale = { ...tailscale, enabled: true, state: 'connected', dns_name: window.location.hostname, serve: { enabled: true } };
  renderPage({ ...setup, client: { network: 'unknown', via: 'tailscale' } }, [camera], readyTailscale);
  expect(await screen.findByText("You're viewing Nightlight through Tailscale right now.")).toBeInTheDocument();
  expect(screen.getByText('Use your own domain or port forward (advanced)').closest('details').open).toBe(false);
});

test('#962 an older server without via gives neutral unknown guidance', async () => {
  renderPage({ ...setup, client: { network: 'unknown' } });
  await openAdvanced();
  const section = screen.getByRole('heading', { name: "Where you're connecting from" }).closest('section');
  expect(section).toHaveTextContent("Nightlight can't tell where you're connecting from.");
  expect(section.textContent).not.toContain('TRUST_PROXY');
});

test('connection address, trusted proxy value, docs link and checklist status words appear', async () => {
  renderPage(); await openAdvanced();
  const connection = screen.getByRole('heading', { name: "Where you're connecting from" }).closest('section');
  expect(connection).toHaveTextContent(`You opened Nightlight at ${window.location.origin}`);
  expect(connection.querySelector('.tailscale-address')).toHaveTextContent(window.location.origin);
  const details = screen.getByRole('heading', { name: 'Your setup' }).closest('section');
  expect(details).toHaveTextContent('Trusted proxies (TRUST_PROXY): loopback');
  expect(details).toHaveTextContent('only a proxy running on this same server, the default');
  expect(details.querySelector('a[href*="trust_proxy"]')).toHaveTextContent('docs');
  const checklist = screen.getByRole('heading', { name: 'Setup checklist' }).closest('section');
  expect([...checklist.querySelectorAll('li .status-badge')].map((badge) => badge.textContent)).toEqual(['Check', 'OK', 'OK', 'Not checked', 'Not checked']);
});

test('UDP checklist row changes after the this-device test', async () => {
  renderPage(); await openAdvanced();
  const checklist = screen.getByRole('heading', { name: 'Setup checklist' }).closest('section');
  const udp = [...checklist.querySelectorAll('li')].find((item) => item.textContent.includes('UDP port forward'));
  expect(udp.querySelector('.status-badge')).toHaveTextContent('Not checked');
  await run();
  await act(async () => peers[0].connect());
  expect(udp.querySelector('.status-badge')).toHaveTextContent('OK');
  expect(udp).toHaveTextContent('connected over UDP from an address Nightlight counts as outside your home');
});

test('Tailscale viewer receives no TRUST_PROXY instruction', async () => {
  renderPage({ ...setup, client: { network: 'unknown', via: 'tailscale' } }); await openAdvanced();
  expect(document.body.textContent).not.toMatch(/TRUST_PROXY (doesn't|needs|must|should)/);
});

test('setup shows unset PUBLIC_HOST without treating a home visit as an error, and STUN off', async () => {
  renderPage({ ...setup, client: { network: 'home' }, public_host_set: false, public_hosts: [], advertised_hosts: ['192.168.1.50'], stun: { enabled: false, servers: [] } });
  expect(await screen.findByText('Not set. Low latency video from outside the home needs PUBLIC_HOST.')).toBeInTheDocument();
  expect(screen.getByText('Off')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('setup shows IP literal, resolved name, DNS errors, addresses and STUN privacy', async () => {
  renderPage({ ...setup, public_hosts: [
    { host: '203.0.113.8', kind: 'ip', addresses: ['203.0.113.8'], error: null },
    ...setup.public_hosts,
    { host: 'missing.example', kind: 'name', addresses: [], error: 'not_found' },
    { host: 'slow.example', kind: 'name', addresses: [], error: 'timeout' },
    { host: 'broken.example', kind: 'name', addresses: [], error: 'failed' },
  ] });
  expect(await screen.findByText('203.0.113.8 is an IP address, advertised as 203.0.113.8.')).toBeInTheDocument();
  for (const text of [/example.org resolves to 203/, /name not found/, /lookup timed out/, /lookup failed/, /203.0.113.7, 192.168.1.50/, /A STUN server can see/]) {
    expect(screen.getAllByText(text).length).toBeGreaterThan(0);
  }
});

test('failed load shows a banner and Retry loads again', async () => {
  const get = vi.spyOn(api, 'get').mockImplementation((path) => path === '/remote-access/tailscale' ? Promise.resolve(tailscale) : Promise.reject(new Error('offline')));
  const view = renderAsAdmin(<SettingsRemoteAccess />, { cameras: [camera] });
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load remote access details");
  get.mockImplementation((path) => Promise.resolve(path === '/remote-access' ? setup : tailscale));
  await view.user.click(screen.getByRole('button', { name: 'Retry' }));
  await openAdvanced();
  expect(await screen.findByRole('heading', { name: 'Your setup' })).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith('/remote-access');
});

test('a failed Tailscale read leaves the own-domain cards available', async () => {
  vi.spyOn(api, 'get').mockImplementation((path) => path === '/remote-access/tailscale'
    ? Promise.reject(new Error('offline')) : Promise.resolve(path === '/remote-access' ? setup : { demo: false }));
  renderAsAdmin(<SettingsRemoteAccess />, { cameras: [camera] });
  expect(await screen.findByText(/Couldn’t load Tailscale details/)).toBeInTheDocument();
  await openAdvanced();
  expect(screen.getByRole('heading', { name: 'Your setup' })).toBeInTheDocument();
});

test('no running enabled camera disables the test', async () => {
  renderPage(setup, [{ ...camera, disabled: true }, { ...camera, id: 'c2', status: { ready: false } }]);
  await openAdvanced();
  expect(await screen.findByText('No camera is running yet, so there is nothing to test. Add or start a camera first.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Test from this device' })).toBeDisabled();
});

test.each([
  ['remote', 'udp', 'Low latency video works from outside your home. Your port forward and PUBLIC_HOST are set up correctly.'],
  ['remote', 'tcp', 'Low latency video connected, but not over UDP. Check the UDP port forward.'],
  ['home', 'udp', "Connected, but you're not outside your home network, so this doesn't prove the forward works. Try again from mobile data."],
  ['vpn', 'udp', "Connected, but you're not outside your home network, so this doesn't prove the forward works. Try again from mobile data."],
])('%s %s connection has the right interpretation', async (network, selectedProtocol, sentence) => {
  protocol = selectedProtocol;
  renderPage({ ...setup, client: { network } });
  await run();
  await act(async () => peers[0].connect());
  expect(await screen.findByText(sentence)).toBeInTheDocument();
  expect(peers[0].closed).toBe(true);
  expect(requests[1].url).toBe('/live/cam/whep/session');
});

test('remote failure names the UDP port and PUBLIC_HOST', async () => {
  renderPage(); await run();
  await act(async () => peers[0].fail());
  expect(await screen.findByText(/Couldn't connect from outside. Check the UDP forward \(port 8189\) and PUBLIC_HOST/)).toBeInTheDocument();
});

test('#962 Tailscale success describes video without suggesting mobile data', async () => {
  renderPage({ ...setup, client: { network: 'unknown', via: 'tailscale' } });
  await run();
  await act(async () => peers[0].connect());
  const status = await screen.findByText('Low latency video works through Tailscale.');
  expect(status).toBeInTheDocument();
  expect(status.textContent).not.toMatch(/outside your home|mobile data/);
});

test('#962 Tailscale failure keeps the local connection guidance', async () => {
  renderPage({ ...setup, client: { network: 'unknown', via: 'tailscale' } });
  await run();
  await act(async () => peers[0].fail());
  expect(await screen.findByText("Couldn't connect. Low latency video isn't working from here (Compatibility mode still works).")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/TRUST_PROXY (doesn't|needs|must|should)/);
});

test('#962 Tailscale timeout keeps the local connection guidance', async () => {
  renderPage({ ...setup, client: { network: 'unknown', via: 'tailscale' } });
  await openAdvanced();
  const button = await screen.findByRole('button', { name: 'Test from this device' });
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(button); await vi.advanceTimersByTimeAsync(1000); });
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(screen.getByText("Couldn't connect. Low latency video isn't working from here (Compatibility mode still works).")).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/TRUST_PROXY (doesn't|needs|must|should)/);
});

test('timeout ends the probe and gives the same remote guidance', async () => {
  renderPage();
  await openAdvanced();
  const button = await screen.findByRole('button', { name: 'Test from this device' });
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(button); await vi.advanceTimersByTimeAsync(1000); });
  expect(requests[0].url).toBe('/live/cam/whep');
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(screen.getByText(/Check the UDP forward \(port 8189\)/)).toBeInTheDocument();
  expect(peers[0].closed).toBe(true);
  expect(requests[1].url).toBe('/live/cam/whep/session');
});

test.each([
  ['outside home', setup],
  ['Tailscale', { ...setup, client: { network: 'unknown', via: 'tailscale' } }],
])('unsupported browser gives a plain result through %s', async (_route, data) => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  renderPage(data);
  await openAdvanced();
  fireEvent.click(await screen.findByRole('button', { name: 'Test from this device' }));
  expect(await screen.findByText("This browser can't make a Low latency connection.")).toBeInTheDocument();
  if (data.client.via === 'tailscale') expect(document.body.textContent).not.toMatch(/TRUST_PROXY (doesn't|needs|must|should)/);
});

test('double click starts one probe and keeps the button busy', async () => {
  renderPage();
  await openAdvanced();
  const button = await screen.findByRole('button', { name: 'Test from this device' });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(peers).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Testing…' })).toBeDisabled();
});

test('a result stays visible until another manual run starts', async () => {
  renderPage(); await run();
  await act(async () => peers[0].connect());
  const sentence = 'Low latency video works from outside your home. Your port forward and PUBLIC_HOST are set up correctly.';
  expect(screen.getByText(sentence)).toBeInTheDocument();
  expect(requests.filter((r) => r.options.method === 'POST')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Test from this device' }));
  expect(screen.queryByText(sentence)).toBeNull();
  await waitFor(() => expect(requests.filter((r) => r.options.method === 'POST')).toHaveLength(2));
});

test('unmount closes the peer and sends DELETE, including a late POST response', async () => {
  let answer;
  postResponse = new Promise((resolve) => { answer = resolve; });
  const view = renderPage(); await run();
  view.unmount();
  expect(peers[0].closed).toBe(true);
  answer({ ok: true, headers: { get: () => '/live/cam/whep/session' }, text: async () => 'answer' });
  await waitFor(() => expect(requests[1].url).toBe('/live/cam/whep/session'));
});
