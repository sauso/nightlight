// The phone app's second address (owner, 2026-11-06): the phone opens the address it was set up with and falls back to the server's
// Tailscale address. This file pins the WEB half in lib/nativeBridge.js:
//   1. syncTailscaleEndpoint reads GET /api/remote-access/tailscale/address and hands a string to the shell's addEndpoint, null to
//      removeEndpoint, and changes NOTHING for anything else (a 409 "not known right now", an old server's 404, no network, an odd
//      body): the server says null only when the address is definitely not available, so a daemon restart cannot erase one;
//   2. it does nothing outside the Android shell, signed out, or on a shell without the new methods (iOS, older apps), and
//      never throws;
//   3. the person is told once, the first time the address is saved, and never over a switch-server dialog;
//   4. a link or alert that names EITHER of the server's two addresses is the server already in use, not a request to switch
//      (requestServerSwitch), while an unrelated saved server still asks.
// NOT COVERED: the native half (what the shell checks and stores: ServerConfigPlugin.addEndpoint). Its rules are in the JVM
// tests (EndpointRulesTest, EndpointChooserTest, EndpointProbeTest in nightlight-mobile); the plugin glue is a manual checklist.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const HOME = 'http://192.168.1.50:4000';
const TS = 'https://nightlight.example.ts.net';
const ADDRESS_ROUTE = '/api/remote-access/tailscale/address';
const CUSTOM_ROUTE = '/api/remote-access/address';

let nb;
let answer; // what GET /api/remote-access/tailscale/address does: { status, body } or a thrown error
let fetched;

function stubNative(extra = {}) {
  const ServerConfig = {
    list: vi.fn().mockResolvedValue({ servers: [HOME], active: HOME, tailscale: null }),
    save: vi.fn(async ({ url }) => ({ url })),
    restart: vi.fn().mockResolvedValue(undefined),
    takePending: vi.fn().mockResolvedValue({ server: null }),
    addEndpoint: vi.fn().mockResolvedValue({ added: true }),
    removeEndpoint: vi.fn().mockResolvedValue({ removed: true }),
    ...extra,
  };
  window.Capacitor = { isNativePlatform: () => true, Plugins: { ServerConfig, BackgroundAudio: { stop: vi.fn().mockResolvedValue(undefined) } } };
  return ServerConfig;
}

beforeEach(async () => {
  vi.resetModules();
  delete window.Capacitor;
  localStorage.setItem('nightlight_token', 't');
  fetched = [];
  answer = { status: 200, body: { url: TS } };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(String(input), 'http://localhost').pathname;
    fetched.push(path);
    if (path === ADDRESS_ROUTE || path === CUSTOM_ROUTE) {
      if (answer instanceof Error) throw answer;
      return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, text: async () => JSON.stringify(answer.body) };
    }
    return { status: 200, ok: true, text: async () => JSON.stringify({ publicBaseUrl: null }) };
  });
  nb = await import('../../src/lib/nativeBridge.js');
});

afterEach(() => {
  const open = nb?.getServerSwitchPrompt();
  if (open) nb.dismissServerSwitchPrompt(open.id);
  localStorage.clear();
  delete window.Capacitor;
  vi.restoreAllMocks();
});

describe('★ syncTailscaleEndpoint: what the server says decides what the phone keeps', () => {
  test('a capable shell uses the new route and passes the custom kind, while a 409 changes nothing', async () => {
    const SC = stubNative({ get: vi.fn().mockResolvedValue({ supportsCustomUrl: true }) });
    answer = { status: 200, body: { url: 'https://custom.example', kind: 'custom' } };
    expect(await nb.syncTailscaleEndpoint()).toBe('added');
    expect(fetched).toEqual([CUSTOM_ROUTE]);
    expect(SC.addEndpoint).toHaveBeenCalledWith({ url: 'https://custom.example', kind: 'custom' });
    answer = { status: 409, body: { code: 'status_unavailable' } };
    expect(await nb.syncTailscaleEndpoint()).toBeNull();
    expect(SC.removeEndpoint).not.toHaveBeenCalled();
  });

  test('a capable shell binds a Tailscale kind and removes a definite null; a failed capability read uses the old route', async () => {
    const SC = stubNative({ get: vi.fn().mockResolvedValue({ supportsCustomUrl: true }) });
    answer = { status: 200, body: { url: TS, kind: 'tailscale' } };
    await nb.syncTailscaleEndpoint();
    expect(SC.addEndpoint).toHaveBeenCalledWith({ url: TS, kind: 'tailscale' });
    answer = { status: 200, body: { url: null, kind: null } };
    await nb.syncTailscaleEndpoint();
    expect(SC.removeEndpoint).toHaveBeenCalledTimes(1);
    SC.get.mockRejectedValue(new Error('old shell'));
    await nb.syncTailscaleEndpoint();
    expect(fetched.at(-1)).toBe(ADDRESS_ROUTE);
  });
  test('★ an address is handed to the shell exactly as the server sent it, and the person is told once', async () => {
    const SC = stubNative();
    expect(await nb.syncTailscaleEndpoint()).toBe('added');
    expect(SC.addEndpoint).toHaveBeenCalledTimes(1);
    expect(SC.addEndpoint).toHaveBeenCalledWith({ url: TS });
    expect(SC.removeEndpoint).not.toHaveBeenCalled();
    expect(nb.getServerSwitchPrompt()).toMatchObject({ kind: 'tailscale-added' });
  });

  test('★ switching away and back learns the address again, but the person is told only the first time', async () => {
    // Change server forgets a server's Tailscale address by design, so every return reports "added" again (owner, 2026-11-06:
    // the message came back on every switch).
    const SC = stubNative();
    expect(await nb.syncTailscaleEndpoint()).toBe('added');
    expect(nb.getServerSwitchPrompt()).toMatchObject({ kind: 'tailscale-added' });
    nb.dismissServerSwitchPrompt(nb.getServerSwitchPrompt().id);
    expect(await nb.syncTailscaleEndpoint()).toBe('added'); // the shell says "added" again
    expect(SC.addEndpoint).toHaveBeenCalledTimes(2);
    expect(nb.getServerSwitchPrompt()).toBeNull();
  });

  test('an address the phone already had changes nothing and tells nobody', async () => {
    const SC = stubNative({ addEndpoint: vi.fn().mockResolvedValue({ added: false }) });
    expect(await nb.syncTailscaleEndpoint()).toBe('unchanged');
    expect(SC.addEndpoint).toHaveBeenCalledTimes(1);
    expect(nb.getServerSwitchPrompt()).toBeNull();
  });

  test('★ url: null (definitely not available) removes the saved address, quietly', async () => {
    answer = { status: 200, body: { url: null } };
    const SC = stubNative();
    expect(await nb.syncTailscaleEndpoint()).toBe('removed');
    expect(SC.removeEndpoint).toHaveBeenCalledTimes(1);
    expect(SC.addEndpoint).not.toHaveBeenCalled();
    expect(nb.getServerSwitchPrompt()).toBeNull();
  });

  test('★ "not known right now" (409), an old server (404), a server error and no network all change NOTHING', async () => {
    for (const next of [
      { status: 409, body: { error: 'x', code: 'status_unavailable' } },
      { status: 404, body: { error: 'Not found' } },
      { status: 500, body: { error: 'boom' } },
      new TypeError('Failed to fetch'),
    ]) {
      answer = next;
      const SC = stubNative();
      expect(await nb.syncTailscaleEndpoint()).toBeNull();
      expect(SC.addEndpoint).not.toHaveBeenCalled();
      expect(SC.removeEndpoint, 'a saved address must survive a reply that is not a definite "no"').not.toHaveBeenCalled();
    }
  });

  test('★ a body that is neither an address nor null changes nothing (a missing url is not "off")', async () => {
    for (const body of [{}, { url: undefined }, { url: 5 }, { url: true }, { url: {} }, { url: [] }, [], null, 'x']) {
      answer = { status: 200, body };
      const SC = stubNative();
      expect(await nb.syncTailscaleEndpoint(), JSON.stringify(body)).toBeNull();
      expect(SC.removeEndpoint, JSON.stringify(body)).not.toHaveBeenCalled();
      expect(SC.addEndpoint, JSON.stringify(body)).not.toHaveBeenCalled();
    }
  });

  test('a shell that refuses the address is swallowed: nothing thrown, nobody told', async () => {
    const SC = stubNative({ addEndpoint: vi.fn().mockRejectedValue(new Error('That address is a different server')) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(nb.syncTailscaleEndpoint()).resolves.toBeNull();
    expect(SC.addEndpoint).toHaveBeenCalledTimes(1);
    expect(nb.getServerSwitchPrompt()).toBeNull();
    const removing = stubNative({ removeEndpoint: vi.fn().mockRejectedValue(new Error('Not available on this page')) });
    answer = { status: 200, body: { url: null } };
    await expect(nb.syncTailscaleEndpoint()).resolves.toBeNull();
    expect(removing.removeEndpoint).toHaveBeenCalledTimes(1);
  });
});

// Owner, 2026-11-07: About says WHY no Tailscale address is saved. The ask's outcome is kept and reported by getConnectionRoute,
// but only while nothing is saved. The shell's refusal sentences below are the real ones (ServerConfigPlugin.refusal in
// nightlight-mobile); the wording is matched, so an unrecognised sentence must fall to the generic 'refused', never to a cause.
describe('★ the outcome of the last ask, as About reads it (getConnectionRoute.why)', () => {
  const nothingSaved = () => ({ get: vi.fn().mockResolvedValue({ url: HOME, tailscale: null }) });
  const whyAfter = async (native) => {
    stubNative({ ...nothingSaved(), ...native });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await nb.syncTailscaleEndpoint();
    return (await nb.getConnectionRoute()).why;
  };

  test('★ each way the shell can refuse maps to its own reason, and an unknown sentence to the generic one', async () => {
    const cases = [
      ["Couldn't reach that Tailscale address", 'unreachable'],
      ['That address is a different server', 'different'],
      ["Couldn't read this server's identity", 'refused'],
      ['Not available on this page', 'refused'],
      ['Something the shell never said', 'refused'],
    ];
    for (const [sentence, why] of cases) {
      expect(await whyAfter({ addEndpoint: vi.fn().mockRejectedValue(new Error(sentence)) }), sentence).toBe(why);
    }
    expect(nb.classifyAddRefusal(undefined)).toBe('refused'); // a rejection with no message at all
    expect(nb.classifyAddRefusal('Couldn\'t reach')).toBe('refused'); // a bare string is not an Error: no guessing
  });

  test('★ the server saying it has none is "server-none"; a reply that says nothing definite is "unknown"', async () => {
    answer = { status: 200, body: { url: null } };
    expect(await whyAfter({})).toBe('server-none');
    for (const next of [{ status: 409, body: {} }, { status: 404, body: {} }, new TypeError('Failed to fetch'), { status: 200, body: { url: 5 } }]) {
      answer = next;
      expect(await whyAfter({}), JSON.stringify(next)).toBe('unknown');
    }
    // A removeEndpoint that throws does not change what the server said.
    answer = { status: 200, body: { url: null } };
    expect(await whyAfter({ removeEndpoint: vi.fn().mockRejectedValue(new Error('Not available on this page')) })).toBe('server-none');
  });

  test('★ a saved address wins: no reason and the host is reported, even if the last ask failed', async () => {
    const saved = { get: vi.fn().mockResolvedValue({ url: HOME, tailscale: TS }), addEndpoint: vi.fn().mockRejectedValue(new Error("Couldn't reach that Tailscale address")) };
    stubNative(saved);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await nb.syncTailscaleEndpoint();
    expect(await nb.getConnectionRoute()).toMatchObject({ tailscaleSaved: true, address: 'nightlight.example.ts.net', why: null });
  });

  test('★ a good save is "saved", and signing out clears what was learned', async () => {
    stubNative({ ...nothingSaved() });
    await nb.syncTailscaleEndpoint();
    expect((await nb.getConnectionRoute()).why).toBe('saved');
    localStorage.removeItem('nightlight_token');
    await nb.syncTailscaleEndpoint();
    expect((await nb.getConnectionRoute()).why).toBeNull();
  });

  // Codex review of the code: three orderings the awaited-one-at-a-time tests above cannot see.
  test('★ About opened while the start-up ask is still running waits for it and shows its result', async () => {
    let refuse;
    stubNative({ ...nothingSaved(), addEndpoint: vi.fn(() => new Promise((_, reject) => { refuse = reject; })) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ask = nb.syncTailscaleEndpoint();
    const route = nb.getConnectionRoute(); // opened mid-ask
    await vi.waitFor(() => expect(refuse).toBeTypeOf('function'));
    refuse(new Error("Couldn't reach that Tailscale address"));
    await ask;
    expect((await route).why).toBe('unreachable');
  });

  test('★ an ask that finishes after a sign-out and a new sign-in does not overwrite the new session\'s outcome', async () => {
    let refuse;
    const addEndpoint = vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { refuse = reject; }))
      .mockResolvedValue({ added: false });
    stubNative({ ...nothingSaved(), addEndpoint });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = nb.syncTailscaleEndpoint(); // signed in as "t"
    await vi.waitFor(() => expect(refuse).toBeTypeOf('function'));
    localStorage.setItem('nightlight_token', 'u'); // signed out and in again as someone else while it was still asking
    await nb.syncTailscaleEndpoint();
    expect((await nb.getConnectionRoute()).why).toBe('saved');
    refuse(new Error("Couldn't reach that Tailscale address"));
    await first;
    expect((await nb.getConnectionRoute()).why, 'the old ask must not write over the new one').toBe('saved');
  });

  test('a shell that cannot remove an address (so the ask returns early) clears an older reason instead of keeping it', async () => {
    stubNative({ ...nothingSaved(), addEndpoint: vi.fn().mockRejectedValue(new Error("Couldn't reach that Tailscale address")) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await nb.syncTailscaleEndpoint();
    expect((await nb.getConnectionRoute()).why).toBe('unreachable');
    const partial = stubNative({ ...nothingSaved() });
    delete partial.removeEndpoint;
    await nb.syncTailscaleEndpoint();
    expect((await nb.getConnectionRoute()).why).toBeNull();
  });

  test('nothing has been asked yet in this page load: no reason', async () => {
    stubNative({ ...nothingSaved() });
    expect((await nb.getConnectionRoute()).why).toBeNull();
  });
});

describe('★ syncTailscaleEndpoint: where it does nothing', () => {
  test('in a browser (no native shell): no request at all', async () => {
    expect(await nb.syncTailscaleEndpoint()).toBeNull();
    expect(fetched).toEqual([]);
  });

  test('signed out: no request, no call into the shell', async () => {
    // The token is read when api.js loads, so load it again without the token.
    localStorage.removeItem('nightlight_token');
    vi.resetModules();
    nb = await import('../../src/lib/nativeBridge.js');
    const SC = stubNative();
    expect(await nb.syncTailscaleEndpoint()).toBeNull();
    expect(fetched).not.toContain(ADDRESS_ROUTE);
    expect(SC.addEndpoint).not.toHaveBeenCalled();
    expect(SC.removeEndpoint).not.toHaveBeenCalled();
  });

  test('★ a shell without the new methods (iOS, an older Android app) is left alone: no request, nothing thrown', async () => {
    for (const missing of ['addEndpoint', 'removeEndpoint']) {
      fetched = [];
      const SC = stubNative();
      delete SC[missing];
      expect(await nb.syncTailscaleEndpoint()).toBeNull();
      expect(fetched, `without ${missing}`).not.toContain(ADDRESS_ROUTE);
    }
  });

  test('★ the notice never replaces a switch-server dialog that is already open, whichever kind it is', async () => {
    const SC = stubNative({ list: vi.fn().mockResolvedValue({ servers: [HOME, 'https://other.example'], active: HOME, tailscale: null }) });
    // A confirm dialog ("Switch server?")...
    expect(await nb.requestServerSwitch('https://other.example')).toBe('asked');
    const confirm = nb.getServerSwitchPrompt();
    expect(confirm.kind).toBe('confirm');
    expect(await nb.syncTailscaleEndpoint()).toBe('added'); // the address was still saved
    expect(SC.addEndpoint).toHaveBeenCalledTimes(1);
    expect(nb.getServerSwitchPrompt()).toBe(confirm);
    // ...and a refusal ("Server not saved in this app"), which is the one a narrower guard would let the notice replace.
    expect(await nb.requestServerSwitch('https://unsaved.example')).toBe('refused');
    const refused = nb.getServerSwitchPrompt();
    expect(refused.kind).toBe('refused');
    await nb.syncTailscaleEndpoint();
    expect(nb.getServerSwitchPrompt()).toBe(refused);
  });

  test('the notice only informs: it cannot be "confirmed" as a server switch', async () => {
    const SC = stubNative();
    await nb.syncTailscaleEndpoint();
    const notice = nb.getServerSwitchPrompt();
    expect(notice.kind).toBe('tailscale-added');
    expect(await nb.confirmServerSwitch(notice.id)).toBe(false);
    expect(SC.save).not.toHaveBeenCalled();
    expect(SC.restart).not.toHaveBeenCalled();
  });
});

describe('★ requestServerSwitch: either address of the server in use is the server in use', () => {
  // The page is on window.location.origin (jsdom). The saved server is HOME, a different address, as when the phone is away.
  test('★ the saved address and the Tailscale address are both "same", with no dialog', async () => {
    stubNative({ list: vi.fn().mockResolvedValue({ servers: [HOME], active: HOME, tailscale: TS }) });
    expect(await nb.requestServerSwitch(HOME)).toBe('same');
    expect(nb.getServerSwitchPrompt()).toBeNull();
    expect(await nb.requestServerSwitch(TS)).toBe('same');
    expect(nb.getServerSwitchPrompt()).toBeNull();
  });

  test('★ a link naming the saved address while the shell has no Tailscale address is still "same" (it is the active server)', async () => {
    stubNative({ list: vi.fn().mockResolvedValue({ servers: [HOME], active: HOME, tailscale: null }) });
    expect(await nb.requestServerSwitch(HOME)).toBe('same');
  });

  test('★ a Tailscale address that is NOT the one saved for this server is not "same": it is not in the saved list, so it is refused', async () => {
    stubNative({ list: vi.fn().mockResolvedValue({ servers: [HOME], active: HOME, tailscale: TS }) });
    expect(await nb.requestServerSwitch('https://stranger.example.ts.net')).toBe('refused');
  });

  test('★ an unrelated saved server still asks first', async () => {
    stubNative({ list: vi.fn().mockResolvedValue({ servers: [HOME, 'https://other.example'], active: HOME, tailscale: TS }) });
    expect(await nb.requestServerSwitch('https://other.example')).toBe('asked');
    expect(nb.getServerSwitchPrompt().kind).toBe('confirm');
  });

  test('an older shell (no tailscale field) and an unreadable list behave as before', async () => {
    stubNative({ list: vi.fn().mockResolvedValue({ servers: ['https://other.example'], active: 'https://other.example' }) });
    expect(await nb.requestServerSwitch('https://other.example')).toBe('same');
    stubNative({ list: vi.fn().mockRejectedValue(new Error('no list')) });
    expect(await nb.requestServerSwitch(TS)).toBe('refused');
  });
});
