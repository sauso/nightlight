// WhepPlayer's session cleanup: where the token-carrying DELETE goes (#562).
//
// ★ THE DEFECT. On teardown the player sends `DELETE <the POST answer's Location header>` with the person's full
// session token in `Authorization`. The header was used exactly as it came back, so whatever sat between the
// browser and MediaMTX decided where the token went. It now goes through resolveWhepResource (src/lib/whep.js),
// and the DELETE refuses to follow a redirect.
//
// WHY THIS FILE EXISTS NEXT TO whep.test.js. A unit test of the helper cannot tell a helper that is wired in from
// one that is imported and never called: both pass it. This mounts the REAL WhepPlayer, with a stubbed
// RTCPeerConnection and a stubbed global fetch (jsdom has neither), and watches what goes on the wire. Two
// cameras are used because a call site that resolved against one fixed camera path passed every test while they
// all used `cam1` (a surviving mutant in code review).
//
// ⚠️ EVERY TEST WAITS FOR setRemoteDescription BEFORE UNMOUNTING. An unmount that lands before the POST has been
// answered runs the cleanup while nothing is stored yet, so no DELETE is sent with or without the fix and a
// negative test would pass for nothing (found in plan review).
// Waiting for the answer to be applied, and asserting the peer connection was then closed by the cleanup, is
// what makes "no DELETE" mean "the DELETE was refused".
//
// ⚠️ REDIRECTS: THE `redirect` FLAG IS THE CONTROL. A stubbed fetch follows nothing by itself, and jsdom cannot
// show what a browser does with a 307. So the stub below MODELS the Fetch spec: unless the request said
// `redirect: 'error'`, a 307/308 is followed with the same method and headers (that is what a browser does on a
// same-origin redirect, and what code review reproduced against a stub server), and each such follow is recorded
// apart from the player's own calls. The tests assert the flag on the player's request AND that the modelled
// browser followed nothing; the first is the real guarantee, the second only shows what the flag prevents.
//
// WHAT IT DOES NOT PROVE: a real WebRTC session (no media, no ICE; the player stays on vite.config.js's coverage
// exclude list because jsdom cannot play it), a real browser's redirect handling, or what MediaMTX does with a
// session nobody DELETEs.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import WhepPlayer from '../src/components/WhepPlayer.jsx';
import { setToken } from '../src/lib/api.js';

// A marker that can only have come from this test, so "the token went nowhere else" is checkable.
const TOKEN = 'TOKEN-562-must-stay-on-this-site';
// The redirects that keep the method and headers (the only ones the model below needs).
const REDIRECTS = [307, 308];

let peers;
let fetchMock;
let locationHeader;
// How the stubbed server answers the DELETE: a plain 200 unless a test sets a redirect.
let deleteAnswer;
// Requests the modelled browser made by following a redirect (not the player's own calls).
let followed;

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

const headersWith = (location) => ({ get: (name) => (name.toLowerCase() === 'location' ? location : null) });

// The modelled server: answers the POST like MediaMTX (201, an SDP answer, a Location), the DELETE with
// `deleteAnswer`.
function answer(url, init) {
  if (init.method === 'POST') {
    return { ok: true, status: 201, headers: headersWith(locationHeader), text: async () => 'v=0 answer' };
  }
  return deleteAnswer;
}

beforeEach(() => {
  peers = [];
  locationHeader = null;
  deleteAnswer = { ok: true, status: 200, headers: headersWith(null) };
  followed = [];
  // The modelled browser. A 307/308 is followed the way the Fetch spec says (same method, same headers, on a
  // same-origin redirect), and recorded in `followed`; `redirect: 'error'` makes it a network error instead,
  // which the player's own `.catch` swallows.
  fetchMock = vi.fn(async (url, init = {}) => {
    const res = answer(url, init);
    if (REDIRECTS.includes(res.status)) {
      if (init.redirect === 'error') throw new TypeError('Failed to fetch: redirect refused');
      const next = res.headers.get('location');
      followed.push({ url: next, method: init.method, authorization: init.headers?.Authorization });
      return { ok: true, status: 200, headers: headersWith(null) };
    }
    return res;
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  setToken(TOKEN);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setToken(null);
});

// Mount with the given Location, wait until the answer has been applied, unmount, and return every request the
// PLAYER made (a redirect the modelled browser followed is in `followed`, not here).
async function mountAnswerAndUnmount(location, camera = 'cam1') {
  locationHeader = location;
  const { unmount } = render(<WhepPlayer mediamtxPath={camera} active muted />);
  await waitFor(() => expect(peers[0]?.remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer' }));
  unmount();
  // Let the DELETE's promise settle, so anything the modelled browser would follow has been recorded.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  // The cleanup ran (it closes the peer connection before it decides on the DELETE).
  expect(peers[0].closed).toBe(true);
  const calls = fetchMock.mock.calls.map(([url, init = {}]) => ({
    url,
    method: init.method,
    authorization: init.headers?.Authorization,
    redirect: init.redirect,
  }));
  // Exactly one POST, to this camera's own WHEP path, whatever the Location was.
  expect(calls.filter((c) => c.method === 'POST')).toEqual([
    { url: `/live/${camera}/whep`, method: 'POST', authorization: `Bearer ${TOKEN}`, redirect: undefined },
  ]);
  return calls;
}

// Every request that carried the token, as an absolute URL, must be on the page's own origin.
function expectTokenStayedOnThisSite(calls) {
  for (const c of [...calls, ...followed].filter((x) => String(x.authorization).includes(TOKEN))) {
    expect(new URL(c.url, window.location.href).origin, `token sent to ${c.url}`).toBe(window.location.origin);
  }
}

const deleteTo = (url) => ({ url, method: 'DELETE', authorization: `Bearer ${TOKEN}`, redirect: 'error' });

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

  test('a Location at the camera session path gets exactly one DELETE, with the Bearer token and no redirects', async () => {
    const calls = await mountAnswerAndUnmount('/live/cam1/whep/abc');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([deleteTo('/live/cam1/whep/abc')]);
    expectTokenStayedOnThisSite(calls);
  });

  test('★ a relative Location is resolved against the POST URL, not the page, and gets the same DELETE', async () => {
    const calls = await mountAnswerAndUnmount('whep/abc');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([deleteTo('/live/cam1/whep/abc')]);
  });

  test("★ a second camera's player DELETEs its own session path", async () => {
    const calls = await mountAnswerAndUnmount('/live/cam2/whep/def', 'cam2');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([deleteTo('/live/cam2/whep/def')]);
  });

  test("★ a second camera's player sends no DELETE for a Location on the first camera's path", async () => {
    const calls = await mountAnswerAndUnmount('/live/cam1/whep/abc', 'cam2');
    expect(calls.map((c) => c.method)).toEqual(['POST']);
  });

  test('★ a redirect in answer to the DELETE is not followed: no second DELETE carries the token to /api', async () => {
    deleteAnswer = { ok: false, status: 307, headers: headersWith('/api/auth/users/1') };
    const calls = await mountAnswerAndUnmount('/live/cam1/whep/abc');
    // The player's own request: one DELETE, and it asked the browser not to follow a redirect (the control).
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([deleteTo('/live/cam1/whep/abc')]);
    // What the flag prevents: without it the modelled browser would replay the DELETE, token and all, at /api.
    expect(followed).toEqual([]);
    expectTokenStayedOnThisSite(calls);
  });
});

// ★ #694. The Location used to be stored in one ref shared by every run of the connect effect, before the
// `cancelled` check, so a slow POST from a torn-down run could overwrite a newer run's address.
describe('WhepPlayer late POST answer from a torn-down run (#694)', () => {
  // A POST whose answer the test releases by hand; the DELETE is answered at once.
  function holdPosts() {
    const held = [];
    fetchMock.mockImplementation((url, init = {}) => {
      if (init.method !== 'POST') return Promise.resolve(deleteAnswer);
      return new Promise((resolve) => {
        held.push({
          url,
          release: (location) =>
            resolve({ ok: true, status: 201, headers: headersWith(location), text: async () => 'v=0 answer' }),
        });
      });
    });
    return held;
  }
  const deletes = () =>
    fetchMock.mock.calls.filter(([, init = {}]) => init.method === 'DELETE').map(([url, init]) => ({ url, redirect: init.redirect }));
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

  test("★ a late answer from the old run neither replaces the new run's address nor leaves its own session open", async () => {
    const held = holdPosts();
    const { rerender, unmount } = render(<WhepPlayer mediamtxPath="cam1" active muted />);
    await waitFor(() => expect(held).toHaveLength(1));
    // Run A is torn down (camera switch) while its POST is still in flight: nothing stored, so no DELETE yet.
    rerender(<WhepPlayer mediamtxPath="cam2" active muted />);
    await waitFor(() => expect(held).toHaveLength(2));
    expect(deletes()).toEqual([]);
    // Run B is answered and applied.
    held[1].release('/live/cam2/whep/new');
    await waitFor(() => expect(peers[1].remoteDescription).toEqual({ type: 'answer', sdp: 'v=0 answer' }));
    // Run A's slow answer arrives now. It is the only cleanup that session will ever get, so it is DELETEd at once
    // (and ONLY that one; B is still live).
    held[0].release('/live/cam1/whep/old');
    await settle();
    expect(deletes()).toEqual([{ url: '/live/cam1/whep/old', redirect: 'error' }]);
    expect(peers[0].remoteDescription).toBeNull();
    // B's cleanup ends B's own session, not A's.
    unmount();
    await settle();
    expect(deletes()).toEqual([
      { url: '/live/cam1/whep/old', redirect: 'error' },
      { url: '/live/cam2/whep/new', redirect: 'error' },
    ]);
  });

  test('a late answer after unmount DELETEs its own session once', async () => {
    const held = holdPosts();
    const { unmount } = render(<WhepPlayer mediamtxPath="cam1" active muted />);
    await waitFor(() => expect(held).toHaveLength(1));
    unmount();
    await settle();
    expect(deletes()).toEqual([]);
    held[0].release('/live/cam1/whep/late');
    await settle();
    expect(deletes()).toEqual([{ url: '/live/cam1/whep/late', redirect: 'error' }]);
  });

  test('a late answer whose Location fails the #562 guard sends no DELETE at all', async () => {
    const held = holdPosts();
    const { unmount } = render(<WhepPlayer mediamtxPath="cam1" active muted />);
    await waitFor(() => expect(held).toHaveLength(1));
    unmount();
    held[0].release('/api/users/1');
    await settle();
    expect(deletes()).toEqual([]);
  });

  test('normal connect then disconnect is unchanged: one DELETE, at unmount, after the answer was applied', async () => {
    const calls = await mountAnswerAndUnmount('/live/cam1/whep/abc');
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([deleteTo('/live/cam1/whep/abc')]);
  });
});
