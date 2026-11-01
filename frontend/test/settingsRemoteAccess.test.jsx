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
  public_hosts: [{ host: 'example.org', kind: 'name', addresses: ['203.0.113.7'], error: null }],
  advertised_hosts: ['203.0.113.7', '192.168.1.50'],
  stun: { enabled: true, servers: ['stun:stun.example.org'] }, trust_proxy: 'loopback',
  client: { network: 'remote' },
};
const camera = { id: 'c1', mediamtx_path: 'cam', disabled: false, status: { ready: true } };
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
function mockSetup(data = setup) {
  vi.spyOn(api, 'get').mockImplementation((path) => Promise.resolve(path === '/remote-access' ? data : { stunServers: [] }));
}
function renderPage(data = setup, cameras = [camera]) {
  mockSetup(data);
  return renderAsAdmin(<SettingsRemoteAccess />, { cameras });
}
async function run() {
  const button = await screen.findByRole('button', { name: 'Test from this device' });
  fireEvent.click(button);
  await waitFor(() => expect(requests.some((r) => r.options.method === 'POST')).toBe(true));
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

test('admin sees all cards and the static Tailscale row', async () => {
  renderPage();
  for (const title of ["How you're connected right now", 'Your setup', 'Test Low latency video from this device', 'Before watching from outside']) {
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
  }
  expect(screen.getByText('Tailscale')).toBeInTheDocument();
  expect(screen.getByText('Coming later')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Tailscale' })).toBeNull();
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
  ['unknown', /Nightlight can't tell whether you're at home/],
])('%s network explains the limit', async (network, sentence) => {
  renderPage({ ...setup, client: { network } });
  expect(await screen.findByText(sentence)).toBeInTheDocument();
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
    expect(screen.getByText(text)).toBeInTheDocument();
  }
});

test('failed load shows a banner and Retry loads again', async () => {
  const get = vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(setup);
  const view = renderAsAdmin(<SettingsRemoteAccess />, { cameras: [camera] });
  expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load remote access details");
  await view.user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('heading', { name: 'Your setup' })).toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(2);
});

test('no running enabled camera disables the test', async () => {
  renderPage(setup, [{ ...camera, disabled: true }, { ...camera, id: 'c2', status: { ready: false } }]);
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

test('timeout ends the probe and gives the same remote guidance', async () => {
  renderPage();
  const button = await screen.findByRole('button', { name: 'Test from this device' });
  vi.useFakeTimers();
  await act(async () => { fireEvent.click(button); await vi.advanceTimersByTimeAsync(1000); });
  expect(requests[0].url).toBe('/live/cam/whep');
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(screen.getByText(/Check the UDP forward \(port 8189\)/)).toBeInTheDocument();
  expect(peers[0].closed).toBe(true);
  expect(requests[1].url).toBe('/live/cam/whep/session');
});

test('unsupported browser gives a plain result', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Test from this device' }));
  expect(await screen.findByText("This browser can't make a Low latency connection.")).toBeInTheDocument();
});

test('double click starts one probe and keeps the button busy', async () => {
  renderPage();
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
