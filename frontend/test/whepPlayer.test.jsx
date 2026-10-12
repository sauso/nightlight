// WhepPlayer's session cleanup: where the token-carrying DELETE goes (#562).
//
// ★ THE DEFECT. On teardown the player sends `DELETE <the POST answer's Location header>` with the person's full
// session token in `Authorization`. The header was used exactly as it came back, so whatever sat between the
// browser and MediaMTX decided where the token went. It now goes through resolveWhepResource (src/lib/whep.js).
//
// WHY THIS FILE EXISTS NEXT TO whep.test.js. A unit test of the helper cannot tell a helper that is wired in from
// one that is imported and never called: both pass it. This mounts the REAL WhepPlayer, with a stubbed
// RTCPeerConnection and a stubbed global fetch (jsdom has neither), and watches what goes on the wire.
//
// ⚠️ EVERY TEST WAITS FOR setRemoteDescription BEFORE UNMOUNTING. An unmount that lands before the POST has been
// answered runs the cleanup while nothing is stored yet, so no DELETE is sent with or without the fix and a
// negative test would pass for nothing (found in plan review).
// Waiting for the answer to be applied, and asserting the peer connection was then closed by the cleanup, is
// what makes "no DELETE" mean "the DELETE was refused".
//
// WHAT IT DOES NOT PROVE: a real WebRTC session (no media, no ICE; the player stays on vite.config.js's coverage
// exclude list because jsdom cannot play it), or what MediaMTX does with a session nobody DELETEs.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import WhepPlayer from '../src/components/WhepPlayer.jsx';
import { setToken } from '../src/lib/api.js';

// A marker that can only have come from this test, so "the token went nowhere else" is checkable.
const TOKEN = 'TOKEN-562-must-stay-on-this-site';

let peers;
let fetchMock;
let locationHeader;

// Just enough of RTCPeerConnection for the signalling path: the offer, the answer, and close().
class FakePeerConnection {
  constructor() {
    this.connectionState = 'new';
    this.remoteDescription = null;
    this.closed = false;
    peers.push(this);
  }

  addTransceiver() {}

  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }

  async setLocalDescription() {}

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
}

beforeEach(() => {
  peers = [];
  locationHeader = null;
  // Every request the player makes lands here. The POST is answered like MediaMTX (201, an SDP answer and a
  // Location); anything else (the DELETE) gets a bare 200.
  fetchMock = vi.fn(async (url, init = {}) => {
    if (init.method === 'POST') {
      return {
        ok: true,
        status: 201,
        headers: { get: (name) => (name.toLowerCase() === 'location' ? locationHeader : null) },
        text: async () => 'v=0 answer',
      };
    }
    return { ok: true, status: 200 };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  setToken(TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

// Mount with the given Location, wait until the answer has been applied, unmount, and return every request.
async function mountAnswerAndUnmount(location) {
  locationHeader = location;
  const { unmount } = render(<WhepPlayer mediamtxPath="cam1" active muted />);
  await waitFor(() => expect(peers[0]?.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer' }));
  unmount();
  // The cleanup ran (it closes the peer connection before it decides on the DELETE).
  expect(peers[0].closed).toBe(true);
  const calls = fetchMock.mock.calls.map(([url, init = {}]) => ({
    url,
    method: init.method,
    authorization: init.headers?.Authorization,
  }));
  // Exactly one POST, to the camera's own WHEP path, whatever the Location was.
  expect(calls.filter((c) => c.method === 'POST')).toEqual([
    { url: '/live/cam1/whep', method: 'POST', authorization: `Bearer ${TOKEN}` },
  ]);
  return calls;
}

// Every request that carried the token, as an absolute URL, must be on the page's own origin.
function expectTokenStayedOnThisSite(calls) {
  for (const c of calls.filter((x) => String(x.authorization).includes(TOKEN))) {
    expect(new URL(c.url, window.location.href).origin, `token sent to ${c.url}`).toBe(window.location.origin);
  }
}

describe('WhepPlayer session DELETE (#562)', () => {
  test('★ a Location on another site gets no DELETE, and the token goes nowhere but the POST', async () => {
    const calls = await mountAnswerAndUnmount('https://evil.example/live/x/whep/1');
    expect(calls.map((c) => c.method)).toEqual(['POST']);
    expectTokenStayedOnThisSite(calls);
  });

  test('★ a Location on this site but off the camera path gets no DELETE', async () => {
    // Same origin, so the CSP would not stop it: without the guard this is a DELETE to an /api route with the
    // viewer's token.
    const calls = await mountAnswerAndUnmount('/api/auth/users/12345');
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  test('a Location at the camera session path gets exactly one DELETE, with the Bearer token', async () => {
    const calls = await mountAnswerAndUnmount('/live/cam1/whep/abc');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([
      { url: '/live/cam1/whep/abc', method: 'DELETE', authorization: `Bearer ${TOKEN}` },
    ]);
    expectTokenStayedOnThisSite(calls);
  });

  test('★ a relative Location is resolved against the POST URL, not the page, and gets the same DELETE', async () => {
    const calls = await mountAnswerAndUnmount('whep/abc');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([
      { url: '/live/cam1/whep/abc', method: 'DELETE', authorization: `Bearer ${TOKEN}` },
    ]);
  });
});
