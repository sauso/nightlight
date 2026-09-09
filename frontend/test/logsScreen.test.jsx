// Settings → Logs and the three cards on it: LogViewer, DiagnosticsCard and (from the child page)
// SensorHistoryCard. All three were at 0–3% and none had a test.
//
// What is worth pinning:
//   1. THE LOG FILTER IS CLIENT-SIDE OVER AN ALREADY-LOADED BUFFER, and the "N of M" counter is the
//      only thing telling the user the view is filtered at all. A filter that matched nothing and a
//      buffer that WAS empty must not read the same — they are different problems ("nothing has
//      happened" vs "your filter is too narrow") and the component has two distinct strings for it.
//   2. AUTO-REFRESH OWNS A 5-SECOND INTERVAL. Turning it off must actually stop the polling, and
//      unmounting must clear it — a leaked interval keeps calling a dead component's setState.
//   3. THE DIAGNOSTICS BUNDLE HAS A HARD DOUBLE-SUBMIT GUARD (a ref, not just the disabled attribute)
//      because a slow save on a phone looked like nothing had happened and produced several downloads.
//      A `disabled` prop alone cannot be tested for that — the ref is what stops the second call.
//   4. THE NATIVE-APP PATH HAS THREE OUTCOMES (Downloads, share sheet, failure) and one of them is an
//      OLD APP running this newer web UI, which must say so rather than "couldn't save".
//   5. SensorHistoryCard CONVERTS CELSIUS TO THE USER'S UNIT. The server stores C; the setting is
//      per-install. Getting this wrong shows a plausible-looking wrong number, which is worse than
//      showing nothing.
import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { screen, waitFor, within, act } from '@testing-library/react';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import LogViewer from '../src/components/LogViewer.jsx';
import DiagnosticsCard from '../src/components/DiagnosticsCard.jsx';
import SensorHistoryCard from '../src/components/SensorHistoryCard.jsx';
import SettingsLogs from '../src/pages/SettingsLogs.jsx';
import { api } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';

const LINES = [
  '2026-09-02 10:00:01 [motion:raffa] movement 0.031',
  '2026-09-02 10:00:02 [sound:raffa] +12 dB over ambient',
  '2026-09-02 10:00:03 ERROR mediamtx path not ready',
];

afterEach(() => vi.restoreAllMocks());

// --- LogViewer ----------------------------------------------------------------------------------

describe('LogViewer', () => {
  const mockLogs = (lines = LINES) => {
    vi.spyOn(api, 'get').mockResolvedValue({ lines });
    vi.spyOn(api, 'del').mockResolvedValue({});
  };

  test('loads the buffer on mount and shows every line', async () => {
    mockLogs();
    const { container } = renderAsAdmin(<LogViewer />);
    await waitFor(() => expect(container.querySelector('.log-viewer__box').textContent).toContain('ERROR'));
    // ⚠️ Compared as SUBSTRINGS of the box, not with `new RegExp(line)`: real log lines contain `[`
    // and `+`, which a RegExp built from them reads as metacharacters — `[motion:raffa]` becomes a
    // character class and matches a single letter, so the assertion passes against almost anything.
    const box = container.querySelector('.log-viewer__box').textContent;
    for (const l of LINES) expect(box).toContain(l);
  });

  test('an empty buffer and a filter that matches nothing say DIFFERENT things', async () => {
    mockLogs([]);
    const { unmount } = renderAsAdmin(<LogViewer />);
    expect(await screen.findByText('No log activity yet since the app last started.')).toBeInTheDocument();
    unmount();

    mockLogs();
    const { user } = renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);
    await user.type(screen.getByPlaceholderText(/Filter logs/), 'zzzzz');
    // ⚠️ These are two different problems for the person reading them, and the component has two
    // strings on purpose. Collapsing them tells someone "nothing has happened" when in fact plenty has.
    expect(screen.getByText('Nothing matches that filter.')).toBeInTheDocument();
    expect(screen.queryByText('No log activity yet since the app last started.')).not.toBeInTheDocument();
  });

  test('the text filter is case-insensitive and reports how much it is hiding', async () => {
    mockLogs();
    const { user } = renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);
    await user.type(screen.getByPlaceholderText(/Filter logs/), 'SOUND');
    expect(screen.getByText(/\+12 dB over ambient/)).toBeInTheDocument();
    expect(screen.queryByText(/movement 0.031/)).not.toBeInTheDocument();
    // The counter is the ONLY signal that the view is filtered; without it a narrow filter looks
    // exactly like a quiet server.
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  test('the count is hidden when nothing is filtered', async () => {
    mockLogs();
    renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);
    expect(screen.queryByText(/of 3/)).not.toBeInTheDocument();
  });

  test('a quick-filter chip sets the filter, and tapping the SAME chip clears it', async () => {
    mockLogs();
    const { user } = renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);

    await user.click(screen.getByRole('button', { name: 'Sound' }));
    expect(screen.getByPlaceholderText(/Filter logs/)).toHaveValue('sound');
    expect(screen.getByRole('button', { name: 'Sound' })).toHaveClass('log-chip--active');
    expect(screen.queryByText(/movement 0.031/)).not.toBeInTheDocument();

    // A chip is a toggle, not a one-way set — without this it is a trap, because the only way back
    // is to notice the text box and clear it by hand.
    await user.click(screen.getByRole('button', { name: 'Sound' }));
    expect(screen.getByPlaceholderText(/Filter logs/)).toHaveValue('');
    expect(await screen.findByText(/movement 0.031/)).toBeInTheDocument();
  });

  test('only the chip matching the current filter is marked active', async () => {
    mockLogs();
    const { user } = renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);
    await user.click(screen.getByRole('button', { name: 'Motion' }));
    expect(screen.getByRole('button', { name: 'Motion' })).toHaveClass('log-chip--active');
    // 'ONVIF motion' filters on 'onvif-motion', a different string — it must NOT light up too.
    expect(screen.getByRole('button', { name: 'ONVIF motion' })).not.toHaveClass('log-chip--active');
  });

  test('Refresh now re-reads the buffer on demand', async () => {
    mockLogs();
    const { user } = renderAsAdmin(<LogViewer />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  test('a failed load shows the reason and keeps whatever was already on screen', async () => {
    mockLogs();
    const { user } = renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);
    api.get.mockRejectedValue(new Error('Log buffer unavailable'));
    await user.click(screen.getByRole('button', { name: 'Refresh now' }));
    expect(await screen.findByText('Log buffer unavailable')).toBeInTheDocument();
    // `setLines` is only called on success, so the last good buffer must survive the failure.
    expect(screen.getByText(/movement 0.031/)).toBeInTheDocument();
  });

  test('clearing asks first, then empties the buffer and re-reads it', async () => {
    mockLogs();
    const { user } = renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);

    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    const dialog = screen.getByRole('dialog');
    expect(api.del).not.toHaveBeenCalled();

    api.get.mockResolvedValue({ lines: [] });
    await user.click(within(dialog).getByRole('button', { name: 'Clear log' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/logs'));
    expect(await screen.findByText('No log activity yet since the app last started.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('cancelling the clear sends nothing', async () => {
    mockLogs();
    const { user } = renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);
    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.del).not.toHaveBeenCalled();
  });

  test('a failed clear surfaces the reason rather than looking like it worked', async () => {
    mockLogs();
    api.del.mockRejectedValue(new Error('Read-only filesystem'));
    const { user } = renderAsAdmin(<LogViewer />);
    await screen.findByText(/movement 0.031/);
    await user.click(screen.getByRole('button', { name: 'Clear log' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Clear log' }));
    expect(await screen.findByText('Read-only filesystem')).toBeInTheDocument();
  });

  describe('auto-refresh', () => {
    beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
    afterEach(() => vi.useRealTimers());

    test('polls every 5 seconds while on, and STOPS when switched off', async () => {
      mockLogs();
      const { user } = renderAsAdmin(<LogViewer />);
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(api.get).toHaveBeenCalledTimes(2);

      // Switching off re-runs the effect, which loads once more and then registers no interval.
      await user.click(screen.getByRole('switch'));
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
      const settled = api.get.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(api.get).toHaveBeenCalledTimes(settled);
    });

    test('unmounting clears the interval', async () => {
      mockLogs();
      const { unmount } = renderAsAdmin(<LogViewer />);
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
      unmount();
      // ⚠️ A leaked interval keeps calling setState on an unmounted component every 5 s for the life
      // of the tab — and this screen is one people leave open while diagnosing something.
      await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });
});

// --- DiagnosticsCard ----------------------------------------------------------------------------

describe('DiagnosticsCard', () => {
  const BUNDLE = { version: '0.29.0', cameras: [{ id: 'cam-a' }] };

  beforeEach(() => {
    // jsdom implements neither of these; the browser download path needs both.
    URL.createObjectURL = vi.fn(() => 'blob:nightlight/1');
    URL.revokeObjectURL = vi.fn();
  });

  const mockBundle = () => vi.spyOn(api, 'get').mockResolvedValue(BUNDLE);
  const asBrowser = () => vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);

  test('renders its title and the issue link for either role', () => {
    mockBundle();
    asBrowser();
    const { unmount } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
    expect(screen.getByText('Report a problem')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /Report an issue/ });
    expect(link).toHaveAttribute('target', '_blank');
    // `noreferrer` on a target=_blank link is not cosmetic — without it the opened page gets a
    // window.opener handle back into the app.
    expect(link).toHaveAttribute('rel', 'noreferrer');
    unmount();

    renderAsCaregiver(<DiagnosticsCard title="Report a problem" />);
    expect(screen.getByRole('button', { name: /Download diagnostics/ })).toBeEnabled();
  });

  test('the browser path builds a timestamped .json blob and offers it as a download', async () => {
    mockBundle();
    asBrowser();
    const clicks = [];
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag) => {
      const el = realCreate(tag);
      if (tag === 'a') el.click = () => clicks.push({ href: el.href, download: el.download });
      return el;
    });

    const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
    await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));

    await waitFor(() => expect(clicks).toHaveLength(1));
    expect(clicks[0].href).toBe('blob:nightlight/1');
    // Colons are illegal in Windows filenames and ISO timestamps are full of them — the component
    // strips them on purpose, so the name must not contain any.
    expect(clicks[0].download).toMatch(/^nightlight-diagnostics-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/);
    expect(clicks[0].download).not.toContain(':');
    // The bundle is serialised readable, because the whole point is that a user can open it and
    // check what they are about to share.
    const written = URL.createObjectURL.mock.calls[0][0];
    expect(written.type).toBe('application/json');
  });

  test('the button locks and reports success, then returns to idle', async () => {
    mockBundle();
    asBrowser();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
      await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));
      const done = await screen.findByRole('button', { name: /Downloaded ✓/ });
      expect(done).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
      expect(screen.getByRole('button', { name: /Download diagnostics/ })).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('a second tap while it is still preparing is ignored', async () => {
    asBrowser();
    let release;
    vi.spyOn(api, 'get').mockImplementation(() => new Promise((r) => { release = r; }));
    const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
    const btn = screen.getByRole('button', { name: /Download diagnostics/ });
    await user.click(btn);

    // ⚠️ The `disabled` attribute is not the guard being tested — `busyRef` is. A slow save on a
    // phone looked like nothing had happened and produced several downloads, so the component holds
    // a ref that does not depend on render timing.
    await user.click(screen.getByRole('button', { name: /Preparing…/ }));
    expect(api.get).toHaveBeenCalledTimes(1);
    release(BUNDLE);
    await screen.findByRole('button', { name: /Downloaded ✓/ });
  });

  test('a failed build shows the reason and unlocks the button for a retry', async () => {
    asBrowser();
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Diagnostics are admin-only'));
    const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
    await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));
    expect(await screen.findByText('Diagnostics are admin-only')).toBeInTheDocument();
    // Both halves matter: the busyRef must be released too, or the retry is silently a no-op.
    const btn = screen.getByRole('button', { name: /Download diagnostics/ });
    expect(btn).toBeEnabled();
    api.get.mockResolvedValue(BUNDLE);
    await user.click(btn);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  test('an error with no message still says something', async () => {
    asBrowser();
    vi.spyOn(api, 'get').mockRejectedValue(new Error(''));
    const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
    await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));
    expect(await screen.findByText('Failed to build diagnostics')).toBeInTheDocument();
  });

  describe('inside the native app', () => {
    const asNative = (over = {}) => {
      vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
      vi.spyOn(nativeBridge, 'hasFileExport').mockReturnValue(over.hasExport ?? true);
      vi.spyOn(nativeBridge, 'saveToDownloads').mockResolvedValue(over.downloads ?? true);
      vi.spyOn(nativeBridge, 'saveTextFile').mockResolvedValue(over.share ?? true);
    };

    test('saves straight to Downloads when it can', async () => {
      mockBundle();
      asNative();
      const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
      await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));
      expect(await screen.findByText('Saved to your Downloads folder.')).toBeInTheDocument();
      expect(nativeBridge.saveToDownloads).toHaveBeenCalled();
      expect(nativeBridge.saveTextFile).not.toHaveBeenCalled();
    });

    test('falls back to the share sheet when Downloads is refused', async () => {
      mockBundle();
      asNative({ downloads: false });
      const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
      await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));
      expect(await screen.findByText('Shared — pick "Save to Files" to keep a copy.')).toBeInTheDocument();
    });

    test('says so plainly when BOTH native routes refuse', async () => {
      mockBundle();
      asNative({ downloads: false, share: false });
      const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
      await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));
      expect(await screen.findByText("Couldn't save the file on this device.")).toBeInTheDocument();
    });

    test('an OLD installed app is told to update, not given a mystery failure', async () => {
      mockBundle();
      asNative({ hasExport: false });
      const { user } = renderAsAdmin(<DiagnosticsCard title="Report a problem" />);
      await user.click(screen.getByRole('button', { name: /Download diagnostics/ }));
      // ⚠️ The web UI is loaded live from the server, so an app installed months ago runs today's
      // React against yesterday's plugins. "Couldn't save" would send that person to the wrong
      // problem entirely.
      expect(await screen.findByText(/Update to the latest app version/)).toBeInTheDocument();
      expect(nativeBridge.saveToDownloads).not.toHaveBeenCalled();
    });
  });
});

// --- SensorHistoryCard --------------------------------------------------------------------------

describe('SensorHistoryCard', () => {
  const CAM = { id: 'cam-a', name: 'Raffa Room' };
  const readings = (rows) => vi.spyOn(api, 'get').mockResolvedValue({ readings: rows });

  test('renders nothing at all while loading', () => {
    vi.spyOn(api, 'get').mockImplementation(() => new Promise(() => {}));
    const { container } = renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    // Deliberately null rather than an empty card: a card that appears and then changes shape is
    // worse on a page that already has several.
    expect(container.querySelector('.sensor-card')).toBeNull();
  });

  test('asks for exactly 24 hours of this camera history', async () => {
    readings([]);
    renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/cameras/cam-a/sensor-history?hours=24'));
  });

  test('names the camera in the empty state, so it is clear WHICH room has no data', async () => {
    readings([]);
    renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    expect(await screen.findByText(/Collecting data/)).toBeInTheDocument();
    expect(screen.getByText('Raffa Room')).toBeInTheDocument();
  });

  test('a failed fetch degrades to the empty state rather than throwing', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('no sensor'));
    renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    expect(await screen.findByText(/Collecting data/)).toBeInTheDocument();
  });

  test('a malformed response is treated as no data, not as a crash', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ readings: 'nope' });
    renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    expect(await screen.findByText(/Collecting data/)).toBeInTheDocument();
  });

  test('shows the latest reading plus the 24h low and high, in Celsius', async () => {
    readings([
      { temperature: 20.4, humidity: 51 },
      { temperature: 23.8, humidity: 60 },
      { temperature: 21.2, humidity: 55 },
    ]);
    renderAsAdmin(<SensorHistoryCard camera={CAM} />, { settings: { temp_unit: 'C' } });
    expect(await screen.findByText('21.2°C')).toBeInTheDocument(); // latest, not the max
    expect(screen.getByText('low 20.4°C')).toBeInTheDocument();
    expect(screen.getByText('high 23.8°C')).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
  });

  test('converts to Fahrenheit when that is the configured unit — humidity is NOT converted', async () => {
    readings([{ temperature: 0, humidity: 50 }, { temperature: 100, humidity: 55 }]);
    renderAsAdmin(<SensorHistoryCard camera={CAM} />, { settings: { temp_unit: 'F' } });
    // 0 °C = 32 °F and 100 °C = 212 °F: the two fixed points, so a wrong scale factor OR a wrong
    // offset both fail here. A single mid-range value would pass against either mistake alone.
    expect(await screen.findByText('212.0°F')).toBeInTheDocument();
    expect(screen.getByText('low 32.0°F')).toBeInTheDocument();
    expect(screen.getByText('high 212.0°F')).toBeInTheDocument();
    expect(screen.getByText('55%')).toBeInTheDocument();
  });

  test('a series with no readings is dropped entirely, not drawn empty', async () => {
    readings([{ temperature: 21 }, { temperature: 22 }]); // humidity absent throughout
    renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    expect(await screen.findByText('Temperature')).toBeInTheDocument();
    expect(screen.queryByText('Humidity')).not.toBeInTheDocument();
  });

  test('non-numeric readings are skipped rather than plotted as NaN', async () => {
    readings([{ temperature: 21.0, humidity: null }, { temperature: null, humidity: 50 }, { temperature: 22.0, humidity: 52 }]);
    renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    expect(await screen.findByText('22.0°C')).toBeInTheDocument();
    expect(screen.getByText('52%')).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  test('a single reading shows its value but draws no sparkline', async () => {
    readings([{ temperature: 21.5, humidity: 50 }]);
    const { container } = renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    expect(await screen.findByText('21.5°C')).toBeInTheDocument();
    // A two-point line needs two points; one would divide by zero building the x coordinates.
    expect(container.querySelector('svg.spark')).toBeNull();
  });

  test('a flat series still draws a line instead of collapsing onto the edge', async () => {
    readings([{ temperature: 21.0 }, { temperature: 21.0 }, { temperature: 21.0 }]);
    const { container } = renderAsAdmin(<SensorHistoryCard camera={CAM} />);
    await screen.findByText('21.0°C');
    const path = container.querySelector('svg.spark path:nth-of-type(2)');
    // With min === max the range is padded by ±0.5, so the line sits mid-height. Without that guard
    // the division is 0/0 and every y is NaN, which renders an invisible, silently broken chart.
    expect(path.getAttribute('d')).not.toMatch(/NaN/);
  });
});

// --- the Logs screen itself ---------------------------------------------------------------------

describe('Settings → Logs', () => {
  test('assembles the four cards under their headings', async () => {
    // Path-aware: each card unwraps a DIFFERENT shape (`{lines}`, `{events}`, a bare array), and a
    // single blanket mock makes two of the three throw on `undefined.length` — which then reads as
    // "the screen is broken" rather than "the fixture is".
    vi.spyOn(api, 'get').mockImplementation((path) => {
      const p = String(path);
      if (p.startsWith('/logs')) return Promise.resolve({ lines: LINES });
      if (p.startsWith('/events')) return Promise.resolve({ events: [] });
      return Promise.resolve([]);
    });
    const { container } = renderAsAdmin(<SettingsLogs />);
    expect(screen.getByText('Logs')).toBeInTheDocument();
    expect(screen.getByText('Report a problem')).toBeInTheDocument();
    expect(screen.getByText('Recent alerts')).toBeInTheDocument();
    expect(screen.getByText('Camera history')).toBeInTheDocument();
    expect(screen.getByText('Recent logs')).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector('.log-viewer__box').textContent).toContain('movement 0.031')
    );
  });
});
