// The live-view player takes its ICE (STUN) servers from the server's STUN_SERVERS setting (#558).
//
// Before #558 the player built `new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] })`
// whatever the operator wanted. Here the REAL WhepPlayer is mounted with a stubbed RTCPeerConnection that records
// the configuration it was given and a stubbed fetch that answers GET /api/about like the server.
//
// NOT COVERED: that a real browser contacts nobody when the list is empty (jsdom has no ICE), and the server half
// (backend/test/stun-servers.test.js).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import WhepPlayer from '../src/components/WhepPlayer.jsx';
import { setToken } from '../src/lib/api.js';
import { getIceServers, getIceServersWithin, resetIceServersCache } from '../src/lib/iceServers.js';

let configs;
let aboutAnswer;
let aboutCalls;

class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    configs.push(config);
  }
  addTransceiver() {}
  async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  close() { this.connectionState = 'closed'; }
}

beforeEach(() => {
  configs = [];
  aboutCalls = 0;
  aboutAnswer = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ version: '1', stunServers: [] }) });
  resetIceServersCache();
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    if (init.method === 'GET' && String(url).endsWith('/api/about')) { aboutCalls += 1; return aboutAnswer(); }
    return { ok: true, status: 201, headers: { get: () => null }, text: async () => 'v=0 answer' };
  }));
  setToken('t');
});
afterEach(() => { vi.unstubAllGlobals(); setToken(null); });

const answerWith = (stunServers) => () => ({
  ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ version: '1', stunServers }),
});

describe('#558 the player uses the server\'s STUN list', () => {
  test('#558 a configured list becomes one iceServers entry with exactly those URLs', async () => {
    aboutAnswer = answerWith(['stun:a.example.org:3478', 'stun:b.example.org:3478']);
    render(<WhepPlayer mediamtxPath="cam1" active muted />);
    await waitFor(() => expect(configs).toHaveLength(1));
    expect(configs[0]).toEqual({ iceServers: [{ urls: ['stun:a.example.org:3478', 'stun:b.example.org:3478'] }] });
  });

  test('#558 an EMPTY list gives iceServers: [] (no STUN, and not the old Google default)', async () => {
    aboutAnswer = answerWith([]);
    render(<WhepPlayer mediamtxPath="cam1" active muted />);
    await waitFor(() => expect(configs).toHaveLength(1));
    expect(configs[0]).toEqual({ iceServers: [] });
    expect(JSON.stringify(configs[0])).not.toMatch(/google/i);
  });

  test('#558 if /api/about cannot be read the player still connects, with NO STUN (never Google), and asks again next time', async () => {
    aboutAnswer = () => { throw new TypeError('offline'); };
    const { unmount } = render(<WhepPlayer mediamtxPath="cam1" active muted />);
    await waitFor(() => expect(configs).toHaveLength(1));
    expect(configs[0]).toEqual({ iceServers: [] });
    unmount();
    aboutAnswer = answerWith(['stun:a.example.org:3478']);
    expect(await getIceServers()).toEqual([{ urls: ['stun:a.example.org:3478'] }]);
  });

  test('#558 a server that sends no stunServers field (older build) is treated as no STUN', async () => {
    aboutAnswer = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ version: '0.38.0' }) });
    expect(await getIceServers()).toEqual([]);
  });

  // Post-merge review of PR #701 (mutant F3): with `if (!urls) throw` turned into `return []` every test passed, but
  // the missing field was then REMEMBERED as a successful "no STUN" for the life of the page, so a remote viewer
  // stayed without STUN after the server came back (an upgrade, a proxy that served a stale /about) until a reload.
  test('#701 review an /about with no stunServers field is NOT remembered: the next lookup asks again', async () => {
    aboutAnswer = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ version: '0.38.0' }) });
    expect(await getIceServers()).toEqual([]);
    aboutAnswer = answerWith(['stun:a.example.org:3478']);
    expect(await getIceServers()).toEqual([{ urls: ['stun:a.example.org:3478'] }]);
    expect(aboutCalls).toBe(2);
  });

  // Mutant F4: without the `typeof u === 'string'` filter, whatever the JSON held went straight into iceServers.
  test('#701 review entries that are not text are dropped from the list the player is given', async () => {
    aboutAnswer = answerWith(['stun:a.example.org:3478', 5, null, { urls: 'stun:x.example.org' }, ['stun:y.example.org'], 'stun:b.example.org:3478']);
    expect(await getIceServers()).toEqual([{ urls: ['stun:a.example.org:3478', 'stun:b.example.org:3478'] }]);
  });

  test('#558 a successful answer is remembered: many tiles cost one request', async () => {
    aboutAnswer = answerWith(['stun:a.example.org:3478']);
    await Promise.all([getIceServers(), getIceServers(), getIceServers()]);
    await getIceServers();
    expect(aboutCalls).toBe(1);
  });
});

// #701 review (P2): the ICE-server lookup used to run BEFORE the 2s first-connection timer was armed, so a
// /api/about that never answered held CameraTile's fall-back to Compatibility mode for the API client's 30s timeout.
// Here /api/about NEVER settles and the clock is faked.
describe('#701 a hung /api/about cannot delay the first-connection deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    aboutAnswer = () => new Promise(() => {});
  });
  afterEach(() => { vi.useRealTimers(); });

  test('#701 onFirstConnectFailed fires at 2s, not before and not at the API timeout', async () => {
    const onFirstConnectFailed = vi.fn();
    render(<WhepPlayer mediamtxPath="cam1" active muted onFirstConnectFailed={onFirstConnectFailed} />);
    await vi.advanceTimersByTimeAsync(1999);
    expect(onFirstConnectFailed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(onFirstConnectFailed).toHaveBeenCalledTimes(1);
  });

  test('#701 the lookup gives up after 1s: the connection is built with NO STUN (never Google)', async () => {
    render(<WhepPlayer mediamtxPath="cam1" active muted />);
    await vi.advanceTimersByTimeAsync(999);
    expect(configs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(configs).toEqual([{ iceServers: [] }]);
  });

  test('#701 unmounting while the lookup is pending builds no peer connection', async () => {
    const { unmount } = render(<WhepPlayer mediamtxPath="cam1" active muted />);
    await vi.advanceTimersByTimeAsync(500);
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(configs).toHaveLength(0);
  });

  test('#701 an unmounted player does not fire onFirstConnectFailed at 2s', async () => {
    const onFirstConnectFailed = vi.fn();
    const { unmount } = render(<WhepPlayer mediamtxPath="cam1" active muted onFirstConnectFailed={onFirstConnectFailed} />);
    unmount();
    await vi.advanceTimersByTimeAsync(5000);
    expect(onFirstConnectFailed).not.toHaveBeenCalled();
  });

  test('#701 getIceServersWithin answers [] at the budget and a late success is still cached', async () => {
    let release;
    aboutAnswer = () => new Promise((resolve) => { release = () => resolve(answerWith(['stun:a.example.org:3478'])()); });
    const pending = getIceServersWithin(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([]);
    release();
    expect(await getIceServers()).toEqual([{ urls: ['stun:a.example.org:3478'] }]);
    expect(aboutCalls).toBe(1);
  });
});
