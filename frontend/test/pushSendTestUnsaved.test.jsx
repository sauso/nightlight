// "Send test" on the three push provider pages (Pushover, Gotify, ntfy) (#396). The helper behind it is
// unit-tested in unsavedEdits.test.js; this file only goes through the pages.
//
// ★ THE DEFECT. Send test POSTs with NO body: the server tests whatever is SAVED. The button was enabled
// whenever the provider was `configured`, including while the person had typed a new value that had not
// been saved. They pressed it, read "Test sent" or a failure, and believed it described the settings on
// screen. It described the old ones.
//
// WHAT THIS PROVES: the button is held back while the screen differs from the last loaded/saved config, a
// hint says why, typing a value back (or clearing a typed secret) releases it, a FAILED save does not, and a
// successful one does. It does not prove the server-side test route (backend tests) or a real provider
// delivering a message (not run: negative space in the PR).
//
// ★ THE FIXTURES ARE HOSTILE ON PURPOSE. Gotify's `priority` arrives from the server as a NUMBER and, once
// typed into a number input, is a STRING: comparing with === leaves 5 -> 6 -> 5 "dirty" forever (plan review
// found this; the test below fails on ===). A loaded priority of 0 must not be read as "unset" (`||` would).
import { describe, test, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsPushPushover from '../src/pages/SettingsPushPushover.jsx';
import SettingsPushGotify from '../src/pages/SettingsPushGotify.jsx';
import SettingsPushNtfy from '../src/pages/SettingsPushNtfy.jsx';
import { api } from '../src/lib/api.js';

afterEach(() => vi.restoreAllMocks());

// ⚠️ This file deliberately does NOT import src/lib/unsavedEdits.js, and matches the hint by a literal
// regexp. The pages are what is under test; importing the new helper would make the whole file fail at
// import on the old source (where it does not exist) and the old, always-enabled button would never be
// exercised, so a red-on-old run would fail for the wrong reason. The helper has its own file
// (unsavedEdits.test.js).
const sendTest = () => screen.getByRole('button', { name: /Send test/i });
const hint = () => screen.queryByText(/Save your changes first/);

// One row per page: how to render it, what its saved config is, a text field to edit, and its secrets.
const PAGES = [
  {
    name: 'Pushover',
    Page: SettingsPushPushover,
    configUrl: '/pushover/config',
    config: {
      enabled: true, configured: true, app_token_set: true, app_token_masked: 'a1b…c3d',
      user_key_set: true, user_key_masked: 'u1v…w3x', device: 'living-room-phone',
    },
    stored: 'living-room-phone', // a value that is only on screen once the config has landed
    field: () => screen.getByLabelText(/^Device/), // by label: its value changes as the test types
    secrets: ['Application API token', 'User or group key'],
  },
  {
    name: 'Gotify',
    Page: SettingsPushGotify,
    configUrl: '/gotify/config',
    config: {
      enabled: true, configured: true, server_url: 'https://gotify.example.com',
      app_token_set: true, app_token_masked: 'A…z', priority: 5,
    },
    stored: 'https://gotify.example.com',
    field: () => screen.getByLabelText('Server URL'),
    secrets: ['Application token'],
  },
  {
    name: 'ntfy',
    Page: SettingsPushNtfy,
    configUrl: '/ntfy/config',
    config: {
      enabled: true, configured: true, server_url: 'https://ntfy.sh', topic: 'nursery-abc',
      token_set: true, token_masked: 'tk_…9f2c', username: 'me', password_set: true,
    },
    stored: 'nursery-abc',
    field: () => screen.getByLabelText('Topic'),
    secrets: ['Access token (optional)', 'Password (optional)'],
  },
];

async function mount(p, { putImpl } = {}) {
  vi.spyOn(api, 'get').mockResolvedValue(p.config);
  const put = vi.spyOn(api, 'put');
  if (putImpl) put.mockImplementation(putImpl); else put.mockResolvedValue(p.config);
  const post = vi.spyOn(api, 'post').mockResolvedValue({});
  const utils = renderAsAdmin(<p.Page />);
  await screen.findByDisplayValue(p.stored); // the config has landed (typing earlier is overwritten by it)
  await waitFor(() => expect(sendTest()).toBeEnabled());
  return { ...utils, put, post };
}

describe.each(PAGES)('$name: Send test follows the SAVED settings (#396)', (p) => {
  test('clean and configured: enabled, labelled as testing the saved settings, no hint', async () => {
    await mount(p);
    expect(sendTest()).toBeEnabled();
    expect(sendTest()).toHaveAccessibleName('Send test with saved settings');
    expect(hint()).toBeNull();
  });

  test('★ editing a field holds Send test back, says why, and sends nothing', async () => {
    const { user, post } = await mount(p);
    await user.type(p.field(), 'x');
    expect(sendTest()).toBeDisabled();
    expect(hint()).not.toBeNull();
    await user.click(sendTest()); // a click on a disabled button is a no-op; asserted, not assumed
    expect(post).not.toHaveBeenCalled();
  });

  test('★ putting the original value back releases it again (derived, not a flag set on change)', async () => {
    const { user } = await mount(p);
    const el = p.field();
    const original = el.value;
    await user.type(el, 'x');
    expect(sendTest()).toBeDisabled();
    await user.clear(el);
    await user.type(el, original);
    expect(sendTest()).toBeEnabled();
    expect(hint()).toBeNull();
  });

  test.each(p.secrets)('★ a typed secret (%s) holds it back, and clearing it releases it', async (label) => {
    const { user } = await mount(p);
    await user.type(screen.getByLabelText(label), 'new-secret');
    expect(sendTest()).toBeDisabled();
    expect(hint()).not.toBeNull();
    await user.clear(screen.getByLabelText(label));
    expect(sendTest()).toBeEnabled();
  });

  test('★ the Enable switch is an edit too: toggling it holds Send test back, toggling it back releases it', async () => {
    // `enabled` is saved with the rest of the form, so a switch flipped and not yet saved is an unsaved
    // change like any text field. (A helper that skipped booleans, or this one key, would leave the button
    // live while the screen says something the saved config does not.)
    const { user, post } = await mount(p);
    expect(p.config.enabled).toBe(true); // the fixture is saved ON, so one click is a real change
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(sendTest()).toBeDisabled();
    expect(hint()).not.toBeNull();
    await user.click(sendTest());
    expect(post).not.toHaveBeenCalled();

    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch')).toBeChecked();
    expect(sendTest()).toBeEnabled();
    expect(hint()).toBeNull();
  });

  test('★ a FAILED save leaves it held back: the screen still differs from what is saved', async () => {
    const { user } = await mount(p, { putImpl: () => Promise.reject(new Error('Save refused #396')) });
    await user.type(p.field(), 'x');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Save refused #396')).toBeTruthy();
    expect(sendTest()).toBeDisabled();
    expect(hint()).not.toBeNull();
  });

  test('★ a successful save re-enables it, and the test then goes out', async () => {
    // The server's response is what is now saved; here it echoes the edited field.
    const { user, post } = await mount(p, {
      putImpl: async () => {
        const typed = p.field().value;
        const key = p.name === 'Pushover' ? 'device' : p.name === 'Gotify' ? 'server_url' : 'topic';
        return { ...p.config, [key]: typed };
      },
    });
    await user.type(p.field(), 'x');
    expect(sendTest()).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sendTest()).toBeEnabled());
    expect(hint()).toBeNull();
    await user.click(sendTest());
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  });

  test('a provider that is not configured stays disabled, with or without edits (unchanged behaviour)', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ ...p.config, configured: false });
    renderAsAdmin(<p.Page />);
    await screen.findByDisplayValue(p.stored);
    expect(sendTest()).toBeDisabled();
    expect(hint(), 'no "save your changes" hint when there are no changes').toBeNull();
  });
});

describe('Gotify priority: a number from the server, a string once typed (#396)', () => {
  const gotify = PAGES.find((p) => p.name === 'Gotify');
  const priority = () => screen.getByLabelText('Priority (0–10)');
  const retype = async (user, value) => { await user.clear(priority()); await user.type(priority(), String(value)); };

  test('★ 5 -> 6 -> 5 is clean again (=== would call 5 !== "5" dirty for good)', async () => {
    const { user } = await mount(gotify);
    await retype(user, 6);
    expect(sendTest()).toBeDisabled();
    await retype(user, 5);
    expect(priority()).toHaveValue(5);
    expect(sendTest()).toBeEnabled();
    expect(hint()).toBeNull();
  });

  test('★ a stored priority of 0 is a value, not "unset": typing 3 is an edit and 0 again is not', async () => {
    const { user } = await mount({ ...gotify, config: { ...gotify.config, priority: 0 } });
    expect(priority()).toHaveValue(0);
    await retype(user, 3);
    expect(sendTest()).toBeDisabled();
    // Typed "0" is the STRING '0' against a saved NUMBER 0. Treating a saved 0 as empty ('') would call
    // that dirty.
    await retype(user, 0);
    expect(sendTest()).toBeEnabled();
  });
});

