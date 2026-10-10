// #561: every screen that shows a time shows it in HOME time (settings.timezone), with a zone label
// when the viewer's device is in a different zone. One test group per screen, each proving the screen
// formats in the HOME zone rather than the device's.
//
// ★ HOW THE TWO ZONES ARE KEPT APART. The suite's device zone is pinned to Pacific/Auckland
// (vite.config.js) and its locale to en-AU (test/setup.js). Home is set per test through
// `settings.timezone`:
//   * America/Los_Angeles — a zone that is NOT the device's. The screen must show Los Angeles time and
//     carry the label ("GMT-7").
//   * Pacific/Auckland    — the device's own zone. The screen must show the same clock and NO label: a
//     household that never travels must see nothing new.
//   * undefined           — an unset timezone is the backend default, UTC (labelled, as UTC != device).
// One instant is used throughout so the three readings can be compared:
//   2026-08-31 02:00:00 UTC  =  7:00 pm on 30 Aug in Los Angeles  =  2:00 pm on 31 Aug in Auckland.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import AlertList from '../src/components/AlertList.jsx';
import RecentAlerts from '../src/components/RecentAlerts.jsx';
import EventLog from '../src/components/EventLog.jsx';
import ClipPlayerModal from '../src/components/ClipPlayerModal.jsx';
import ClipManagement from '../src/pages/ClipManagement.jsx';
import ClipDatePicker from '../src/components/ClipDatePicker.jsx';
import RecordingsCard from '../src/components/RecordingsCard.jsx';
import TimelapseCard from '../src/components/TimelapseCard.jsx';
import LiveMonitor from '../src/components/LiveMonitor.jsx';
import { api } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';

const LA = 'America/Los_Angeles';
const DEVICE = 'Pacific/Auckland';
const X = '2026-08-31 02:00:00'; // naive UTC, exactly as SQLite stores it

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('AlertList (the tooltip carries the clock time)', () => {
  const alert = { id: 'a1', type: 'motion', camera_name: 'Nursery', created_at: X };
  const titleOf = (container) => container.querySelector('time').getAttribute('title');

  test('★ shows HOME time with the zone label when the device is elsewhere', () => {
    const { container } = renderAsAdmin(<AlertList alerts={[alert]} />, { settings: { timezone: LA } });
    expect(titleOf(container)).toBe('30/08/2026, 7:00:00 pm GMT-7');
  });

  test('★ no label when home and device are the same zone', () => {
    const { container } = renderAsAdmin(<AlertList alerts={[alert]} />, { settings: { timezone: DEVICE } });
    expect(titleOf(container)).toBe('31/08/2026, 2:00:00 pm');
  });

  test('★ an unset timezone is UTC, the backend default — not the device zone', () => {
    const { container } = renderAsAdmin(<AlertList alerts={[alert]} />, { settings: { timezone: undefined } });
    expect(titleOf(container)).toBe('31/08/2026, 2:00:00 am UTC');
  });
});

describe('RecentAlerts', () => {
  test('★ the row\'s tooltip is HOME time with the label', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([{ id: 'a1', type: 'motion', camera_name: 'Nursery', detail: '', created_at: X }]);
    const { container } = renderAsAdmin(<RecentAlerts />, { settings: { timezone: LA } });
    await screen.findByText('Nursery');
    expect(container.querySelector('time').getAttribute('title')).toBe('30/08/2026, 7:00:00 pm GMT-7');
  });

  test('★ and has no label when the device is at home', async () => {
    vi.spyOn(api, 'get').mockResolvedValue([{ id: 'a1', type: 'motion', camera_name: 'Nursery', detail: '', created_at: X }]);
    const { container } = renderAsAdmin(<RecentAlerts />, { settings: { timezone: DEVICE } });
    await screen.findByText('Nursery');
    expect(container.querySelector('time').getAttribute('title')).toBe('31/08/2026, 2:00:00 pm');
  });
});

describe('EventLog', () => {
  const rows = { events: [{ id: 'e1', type: 'offline', camera_name: 'Nursery', detail: '', created_at: X }] };

  test('★ the row\'s tooltip is HOME time with the label', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(rows);
    const { container } = renderAsAdmin(<EventLog />, { settings: { timezone: LA } });
    await screen.findByText('Nursery');
    expect(container.querySelector('time').getAttribute('title')).toBe('30/08/2026, 7:00:00 pm GMT-7');
  });

  test('★ and has no label when the device is at home', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(rows);
    const { container } = renderAsAdmin(<EventLog />, { settings: { timezone: DEVICE } });
    await screen.findByText('Nursery');
    expect(container.querySelector('time').getAttribute('title')).toBe('31/08/2026, 2:00:00 pm');
  });
});

describe('ClipPlayerModal', () => {
  const ev = { id: 'a1', type: 'motion', camera_name: 'Nursery', created_at: X, clip_duration_s: 12 };

  test('★ the capture time is HOME time with the label', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    renderAsAdmin(<ClipPlayerModal ev={ev} onClose={() => {}} />, { settings: { timezone: LA } });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('30/08/2026, 7:00:00 pm GMT-7 · 12s');
  });

  test('★ no label when the device is at home', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    renderAsAdmin(<ClipPlayerModal ev={ev} onClose={() => {}} />, { settings: { timezone: DEVICE } });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('31/08/2026, 2:00:00 pm · 12s');
    expect(dialog.textContent).not.toMatch(/GMT|NZST|NZDT/);
  });
});

describe('ClipManagement', () => {
  // Newest first, as the endpoint returns them. In Los Angeles these are two different DAYS (30 Aug,
  // 7:00 pm / 31 Aug, 1:00 am); in Auckland, the device, they are the SAME day (31 Aug, 2:00 pm / 8:00 pm).
  const CLIPS = [
    { id: 'c2', type: 'sound', camera_name: 'Nursery', created_at: '2026-08-31 08:00:00', clip_bytes: 1024 * 1024 },
    { id: 'c1', type: 'motion', camera_name: 'Nursery', created_at: X, clip_bytes: 1024 * 1024 },
  ];
  const mount = (timezone) => {
    vi.spyOn(api, 'get').mockResolvedValue(CLIPS);
    return renderAsAdmin(<ClipManagement />, { route: '/settings/clips', settings: { timezone } });
  };
  const headings = () => [...document.querySelectorAll('.card.tight .card-title')].map((n) => n.textContent);
  const metas = () => [...document.querySelectorAll('.clip-row__meta')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());

  test('★★ clips are grouped by the HOME-zone day: two clips the device calls one day are two days at home', async () => {
    mount(LA);
    await screen.findByText(/2 clips/);
    expect(headings()).toEqual(['31/08/2026', '30/08/2026']);
  });

  test('★★ …and a household whose device is at home still sees one day (nothing changes for them)', async () => {
    mount(DEVICE);
    await screen.findByText(/2 clips/);
    expect(headings()).toEqual(['31/08/2026']);
  });

  test('★ each row\'s clock time is HOME time with the label, and has none when the device is at home', async () => {
    const away = mount(LA);
    await screen.findByText(/2 clips/);
    expect(metas()[0]).toMatch(/^Sound · 01:00 am GMT-7/);
    expect(metas()[1]).toMatch(/^Motion · 07:00 pm GMT-7/);
    away.unmount();

    mount(DEVICE);
    await screen.findByText(/2 clips/);
    expect(metas()[0]).toMatch(/^Sound · 08:00 pm(?! GMT)/);
    expect(metas()[0]).not.toMatch(/GMT|NZST|NZDT/);
  });

  test('★★ the day FILTER uses the home-zone day too: picking 30 Aug shows only the clip made that evening', async () => {
    const { user } = mount(LA);
    await screen.findByText(/2 clips/);
    await user.click(screen.getByRole('button', { name: /All dates/ }));
    await user.click(screen.getByRole('button', { name: '30/08/2026 — clips available' }));
    await waitFor(() => expect(metas()).toHaveLength(1));
    expect(metas()[0]).toMatch(/^Motion · 07:00 pm GMT-7/);
  });

  test('★★ "Select all shown" after a day filter selects only that HOME day\'s clips (the list and the selection agree)', async () => {
    // The filter feeds two things: which day headings render, and `visible`, which "Select all shown" and
    // its Delete act on. They must use the same day key — a selection that quietly spans a day the screen
    // is not showing would delete clips the person cannot see.
    const { user } = mount(LA);
    await screen.findByText(/2 clips/);
    await user.click(screen.getByRole('button', { name: /All dates/ }));
    await user.click(screen.getByRole('button', { name: '30/08/2026 — clips available' }));
    await user.click(await screen.findByRole('button', { name: 'Select all shown' }));
    expect(await screen.findByText('1 selected')).toBeInTheDocument();
  });

  test('★ the player\'s timestamp is HOME time with the label', async () => {
    const { user } = mount(LA);
    await screen.findByText(/2 clips/);
    // The second row is c1 (the older clip, made at X).
    await user.click(screen.getAllByRole('button', { name: 'Play clip from Nursery' })[1]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('30/08/2026, 7:00:00 pm GMT-7');
  });
});

describe('ClipDatePicker — "today" is the HOME zone\'s today', () => {
  // 20:00 UTC on 30 Sep is still 30 Sep in Los Angeles but already 1 Oct in Auckland (the device). With
  // no clips and nothing selected the picker opens on today's month, which therefore depends on the zone.
  const NOW = '2026-09-30T20:00:00Z';
  const open = async (timezone) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
    const r = renderAsAdmin(
      <ClipDatePicker selected={new Set()} onToggle={() => {}} onClear={() => {}} availableDays={new Set()} labelFor={() => null} />,
      { settings: { timezone } },
    );
    await r.user.click(screen.getByRole('button', { name: /All dates/ }));
    return r;
  };

  test('★ opens on September when home is Los Angeles (the device\'s own today would be October)', async () => {
    await open(LA);
    expect(screen.getByText('September 2026')).toBeInTheDocument();
  });

  test('★ opens on October when home is the device\'s own zone', async () => {
    await open(DEVICE);
    expect(screen.getByText('October 2026')).toBeInTheDocument();
  });
});

describe('RecordingsCard', () => {
  const ROWS = [{ id: 'r-1', camera_name: 'Nursery', started_at: X, duration_s: 30 }];
  const mount = (timezone) => {
    vi.spyOn(api, 'get').mockResolvedValue(ROWS);
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    return renderAsAdmin(<RecordingsCard childId="kid-1" />, { settings: { timezone } });
  };

  test('★ the entry\'s time is HOME time with the label', async () => {
    const { container } = mount(LA);
    await screen.findByText('Recordings');
    await waitFor(() => expect(container.querySelector('.rec-strip__item')).not.toBeNull());
    expect(container.querySelector('.rec-strip__item').textContent).toContain('Sun, 30 Aug, 7:00 pm GMT-7');
  });

  test('★ no label when the device is at home', async () => {
    const { container } = mount(DEVICE);
    await screen.findByText('Recordings');
    await waitFor(() => expect(container.querySelector('.rec-strip__item')).not.toBeNull());
    const text = container.querySelector('.rec-strip__item').textContent;
    expect(text).toContain('Mon, 31 Aug, 2:00 pm');
    expect(text).not.toMatch(/GMT|NZST|NZDT/);
  });
});

describe('TimelapseCard — a night is a calendar date, not an instant', () => {
  test('★ the home zone does not shift the night\'s date (8 Mar stays Sun 8 Mar in Los Angeles)', async () => {
    vi.spyOn(api, 'url').mockImplementation((p) => `http://host${p}`);
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    vi.spyOn(api, 'get').mockResolvedValue([{ id: 't-1', night_date: '2026-03-08', duration_s: 42 }]);
    // Under the old code (local midnight, formatted locally) this also passed; what it must NOT do is
    // what a naive "convert to home time" would: read '2026-03-08' as 00:00 UTC and print the evening
    // before in Los Angeles. This pins that a date key never goes through a time-zone conversion.
    renderAsAdmin(<TimelapseCard childId="kid-1" />, { settings: { timezone: LA } });
    expect(await screen.findByRole('button', { name: 'Play Sun, 8 Mar timelapse' })).toBeInTheDocument();
  });
});

describe('CameraTile — the snooze end time', () => {
  // A mute that ends at a fixed wall-clock instant, a few hours from now.
  const snoozedUntil = Date.now() + 3 * 60 * 60 * 1000;
  const expected = (zone, withZone) => new Intl.DateTimeFormat('en-AU', {
    timeZone: zone, hour: 'numeric', minute: '2-digit', ...(withZone ? { timeZoneName: 'short' } : null),
  }).format(snoozedUntil);
  const mount = (timezone) => renderAsAdmin(<LiveMonitor />, {
    settings: { timezone },
    cameras: [{ id: 'c1', name: 'Nursery', mediamtx_path: 'p1', alerts_snoozed_until: snoozedUntil }],
  });

  test('★ the mute\'s end is shown in HOME time with the label', () => {
    mount(LA);
    // Guard the fixture: the two zones must read differently, or the assertion below proves nothing.
    expect(expected(LA, true)).not.toBe(expected(DEVICE, true));
    expect(screen.getByTitle(/Alerts muted until/).getAttribute('title')).toBe(`Alerts muted until ${expected(LA, true)}`);
  });

  test('★ no label when the device is at home', () => {
    mount(DEVICE);
    const title = screen.getByTitle(/Alerts muted until/).getAttribute('title');
    expect(title).toBe(`Alerts muted until ${expected(DEVICE, false)}`);
    expect(title).not.toMatch(/GMT|NZST|NZDT/);
  });
});
