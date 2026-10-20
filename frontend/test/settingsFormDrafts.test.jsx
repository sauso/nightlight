// Unsaved edits on the rest of the settings forms survive a reload (#377, second step).
//
// The first step (formDrafts.test.jsx) covered the child form, the camera form and Recording. This file covers
// Settings -> General and MQTT, the Gotify / ntfy / Pushover pages and the add/edit caregiver screen. As there,
// a "reload" is UNMOUNT then mount again with the real sessionStorage in between; nothing in the storage path is
// mocked.
//
// ★ THE RULE THIS FILE EXISTS FOR: no secret ever reaches browser storage. Every secret input below gets a planted
// marker, and EVERY value in sessionStorage and localStorage is scanned for it. Beyond the password-like inputs
// the markers are also planted where a name-based check cannot see them: the ntfy topic (the page calls it the
// only thing keeping a public feed private), the MQTT certificate text (free text where a key could be pasted)
// and a server address with a username and password written into it.
//
// WHAT THIS DOES NOT PROVE: that a real phone reloads the app and returns to the same form (the e2e run and the
// release checklist cover the app's reload itself); only what each form does when it is mounted again.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Routes, Route, Link } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsGeneral from '../src/pages/SettingsGeneral.jsx';
import SettingsMqtt from '../src/pages/SettingsMqtt.jsx';
import SettingsPushGotify from '../src/pages/SettingsPushGotify.jsx';
import SettingsPushNtfy from '../src/pages/SettingsPushNtfy.jsx';
import SettingsPushPushover from '../src/pages/SettingsPushPushover.jsx';
import UserSettings from '../src/pages/UserSettings.jsx';
import { api } from '../src/lib/api.js';

const everythingStored = () => [localStorage, sessionStorage]
  .flatMap((s) => Object.keys(s).map((k) => `${k}=${s.getItem(k)}`)).join('\n');
const MARK = 'PLANTED-SECRET-377';

const SETTINGS = {
  app_name: 'Nightlight', accent_color: '#f4c56a', live_color: '#7FBFA3', offline_color: '#E08585',
  timezone: 'Australia/Melbourne', font_choice: 'warm-serif', temp_unit: 'C',
};

let putSpy;
beforeEach(() => {
  vi.spyOn(api, 'get').mockResolvedValue({});
  putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
  vi.spyOn(api, 'post').mockResolvedValue({});
  vi.spyOn(api, 'del').mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------- General
describe('Settings -> General', () => {
  const mount = (extra = {}) => renderAsAdmin(<SettingsGeneral />, { settings: SETTINGS, ...extra });

  test('★ an app name typed and not saved comes back after a reload, with a notice; the rest follows the server', async () => {
    const first = mount();
    const name = await screen.findByLabelText('App name');
    await first.user.clear(name);
    await first.user.type(name, 'Unsaved name');
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
    first.unmount();

    mount();
    expect((await screen.findByLabelText('App name')).value).toBe('Unsaved name');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
    expect(screen.getByLabelText('Timezone').value).toBe('Australia/Melbourne');
  });

  test('an untouched form stores nothing and shows no notice', async () => {
    mount();
    await screen.findByLabelText('App name');
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('typing the original value back removes the draft and the notice', async () => {
    const { user } = mount();
    const name = await screen.findByLabelText('App name');
    await user.type(name, 'x');
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    await user.type(name, '{Backspace}');
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('a successful Save sends the screen\'s fields, clears the draft and keeps what was typed on screen', async () => {
    putSpy.mockResolvedValue({ ...SETTINGS, app_name: 'Renamed' });
    const { user } = mount();
    const name = await screen.findByLabelText('App name');
    await user.clear(name);
    await user.type(name, 'Renamed');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).toEqual({ ...SETTINGS, app_name: 'Renamed' });
    await waitFor(() => expect(screen.queryByText(/Unsaved changes/)).toBeNull());
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(screen.getByLabelText('App name').value).toBe('Renamed');
  });

  test('a refused Save keeps the draft', async () => {
    putSpy.mockRejectedValue(new Error('nope'));
    const { user } = mount();
    const name = await screen.findByLabelText('App name');
    await user.type(name, '!');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('nope')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toHaveLength(1);
  });

  test('★ Discard changes goes back to the stored values and removes the draft', async () => {
    const { user } = mount();
    const name = await screen.findByLabelText('App name');
    await user.type(name, 'zzz');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('App name').value).toBe('Nightlight');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('★ a refresh of the settings in the background does not overwrite what is being typed (the old sync effect did)', async () => {
    const { user, rerenderWith } = mount();
    const name = await screen.findByLabelText('App name');
    await user.clear(name);
    await user.type(name, 'Typing');
    rerenderWith({ settings: { ...SETTINGS, accent_color: '#123456' } });
    expect(screen.getByLabelText('App name').value).toBe('Typing');
    // A field nobody touched still follows the server.
    expect(screen.getByLabelText(/Accent/).value).toBe('#123456');
  });

  test('★ a draft that equals the placeholder survives the wait for the server\'s settings', async () => {
    // First visit: the server's name is 'Server Name' and the person types 'Nightlight', which is also the
    // provider's PLACEHOLDER name. On the next visit the screen first sees the placeholder: without a ready
    // check that draft reads "no change" and is erased before the server's value arrives.
    const first = mount({ settings: { ...SETTINGS, app_name: 'Server Name' } });
    const name = await screen.findByLabelText('App name');
    await first.user.clear(name);
    await first.user.type(name, 'Nightlight');
    first.unmount();
    expect(Object.keys(sessionStorage)).toHaveLength(1);

    const second = mount({ settings: SETTINGS, settingsLoaded: false });
    await screen.findByLabelText('App name');
    expect(Object.keys(sessionStorage), 'erased while the server settings were still loading').toHaveLength(1);
    second.rerenderWith({ settings: { ...SETTINGS, app_name: 'Server Name' }, settingsLoaded: true });
    expect(screen.getByLabelText('App name').value).toBe('Nightlight');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------------------------- MQTT
describe('Settings -> MQTT', () => {
  const CONFIG = {
    mqtt_enabled: true, mqtt_host: 'broker.local', mqtt_port: 1883, mqtt_username: 'nightlight', mqtt_password_set: true,
    mqtt_tls: true, mqtt_tls_ca: '', mqtt_tls_verify: true,
  };
  beforeEach(() => {
    api.get.mockImplementation(async (path) => (String(path).includes('/mqtt/status') ? { enabled: true } : CONFIG));
  });
  const mount = () => renderAsAdmin(<SettingsMqtt />);

  test('★ a host typed and not saved comes back after a reload, with a notice', async () => {
    const first = mount();
    const host = await screen.findByDisplayValue('broker.local');
    await first.user.clear(host);
    await first.user.type(host, 'other.local');
    first.unmount();

    mount();
    expect(await screen.findByDisplayValue('other.local')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
    // Untouched fields come from the server.
    expect(screen.getByLabelText('Broker port').value).toBe('1883');
  });

  test('★ a typed password and certificate text are never stored; a host edit beside them still is', async () => {
    const first = mount();
    const host = await screen.findByDisplayValue('broker.local');
    await first.user.type(host, '2');
    await first.user.type(screen.getByLabelText(/Password/), MARK);
    await first.user.type(screen.getByLabelText(/CA certificate/), `ca-${MARK}`);
    expect(everythingStored()).not.toContain(MARK);
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    first.unmount();

    mount();
    expect(await screen.findByDisplayValue('broker.local2')).toBeInTheDocument();
    expect(screen.getByLabelText(/Password/).value).toBe('');
    expect(screen.getByLabelText(/CA certificate/).value).toBe('');
  });

  test('★ a secret-only edit shows the notice now, and after a reload there is nothing stored and no notice', async () => {
    const first = mount();
    await screen.findByDisplayValue('broker.local');
    await first.user.type(screen.getByLabelText(/Password/), MARK);
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
    expect(everythingStored()).not.toContain(MARK);
    first.unmount();

    mount();
    await screen.findByDisplayValue('broker.local');
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
  });

  test('a certificate edit alone keeps the notice on (it is not stored, but it is not saved either)', async () => {
    const { user } = mount();
    await screen.findByDisplayValue('broker.local');
    await user.type(screen.getByLabelText(/CA certificate/), 'pasted text');
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('a certificate edited while TLS is off is NOT counted as saved by a Save (it is not sent)', async () => {
    const { user } = mount();
    await screen.findByDisplayValue('broker.local');
    await user.type(screen.getByLabelText(/CA certificate/), 'pasted text');
    await user.click(screen.getByRole('switch', { name: /Use TLS/ }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('mqtt_tls_ca');
    // The certificate was never sent, so the screen still differs from what is stored.
    await waitFor(() => expect(screen.queryByText('Saved ✓')).toBeInTheDocument());
    expect(screen.getByText('Unsaved changes.')).toBeInTheDocument();
  });

  test('a successful Save clears the draft and the notice', async () => {
    const first = mount();
    const host = await screen.findByDisplayValue('broker.local');
    await first.user.clear(host);
    await first.user.type(host, 'new.local');
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    await first.user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    await waitFor(() => expect(Object.keys(sessionStorage)).toEqual([]));
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
  });

  test('a failed load neither writes nor erases a stored draft', async () => {
    const first = mount();
    const host = await screen.findByDisplayValue('broker.local');
    await first.user.type(host, '3');
    first.unmount();
    const stored = everythingStored();
    api.get.mockRejectedValue(new Error('offline'));

    mount();
    await screen.findByRole('button', { name: 'Save changes' });
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(everythingStored()).toBe(stored);
  });
});

// --------------------------------------------------------------------------------------- push providers
describe('Settings -> push providers', () => {
  const GOTIFY = { enabled: true, configured: true, server_url: 'https://gotify.example', app_token_set: true, app_token_masked: '••', priority: 5 };
  const NTFY = { enabled: true, configured: true, server_url: 'https://ntfy.sh', topic: 'saved-topic', token_set: false, token_masked: '', username: '', password_set: false };
  const PUSHOVER = { enabled: true, configured: true, app_token_set: true, app_token_masked: '••', user_key_set: true, user_key_masked: '••', device: '' };

  test('★ Gotify: a priority typed and not saved comes back after a reload; Send test stays held back', async () => {
    api.get.mockResolvedValue(GOTIFY);
    const first = renderAsAdmin(<SettingsPushGotify />);
    const priority = await screen.findByLabelText(/Priority/);
    await first.user.clear(priority);
    await first.user.type(priority, '8');
    first.unmount();

    renderAsAdmin(<SettingsPushGotify />);
    expect((await screen.findByLabelText(/Priority/)).value).toBe('8');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Send test/ })).toBeDisabled();
  });

  test('★ Gotify: a server address with a login written into it is never stored', async () => {
    api.get.mockResolvedValue(GOTIFY);
    const first = renderAsAdmin(<SettingsPushGotify />);
    const url = await screen.findByLabelText('Server URL');
    await first.user.clear(url);
    await first.user.type(url, `https://user:${MARK}@gotify.other`);
    await first.user.type(screen.getByLabelText(/Application token/), MARK);
    expect(everythingStored()).not.toContain(MARK);
    first.unmount();

    renderAsAdmin(<SettingsPushGotify />);
    // Nothing was stored, so the stored address is back and there is no notice.
    expect((await screen.findByLabelText('Server URL')).value).toBe('https://gotify.example');
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
  });

  test('★ Gotify: a failed load neither writes nor erases a stored draft, and the page stays usable', async () => {
    api.get.mockResolvedValue(GOTIFY);
    const first = renderAsAdmin(<SettingsPushGotify />);
    const priority = await screen.findByLabelText(/Priority/);
    await first.user.clear(priority);
    await first.user.type(priority, '9');
    first.unmount();
    const stored = everythingStored();
    expect(stored).toContain('"priority"');

    api.get.mockRejectedValue(new Error('offline'));
    const failed = renderAsAdmin(<SettingsPushGotify />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
    expect(everythingStored()).toBe(stored);
    failed.unmount();

    // The next visit that CAN reach the server gets the draft back: the failed one did not erase it.
    api.get.mockResolvedValue(GOTIFY);
    renderAsAdmin(<SettingsPushGotify />);
    await waitFor(() => expect(screen.getByLabelText(/Priority/).value).toBe('9'));
  });

  test('Gotify: Save clears the draft', async () => {
    api.get.mockResolvedValue(GOTIFY);
    putSpy.mockResolvedValue({ ...GOTIFY, priority: 8 });
    const { user } = renderAsAdmin(<SettingsPushGotify />);
    const priority = await screen.findByLabelText(/Priority/);
    await user.clear(priority);
    await user.type(priority, '8');
    expect(Object.keys(sessionStorage)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(Object.keys(sessionStorage)).toEqual([]));
    expect(screen.queryByText(/Unsaved changes/)).toBeNull();
  });

  test('Gotify: Discard changes returns to the saved settings and removes the draft', async () => {
    api.get.mockResolvedValue(GOTIFY);
    const { user } = renderAsAdmin(<SettingsPushGotify />);
    const priority = await screen.findByLabelText(/Priority/);
    await user.clear(priority);
    await user.type(priority, '2');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText(/Priority/).value).toBe('5');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('★ ntfy: the topic, token and password are never stored; the username beside them is', async () => {
    api.get.mockResolvedValue(NTFY);
    const first = renderAsAdmin(<SettingsPushNtfy />);
    await screen.findByDisplayValue('saved-topic');
    await first.user.type(screen.getByLabelText('Username (optional)'), 'someone');
    await first.user.clear(screen.getByLabelText('Topic'));
    await first.user.type(screen.getByLabelText('Topic'), `topic-${MARK}`);
    await first.user.type(screen.getByLabelText(/Access token/), MARK);
    await first.user.type(screen.getByLabelText(/Password/), MARK);
    expect(everythingStored()).not.toContain(MARK);
    first.unmount();

    renderAsAdmin(<SettingsPushNtfy />);
    expect((await screen.findByLabelText('Username (optional)')).value).toBe('someone');
    expect(screen.getByLabelText('Topic').value).toBe('saved-topic');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
  });

  test('ntfy: the fields cannot be typed into before the config has loaded (a load replaces the form)', async () => {
    let release;
    api.get.mockImplementation(() => new Promise((resolve) => { release = () => resolve(NTFY); }));
    renderAsAdmin(<SettingsPushNtfy />);
    expect(screen.getByLabelText('Server URL')).toBeDisabled();
    expect(screen.getByLabelText('Topic')).toBeDisabled();
    expect(screen.getByLabelText('Username (optional)')).toBeDisabled();
    release();
    await waitFor(() => expect(screen.getByLabelText('Topic')).toBeEnabled());
  });

  test('★ Pushover: a device typed and not saved comes back after a reload; the tokens are never stored', async () => {
    api.get.mockResolvedValue(PUSHOVER);
    const first = renderAsAdmin(<SettingsPushPushover />);
    await first.user.type(await screen.findByLabelText(/Device/), 'pixel');
    await first.user.type(screen.getByLabelText('Application API token'), MARK);
    await first.user.type(screen.getByLabelText('User or group key'), MARK);
    expect(everythingStored()).not.toContain(MARK);
    first.unmount();

    renderAsAdmin(<SettingsPushPushover />);
    expect((await screen.findByLabelText(/Device/)).value).toBe('pixel');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------- caregivers
describe('add / edit caregiver', () => {
  const USERS = [
    { id: 'u-a', username: 'alice', role: 'caregiver', first_name: 'Alice', last_name: '', mfa_enabled: 0 },
    { id: 'u-b', username: 'bob', role: 'caregiver', first_name: 'Bob', last_name: '', mfa_enabled: 0 },
    { id: 'u-admin', username: 'nacho', role: 'admin', first_name: 'Nacho', last_name: '', mfa_enabled: 0 },
  ];
  beforeEach(() => { api.get.mockResolvedValue(USERS); });
  const mount = (route, extra = null) => renderAsAdmin(
    <Routes>
      <Route path="/settings/users/new" element={<UserSettings />} />
      <Route path="/settings/users/:id" element={<>{extra}<UserSettings /></>} />
      <Route path="*" element={<div>elsewhere</div>} />
    </Routes>,
    { route },
  );

  test('★ a new caregiver\'s details survive a reload, the password does not, and Add clears the draft', async () => {
    const first = mount('/settings/users/new');
    await first.user.type(await screen.findByLabelText('First name'), 'Carol');
    await first.user.type(screen.getByLabelText('Username (login)'), 'carol');
    await first.user.type(screen.getByLabelText('Password'), `${MARK}-1`);
    expect(everythingStored()).not.toContain(MARK);
    first.unmount();

    const second = mount('/settings/users/new');
    expect((await screen.findByLabelText('First name')).value).toBe('Carol');
    expect(screen.getByLabelText('Username (login)').value).toBe('carol');
    expect(screen.getByLabelText('Password').value).toBe('');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();

    await second.user.type(screen.getByLabelText('Password'), 'long-enough-1');
    await second.user.click(screen.getByRole('button', { name: 'Add caregiver' }));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('editing an existing caregiver: a draft is restored over the saved values, and Save clears it', async () => {
    const first = mount('/settings/users/u-a');
    const last = await screen.findByLabelText('Last name');
    await first.user.type(last, 'Smith');
    first.unmount();

    const second = mount('/settings/users/u-a');
    await waitFor(() => expect(screen.getByLabelText('Last name').value).toBe('Smith'));
    expect(screen.getByLabelText('First name').value).toBe('Alice');
    expect(screen.getByText('Unsaved changes restored.')).toBeInTheDocument();

    await second.user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('★ moving from one caregiver to another never writes the first one\'s fields under the second one\'s key', async () => {
    const link = <Link to="/settings/users/u-b">go to bob</Link>;
    const { user } = mount('/settings/users/u-a', link);
    const last = await screen.findByLabelText('Last name');
    await user.type(last, 'Edited');
    expect(Object.keys(sessionStorage).join()).toMatch(/user:u-a/);

    await user.click(screen.getByText('go to bob'));
    await waitFor(() => expect(screen.getByLabelText('Username (login)').value).toBe('bob'));
    // Bob's own page shows Bob's values, not Alice's draft, and nothing was written under Bob's key.
    expect(screen.getByLabelText('Last name').value).toBe('');
    expect(Object.keys(sessionStorage).join()).not.toMatch(/user:u-b/);
    expect(everythingStored()).not.toContain('alice');
  });

  test('Discard changes returns to the saved values and removes the draft', async () => {
    const { user } = mount('/settings/users/u-a');
    await user.type(await screen.findByLabelText('Last name'), 'Smith');
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.getByLabelText('Last name').value).toBe('');
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  test('removing a caregiver clears its draft', async () => {
    const { user } = mount('/settings/users/u-a');
    await user.type(await screen.findByLabelText('Last name'), 'Smith');
    await user.click(screen.getByRole('button', { name: 'Remove caregiver' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(Object.keys(sessionStorage)).toEqual([]);
  });
});
