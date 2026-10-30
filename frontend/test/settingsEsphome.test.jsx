// Settings → Integrations → ESPHome (#506). The device list and its states, the add / edit form (and its one secret, the
// encryption key), test, delete, retention and the CSV download. The server is mocked at `api`; the rules it relies on
// (what a state means, the export size guard) have their own tests in esphomeUi.test.js.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within, fireEvent, act } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsEsphome from '../src/pages/SettingsEsphome.jsx';
import { api } from '../src/lib/api.js';
import { saveTextDownload } from '../src/lib/saveTextDownload.js';
import { dayString } from '../src/lib/esphomeUi.js';

vi.mock('../src/lib/saveTextDownload.js', () => ({ saveTextDownload: vi.fn(async () => '') }));

const status = (over = {}) => ({
  id: 1, enabled: true, state: 'connected', encrypted: true, error_code: null, error: null, entity_count: 7,
  last_row_at: new Date(Date.now() - 120000).toISOString(), rows_last_hour: 410, coverage: { rows_last_hour: 410 }, ...over,
});
const device = (over = {}) => ({
  id: 1, name: 'Device A', host: '10.0.0.5', port: 6053, child_id: null, enabled: true, created_at: '2026-10-01 00:00:00',
  key_set: true, status: status(), ...over,
});
const CHILDREN = [{ id: 'c1', name: 'First child' }, { id: 'c2', name: 'Second child' }];
const SECRET = 'QWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU=';

let getSpy, postSpy, putSpy, delSpy, getTextSpy;
function mockApi({ devices = [device()], onDevices = null, children = CHILDREN, childrenFail = false, settings = { retention_days: 30 },
  entities = [], post = null, put = null, del = null, getText = null } = {}) {
  getSpy = vi.spyOn(api, 'get').mockImplementation(async (path) => {
    const p = String(path);
    if (p === '/esphome/devices') return onDevices ? onDevices() : devices;
    if (/^\/esphome\/devices\/\d+\/entities$/.test(p)) return entities;
    if (p === '/children') { if (childrenFail) throw new Error('no'); return children; }
    if (p === '/esphome/settings') return settings;
    throw new Error(`unexpected GET ${p}`);
  });
  postSpy = vi.spyOn(api, 'post').mockImplementation(post || (async () => ({})));
  putSpy = vi.spyOn(api, 'put').mockImplementation(put || (async () => ({})));
  delSpy = vi.spyOn(api, 'del').mockImplementation(del || (async () => ({ ok: true })));
  getTextSpy = vi.spyOn(api, 'getText').mockImplementation(getText || (async () => 'minute_utc\r\n'));
}
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const cardOf = (name) => screen.getByText(name).closest('.card');
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
// The page has a Save of its own (retention) beside the dialog's: inside an open dialog, the dialog's.
const saveButton = () => within(screen.queryByRole('dialog') || document.body).getByRole('button', { name: 'Save' });

beforeEach(() => { mockApi(); vi.mocked(saveTextDownload).mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('the device list', () => {
  test.each([
    ['connected', 'Connected', 'status-badge--ok'],
    ['connecting', 'Connecting', 'status-badge--off'],
    ['disconnected', 'Disconnected', 'status-badge--bad'],
    ['failed', 'Failed', 'status-badge--bad'],
    ['disabled', 'Off', 'status-badge--off'],
  ])('a %s device shows %s', async (state, text, cls) => {
    mockApi({ devices: [device({ enabled: state !== 'disabled', status: status({ state }) })] });
    renderAsAdmin(<SettingsEsphome />);
    await screen.findByText('Device A');
    expect(within(cardOf('Device A')).getByText(text)).toHaveClass(cls);
  });

  test('shows the address, the child, the last reading and the sensor count', async () => {
    mockApi({ devices: [device({ child_id: 'c2' })] });
    renderAsAdmin(<SettingsEsphome />);
    const card = within(await screen.findByText('Device A').then((el) => el.closest('.card')));
    expect(card.getByText(/10\.0\.0\.5:6053 · Second child/)).toBeInTheDocument();
    expect(card.getByText(/Last reading: 2 min ago · 410 in the last hour · 7 sensors/)).toBeInTheDocument();
  });

  test('a child that is not in the list reads "A child", and none reads "No child"; an IPv6 address is bracketed', async () => {
    mockApi({ devices: [device({ id: 1, name: 'Device A', child_id: 'gone' }), device({ id: 2, name: 'Device B', host: 'fd00::5' })] });
    renderAsAdmin(<SettingsEsphome />);
    await screen.findByText('Device A');
    expect(within(cardOf('Device A')).getByText(/· A child/)).toBeInTheDocument();
    expect(within(cardOf('Device B')).getByText(/\[fd00::5\]:6053 · No child/)).toBeInTheDocument();
  });

  test('★ encryption wording: a plaintext warning only for a CONNECTED unencrypted device, never for one that merely is not connected', async () => {
    mockApi({
      devices: [
        device({ id: 1, name: 'Plain', key_set: false, status: status({ encrypted: false }) }),
        device({ id: 2, name: 'Locked', key_set: true, status: status({ encrypted: true }) }),
        device({ id: 3, name: 'Down', key_set: true, status: status({ state: 'failed', encrypted: false, error: 'The device refused the connection.' }) }),
      ],
    });
    renderAsAdmin(<SettingsEsphome />);
    await screen.findByText('Plain');
    expect(within(cardOf('Plain')).getByText(/Not encrypted: anyone on your network/)).toBeInTheDocument();
    expect(within(cardOf('Locked')).getByText('Encrypted')).toBeInTheDocument();
    expect(within(cardOf('Down')).queryByText(/Not encrypted/)).toBeNull();
    expect(within(cardOf('Down')).getByText('Encryption key set')).toBeInTheDocument();
    expect(within(cardOf('Down')).getByText('The device refused the connection.')).toBeInTheDocument();
  });

  test('★ a status error is shown as TEXT, never as markup', async () => {
    const hostile = '<img src="x" onerror="window.__pwned = 1">';
    mockApi({ devices: [device({ status: status({ state: 'failed', error: hostile }) })] });
    renderAsAdmin(<SettingsEsphome />);
    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(window.__pwned).toBeUndefined();
  });

  test('no devices says so and offers Add', async () => {
    mockApi({ devices: [] });
    renderAsAdmin(<SettingsEsphome />);
    expect(await screen.findByText(/No devices yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a device' })).toBeEnabled();
  });

  test('★ a failed first load says so and can be retried; it does not look like "no devices"', async () => {
    let fail = true;
    mockApi({ onDevices: async () => { if (fail) throw new Error('The server took too long to respond.'); return [device()]; } });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    expect(await screen.findByText(/The server took too long to respond/)).toBeInTheDocument();
    expect(screen.queryByText(/No devices yet/)).toBeNull();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Device A')).toBeInTheDocument();
  });

  test('★ eight devices disable Add and say why; seven do not', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => device({ id: i + 1, name: `Device ${i + 1}` }));
    mockApi({ devices: eight });
    renderAsAdmin(<SettingsEsphome />);
    await screen.findByText('Device 1');
    expect(screen.getByRole('button', { name: 'Add a device' })).toBeDisabled();
    expect(screen.getByText(/limit of 8 devices/)).toBeInTheDocument();
    vi.restoreAllMocks();
    mockApi({ devices: eight.slice(0, 7) });
    renderAsAdmin(<SettingsEsphome />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Add a device' }).at(-1)).toBeEnabled());
  });

  test('Sensors lists each entity with its latest value and age', async () => {
    mockApi({
      entities: [
        { id: 1, object_id: 'hr', name: 'Heart rate', category: 'heart_rate', unit: 'bpm', value: 72, age_s: 3 },
        { id: 2, object_id: 'presence', name: 'Presence', category: 'occupancy', unit: null, value: true, age_s: null },
        { id: 3, object_id: 'lux', name: 'Light', category: null, unit: 'lx', value: null, age_s: null },
      ],
    });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Sensors' }));
    expect(await screen.findByText(/72 bpm · 3 s ago/)).toBeInTheDocument();
    expect(screen.getByText(/on · no update yet/)).toBeInTheDocument();
    expect(screen.getByText(/no reading yet · no update yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide sensors' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('refreshing while the page is open', () => {
  test('★ a tick while a read is in flight makes no second read, and an older answer never replaces a newer one', async () => {
    vi.useFakeTimers();
    const slow = deferred();
    let calls = 0;
    const A = device({ id: 1, name: 'Device A' });
    const B = device({ id: 2, name: 'Device B' });
    mockApi({
      onDevices: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([A]);
        if (calls === 2) return slow.promise; // the 10 s tick, still waiting
        return Promise.resolve([A, B]);       // the read after the save
      },
    });
    renderAsAdmin(<SettingsEsphome />);
    await settle();
    expect(screen.getByText('Device A')).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(calls).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(calls, 'single-flight: the next tick waits for the read in flight').toBe(2);

    // Adding a device reads the list again straight away, while the tick's read is still waiting.
    fireEvent.click(screen.getByRole('button', { name: 'Add a device' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Device B' } });
    fireEvent.change(screen.getByLabelText('IP address'), { target: { value: '10.0.0.6' } });
    fireEvent.click(saveButton());
    await settle();
    expect(calls).toBe(3);
    expect(screen.getByText('Device B')).toBeInTheDocument();

    // The slow read finally answers with the OLD list: it must be dropped.
    await act(async () => { slow.resolve([A]); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Device B')).toBeInTheDocument();
  });

  test('★ a read that was in flight when a device was deleted does not bring it back', async () => {
    vi.useFakeTimers();
    const slow = deferred();
    let calls = 0;
    const A = device({ id: 1, name: 'Device A' });
    const B = device({ id: 2, name: 'Device B' });
    mockApi({
      onDevices: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve([A, B]);
        if (calls === 2) return slow.promise;
        return Promise.resolve([A]);
      },
    });
    renderAsAdmin(<SettingsEsphome />);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); }); // the slow tick read
    fireEvent.click(within(cardOf('Device B')).getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: /Delete device and readings/ }));
    await settle();
    expect(screen.queryByText('Device B')).toBeNull();

    await act(async () => { slow.resolve([A, B]); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText('Device B'), 'the stale answer must not resurrect it').toBeNull();
  });

  test('a failed refresh keeps the last good list and says it could not refresh', async () => {
    vi.useFakeTimers();
    let calls = 0;
    mockApi({ onDevices: async () => { calls += 1; if (calls > 1) throw new Error('offline'); return [device()]; } });
    renderAsAdmin(<SettingsEsphome />);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(screen.getByText('Device A')).toBeInTheDocument();
    expect(screen.getByText(/Could not refresh just now/)).toBeInTheDocument();
  });

  test('a hidden tab is not read, and showing it again reads once at once', async () => {
    vi.useFakeTimers();
    let visibility = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    try {
      let calls = 0;
      mockApi({ onDevices: async () => { calls += 1; return [device()]; } });
      renderAsAdmin(<SettingsEsphome />);
      await settle();
      expect(calls).toBe(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(calls, 'nothing while hidden').toBe(1);
      visibility = 'visible';
      await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
      expect(calls).toBe(2);
    } finally {
      delete document.visibilityState;
    }
  });

  test('nothing is read and nothing throws after the page is left, even if an answer arrives late', async () => {
    vi.useFakeTimers();
    const late = deferred();
    let calls = 0;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockApi({ onDevices: () => { calls += 1; return calls === 1 ? Promise.resolve([device()]) : late.promise; } });
    const view = renderAsAdmin(<SettingsEsphome />);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    view.unmount();
    await act(async () => { late.resolve([device()]); await vi.advanceTimersByTimeAsync(60000); });
    expect(calls, 'the interval stopped at unmount').toBe(2);
    expect(errors).not.toHaveBeenCalled();
  });
});

describe('adding a device', () => {
  test('a port that was entered is the port that is sent', async () => {
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    await user.type(screen.getByLabelText('Name'), 'Device Z');
    await user.type(screen.getByLabelText('IP address'), '10.0.0.9');
    await user.type(screen.getByLabelText('Port'), '6054');
    await user.click(saveButton());
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0][1]).toMatchObject({ host: '10.0.0.9', port: 6054 });
  });

  test('★ two clicks on Save in the same tick make ONE device, and Save is disabled while it is saving', async () => {
    // WHY: the button is disabled by `busy`, but that only takes effect on the next render. Two clicks inside one
    // tick (a fast double tap on a phone) would both pass and make two devices; the synchronous guard stops the second.
    const slow = deferred();
    mockApi({ post: () => slow.promise });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    await user.type(screen.getByLabelText('Name'), 'Device Z');
    await user.type(screen.getByLabelText('IP address'), '10.0.0.9');
    const save = saveButton();
    await act(async () => { fireEvent.click(save); fireEvent.click(save); });
    expect(postSpy).toHaveBeenCalledTimes(1);
    expect(save).toBeDisabled();
    await act(async () => { slow.resolve({}); });
  });

  test('★ the request carries exactly what was entered; the key only when typed, the port only when given', async () => {
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    await user.type(screen.getByLabelText('Name'), 'Device Z');
    await user.type(screen.getByLabelText('IP address'), ' 10.0.0.9 ');
    await user.type(screen.getByLabelText(/Encryption key/), SECRET);
    await user.selectOptions(screen.getByLabelText('Child'), 'c1');
    await user.click(saveButton());
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy).toHaveBeenCalledWith('/esphome/devices', { name: 'Device Z', enabled: true, child_id: 'c1', host: '10.0.0.9', key: SECRET });
  });

  test('with no key, no port and no child, the request has no key, no port and a null child', async () => {
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    await user.type(screen.getByLabelText('Name'), 'Device Z');
    await user.type(screen.getByLabelText('IP address'), '10.0.0.9');
    await user.click(saveButton());
    await waitFor(() => expect(postSpy).toHaveBeenCalled());
    expect(postSpy.mock.calls[0][1]).toEqual({ name: 'Device Z', enabled: true, child_id: null, host: '10.0.0.9' });
  });

  test('★ a refusal from the server is shown in the dialog, and the dialog stays open', async () => {
    mockApi({ post: async () => { throw new Error("Use the device's IP address; names ending in .local do not resolve inside the container."); } });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    await user.type(screen.getByLabelText('Name'), 'Device Z');
    await user.type(screen.getByLabelText('IP address'), 'bed.local');
    await user.click(saveButton());
    expect(await screen.findByText(/names ending in \.local/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  test.each([
    ['no name', { host: '10.0.0.9' }, /Give the device a name/],
    ['no address', { name: 'Device Z' }, /Enter the device’s IP address|Enter the device's IP address/],
    ['a port of 0', { name: 'Device Z', host: '10.0.0.9', port: '0' }, /port must be a whole number/],
    ['a port of 70000', { name: 'Device Z', host: '10.0.0.9', port: '70000' }, /port must be a whole number/],
    ['a port of 60.5', { name: 'Device Z', host: '10.0.0.9', port: '60.5' }, /port must be a whole number/],
  ])('%s is refused here, with no request', async (_label, values, message) => {
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    if (values.name) await user.type(screen.getByLabelText('Name'), values.name);
    if (values.host) await user.type(screen.getByLabelText('IP address'), values.host);
    if (values.port) fireEvent.change(screen.getByLabelText('Port'), { target: { value: values.port } });
    // Submitted directly: a browser's own min/max/step check on the port would stop a click first (and show its own
    // message); this is the page's check behind it.
    fireEvent.submit(screen.getByRole('dialog').querySelector('form'));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(postSpy).not.toHaveBeenCalled();
  });

  test('if the children cannot be loaded the form says so and offers "No child"', async () => {
    mockApi({ childrenFail: true });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    await waitFor(() => expect(screen.getByText(/Children could not be loaded/)).toBeInTheDocument());
    expect(within(screen.getByLabelText('Child')).getAllByRole('option')).toHaveLength(1);
  });
});

describe('editing a device', () => {
  const open = async () => {
    const view = renderAsAdmin(<SettingsEsphome />);
    await view.user.click(await screen.findByRole('button', { name: 'Edit' }));
    return view;
  };

  test('★ a blank key keeps the stored one: the request has no key and no clear_key, and the box says so', async () => {
    const { user } = await open();
    expect(screen.getByLabelText(/Encryption key/)).toHaveAttribute('placeholder', 'Leave blank to keep the stored key');
    expect(screen.getByLabelText(/Encryption key/)).toHaveValue('');
    await user.click(saveButton());
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy).toHaveBeenCalledWith('/esphome/devices/1', { name: 'Device A', enabled: true, child_id: null, host: '10.0.0.5', port: 6053 });
  });

  test('"Remove the stored key" sends clear_key', async () => {
    const { user } = await open();
    await user.click(screen.getByLabelText('Remove the stored key'));
    await user.click(saveButton());
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).toMatchObject({ clear_key: true });
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('key');
  });

  test('★ typing a new key disables "remove" (the server would let remove win) and sends the key only', async () => {
    const { user } = await open();
    await user.click(screen.getByLabelText('Remove the stored key'));
    await user.type(screen.getByLabelText(/Encryption key/), SECRET);
    expect(screen.getByLabelText('Remove the stored key')).toBeDisabled();
    await user.click(saveButton());
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).toMatchObject({ key: SECRET });
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('clear_key');
  });

  test('a device with no stored key has no "remove" box', async () => {
    mockApi({ devices: [device({ key_set: false })] });
    await open();
    expect(screen.queryByLabelText('Remove the stored key')).toBeNull();
  });

  test('an IPv6 address is edited in brackets, the form the server expects', async () => {
    mockApi({ devices: [device({ host: 'fd00::5' })] });
    await open();
    expect(screen.getByLabelText('IP address')).toHaveValue('[fd00::5]');
  });
});

describe('★ the encryption key is a secret', () => {
  test('it is never written to browser storage, never in a URL, never shown again, and not in the page after saving', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    // A response that carries the key (it must not) is still never rendered.
    mockApi({ devices: [device({ encryption_key: 'DECOY-KEY-FROM-THE-RESPONSE', key: 'DECOY-KEY-TOO' })] });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await screen.findByText('Device A');
    expect(document.body.innerHTML).not.toContain('DECOY');

    await user.click(screen.getByRole('button', { name: 'Add a device' }));
    await user.type(screen.getByLabelText('Name'), 'Device Z');
    await user.type(screen.getByLabelText('IP address'), '10.0.0.9');
    await user.type(screen.getByLabelText(/Encryption key/), SECRET);
    expect(screen.getByLabelText(/Encryption key/)).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await user.click(saveButton());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // After the save, and after the dialog is gone:
    expect(document.body.innerHTML).not.toContain(SECRET);
    const stored = JSON.stringify([...Object.entries(localStorage), ...Object.entries(sessionStorage)]);
    expect(stored).not.toContain(SECRET);
    for (const call of setItem.mock.calls) expect(String(call[1])).not.toContain(SECRET);
    // Only the two requests meant to carry it do, and in the body, never in a path.
    const carrying = [...postSpy.mock.calls, ...putSpy.mock.calls].filter(([, body]) => JSON.stringify(body ?? {}).includes(SECRET));
    expect(carrying.map(([path]) => path).sort()).toEqual(['/esphome/devices', '/esphome/test']);
    for (const call of [...getSpy.mock.calls, ...getTextSpy.mock.calls, ...delSpy.mock.calls]) expect(String(call[0])).not.toContain(SECRET);
    for (const call of [...postSpy.mock.calls, ...putSpy.mock.calls]) expect(String(call[0])).not.toContain(SECRET);

    // Reopened, the field is empty again.
    await user.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(screen.getByLabelText(/Encryption key/)).toHaveValue('');
  });

  test('cancelling the dialog also drops what was typed', async () => {
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    await user.type(screen.getByLabelText(/Encryption key/), SECRET);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.body.innerHTML).not.toContain(SECRET);
    await user.click(screen.getByRole('button', { name: 'Add a device' }));
    expect(screen.getByLabelText(/Encryption key/)).toHaveValue('');
  });
});

describe('testing a connection', () => {
  test('a saved device is tested by its number, and a good result is shown', async () => {
    mockApi({ post: async () => ({ ok: true, encrypted: true, entities: [{}, {}, {}] }) });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/Connected and encrypted · 3 sensors found/)).toBeInTheDocument();
    expect(postSpy).toHaveBeenCalledWith('/esphome/test', { device_id: 1 });
  });

  test('★ a connection that works but is not encrypted is a warning, not a plain success', async () => {
    mockApi({ post: async () => ({ ok: true, encrypted: false, entities: [] }) });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Test' }));
    const note = await screen.findByText(/the connection is not encrypted: anyone on your network can read it/);
    expect(note).toHaveClass('esphome-warn');
  });

  test.each([
    ['a failure', 'The encryption key was rejected by the device.'],
    ['a test already running', 'A connection test is already running.'],
  ])('%s shows the server sentence', async (_label, sentence) => {
    mockApi({ post: async () => { throw new Error(sentence); } });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  test('★ editing a device clears its earlier test result, which described the old address and key', async () => {
    let host = '10.0.0.5';
    mockApi({
      onDevices: async () => [device({ host })],
      post: async () => ({ ok: true, encrypted: true, entities: [] }),
      put: async () => { host = '10.0.0.6'; return {}; },
    });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText(/Connected and encrypted/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByText(/10\.0\.0\.6:6053/)).toBeInTheDocument());
    expect(screen.queryByText(/Connected and encrypted/)).toBeNull();
  });

  test('inside the Add form the values typed so far are tested (no port, no key when blank)', async () => {
    mockApi({ post: async () => ({ ok: true, encrypted: false, entities: [] }) });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Add a device' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Enter the device.s IP address/)).toBeInTheDocument();
    expect(postSpy).not.toHaveBeenCalled();
    await user.type(screen.getByLabelText('IP address'), '10.0.0.9');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/esphome/test', { host: '10.0.0.9' }));
  });
});

describe('deleting a device', () => {
  test('★ asks first, says the readings go too, and focuses Cancel', async () => {
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(screen.getByText(/deletes all the readings stored for it/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus());
    expect(delSpy).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(delSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Device A')).toBeInTheDocument();
  });

  test('confirming deletes that device and takes it off the page', async () => {
    // The list the server returns AFTER the delete (the page reads it again at once).
    let deleted = false;
    mockApi({ onDevices: async () => (deleted ? [] : [device({ id: 4, name: 'Device A' })]), del: async () => { deleted = true; return { ok: true }; } });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: /Delete device and readings/ }));
    await waitFor(() => expect(delSpy).toHaveBeenCalledWith('/esphome/devices/4'));
    await waitFor(() => expect(screen.queryByText('Device A')).toBeNull());
  });

  test('a refusal is shown in the dialog and the device stays', async () => {
    mockApi({ del: async () => { throw new Error('Device not found.'); } });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: /Delete device and readings/ }));
    expect(await screen.findByText('Device not found.')).toBeInTheDocument();
  });
});

describe('keeping readings (retention)', () => {
  test('shows the stored value with its range and default', async () => {
    mockApi({ settings: { retention_days: 45 } });
    renderAsAdmin(<SettingsEsphome />);
    expect(await screen.findByLabelText(/Days to keep \(1–365, default 30\)/)).toHaveValue(45);
  });

  test.each([['0'], ['366'], ['1.5'], ['']])('★ %j is refused here, with no request', async (value) => {
    renderAsAdmin(<SettingsEsphome />);
    const input = await screen.findByLabelText(/Days to keep/);
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value } });
    // Submitted directly: a browser's own min/max/step check would stop a click first, and this is the page's check.
    fireEvent.submit(input.closest('form'));
    expect(await screen.findByText(/whole number of days from 1 to 365/)).toBeInTheDocument();
    expect(putSpy).not.toHaveBeenCalled();
  });

  test('a valid value is sent as a whole number', async () => {
    const { user } = renderAsAdmin(<SettingsEsphome />);
    const input = await screen.findByLabelText(/Days to keep/);
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.change(input, { target: { value: '365' } });
    await user.click(saveButton());
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/esphome/settings', { retention_days: 365 }));
    expect(typeof putSpy.mock.calls[0][1].retention_days).toBe('number');
  });

  test("the server's refusal is shown", async () => {
    mockApi({ put: async () => { throw new Error('Retention must be a whole number from 1 to 365 days.'); } });
    const { user } = renderAsAdmin(<SettingsEsphome />);
    const input = await screen.findByLabelText(/Days to keep/);
    await waitFor(() => expect(input).toBeEnabled());
    await user.click(saveButton());
    expect(await screen.findByText('Retention must be a whole number from 1 to 365 days.')).toBeInTheDocument();
  });
});

describe('downloading a CSV', () => {
  const openExport = async (devices) => {
    if (devices) mockApi({ devices });
    const view = renderAsAdmin(<SettingsEsphome />);
    await view.user.click(await screen.findByRole('button', { name: 'Download CSV' }));
    return view;
  };
  const setDates = (from, to) => {
    fireEvent.change(screen.getByLabelText(/From/), { target: { value: from } });
    fireEvent.change(screen.getByLabelText(/To \(UTC/), { target: { value: to } });
  };

  test('defaults to the last 7 UTC days', async () => {
    await openExport();
    expect(screen.getByLabelText(/To \(UTC/)).toHaveValue(dayString(Date.now()));
    expect(screen.getByLabelText(/From/)).toHaveValue(dayString(Date.now() - 6 * 86400000));
  });

  test('★ the request ends on the day AFTER the last day chosen, goes through api.getText, and the file is saved with a clear name', async () => {
    mockApi({ getText: async () => 'minute_utc,device\r\n' });
    const { user } = await openExport();
    setDates('2026-10-01', '2026-10-07');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(getTextSpy).toHaveBeenCalledWith('/esphome/export?device=1&from=2026-10-01&to=2026-10-08'));
    expect(saveTextDownload).toHaveBeenCalledWith('esphome-1-2026-10-01-to-2026-10-07.csv', 'minute_utc,device\r\n', 'text/csv');
    expect(await screen.findByText('Downloaded ✓')).toBeInTheDocument();
  });

  test('★ 32 days and an end before the start are refused with no request, and Download is off', async () => {
    const { user } = await openExport();
    setDates('2026-10-01', '2026-11-01');
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByText(/no more than 31 days/)).toBeInTheDocument();
    setDates('2026-10-07', '2026-10-01');
    expect(screen.getByText(/end date is before the start date/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(getTextSpy).not.toHaveBeenCalled();
  });

  test('★ 31 days is allowed for a typical 7-sensor device', async () => {
    await openExport();
    setDates('2026-10-01', '2026-10-31');
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
    expect(screen.getByText(/31 days, roughly/)).toBeInTheDocument();
  });

  test('★ a 200-sensor device is held to what fits: no request, and the message names the longest range', async () => {
    const { user } = await openExport([device({ status: status({ entity_count: 200 }) })]);
    setDates('2026-10-01', '2026-10-07');
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByText(/200 entities.*Try up to 1 day/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(getTextSpy).not.toHaveBeenCalled();
    setDates('2026-10-07', '2026-10-07');
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });

  test('★ a second tap while the file is being prepared makes no second request', async () => {
    const slow = deferred();
    mockApi({ getText: () => slow.promise });
    const { user } = await openExport();
    setDates('2026-10-01', '2026-10-02');
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await user.click(screen.getByRole('button', { name: /Preparing/ }));
    fireEvent.click(screen.getByRole('button', { name: /Preparing/ }));
    expect(getTextSpy).toHaveBeenCalledTimes(1);
    await act(async () => { slow.resolve('x'); });
  });

  test('a refusal from the server, or a save that fails, is shown and the button is usable again', async () => {
    mockApi({ getText: async () => { throw new Error('Device not found.'); } });
    const { user } = await openExport();
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText('Device not found.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();

    mockApi();
    vi.mocked(saveTextDownload).mockRejectedValueOnce(new Error('This version of the app can’t export files. Update to the latest app version and try again.'));
    await user.click(screen.getByRole('button', { name: 'Download' }));
    expect(await screen.findByText(/Update to the latest app version/)).toBeInTheDocument();
  });
});
