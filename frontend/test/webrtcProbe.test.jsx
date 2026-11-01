import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { probeLowLatency, selectedRemoteCandidate } from '../src/lib/webrtcProbe.js';
import { api, setToken } from '../src/lib/api.js';
import { resetIceServersCache } from '../src/lib/iceServers.js';

let peers;
let requests;
class Peer {
  constructor() { this.connectionState = 'new'; this.closed = false; peers.push(this); }
  addTransceiver(kind, options) { this.transceiver = { kind, options }; }
  createOffer() { return Promise.resolve({ sdp: 'offer' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  getStats() { return Promise.resolve(new Map([
    ['transport', { type: 'transport', selectedCandidatePairId: 'pair' }],
    ['pair', { type: 'candidate-pair', remoteCandidateId: 'remote' }],
    ['remote', { type: 'remote-candidate', protocol: 'udp', candidateType: 'host' }],
  ])); }
  connect() { this.connectionState = 'connected'; this.onconnectionstatechange(); }
  fail() { this.connectionState = 'failed'; this.onconnectionstatechange(); }
  close() { this.closed = true; this.connectionState = 'closed'; }
}
const response = { ok: true, headers: { get: () => '/live/cam/whep/session' }, text: async () => 'answer' };
beforeEach(() => {
  peers = []; requests = [];
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.stubGlobal('fetch', vi.fn((url, options) => { requests.push({ url, options }); return Promise.resolve(response); }));
  vi.spyOn(api, 'get').mockResolvedValue({ stunServers: [] });
  resetIceServersCache();
  setToken('test-token');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); resetIceServersCache(); setToken(null); });

describe('candidate pair stats', () => {
  test('uses the transport-selected pair', () => {
    const stats = new Map([
      ['transport', { type: 'transport', selectedCandidatePairId: 'selected' }],
      ['selected', { type: 'candidate-pair', remoteCandidateId: 'tcp' }],
      ['other', { type: 'candidate-pair', nominated: true, state: 'succeeded', remoteCandidateId: 'udp' }],
      ['tcp', { protocol: 'tcp', candidateType: 'srflx' }], ['udp', { protocol: 'udp', candidateType: 'host' }],
    ]);
    expect(selectedRemoteCandidate(stats)).toEqual({ protocol: 'tcp', candidateType: 'srflx' });
  });
  test('falls back to a nominated, succeeded pair', () => {
    const stats = new Map([['pair', { type: 'candidate-pair', nominated: true, state: 'succeeded', remoteCandidateId: 'remote' }], ['remote', { protocol: 'udp', candidateType: 'host' }]]);
    expect(selectedRemoteCandidate(stats)).toEqual({ protocol: 'udp', candidateType: 'host' });
  });
});

test('connects on only the camera WHEP path and tears down after success', async () => {
  const result = probeLowLatency({ mediamtxPath: 'cam' });
  await waitFor(() => expect(requests.some((r) => r.options.method === 'POST')).toBe(true));
  expect(peers).toHaveLength(1);
  expect(peers[0].transceiver).toEqual({ kind: 'video', options: { direction: 'recvonly' } });
  peers[0].connect();
  expect(await result).toEqual({ outcome: 'connected', protocol: 'udp', candidateType: 'host' });
  expect(peers[0].closed).toBe(true);
  expect(requests.map((r) => r.url)).toEqual(['/live/cam/whep', '/live/cam/whep/session']);
  expect(requests[1].options.redirect).toBe('error');
});

test('failure closes the peer and deletes the WHEP session', async () => {
  const result = probeLowLatency({ mediamtxPath: 'cam' });
  await waitFor(() => expect(requests).toHaveLength(1));
  peers[0].fail();
  expect(await result).toEqual({ outcome: 'failed' });
  expect(peers[0].closed).toBe(true);
  expect(requests[1].url).toBe('/live/cam/whep/session');
});

test('abort closes the peer and deletes a late POST answer', async () => {
  let answer;
  globalThis.fetch = vi.fn((url, options) => {
    requests.push({ url, options });
    return options.method === 'POST' ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve({ ok: true });
  });
  const controller = new AbortController();
  const result = probeLowLatency({ mediamtxPath: 'cam', signal: controller.signal });
  await waitFor(() => expect(answer).toBeTypeOf('function'));
  controller.abort();
  expect(await result).toEqual({ outcome: 'failed' });
  expect(peers[0].closed).toBe(true);
  answer(response);
  await waitFor(() => expect(requests[1].url).toBe('/live/cam/whep/session'));
});

test('timeout aborts the in-flight WHEP POST', async () => {
  vi.useFakeTimers();
  globalThis.fetch = vi.fn((url, options) => {
    requests.push({ url, options });
    return new Promise(() => {});
  });
  const result = probeLowLatency({ mediamtxPath: 'cam' });
  for (let i = 0; i < 10 && requests.length === 0; i++) await Promise.resolve();
  expect(requests).toHaveLength(1);
  expect(requests[0].options.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(10000);
  expect(await result).toEqual({ outcome: 'timeout' });
  expect(requests[0].options.signal.aborted).toBe(true);
});

test('refuses a path that could leave the camera WHEP endpoint', async () => {
  expect(await probeLowLatency({ mediamtxPath: '../api' })).toEqual({ outcome: 'failed' });
  expect(requests).toHaveLength(0);
});

test('an already aborted diagnostic opens no connection', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await probeLowLatency({ mediamtxPath: 'cam', signal: controller.signal })).toEqual({ outcome: 'failed' });
  expect(peers).toHaveLength(0);
  expect(requests).toHaveLength(0);
});
