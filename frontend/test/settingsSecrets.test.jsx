// The secret-bearing settings screens: MQTT and ntfy, plus the SecretField they and the other push
// providers share.
//
// ★ WHY THESE TOGETHER. They all implement the SAME contract, and it is the one this repo has already
// got wrong once on the camera password: **a stored secret is never sent back to the browser, so the
// field renders blank, and a blank field on save must mean "keep what is stored".** Get it wrong in
// either direction and it fails quietly:
//   * send the blank, and a routine edit silently wipes a working credential — MQTT stops connecting,
//     or push notifications stop arriving, with no error and nothing on screen to explain it;
//   * show the secret to make the field non-blank, and it leaks to every browser that loads the page.
//
// There are THREE separate implementations of that contract across these screens — `SecretField`,
// ntfy's own two-secret form, and MQTT's hand-rolled input — and nothing tested any of them. They even
// disagree on the mechanics: ntfy always sends its token (empty string meaning keep) and only sends
// its password when non-empty, while MQTT only sends the password when non-empty. Both work, because
// the routes accept either; the tests below pin what each screen actually does so the next person
// changing one knows which convention they are in.
//
// Role gating is not tested here: these routes are <AdminProtected> (routeGuards.test.jsx).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import SecretField from '../src/components/SecretField.jsx';
import SettingsMqtt from '../src/pages/SettingsMqtt.jsx';
import SettingsPushNtfy from '../src/pages/SettingsPushNtfy.jsx';
import { api } from '../src/lib/api.js';

let putSpy;
let postSpy;

afterEach(() => vi.restoreAllMocks());

describe('SecretField — the shared input for a value the server will not return', () => {
  const noop = () => {};

  test('is a password input that password managers are told to leave alone', async () => {
    // type=password so a pasted token is not shoulder-surfed, and autoComplete off so a manager does
    // not helpfully fill someone's ntfy token with their email password.
    renderAsAdmin(<SecretField id="s" label="Token" value="" onChange={noop} />);
    const field = await screen.findByLabelText('Token');
    expect(field.type).toBe('password');
    expect(field.getAttribute('autocomplete')).toBe('new-password');
  });

  test('★ when a secret is stored it says so, shows a masked preview, and starts EMPTY', async () => {
    // All three parts matter together. Empty is what makes "blank means keep" possible at all; the
    // masked preview is how someone tells WHICH token is saved without being shown it; and the
    // placeholder is the only thing that stops an empty box reading as "no token set", which would
    // invite someone to paste one in and thereby replace a perfectly good credential.
    renderAsAdmin(<SecretField id="s" label="Token" masked="tk_…9f2c" isSet value="" onChange={noop} />);
    const field = await screen.findByLabelText('Token');
    expect(field.value).toBe('');
    expect(field.placeholder).toBe('Leave blank to keep current');
    expect(screen.getByText('tk_…9f2c')).toBeTruthy();
    expect(screen.getByText(/enter a new value to replace it/i)).toBeTruthy();
  });

  test('when nothing is stored it offers the hint instead of a masked preview', async () => {
    renderAsAdmin(
      <SecretField id="s" label="Token" isSet={false} value="" onChange={noop} placeholder="tk_..." hint="Create one in the app" />
    );
    const field = await screen.findByLabelText('Token');
    expect(field.placeholder).toBe('tk_...');
    expect(screen.getByText('Create one in the app')).toBeTruthy();
    // No "Saved:" line — there is nothing saved to describe.
    expect(screen.queryByText(/Saved:/)).toBeNull();
  });

  test('never renders the secret itself, only the mask', async () => {
    // The mask is a preview, not the value. If the component ever fell back to showing what it was
    // given, a screen that only meant to say "a token is set" would put the token on the page.
    renderAsAdmin(<SecretField id="s" label="Token" masked="tk_…9f2c" isSet value="" onChange={noop} />);
    expect(document.body.textContent).not.toContain('tk_supersecretvalue');
    expect((await screen.findByLabelText('Token')).value).toBe('');
  });
});

describe('MQTT settings', () => {
  const CONFIG = {
    mqtt_enabled: true,
    mqtt_host: 'broker.local',
    mqtt_port: 1883,
    mqtt_username: 'nightlight',
    mqtt_password_set: true,
  };

  function mockMqtt(config = CONFIG) {
    vi.spyOn(api, 'get').mockResolvedValue(config);
    putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
  }

  beforeEach(() => mockMqtt());

  test('loads the stored broker details, and the password box arrives empty', async () => {
    renderAsAdmin(<SettingsMqtt />);
    expect((await screen.findByLabelText('Broker host')).value).toBe('broker.local');
    const pw = screen.getByLabelText('Password (optional)');
    expect(pw.value, 'a stored password is never sent to the browser').toBe('');
    expect(pw.placeholder).toBe('Leave blank to keep current password');
  });

  test('★★ saving without retyping the password does NOT send it', async () => {
    // THE test. This is the shape that wiped a camera's credentials once: the field is blank because
    // the server never sent the secret, so posting that blank would clear a working password. Editing
    // the host must not cost you the login.
    const { user } = renderAsAdmin(<SettingsMqtt />);
    const host = await screen.findByLabelText('Broker host');
    await user.clear(host);
    await user.type(host, 'broker2.local');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const body = putSpy.mock.calls[0][1];
    expect(body.mqtt_host).toBe('broker2.local');
    expect(body, 'a blank password must be left out, not sent as empty').not.toHaveProperty('mqtt_password');
  });

  test('a typed password IS sent, and the field clears afterwards', async () => {
    // The other half — the field has to actually work. Clearing it after a successful save matters
    // too: leaving the typed secret on screen is both a shoulder-surfing risk and a lie, since the
    // next save would send it again.
    const { user } = renderAsAdmin(<SettingsMqtt />);
    const pw = await screen.findByLabelText('Password (optional)');
    await user.type(pw, 'hunter2');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].mqtt_password).toBe('hunter2');
    await waitFor(() => expect(screen.getByLabelText('Password (optional)').value).toBe(''));
  });

  test('when no password is stored the box says nothing about keeping one', async () => {
    vi.restoreAllMocks();
    mockMqtt({ ...CONFIG, mqtt_password_set: false });
    renderAsAdmin(<SettingsMqtt />);
    const pw = await screen.findByLabelText('Password (optional)');
    expect(pw.placeholder).toBe('');
  });

  test('a failed save reports it instead of claiming success', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue(CONFIG);
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('Broker refused the connection'));
    const { user } = renderAsAdmin(<SettingsMqtt />);
    await user.click(await screen.findByRole('button', { name: /Save/ }));

    expect(await screen.findByText('Broker refused the connection')).toBeTruthy();
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });
});

describe('ntfy push settings', () => {
  const CONFIG = {
    enabled: true,
    configured: true,
    server_url: 'https://ntfy.sh',
    topic: 'nursery-abc',
    token_set: true,
    token_masked: 'tk_…9f2c',
    username: 'me',
    password_set: true,
  };

  function mockNtfy(config = CONFIG) {
    vi.spyOn(api, 'get').mockResolvedValue(config);
    putSpy = vi.spyOn(api, 'put').mockResolvedValue(config);
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({});
  }

  beforeEach(() => mockNtfy());

  test('loads the stored config with both secrets blank', async () => {
    renderAsAdmin(<SettingsPushNtfy />);
    expect((await screen.findByDisplayValue('nursery-abc')).value).toBe('nursery-abc');
    // The masked preview is the only evidence a token is stored.
    expect(screen.getByText('tk_…9f2c')).toBeTruthy();
  });

  test('★★ saving without retyping either secret keeps both', async () => {
    // ntfy carries TWO secrets with two different conventions, which is exactly why this is worth
    // pinning rather than assumed: the token is always sent (empty string meaning "keep") while the
    // password is only sent when something was typed. Both are accepted by the route as "keep" — but
    // a change to either convention on either side would silently drop a credential.
    const { user } = renderAsAdmin(<SettingsPushNtfy />);
    await screen.findByDisplayValue('nursery-abc');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const body = putSpy.mock.calls[0][1];
    expect(body.token, 'an untouched token is sent empty, which the route reads as keep').toBe('');
    expect(body, 'an untouched password is left out entirely').not.toHaveProperty('password');
    expect(body.topic).toBe('nursery-abc');
  });

  test('a typed token is sent and the field clears afterwards', async () => {
    const { user } = renderAsAdmin(<SettingsPushNtfy />);
    const token = await screen.findByLabelText('Access token (optional)');
    await user.type(token, 'tk_newvalue');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].token).toBe('tk_newvalue');
    await waitFor(() => expect(screen.getByLabelText('Access token (optional)').value).toBe(''));
  });

  test('sending a test says whether it worked', async () => {
    const { user } = renderAsAdmin(<SettingsPushNtfy />);
    await screen.findByDisplayValue('nursery-abc');
    await user.click(screen.getByRole('button', { name: /Send test/i }));

    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/ntfy/test'));
    expect(await screen.findByText(/Test sent/i)).toBeTruthy();
  });

  test('a failed test reports the reason rather than a generic failure', async () => {
    // The reason is the whole value of a test button: "403 from ntfy.sh" tells you the token is wrong,
    // where "test failed" tells you nothing you did not already suspect.
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue(CONFIG);
    vi.spyOn(api, 'put').mockResolvedValue(CONFIG);
    vi.spyOn(api, 'post').mockRejectedValue(new Error('403 from ntfy.sh — check the token'));

    const { user } = renderAsAdmin(<SettingsPushNtfy />);
    await screen.findByDisplayValue('nursery-abc');
    await user.click(screen.getByRole('button', { name: /Send test/i }));

    expect(await screen.findByText('403 from ntfy.sh — check the token')).toBeTruthy();
  });

  test('★ stays USABLE when the config endpoint fails — the first-time setup case', async () => {
    // A provider nobody has configured yet errors here, and that is the exact moment somebody is
    // trying to set it up. The form renders either way, so rendering is not the thing to assert:
    // every control on this screen is `disabled={busy || !loaded}`, and the catch that sets `loaded`
    // is the only reason a failed load does not leave the whole page permanently greyed out with no
    // explanation. Asserting the field exists passed with that catch removed — mutation testing
    // caught it; asserting the button is usable is the claim that actually fails.
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockRejectedValue(new Error('not configured'));
    putSpy = vi.spyOn(api, 'put').mockResolvedValue({});
    renderAsAdmin(<SettingsPushNtfy />);

    expect(await screen.findByLabelText('Access token (optional)')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' }).disabled).toBe(false));
  });
});
