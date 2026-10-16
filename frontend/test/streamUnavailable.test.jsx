// The tile state for "MediaMTX's status call timed out" (#505, duplicate #480).
//
// ★ WHAT IT PINS. The cameras API already says `status: { ready: false, unknown: true }` when the status call
// timed out. Nothing read `unknown`, so the tile showed the camera-offline wording ("No signal") for a fault
// in the server, and a red dot after ~30 s. Now: `unknown` gives "Streaming service unavailable. Your camera
// may still be online." with a Retry button, and never the red dot; `{ ready: false }` WITHOUT `unknown`
// keeps today's behaviour exactly.
//
// Two layers, because each can break alone: the provider must READ the field (CamerasContext, real provider
// with a stubbed api.get), and the tile must SHOW it (real CameraTile via LiveMonitor, as admin and as
// caregiver: role gating is where tile bugs hide).
//
// WHAT IT DOES NOT PROVE: a real WebRTC session (jsdom has none; RTCPeerConnection below is a counter), the
// look of the notice at phone width or in dark mode (CSS tokens only; check by eye), or MediaMTX itself.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import HlsPlayer from '../src/components/HlsPlayer.jsx';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import { CamerasProvider, CamerasContext } from '../src/lib/CamerasContext.jsx';
import { api } from '../src/lib/api.js';

const NOTICE = 'Streaming service unavailable. Your camera may still be online.';
const KIDS = [{ id: 'kid-1', name: 'Child A' }];
const cam = (extra = {}) => ({ id: 'c1', name: 'Nursery', mediamtx_path: 'p1', child_id: 'kid-1', ...extra });

let peers;
beforeEach(() => {
  peers = 0;
  // A player whose offer never resolves, counting the attempts: the tile stays in 'connecting' (not live,
  // where the notice shows). It must NOT fail outright: a failed first connect makes the tile switch itself
  // to Compatibility (HLS) mode, which would swap the player under the test.
  vi.stubGlobal('RTCPeerConnection', class { constructor() { peers += 1; } addTransceiver() {} createOffer() { return new Promise(() => {}); } close() {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CamerasProvider reads status.unknown', () => {
  let seen;
  function Probe() {
    return <CamerasContext.Consumer>{(v) => { seen = v; return null; }}</CamerasContext.Consumer>;
  }
  const poll = async (cameras) => {
    vi.spyOn(api, 'get').mockImplementation(async (url) => (url === '/children' ? KIDS : cameras));
    render(<CamerasProvider><Probe /></CamerasProvider>);
    await waitFor(() => expect(seen.cameras.length).toBe(cameras.length));
    return seen.cameras;
  };

  test('{ ready: false, unknown: true } is flagged unknown and never goes to the red dot', async () => {
    const [c] = await poll([cam({ status: { ready: false, unknown: true } })]);
    expect(c.statusUnknown).toBe(true);
    expect(c.statusLevel).toBe('connecting');
  });

  test('{ ready: false } without unknown is NOT flagged, and still counts toward offline', async () => {
    const [c] = await poll([cam({ status: { ready: false } })]);
    expect(c.statusUnknown).toBeUndefined();
    expect(c.statusLevel).toBe('connecting');
    // Three polls make it 'offline' as before: drive two more refreshes.
    await act(async () => { await seen.refresh(); await seen.refresh(); });
    expect(seen.cameras[0].statusLevel).toBe('offline');
    expect(seen.cameras[0].statusUnknown).toBeUndefined();
  });

  test('a camera that is ready is live and unflagged', async () => {
    const [c] = await poll([cam({ status: { ready: true } })]);
    expect(c.statusLevel).toBe('live');
    expect(c.statusUnknown).toBeUndefined();
  });

  test('unknown polls do not count toward offline: an outage after them is confirmed from scratch', async () => {
    let status = { ready: false, unknown: true };
    vi.spyOn(api, 'get').mockImplementation(async (url) => (url === '/children' ? KIDS : [cam({ status })]));
    render(<CamerasProvider><Probe /></CamerasProvider>);
    await waitFor(() => expect(seen.cameras.length).toBe(1));
    await act(async () => { await seen.refresh(); await seen.refresh(); await seen.refresh(); });
    expect(seen.cameras[0].statusLevel).toBe('connecting'); // 4 unknown polls, still amber
    status = { ready: false };
    await act(async () => { await seen.refresh(); });
    expect(seen.cameras[0].statusLevel).toBe('connecting'); // first confirmed not-ready poll, not red
  });
});

describe.each([['admin', renderAsAdmin], ['caregiver', renderAsCaregiver]])('the tile, as a %s', (_role, renderAs) => {
  const mount = (c) => renderAs(<LiveMonitor />, { cameras: [c], kids: KIDS });

  test('unknown shows the service wording, an icon and Retry, and never the camera-offline wording', async () => {
    const { container } = mount(cam({ statusUnknown: true, status: { ready: false, unknown: true } }));
    const notice = await waitFor(() => { const n = container.querySelector('.stream-unavailable'); expect(n).toBeTruthy(); return n; });
    expect(notice.textContent).toContain(NOTICE);
    expect(notice.querySelector('svg')).toBeTruthy(); // icon + text, not colour alone
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(container.textContent).not.toMatch(/No signal|camera offline/i);
    expect(notice.textContent).not.toMatch(/offline/i); // "online" only: it must not claim the camera is down
  });

  test('{ ready: false } without unknown keeps the existing wording and shows no notice', async () => {
    const { container } = mount(cam({ status: { ready: false } }));
    await waitFor(() => expect(container.textContent).toMatch(/No signal|Camera stream unavailable|Connecting/));
    expect(container.querySelector('.stream-unavailable')).toBeNull();
    expect(container.textContent).not.toContain('Streaming service unavailable');
  });

  test('Retry reconnects through the player (a new connection attempt), and recovery removes the notice', async () => {
    const c = cam({ statusUnknown: true });
    const { user, rerenderWith, container } = mount(c);
    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(container.querySelector('.stream-unavailable')).toBeTruthy();
    await waitFor(() => expect(peers).toBeGreaterThan(0));
    const before = peers;
    await user.click(retry);
    await waitFor(() => expect(peers).toBeGreaterThan(before));
    // The status call recovers on the next poll: the flag clears and the notice goes.
    rerenderWith({ cameras: [cam({ statusUnknown: undefined, status: { ready: true } })] });
    await waitFor(() => expect(screen.queryByText(NOTICE)).toBeNull());
    expect(container.textContent).not.toContain('Streaming service unavailable');
  });
});

describe('the Compatibility (HLS) player shows the same notice', () => {
  test('unknown: service wording and Retry; not unknown: the existing No signal / Connecting wording', () => {
    const { container, rerender } = render(<HlsPlayer mediamtxPath="p1-hls" active statusUnknown />);
    expect(container.querySelector('.stream-unavailable').textContent).toContain(NOTICE);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    rerender(<HlsPlayer mediamtxPath="p1-hls" active />);
    expect(container.querySelector('.stream-unavailable')).toBeNull();
    expect(container.textContent).toMatch(/No signal|Connecting/);
  });
});
