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
import { getIceServers, resetIceServersCache } from '../src/lib/iceServers.js';

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

  test('#558 a successful answer is remembered: many tiles cost one request', async () => {
    aboutAnswer = answerWith(['stun:a.example.org:3478']);
    await Promise.all([getIceServers(), getIceServers(), getIceServers()]);
    await getIceServers();
    expect(aboutCalls).toBe(1);
  });
});
