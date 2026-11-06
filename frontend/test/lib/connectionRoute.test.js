// What the About page shows in the Android app (owner, 2026-11-06): which address this session is on, and whether the Tailscale
// address is saved. getConnectionRoute in lib/nativeBridge.js decides it from what the shell reports and the page's own origin
// (under jsdom, window.location.origin). It must say NOTHING where the feature does not exist, and never throw.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const HERE = window.location.origin; // the address this page is on
const TS = 'https://nightlight.example.ts.net';
const OTHER = 'http://192.168.1.50:4000';

let nb;

function stubNative(get, extra = {}) {
  const ServerConfig = { get, addEndpoint: vi.fn(), removeEndpoint: vi.fn(), list: vi.fn(), ...extra };
  window.Capacitor = { isNativePlatform: () => true, Plugins: { ServerConfig } };
  return ServerConfig;
}

beforeEach(async () => {
  vi.resetModules();
  delete window.Capacitor;
  nb = await import('../../src/lib/nativeBridge.js');
});

afterEach(() => {
  delete window.Capacitor;
});

describe('★ getConnectionRoute', () => {
  test('★ on the saved address, with no Tailscale address saved', async () => {
    stubNative(vi.fn().mockResolvedValue({ url: HERE, tailscale: null }));
    expect(await nb.getConnectionRoute()).toEqual({ via: 'saved', tailscaleSaved: false, address: null, why: null });
  });

  test('★ on the saved address, with a Tailscale address saved', async () => {
    stubNative(vi.fn().mockResolvedValue({ url: HERE, tailscale: TS }));
    expect(await nb.getConnectionRoute()).toEqual({ via: 'saved', tailscaleSaved: true, address: 'nightlight.example.ts.net', why: null });
  });

  test('★ on the Tailscale address: the page IS the saved Tailscale address', async () => {
    stubNative(vi.fn().mockResolvedValue({ url: OTHER, tailscale: HERE }));
    expect(await nb.getConnectionRoute()).toEqual({ via: 'tailscale', tailscaleSaved: true, address: window.location.host, why: null });
  });

  test('on neither it says "other" rather than guessing a name, and still reports what is saved', async () => {
    stubNative(vi.fn().mockResolvedValue({ url: OTHER, tailscale: TS }));
    expect(await nb.getConnectionRoute()).toEqual({ via: 'other', tailscaleSaved: true, address: 'nightlight.example.ts.net', why: null });
    stubNative(vi.fn().mockResolvedValue({ url: null, tailscale: null }));
    expect(await nb.getConnectionRoute()).toEqual({ via: 'other', tailscaleSaved: false, address: null, why: null });
  });

  test('addresses are compared canonically (case, default port, a trailing slash)', async () => {
    stubNative(vi.fn().mockResolvedValue({ url: `${HERE.toUpperCase()}/`, tailscale: null }));
    expect((await nb.getConnectionRoute()).via).toBe('saved');
  });

  test('★ nothing where the feature does not exist: a browser, a shell without addEndpoint (iOS, an older app), a shell that throws', async () => {
    expect(await nb.getConnectionRoute()).toBeNull(); // a browser
    const old = stubNative(vi.fn().mockResolvedValue({ url: HERE }));
    delete old.addEndpoint;
    expect(await nb.getConnectionRoute()).toBeNull();
    stubNative(vi.fn().mockRejectedValue(new Error('no')));
    expect(await nb.getConnectionRoute()).toBeNull();
  });

  test('an odd value from the shell (not a string) counts as nothing saved, not as a match', async () => {
    stubNative(vi.fn().mockResolvedValue({ url: 5, tailscale: {} }));
    expect(await nb.getConnectionRoute()).toEqual({ via: 'other', tailscaleSaved: false, address: null, why: null });
  });
});
