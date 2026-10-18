// Settings → MQTT, the TLS controls (#537): off by default, a CA field and a verify switch (on by default) once it
// is on, a refusal of the CA text shown next to the field, and the reason for a failed connection shown in words.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsMqtt from '../src/pages/SettingsMqtt.jsx';
import { api } from '../src/lib/api.js';

const CONFIG = {
  mqtt_enabled: true, mqtt_host: 'broker.local', mqtt_port: 8883, mqtt_username: 'nightlight', mqtt_password_set: true,
  mqtt_tls: false, mqtt_tls_ca: '', mqtt_tls_verify: true,
};
const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----';

let putSpy;
function mockApi({ config = CONFIG, status = { enabled: true, connected: true, tls: false, error: null }, putImpl = null } = {}) {
  vi.spyOn(api, 'get').mockImplementation(async (path) => (String(path).includes('/mqtt/status') ? status : config));
  putSpy = vi.spyOn(api, 'put').mockImplementation(putImpl || (async () => ({})));
}
beforeEach(() => mockApi());
afterEach(() => vi.restoreAllMocks());

const TLS = { name: /Use TLS/ };
const VERIFY = { name: /Verify the broker's certificate/ };

describe('the default is what every install has today', () => {
  test('TLS is off, and the CA and verify controls are not even shown', async () => {
    renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    expect(screen.getByRole('switch', TLS).checked).toBe(false);
    expect(screen.queryByRole('switch', VERIFY)).toBeNull();
    expect(screen.queryByLabelText(/CA certificate/)).toBeNull();
  });

  test('saving without touching TLS sends it off, with verification on, and no CA text (the box is hidden)', async () => {
    const { user } = renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).toMatchObject({ mqtt_tls: false, mqtt_tls_verify: true });
    // Left out, the server keeps whatever CA is stored (routes/settings.js: an absent field keeps the stored value).
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('mqtt_tls_ca');
  });

  test('a server that predates TLS (no such fields) leaves it off', async () => {
    const { mqtt_tls, mqtt_tls_ca, mqtt_tls_verify, ...old } = CONFIG; // eslint-disable-line no-unused-vars
    mockApi({ config: old });
    renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    expect(screen.getByRole('switch', TLS).checked).toBe(false);
  });
});

describe('turning TLS on', () => {
  test('shows verification (ON by default) and the CA box, and the save carries all three', async () => {
    const { user } = renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    await user.click(screen.getByRole('switch', TLS));
    expect(screen.getByRole('switch', VERIFY).checked, 'verification must default to ON').toBe(true);
    // The broker's own certificate works as the CA only when it is self-signed (#537 review), and the help says so.
    expect(screen.getByText(/or, for a self-signed broker, the broker's\s+own certificate/)).toBeTruthy();
    await user.click(screen.getByLabelText(/CA certificate/));
    await user.paste(PEM);
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).toMatchObject({ mqtt_tls: true, mqtt_tls_verify: true, mqtt_tls_ca: PEM });
  });

  test('verification can be switched off, and that is what is sent', async () => {
    const { user } = renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    await user.click(screen.getByRole('switch', TLS));
    await user.click(screen.getByRole('switch', VERIFY));
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].mqtt_tls_verify).toBe(false);
  });

  test('stored TLS settings are shown as stored', async () => {
    mockApi({ config: { ...CONFIG, mqtt_tls: true, mqtt_tls_verify: false, mqtt_tls_ca: PEM } });
    renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    await waitFor(() => expect(screen.getByRole('switch', TLS).checked).toBe(true));
    expect(screen.getByRole('switch', VERIFY).checked).toBe(false);
    expect(screen.getByLabelText(/CA certificate/).value).toBe(PEM);
  });

  test('the password is still never filled in', async () => {
    renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    expect(screen.getByLabelText(/Password/).value).toBe('');
  });
});

describe('a CA the server refuses', () => {
  test('is explained next to the CA box (not in the page banner), and what was typed is kept', async () => {
    const msg = 'That is a private key, not a certificate. Paste only the CA certificate.';
    mockApi({ putImpl: async () => { throw Object.assign(new Error(msg), { status: 400, data: { error: msg, field: 'mqtt_tls_ca' } }); } });
    const { user } = renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    await user.click(screen.getByRole('switch', TLS));
    await user.click(screen.getByLabelText(/CA certificate/));
    await user.paste('not a certificate');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(msg);
    // Beside the field: the alert sits in the same block as the textarea.
    expect(alert.parentElement.contains(screen.getByLabelText(/CA certificate/))).toBe(true);
    expect(screen.getByLabelText(/CA certificate/).value).toBe('not a certificate');
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });

  // #537 review: the form used to send the CA text even with TLS off, and draw its refusal inside the hidden TLS
  // block. TLS on, junk pasted, TLS off, Save: the save failed with no message on screen and no "Saved".
  test('★ junk typed while TLS was on, then TLS switched off: the save goes through and says Saved', async () => {
    // Refuses CA text the way the real route does (parseMqttCa), so the old behaviour fails this test.
    const refuse = { error: 'No certificate found.', field: 'mqtt_tls_ca' };
    mockApi({
      putImpl: async (_path, body) => {
        if (body.mqtt_tls_ca !== undefined && !String(body.mqtt_tls_ca).includes('BEGIN CERTIFICATE')) {
          throw Object.assign(new Error(refuse.error), { status: 400, data: refuse });
        }
        return {};
      },
    });
    const { user } = renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    await user.click(screen.getByRole('switch', TLS));
    await user.click(screen.getByLabelText(/CA certificate/));
    await user.paste('junk');
    await user.click(screen.getByRole('switch', TLS)); // off again: the CA box is hidden
    expect(screen.queryByLabelText(/CA certificate/)).toBeNull();
    await user.click(screen.getByRole('button', { name: /Save/ }));

    expect(await screen.findByText('Saved ✓')).toBeTruthy();
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('mqtt_tls_ca');
    expect(putSpy.mock.calls[0][1].mqtt_tls).toBe(false);
  });

  test('a CA refusal that arrives while the CA box is hidden is shown in the banner, not dropped', async () => {
    const msg = 'The stored CA certificate is not usable.';
    mockApi({ putImpl: async () => { throw Object.assign(new Error(msg), { status: 400, data: { error: msg, field: 'mqtt_tls_ca' } }); } });
    const { user } = renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText(msg)).toBeTruthy();
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });

  test('any other refusal still goes to the banner', async () => {
    mockApi({ putImpl: async () => { throw Object.assign(new Error('The MQTT port must be a whole number'), { status: 400, data: { error: 'x' } }); } });
    const { user } = renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(await screen.findByText('The MQTT port must be a whole number')).toBeTruthy();
  });
});

describe('the connection, in words', () => {
  test('a failed connection shows the reason the server gave', async () => {
    const error = "The broker's certificate is self-signed and not trusted.";
    mockApi({ config: { ...CONFIG, mqtt_tls: true }, status: { enabled: true, connected: false, tls: true, error, error_code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
    renderAsAdmin(<SettingsMqtt />);
    expect(await screen.findByText(`Not connected: ${error}`)).toBeTruthy();
  });

  test('a working TLS connection says so, and a working plain one does not claim TLS', async () => {
    mockApi({ config: { ...CONFIG, mqtt_tls: true }, status: { enabled: true, connected: true, tls: true, error: null } });
    const first = renderAsAdmin(<SettingsMqtt />);
    expect(await screen.findByText('Connected over TLS.')).toBeTruthy();
    first.unmount();

    mockApi({ status: { enabled: true, connected: true, tls: false, error: null } });
    renderAsAdmin(<SettingsMqtt />);
    expect(await screen.findByText('Connected.')).toBeTruthy();
  });

  test('nothing is said while MQTT is off', async () => {
    mockApi({ config: { ...CONFIG, mqtt_enabled: false }, status: { enabled: false, connected: false, tls: false, error: null } });
    renderAsAdmin(<SettingsMqtt />);
    await screen.findByDisplayValue('broker.local');
    expect(screen.queryByText(/Not connected/)).toBeNull();
    expect(screen.queryByText(/^Connected/)).toBeNull();
  });
});
