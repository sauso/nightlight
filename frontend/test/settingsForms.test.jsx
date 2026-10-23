// The Settings hub and the three settings forms whose fields were still unexercised: MQTT, ntfy and
// Recording.
//
// The recurring thing worth pinning on every one of these screens is THE SAVED PAYLOAD, not the boxes.
// `PUT /settings` keeps any field it is not sent, which is what lets these pages coexist — each owns a
// handful of keys and leaves the rest alone. A page that posted its whole form would stamp its own
// mount-time copy of every unrelated setting over whatever another tab had since saved, and nothing
// on screen would look wrong.
//
// Two more, specific to these screens:
//   * SettingsRecording mixes an IMMEDIATE-APPLY switch (on-demand recording, which starts and stops
//     per-camera buffering the moment it is flipped) with SAVE-ON-SUBMIT numeric fields. The control
//     shapes promise that difference, so the switch must not wait for Save and the numbers must.
//   * The Settings hub's MQTT badge has three states — connected, enabled-but-not-connected, and off —
//     and the middle one is the only signal a broker has gone away.
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAs, renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import Settings from '../src/pages/Settings.jsx';
import SettingsMqtt from '../src/pages/SettingsMqtt.jsx';
import SettingsPushNtfy from '../src/pages/SettingsPushNtfy.jsx';
import SettingsRecording from '../src/pages/SettingsRecording.jsx';
import { api } from '../src/lib/api.js';
import * as nativeBridge from '../src/lib/nativeBridge.js';

afterEach(() => vi.restoreAllMocks());

const pathAware = (map) =>
  vi.spyOn(api, 'get').mockImplementation((p) => {
    const key = Object.keys(map).find((k) => String(p).startsWith(k));
    return Promise.resolve(key ? map[key] : null);
  });

// --- the Settings hub ---------------------------------------------------------------------------

describe('the Settings hub', () => {
  const hub = pathAware;

  test('shows the signed-in person, their role and the app version', async () => {
    hub({ '/about': { version: '0.29.0' }, '/settings/mqtt/status': { enabled: false } });
    renderAsAdmin(<Settings />);
    expect(screen.getByText('Nacho')).toBeInTheDocument();
    expect(screen.getByText('admin · Account')).toBeInTheDocument();
    expect(await screen.findByText('0.29.0')).toBeInTheDocument();
  });

  test('falls back through full name → username → "You"', async () => {
    hub({});
    // ⚠️ renderAs takes the user as its FIRST argument; passing one in the options object is
    // silently ignored, because the helper spreads its own `user` parameter last.
    const { rerenderWith } = renderAs({ username: 'nacho', role: 'admin' }, <Settings />);
    expect(screen.getByText('nacho')).toBeInTheDocument();
    rerenderWith({ user: { role: 'admin' } });
    expect(screen.getByText('You')).toBeInTheDocument();
    rerenderWith({ user: { first_name: 'Nacho', last_name: 'L', username: 'x', role: 'admin' } });
    expect(screen.getByText('Nacho L')).toBeInTheDocument();
  });

  test('ONLY an admin sees the system configuration rows', () => {
    hub({});
    const { unmount } = renderAsAdmin(<Settings />);
    for (const label of ['General', 'Camera controls', 'Recording', 'Caregivers', 'MQTT', 'Push notifications', 'Clip management', 'Logs']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    unmount();

    hub({});
    renderAsCaregiver(<Settings />);
    for (const label of ['General', 'Caregivers', 'MQTT', 'Logs', 'Clip management']) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    // A caregiver still gets their own account and About.
    expect(screen.getByText('About')).toBeInTheDocument();
    expect(screen.getByText('caregiver · Account')).toBeInTheDocument();
  });

  test('a caregiver is never even asked for the MQTT status', async () => {
    const spy = pathAware({});
    renderAsCaregiver(<Settings />);
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/about'));
    // Not a cosmetic saving: the endpoint is admin-only, so calling it would log a 403 on every
    // caregiver's visit to Settings.
    expect(spy.mock.calls.some(([p]) => String(p).includes('mqtt'))).toBe(false);
  });

  test('the MQTT badge distinguishes connected, disconnected and off', async () => {
    for (const [status, text, cls] of [
      [{ enabled: true, connected: true }, 'Connected', 'status-badge--ok'],
      [{ enabled: true, connected: false }, 'Disconnected', 'status-badge--bad'],
      [{ enabled: false, connected: false }, 'Off', 'status-badge--off'],
    ]) {
      hub({ '/settings/mqtt/status': status });
      const { unmount } = renderAsAdmin(<Settings />);
      // ⚠️ "Disconnected" is the whole point of the badge: enabled but not connected is a broker that
      // has gone away, and this row is the only place in the app that says so.
      expect(await screen.findByText(text)).toHaveClass(cls);
      unmount();
    }
  });

  test('no badge at all when the status cannot be read', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('nope'));
    renderAsAdmin(<Settings />);
    await waitFor(() => expect(screen.getByText('MQTT')).toBeInTheDocument());
    // Better silent than a confident "Off" for a broker that might be running fine.
    for (const t of ['Connected', 'Disconnected', 'Off']) expect(screen.queryByText(t)).not.toBeInTheDocument();
  });

  test('rows navigate, carrying a Settings back-link', async () => {
    hub({});
    const { user } = renderAsAdmin(
      <Routes>
        <Route path="/" element={<Settings />} />
        <Route path="/settings/general" element={<div>general page</div>} />
        <Route path="/account" element={<div>account page</div>} />
      </Routes>
    );
    await user.click(screen.getByText('General'));
    expect(await screen.findByText('general page')).toBeInTheDocument();
  });

  test('every row is keyboard-operable — they are divs, not buttons', async () => {
    hub({});
    const { user } = renderAsAdmin(
      <Routes>
        <Route path="/" element={<Settings />} />
        <Route path="/account" element={<div>account page</div>} />
      </Routes>
    );
    // ⚠️ `role="button"` + `tabIndex` + an Enter/Space handler are the only things making these
    // reachable at all. Tab rather than calling focus(), so the tab order is proven — and TWICE,
    // because the header's logo button is the first tabbable thing on the page. Assert where focus
    // actually lands rather than assuming, which is how a one-tab version of this passed while
    // testing the wrong element entirely.
    await user.tab();
    await user.tab();
    expect(document.activeElement).toHaveAttribute('role', 'button');
    expect(document.activeElement.textContent).toContain('Account');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('account page')).toBeInTheDocument();
  });

  test('Space also activates a row, and does not scroll the page', async () => {
    hub({});
    const { user } = renderAsAdmin(
      <Routes>
        <Route path="/" element={<Settings />} />
        <Route path="/settings/general" element={<div>general page</div>} />
      </Routes>
    );
    const row = screen.getByText('General').closest('[role="button"]');
    row.focus();
    await user.keyboard(' ');
    expect(await screen.findByText('general page')).toBeInTheDocument();
  });

  test('Change server appears only inside the native app', () => {
    hub({});
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(false);
    const { unmount } = renderAsAdmin(<Settings />);
    expect(screen.queryByText('Change server')).not.toBeInTheDocument();
    unmount();

    hub({});
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
    renderAsAdmin(<Settings />);
    // In a browser there is no other server to change to — the URL bar is the server picker.
    expect(screen.getByText('Change server')).toBeInTheDocument();
  });

  test('Change server calls into the shell', async () => {
    hub({});
    vi.spyOn(nativeBridge, 'isNativeApp').mockReturnValue(true);
    const change = vi.spyOn(nativeBridge, 'changeServer').mockImplementation(() => {});
    const { user } = renderAsAdmin(<Settings />);
    await user.click(screen.getByText('Change server'));
    expect(change).toHaveBeenCalled();
  });
});

// --- MQTT ---------------------------------------------------------------------------------------

describe('Settings → MQTT', () => {
  const SETTINGS = {
    mqtt_enabled: 1,
    mqtt_host: '192.0.2.50',
    mqtt_port: 1883,
    mqtt_username: 'nightlight',
    app_name: 'Nightlight', // present, and must NOT be posted
  };

  const loadMqtt = (cfg) => vi.spyOn(api, 'get').mockResolvedValue(cfg);

  test('a null response does NOT take the page to the crash screen', async () => {
    // ⚠️ REGRESSION TEST FOR A REAL DEFECT, found by writing the test below. `api.get` returns null
    // for an empty or unparseable body on a 200 (a proxy that strips it, a truncated response), and
    // the page read the config INSIDE a `setForm(f => …)` updater. React runs that on a later tick,
    // so the throw escaped the `.catch` sitting right beside it and became an uncaught TypeError that
    // blanked the whole page. Watched failing before the fix.
    loadMqtt(null);
    renderAsAdmin(<SettingsMqtt />);
    expect(await screen.findByLabelText('Broker host')).toHaveValue('');
    expect(screen.getByLabelText('Broker port')).toHaveValue(null);
  });

  test('saves every field it owns — and nothing else', async () => {
    loadMqtt({ mqtt_enabled: 1, mqtt_host: '192.0.2.50', mqtt_port: 1883, mqtt_username: 'nightlight' });
    vi.spyOn(api, 'put').mockResolvedValue({});
    const { user } = renderAsAdmin(<SettingsMqtt />, { settings: SETTINGS });
    await waitFor(() => expect(screen.getByLabelText('Broker host')).toHaveValue('192.0.2.50'));

    await user.clear(screen.getByLabelText('Broker host'));
    await user.type(screen.getByLabelText('Broker host'), '10.0.0.9');
    await user.clear(screen.getByLabelText('Broker port'));
    await user.type(screen.getByLabelText('Broker port'), '8883');
    await user.clear(screen.getByLabelText('Username (optional)'));
    await user.type(screen.getByLabelText('Username (optional)'), 'ha');
    await user.click(screen.getByRole('switch', { name: /Enable MQTT/ }));
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    expect(body.mqtt_host).toBe('10.0.0.9');
    expect(body.mqtt_port).toBe('8883');
    expect(body.mqtt_username).toBe('ha');
    expect(body.mqtt_enabled).toBe(false);
    // ⚠️ The page must not carry unrelated settings along for the ride.
    expect(body).not.toHaveProperty('app_name');
  });

  test('an empty host renders as an empty box, not the string "null"', async () => {
    loadMqtt({ mqtt_host: null, mqtt_port: null, mqtt_username: null });
    renderAsAdmin(<SettingsMqtt />);
    await waitFor(() => expect(screen.getByLabelText('Broker host')).toHaveValue(''));
    expect(screen.getByLabelText('Broker port')).toHaveValue(null);
  });

  // ★ #562. The broker port was a bare number input: the browser would accept 188333 or 0 and the server
  // would refuse it only after Save (routes/settings.js: 1-65535, blank = 1883). The range is now on the
  // field, so the browser says so first.
  // ⚠️ jsdom implements the constraint-validation flags (rangeOverflow/rangeUnderflow) but not the popup the
  // browser draws; this proves the field REPORTS invalid, which is what blocks the form's submit.
  test('★ #562 the broker port is bounded 1-65535, and blank stays valid (the server default)', async () => {
    loadMqtt({ mqtt_host: null, mqtt_port: null, mqtt_username: null });
    const { user } = renderAsAdmin(<SettingsMqtt />);
    const port = await screen.findByLabelText('Broker port');
    expect(port).toHaveAttribute('min', '1');
    expect(port).toHaveAttribute('max', '65535');

    await user.type(port, '188333');
    expect(port.validity.rangeOverflow).toBe(true);
    expect(port.validity.valid).toBe(false);

    await user.clear(port);
    await user.type(port, '65535');
    expect(port.validity.valid).toBe(true);
    await user.clear(port);
    await user.type(port, '65536');
    expect(port.validity.rangeOverflow).toBe(true);

    await user.clear(port);
    await user.type(port, '0');
    expect(port.validity.rangeUnderflow).toBe(true);
    await user.clear(port);
    await user.type(port, '1');
    expect(port.validity.valid).toBe(true);

    // Blank is valid: it means "use 1883", which the server stores as NULL.
    await user.clear(port);
    expect(port.validity.valid).toBe(true);
  });
});

// --- ntfy ---------------------------------------------------------------------------------------

describe('Settings → Push → ntfy', () => {
  const CONFIG = {
    enabled: 1,
    server_url: 'https://ntfy.sh',
    topic: 'nightlight-alerts-x8k2',
    username: 'me',
    password_set: true,
  };

  test('loads the saved config into every field', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(CONFIG);
    renderAsAdmin(<SettingsPushNtfy />);
    // Wait on the one field whose value ONLY the stored config supplies: 'https://ntfy.sh' is also the
    // form's default, so waiting on Server URL passes before anything has loaded and the reads below race
    // the request (#570).
    await waitFor(() => expect(screen.getByLabelText('Topic')).toHaveValue('nightlight-alerts-x8k2'));
    expect(screen.getByLabelText('Server URL')).toHaveValue('https://ntfy.sh');
    expect(screen.getByLabelText('Username (optional)')).toHaveValue('me');
    // ⚠️ A saved password is never sent back to the client — the placeholder is the only thing that
    // says one exists.
    expect(screen.getByLabelText('Password (optional)')).toHaveValue('');
    expect(screen.getByLabelText('Password (optional)')).toHaveAttribute('placeholder', '•••••• (unchanged)');
  });

  test('shows no "unchanged" hint when no password has ever been set', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...CONFIG, password_set: false });
    renderAsAdmin(<SettingsPushNtfy />);
    await waitFor(() => expect(screen.getByLabelText('Topic')).toHaveValue(CONFIG.topic));
    expect(screen.getByLabelText('Password (optional)')).toHaveAttribute('placeholder', '');
  });

  test('typing in every field reaches the saved payload', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...CONFIG, username: '', password_set: false });
    vi.spyOn(api, 'put').mockResolvedValue({});
    const { user } = renderAsAdmin(<SettingsPushNtfy />);
    await waitFor(() => expect(screen.getByLabelText('Topic')).toHaveValue(CONFIG.topic));

    await user.clear(screen.getByLabelText('Server URL'));
    await user.type(screen.getByLabelText('Server URL'), 'https://ntfy.example');
    await user.clear(screen.getByLabelText('Topic'));
    await user.type(screen.getByLabelText('Topic'), 'my-topic');
    await user.type(screen.getByLabelText('Username (optional)'), 'bob');
    await user.type(screen.getByLabelText('Password (optional)'), 'hunter2');
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: /^Save/ }));

    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    expect(body.server_url).toBe('https://ntfy.example');
    expect(body.topic).toBe('my-topic');
    expect(body.username).toBe('bob');
    expect(body.password).toBe('hunter2');
    expect(body.enabled).toBe(false);
  });

  test('the fields stay disabled until the saved config has actually arrived', async () => {
    // ⚠️ The regression that produced this rule on the Gotify page: an unguarded field lets someone
    // type before the GET resolves, and the arriving config then silently overwrites what they typed.
    let resolve;
    vi.spyOn(api, 'get').mockImplementation(() => new Promise((r) => { resolve = r; }));
    renderAsAdmin(<SettingsPushNtfy />);
    expect(screen.getByRole('switch')).toBeDisabled();
    resolve(CONFIG);
    await waitFor(() => expect(screen.getByRole('switch')).toBeEnabled());
  });
});

// --- Recording ----------------------------------------------------------------------------------

describe('Settings → Recording', () => {
  const SETTINGS = {
    clip_pre_roll_s: 5,
    clip_post_roll_s: 10,
    clip_retention_days: 45,
    clip_retention_max_gb: 20,
    wake_clips_enabled: 1,
    wake_clip_seconds: 30,
    wake_clip_retention_days: 14,
    ondemand_enabled: 1,
    ondemand_pre_roll_s: 30,
    ondemand_max_duration_s: 120,
    app_name: 'Nightlight',
  };
  const withStorage = (usedBytes) =>
    vi.spyOn(api, 'get').mockResolvedValue({ usedBytes, clipCount: 3, path: '/app/data/clips', ok: true });

  test('the numeric fields are SAVE-ON-SUBMIT and go out together', async () => {
    withStorage(1024 ** 3);
    vi.spyOn(api, 'put').mockResolvedValue({});
    const { user } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });

    await user.clear(screen.getByLabelText('Clip length (seconds)'));
    await user.type(screen.getByLabelText('Clip length (seconds)'), '45');
    await user.clear(screen.getByLabelText('Capture before (seconds)'));
    await user.type(screen.getByLabelText('Capture before (seconds)'), '15');
    await user.clear(screen.getByLabelText('Auto-stop after (seconds)'));
    await user.type(screen.getByLabelText('Auto-stop after (seconds)'), '300');
    // Nothing has been sent yet — these keep Save, and the control shape is the promise.
    expect(api.put).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = api.put.mock.calls[0][1];
    expect(body.wake_clip_seconds).toBe('45');
    expect(body.ondemand_pre_roll_s).toBe('15');
    expect(body.ondemand_max_duration_s).toBe('300');
    expect(body).not.toHaveProperty('app_name');
    // Let the save FINISH before the test ends. The page keeps working after the PUT resolves (it refetches
    // the storage readout and arms a timer); a test that ends first leaves that continuation running
    // into the NEXT test, where it competes for the same mocked `api.get` and made "storage is shown in
    // human units" fail whenever the request took more than a few ms (#570).
    await screen.findAllByText('Saved ✓');
  });

  test('the on-demand switch is a DRAFT: nothing is sent until Save (#391)', async () => {
    withStorage(0);
    // PUT /settings answers with the full, normalised admin settings row (see backend/src/routes/settings.js).
    vi.spyOn(api, 'put').mockResolvedValue({ ...SETTINGS, ondemand_enabled: false });
    const { user, settingsValue } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });

    await user.click(screen.getByRole('switch', { name: 'Show a Record button on each camera' }));
    expect(api.put).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    expect(api.put.mock.calls[0][1].ondemand_enabled).toBe(false);
    // The save commits the PUT's own response as the new settings instead of a second, separate re-read
    // that could fail independently of the write that already succeeded (#449; SettingsContext's commit()).
    await waitFor(() => expect(settingsValue.commit).toHaveBeenCalledWith({ ...SETTINGS, ondemand_enabled: false }));
    expect(settingsValue.refresh).not.toHaveBeenCalled();
    await screen.findAllByText('Saved ✓');
  });

  test('a failed Save leaves the switch where the person put it, with the error and the notice', async () => {
    withStorage(0);
    vi.spyOn(api, 'put').mockRejectedValue(new Error('Disk is full'));
    const { user } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    await user.click(screen.getByRole('switch', { name: 'Show a Record button on each camera' }));
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Disk is full')).toBeInTheDocument();
    // It is still a draft, and says so; the stored value (on) is untouched on the server.
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
  });

  test('a failed Save with no message still says something', async () => {
    withStorage(0);
    vi.spyOn(api, 'put').mockRejectedValue(new Error(''));
    const { user } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    await user.click(screen.getByRole('switch', { name: 'Show a Record button on each camera' }));
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
  });

  test('the per-feature fields appear only while that feature is on', async () => {
    withStorage(0);
    const { user } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    expect(screen.getByLabelText('Clip length (seconds)')).toBeInTheDocument();
    expect(screen.getByLabelText('Capture before (seconds)')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Show a Record button on each camera' }));
    expect(screen.queryByLabelText('Capture before (seconds)')).not.toBeInTheDocument();
    // The wake-clip fields belong to the OTHER feature and must be untouched by that.
    expect(screen.getByLabelText('Clip length (seconds)')).toBeInTheDocument();
  });

  test('storage is shown in human units, and an unknown size reads as a dash', async () => {
    withStorage(2 * 1024 ** 3);
    const { unmount } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    // (#392: the alert-clip row and the total both read 2.00 GB here, so more than one element matches.)
    expect((await screen.findAllByText(/2\.00 GB/)).length).toBeGreaterThan(0);
    unmount();

    withStorage(5 * 1024 ** 2);
    const mb = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    expect((await screen.findAllByText(/5 MB/)).length).toBeGreaterThan(0);
    mb.unmount();

    // ⚠️ 2048 rather than 512: 512 bytes formats as "1 KB" after rounding, which is also what a
    // broken formatter that ignored the divisor would produce — a fixture that cannot discriminate.
    withStorage(2048);
    const kb = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    expect((await screen.findAllByText(/2 KB/)).length).toBeGreaterThan(0);
    kb.unmount();

    // ⚠️ `null` and `Infinity` both land on the dash — but only when the CARD renders at all. A
    // failed fetch leaves `storage` null: that is a different behaviour (#392: a card that says it is
    // unavailable, with a Retry), tested below. Here: a card that says it doesn't know the size.
    // (The alert-clip row and the total both show the dash, so more than one element matches.)
    withStorage(null);
    const dash = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    expect((await screen.findAllByText('—')).length).toBeGreaterThan(0);
    dash.unmount();

    vi.spyOn(api, 'get').mockResolvedValue({ usedBytes: Infinity, path: '/x', ok: true });
    const inf = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    expect((await screen.findAllByText('—')).length).toBeGreaterThan(0);
    inf.unmount();
  });

  // #392: the three categories are mutually exclusive and the total is exactly their sum. Byte values are chosen so the
  // wrong readings are distinguishable on screen: 3 MB alert, 5 MB manual, 7 MB wake; the old readout printed the
  // "recordings" figure (manual + wake = 12 MB) and then the wake figure again.
  const MB = 1024 ** 2;
  const FULL = {
    usedBytes: 3 * MB, clipCount: 2, path: '/app/data/clips', ok: true, freeBytes: 20 * 1024 ** 3,
    recordingCount: 4, recordingBytes: 12 * MB,
    manualRecordings: { count: 1, bytes: 5 * MB },
    wakeClips: { count: 3, bytes: 7 * MB },
  };
  const rowOf = (label) => screen.getByText((_, el) => el?.tagName === 'DIV' && el.textContent.startsWith(label));

  test('#392: the storage card shows alert clips, manual recordings and wake clips apart, and a total that counts each once', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(FULL);
    renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    await screen.findByText(/Alert clips:/);
    expect(rowOf('Alert clips:').textContent).toContain('3 MB');
    expect(rowOf('Alert clips:').textContent).toContain('2 clips');
    expect(rowOf('Manual recordings:').textContent).toContain('5 MB');
    expect(rowOf('Manual recordings:').textContent).toContain('1 recording');
    expect(rowOf('Wake clips:').textContent).toContain('7 MB');
    expect(rowOf('Wake clips:').textContent).toContain('3 clips');
    expect(rowOf('Total of the three:').textContent).toContain('15 MB'); // 3 + 5 + 7, not 3 + 12 + 7
    expect(rowOf('Total of the three:').textContent).toContain('20.00 GB free');
    expect(screen.getByText(/apply to alert clips only/)).toBeInTheDocument();
  });

  test('#392: with no alert clips the total is still the sum of what is stored, not zero', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...FULL, usedBytes: 0, clipCount: 0 });
    renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    await screen.findByText(/Alert clips:/);
    expect(rowOf('Total of the three:').textContent).toContain('12 MB');
  });

  test('#392: a server without the manual subtotal is read as all recordings minus wake clips', async () => {
    const { manualRecordings, ...old } = FULL;
    vi.spyOn(api, 'get').mockResolvedValue(old);
    renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    await screen.findByText(/Alert clips:/);
    expect(rowOf('Manual recordings:').textContent).toContain('5 MB');
    expect(rowOf('Manual recordings:').textContent).toContain('1 recording');
    expect(rowOf('Total of the three:').textContent).toContain('15 MB');
  });

  test('#392: a storage refresh that fails after a save keeps the last readout instead of replacing it with an error', async () => {
    let storageCalls = 0;
    let fail = false;
    vi.spyOn(api, 'get').mockImplementation((url) => {
      if (url !== '/settings/clip-storage') return Promise.resolve({});
      storageCalls++;
      return fail ? Promise.reject(new Error('nope')) : Promise.resolve(FULL);
    });
    vi.spyOn(api, 'put').mockResolvedValue({});
    const { user } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    await screen.findByText(/Alert clips:/);
    expect(storageCalls).toBe(1);

    fail = true;
    await user.clear(screen.getByLabelText('Clip length (seconds)'));
    await user.type(screen.getByLabelText('Clip length (seconds)'), '45');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await screen.findAllByText('Saved ✓');
    await waitFor(() => expect(storageCalls).toBe(2)); // the post-save refresh ran, and failed
    expect(screen.getByText(/Alert clips:/)).toBeInTheDocument();
    expect(screen.queryByText('Storage details unavailable.')).not.toBeInTheDocument();
  });

  test('#392: a failed storage request says so and Retry loads it', async () => {
    let fail = true;
    let storageCalls = 0;
    vi.spyOn(api, 'get').mockImplementation((url) => {
      if (url !== '/settings/clip-storage') return Promise.resolve({});
      storageCalls++;
      return fail ? Promise.reject(new Error('nope')) : Promise.resolve(FULL);
    });
    const { user } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    expect(await screen.findByText('Storage details unavailable.')).toBeInTheDocument();
    expect(storageCalls).toBe(1);

    fail = false;
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText(/Alert clips:/);
    expect(storageCalls).toBe(2);
    expect(screen.queryByText('Storage details unavailable.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  test('a failed save shows the reason and leaves the form usable', async () => {
    withStorage(0);
    vi.spyOn(api, 'put').mockRejectedValue(new Error('clip_pre_roll_s must be 0-60'));
    const { user } = renderAsAdmin(<SettingsRecording />, { settings: SETTINGS });
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('clip_pre_roll_s must be 0-60')).toBeInTheDocument();
    expect(screen.queryByText('Saved ✓')).not.toBeInTheDocument();
  });
});
