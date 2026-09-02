// The three list screens: Recent alerts, the camera Event log, and admin Clip management.
//
// ★ WHY TOGETHER. RecentAlerts and EventLog are near-identical by design and differ in exactly one
// dangerous place — **the shape they read**. `/events` wraps its rows (`{ events: [...] }`) while
// `/cameras/alerts` returns the array bare. Both components destructure their own way, so copying one
// to make the other is how you get a screen that renders an empty list forever with no error.
//
// The other thread running through all three is TIME. Each parses a naive SQLite UTC timestamp by
// hand (`replace(' ','T') + 'Z'`) and then renders in the viewer's local zone. This suite runs on
// Pacific/Auckland precisely so that a local-vs-UTC confusion cannot hide — and Clip management goes
// further, GROUPING clips by local calendar day, which is where the two zones actually disagree
// about which day a 3 a.m. wake belongs to.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import RecentAlerts from '../src/components/RecentAlerts.jsx';
import EventLog from '../src/components/EventLog.jsx';
import ClipManagement from '../src/pages/ClipManagement.jsx';
import { api } from '../src/lib/api.js';

// A naive UTC timestamp exactly as SQLite stores it — no zone marker, space instead of 'T'.
const agoSql = (ms) => new Date(Date.now() - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

let delSpy;
let postSpy;

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------
describe('recent alerts', () => {
  const ALERTS = [
    { id: 'a1', type: 'motion', camera_name: 'Nursery', detail: '4.2% of frame', created_at: agoSql(20 * 1000) },
    { id: 'a2', type: 'sound', camera_name: 'Playroom', detail: '+12 dB over ambient', created_at: agoSql(3 * HOUR) },
  ];

  const mockAlerts = (rows = ALERTS) => {
    vi.spyOn(api, 'get').mockResolvedValue(rows);
    delSpy = vi.spyOn(api, 'del').mockResolvedValue({});
  };

  test('★ reads the BARE array this endpoint returns', async () => {
    // `/cameras/alerts` is not wrapped, unlike `/events`. Destructuring it the other way yields
    // undefined, and the screen would sit on "No alerts yet" through a stream of real alerts.
    mockAlerts();
    renderAsAdmin(<RecentAlerts />);
    expect(await screen.findByText('Nursery')).toBeTruthy();
    expect(screen.getByText('Playroom')).toBeTruthy();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cameras/alerts'));
  });

  test('a response that is not an array is treated as none, not as a crash', async () => {
    mockAlerts({ oops: true });
    renderAsAdmin(<RecentAlerts />);
    expect(await screen.findByText(/No alerts yet/)).toBeTruthy();
  });

  test('each alert shows its camera, kind and detail', async () => {
    mockAlerts();
    renderAsAdmin(<RecentAlerts />);
    const row = (await screen.findByText('Playroom')).closest('.event-log__row');
    expect(within(row).getByText('Sound')).toBeTruthy();
    expect(within(row).getByText('+12 dB over ambient')).toBeTruthy();
  });

  test('★★ the age is computed in UTC, not the viewer\'s zone', async () => {
    // A 12-hour error is the failure mode under this suite's clock: dropping the 'Z' would render
    // this three-hour-old alert as fifteen hours old. Measured in HOURS on purpose — at day
    // granularity the same mistake floors away and the test could not fail.
    mockAlerts();
    renderAsAdmin(<RecentAlerts />);
    const row = (await screen.findByText('Playroom')).closest('.event-log__row');
    expect(within(row).getByText('3h ago')).toBeTruthy();
  });

  test('a very recent alert reads "just now"', async () => {
    mockAlerts();
    renderAsAdmin(<RecentAlerts />);
    const row = (await screen.findByText('Nursery')).closest('.event-log__row');
    expect(within(row).getByText('just now')).toBeTruthy();
  });

  test('★ an alert type this build has never heard of still renders', async () => {
    // Forward compatibility, and it matters because the frontend is loaded live from the server while
    // the APK is not: a newer server can send a type this bundle predates. Falling back to the raw
    // type leaves a readable row rather than a blank one.
    mockAlerts([{ id: 'a9', type: 'cry', camera_name: 'Nursery', detail: '', created_at: agoSql(MIN) }]);
    renderAsAdmin(<RecentAlerts />);
    expect(await screen.findByText('cry')).toBeTruthy();
  });

  test('the empty state explains how alerts get here', async () => {
    // An empty list with no explanation reads as broken. This one says what to switch on.
    mockAlerts([]);
    renderAsAdmin(<RecentAlerts />);
    expect(await screen.findByText(/motion detection enabled/)).toBeTruthy();
  });

  test('a failed load shows the error instead of an empty state', async () => {
    // The distinction that matters: "there are no alerts" and "I could not ask" must not look alike.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Server unavailable'));
    renderAsAdmin(<RecentAlerts />);
    expect(await screen.findByText('Server unavailable')).toBeTruthy();
    expect(screen.queryByText(/No alerts yet/)).toBeNull();
  });

  test('★ clearing the log asks first — it cannot be undone', async () => {
    mockAlerts();
    const { user } = renderAsAdmin(<RecentAlerts />);
    await user.click(await screen.findByRole('button', { name: 'Clear log' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/can't be undone/)).toBeTruthy();
    expect(delSpy).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Clear log' }));
    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/cameras/alerts'));
  });

  test('★ auto-refresh polls, and turning it off stops the polling', async () => {
    // The interval is the thing to pin: left running after the toggle it would keep hitting the
    // server every ten seconds for a screen the user has explicitly asked to hold still.
    vi.useFakeTimers();
    try {
      vi.spyOn(api, 'get').mockResolvedValue(ALERTS);
      renderAsAdmin(<RecentAlerts />);
      await vi.advanceTimersByTimeAsync(0);
      const initial = api.get.mock.calls.length;

      await vi.advanceTimersByTimeAsync(10_000);
      expect(api.get.mock.calls.length, 'polls while on').toBeGreaterThan(initial);

      const toggle = screen.getByLabelText('Auto-refresh');
      toggle.click();
      await vi.advanceTimersByTimeAsync(0);
      const afterOff = api.get.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(api.get.mock.calls.length, 'silent once off').toBe(afterOff);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('the camera event log', () => {
  const EVENTS = [
    { id: 'e1', type: 'offline', camera_name: 'Nursery', detail: 'no packets for 30s', created_at: agoSql(5 * MIN) },
    { id: 'e2', type: 'online', camera_name: 'Nursery', detail: '', created_at: agoSql(4 * MIN) },
    { id: 'e3', type: 'restart', camera_name: 'Playroom', detail: '', created_at: agoSql(2 * HOUR) },
  ];

  const mockEvents = (events = EVENTS) => {
    vi.spyOn(api, 'get').mockResolvedValue({ events });
    delSpy = vi.spyOn(api, 'del').mockResolvedValue({});
  };

  test('★ reads the WRAPPED shape this endpoint returns', async () => {
    // The mirror of the alerts test above, and the reason both exist: these two screens look the same
    // and read different shapes.
    mockEvents();
    renderAsAdmin(<EventLog />);
    expect(await screen.findByText('no packets for 30s')).toBeTruthy();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/events'));
  });

  test('each event type gets a readable label', async () => {
    // "online" reading as "Back online" is the point — a log that says "online" next to "offline" at
    // a glance looks like two states, not a recovery.
    mockEvents();
    renderAsAdmin(<EventLog />);
    expect(await screen.findByText('Offline')).toBeTruthy();
    expect(screen.getByText('Back online')).toBeTruthy();
    expect(screen.getByText('Restarted')).toBeTruthy();
  });

  test('an unrecognised event type falls back to its raw name', async () => {
    mockEvents([{ id: 'e9', type: 'firmware_update', camera_name: 'Nursery', detail: '', created_at: agoSql(MIN) }]);
    renderAsAdmin(<EventLog />);
    expect(await screen.findByText('firmware_update')).toBeTruthy();
  });

  test('ages are computed in UTC here too', async () => {
    mockEvents();
    renderAsAdmin(<EventLog />);
    const row = (await screen.findByText('Playroom')).closest('.event-log__row');
    expect(within(row).getByText('2h ago')).toBeTruthy();
  });

  test('clearing asks first, then deletes', async () => {
    mockEvents();
    const { user } = renderAsAdmin(<EventLog />);
    await user.click(await screen.findByRole('button', { name: 'Clear log' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Clear log' }));
    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/events'));
  });

  test('a failed load is reported', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Could not read the event log'));
    renderAsAdmin(<EventLog />);
    expect(await screen.findByText('Could not read the event log')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------
describe('clip management', () => {
  // Two clips on the same LOCAL day and one on another, built from real offsets so the grouping is
  // exercised against whatever "today" is when the suite runs.
  const CLIPS = [
    { id: 'c1', type: 'motion', camera_name: 'Nursery', created_at: agoSql(2 * HOUR), clip_bytes: 5 * 1024 * 1024 },
    { id: 'c2', type: 'sound', camera_name: 'Nursery', created_at: agoSql(3 * HOUR), clip_bytes: 3 * 1024 * 1024 },
    { id: 'c3', type: 'motion', camera_name: 'Playroom', created_at: agoSql(50 * HOUR), clip_bytes: 2 * 1024 * 1024 },
  ];

  const mockClips = (rows = CLIPS) => {
    vi.spyOn(api, 'get').mockResolvedValue(rows);
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({});
  };

  const mountClips = () => renderAsAdmin(<ClipManagement />, { route: '/settings/clips' });

  beforeEach(() => mockClips());

  test('counts the clips and totals their size', async () => {
    // The total is the reason to be on this screen: it is how someone decides whether to delete.
    mountClips();
    expect(await screen.findByText(/3 clips · 10 MB/)).toBeTruthy();
  });

  test('one clip is not pluralised', async () => {
    mockClips([CLIPS[0]]);
    mountClips();
    expect(await screen.findByText(/^1 clip ·/)).toBeTruthy();
  });

  test('the empty state says how clips get recorded', async () => {
    mockClips([]);
    mountClips();
    expect(await screen.findByText(/Save a clip when triggered/)).toBeTruthy();
  });

  test('a failed load reports it rather than showing "no clips"', async () => {
    // The dangerous confusion on this screen: "you have no clips" would suggest nothing is being
    // recorded, and someone might go and change their detection settings because of it.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Clip storage is unavailable'));
    mountClips();
    expect(await screen.findByText('Clip storage is unavailable')).toBeTruthy();
  });

  test('★ selecting all selects everything shown, and again clears it', async () => {
    const { user } = mountClips();
    await user.click(await screen.findByRole('button', { name: 'Select all' }));
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull());
  });

  test('★★ deleting asks first, says the alert survives, and posts the selected ids', async () => {
    // "This removes the video files; the alert and its snapshot stay" is the part people need before
    // confirming — without it, deleting clips looks like deleting the record that anything happened.
    const { user } = mountClips();
    await user.click(await screen.findByRole('button', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/removes the video files/)).toBeTruthy();
    expect(postSpy).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Delete 3' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    const [path, body] = postSpy.mock.calls[0];
    expect(path).toBe('/cameras/clips/delete');
    expect([...body.ids].sort()).toEqual(['c1', 'c2', 'c3']);
  });

  test('a single clip can be selected on its own', async () => {
    const { user } = mountClips();
    const boxes = await screen.findAllByLabelText('Select clip');
    await user.click(boxes[0]);
    expect(await screen.findByRole('button', { name: 'Delete' })).toBeTruthy();
  });

  test('a failed delete says why and keeps the selection', async () => {
    postSpy = vi.spyOn(api, 'post').mockRejectedValue(new Error('Files are in use'));
    const { user } = mountClips();
    await user.click(await screen.findByRole('button', { name: 'Select all' }));
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete 3' }));

    expect(await screen.findByText('Files are in use')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delete' }), 'the selection survives a failure').toBeTruthy();
  });

  test('★ a very small clip still reads as 1 KB, never 0 KB', async () => {
    // The floor is `Math.max(1, …)`. A clip reported as "0 KB" reads as a failed recording rather
    // than a very short one, and someone would go looking for a fault that isn't there.
    //
    // ⚠️ 100 bytes, not 512. 512 rounds to 1 KB anyway, so it cannot tell the floor from the rounding
    // — a mutant that removed the floor survived that fixture. 100 bytes rounds to 0 and needs it.
    mockClips([{ id: 'c1', type: 'motion', camera_name: 'A', created_at: agoSql(MIN), clip_bytes: 100 }]);
    mountClips();
    // On the row, not the page total: only the row proves the per-clip formatter ran.
    const row = (await screen.findByLabelText('Select clip')).closest('.clip-row');
    expect(within(row).getByText(/1 KB/)).toBeTruthy();
  });

  test('a clip whose size is unknown shows no size rather than NaN', async () => {
    // A clip row is written before the recording finishes, so `clip_bytes` is genuinely absent for a
    // moment on a clip being captured right now.
    //
    // ⚠️ This is guarded TWICE and the two are independent: the call site's `c.clip_bytes ? … : ''`
    // and `fmtBytes`'s own `b == null || !isFinite(b)` check. Either one alone is enough, so NO
    // SINGLE MUTATION makes this test fail — verified by removing each in turn, and then both, which
    // does kill it ("NaN KB" reaches the row). Recorded rather than tidied away: the redundancy is
    // deliberate defence in depth, and knowing a single mutant survives here is not the same as this
    // test failing to discriminate.
    mockClips([{ id: 'c1', type: 'motion', camera_name: 'A', created_at: agoSql(MIN) }]);
    mountClips();
    await screen.findByText(/1 clip/);
    expect(document.body.textContent).not.toContain('NaN');
  });

  test('★★ clips are grouped by LOCAL calendar day, from a UTC timestamp', async () => {
    // The one place on this screen where the two zones genuinely disagree. These two clips are four
    // hours apart across UTC midnight, so under any zone ahead of UTC they are the same local day and
    // belong in ONE group. Parse them as local instead of UTC and they split across two headings —
    // which is exactly how a 3 a.m. wake ends up filed under the wrong night.
    mockClips([
      { id: 'c1', type: 'motion', camera_name: 'A', created_at: '2026-08-31 02:00:00', clip_bytes: 1024 * 1024 },
      { id: 'c2', type: 'motion', camera_name: 'A', created_at: '2026-08-30 22:00:00', clip_bytes: 1024 * 1024 },
    ]);
    mountClips();
    await screen.findByText(/2 clips/);
    const headings = document.querySelectorAll('.card.tight .card-title');
    expect(headings.length, 'both clips fall on one local day under this suite\'s clock').toBe(1);
  });
});
