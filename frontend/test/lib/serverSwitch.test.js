// #559: an alert or link that names another server is only a REQUEST. These pin the rules in lib/nativeBridge.js:
//   1. canonicalOrigin accepts a plain http(s) origin and nothing else, and canonicalises it (case, default port,
//      trailing slash) without merging origins that differ (a trailing dot, http vs https, another port);
//   2. requestServerSwitch only offers a server already in the phone's saved list, matched on the canonical
//      origin exactly, against a HOSTILE list of near misses; anything else is refused;
//   3. nothing switches until Switch, and then save() gets the saved entry's own string, never the request's;
//   4. the check is inside switchServer itself, so a caller that skips the dialog still cannot switch;
//   5. nothing contacts the requested address before Switch (the only request is /api/about, to the server on
//      screen), the same server and the address it advertises need no dialog, a newer request replaces an older
//      one (including one whose lookups finish last), and an app without takePending is "nothing pending".
// NOT COVERED: the native half (what the shell stores and when it fires the event). There is no Android test
// harness yet; it is a manual checklist in the PR.
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const CURRENT = window.location.origin; // the server "on screen" under jsdom
const GOOD = 'https://good.example';

let nb;
let fetchSpy;
let advertised;

// The native ServerConfig plugin, with a saved list. Each method is a spy so a test can assert what was (not)
// called, and with which exact string.
function stubNative({ servers = [], takePending } = {}) {
  const ServerConfig = {
    list: vi.fn().mockResolvedValue({ servers, active: CURRENT }),
    save: vi.fn(async ({ url }) => ({ url })),
    restart: vi.fn().mockResolvedValue(undefined),
    takePending: takePending ?? vi.fn().mockResolvedValue({ server: null }),
  };
  const BackgroundAudio = { stop: vi.fn().mockResolvedValue(undefined) };
  window.Capacitor = { isNativePlatform: () => true, Plugins: { ServerConfig, BackgroundAudio } };
  return ServerConfig;
}

beforeEach(async () => {
  vi.resetModules();
  delete window.Capacitor;
  advertised = null;
  // The REAL api.js over a stubbed fetch, so "what was fetched" is the network as the app would make it.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => ({
    status: 200,
    ok: true,
    text: async () => JSON.stringify({ version: 'x', publicBaseUrl: advertised }),
  }));
  nb = await import('../../src/lib/nativeBridge.js');
});

afterEach(() => {
  delete window.Capacitor;
});

describe('★ canonicalOrigin', () => {
  test('canonicalises case, the default port and one trailing slash', () => {
    expect(nb.canonicalOrigin('HTTPS://GOOD.EXAMPLE')).toBe(GOOD);
    expect(nb.canonicalOrigin('https://good.example:443')).toBe(GOOD);
    expect(nb.canonicalOrigin('https://good.example/')).toBe(GOOD);
    expect(nb.canonicalOrigin('  https://good.example  ')).toBe(GOOD);
    expect(nb.canonicalOrigin('http://good.example:80')).toBe('http://good.example');
    expect(nb.canonicalOrigin('http://192.168.1.50:4000')).toBe('http://192.168.1.50:4000');
  });

  test('IPv6 literals and punycode hosts are origins too', () => {
    expect(nb.canonicalOrigin('http://[::1]:4000')).toBe('http://[::1]:4000');
    expect(nb.canonicalOrigin('http://[0:0:0:0:0:0:0:1]:4000')).toBe('http://[::1]:4000');
    expect(nb.canonicalOrigin('https://xn--bcher-kva.example')).toBe('https://xn--bcher-kva.example');
  });

  test('★ origins that only LOOK alike stay different', () => {
    expect(nb.canonicalOrigin('https://good.example.')).toBe('https://good.example.'); // trailing dot kept
    expect(nb.canonicalOrigin('http://good.example')).not.toBe(GOOD);
    expect(nb.canonicalOrigin('https://good.example:444')).toBe('https://good.example:444');
    expect(nb.canonicalOrigin('https://good.example.evil')).toBe('https://good.example.evil');
  });

  test.each([
    ['credentials', 'https://user:pass@good.example'],
    ['a user name', 'https://user@good.example'],
    ['an empty user name', 'https://@good.example'],
    ['a host hidden behind credentials', 'https://good.example@evil.example'],
    ['a path', 'https://good.example/path'],
    ['two slashes', 'https://good.example//'],
    ['an empty query', 'https://good.example?'],
    ['a query', 'https://good.example/?server=x'],
    ['an empty fragment', 'https://good.example#'],
    ['a fragment', 'https://good.example/#x'],
    ['javascript:', 'javascript:alert(1)'],
    ['intent:', 'intent://good.example#Intent;scheme=https;end'],
    ['the app\'s own scheme', 'nightlight://camera/1'],
    ['ftp', 'ftp://good.example'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/html,hi'],
    ['backslashes', 'https:\\\\good.example'],
    ['no slashes', 'https:good.example'],
    ['a tab inside the host', 'https://go\tod.example'],
    ['a space inside the host', 'https://go od.example'],
    ['a non-ASCII host', 'https://bücher.example'],
    ['a port above 65535', 'https://good.example:70000'],
    ['an empty port', 'https://good.example:'],
    ['an impossible IPv6 literal', 'http://[::g]'],
    ['empty', ''],
  ])('refuses %s', (_label, value) => {
    expect(nb.canonicalOrigin(value)).toBeNull();
  });

  test('refuses anything that is not a string', () => {
    for (const v of [null, undefined, 42, {}, ['https://good.example']]) expect(nb.canonicalOrigin(v)).toBeNull();
  });

  test('★ length: 255 characters is accepted, 256 is refused', () => {
    const of = (n) => `https://${'a'.repeat(n - 'https://'.length)}`;
    expect(of(255)).toHaveLength(255);
    expect(nb.canonicalOrigin(of(255))).toBe(of(255));
    expect(nb.canonicalOrigin(of(256))).toBeNull();
  });
});

describe('★ requestServerSwitch: only a saved server, and only after Switch', () => {
  // Every near miss of GOOD a list could hold. None of them is GOOD.
  const HOSTILE = [
    'https://good.example.evil',
    'https://good.example:444',
    'http://good.example',
    'https://good.example.',
    'https://evil.example/good.example',
    'https://good.example@evil.example',
    'https://user@good.example',
    'https://good.example/path',
  ];

  test('★ a server that is not in the saved list is refused, against a list of near misses', async () => {
    const SC = stubNative({ servers: HOSTILE });
    expect(await nb.requestServerSwitch(GOOD)).toBe('refused');
    expect(nb.getServerSwitchPrompt()).toMatchObject({ kind: 'refused', origin: GOOD });
    expect(nb.getServerSwitchPrompt().entry).toBeUndefined();
    expect(SC.save).not.toHaveBeenCalled();
    expect(SC.restart).not.toHaveBeenCalled();
  });

  test('★ a saved server asks first; Switch saves the STORED entry, exactly, once', async () => {
    const STORED = 'https://Good.Example:443'; // how the list happens to spell it
    const SC = stubNative({ servers: [...HOSTILE, STORED] });
    expect(await nb.requestServerSwitch('HTTPS://good.example/')).toBe('asked');
    const prompt = nb.getServerSwitchPrompt();
    expect(prompt).toMatchObject({ kind: 'confirm', origin: GOOD, entry: STORED });
    expect(SC.save).not.toHaveBeenCalled(); // asking is not switching

    expect(await nb.confirmServerSwitch(prompt.id)).toBe(true);
    expect(SC.save).toHaveBeenCalledTimes(1);
    expect(SC.save).toHaveBeenCalledWith({ url: STORED });
    expect(SC.restart).toHaveBeenCalledTimes(1);
  });

  test('Stay closes the dialog and changes nothing', async () => {
    const SC = stubNative({ servers: [GOOD] });
    await nb.requestServerSwitch(GOOD);
    nb.dismissServerSwitchPrompt(nb.getServerSwitchPrompt().id);
    expect(nb.getServerSwitchPrompt()).toBeNull();
    expect(SC.save).not.toHaveBeenCalled();
    expect(SC.restart).not.toHaveBeenCalled();
  });

  test('★ nothing contacts the requested server before Switch: the only request is /about on the server on screen', async () => {
    localStorage.setItem('nightlight_token', 't');
    const SC = stubNative({ servers: [GOOD] });
    expect(await nb.requestServerSwitch(GOOD)).toBe('asked');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/about'); // relative: the server already loaded
    for (const [url] of fetchSpy.mock.calls) expect(String(url)).not.toContain('good.example');
    expect(SC.save).not.toHaveBeenCalled(); // save() is what health-checks the new server
  });

  test('the server on screen needs no dialog, however it is spelled', async () => {
    const SC = stubNative({ servers: [GOOD] });
    for (const spelling of [CURRENT, `${CURRENT}/`, CURRENT.toUpperCase()]) {
      expect(await nb.requestServerSwitch(spelling)).toBe('same');
    }
    expect(nb.getServerSwitchPrompt()).toBeNull();
    expect(SC.list).not.toHaveBeenCalled();
  });

  test('★ the address the server on screen gives out in its links is that server: no dialog', async () => {
    localStorage.setItem('nightlight_token', 't');
    advertised = 'https://public.example';
    const SC = stubNative({ servers: [] }); // the phone saved the server only by its other address
    expect(await nb.requestServerSwitch('https://PUBLIC.example/')).toBe('same');
    expect(nb.getServerSwitchPrompt()).toBeNull();
    expect(SC.save).not.toHaveBeenCalled();
  });

  test('the advertised address is matched exactly: a near miss of it is still refused', async () => {
    localStorage.setItem('nightlight_token', 't');
    advertised = 'https://public.example';
    stubNative({ servers: [] });
    expect(await nb.requestServerSwitch('https://public.example.')).toBe('refused');
    expect(await nb.requestServerSwitch('http://public.example')).toBe('refused');
  });

  test('without a sign-in token the server is not asked (the route would refuse) and the request is judged on the list', async () => {
    advertised = 'https://public.example';
    stubNative({ servers: [] });
    expect(await nb.requestServerSwitch('https://public.example')).toBe('refused');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('an unusable address is ignored: no dialog, no lookup', async () => {
    const SC = stubNative({ servers: [GOOD] });
    expect(await nb.requestServerSwitch('https://good.example/path')).toBe('invalid');
    expect(await nb.requestServerSwitch('javascript:alert(1)')).toBe('invalid');
    expect(nb.getServerSwitchPrompt()).toBeNull();
    expect(SC.list).not.toHaveBeenCalled();
  });

  test('outside the native app there is nothing to switch to', async () => {
    expect(await nb.requestServerSwitch(GOOD)).toBe('unavailable');
    expect(nb.getServerSwitchPrompt()).toBeNull();
  });

  test('a saved list that cannot be read refuses rather than guesses', async () => {
    const SC = stubNative({ servers: [GOOD] });
    SC.list.mockRejectedValue(new Error('not implemented'));
    expect(await nb.requestServerSwitch(GOOD)).toBe('refused');
  });

  test('★ two requests in a row: the newer replaces the older, and the older can no longer switch', async () => {
    const SC = stubNative({ servers: [GOOD] });
    expect(await nb.requestServerSwitch(GOOD)).toBe('asked');
    const older = nb.getServerSwitchPrompt();
    expect(await nb.requestServerSwitch('https://other.example')).toBe('refused');
    expect(nb.getServerSwitchPrompt()).toMatchObject({ kind: 'refused', origin: 'https://other.example' });
    expect(await nb.confirmServerSwitch(older.id)).toBe(false);
    nb.dismissServerSwitchPrompt(older.id); // a late close from the old dialog
    expect(nb.getServerSwitchPrompt()).toMatchObject({ origin: 'https://other.example' }); // must not close the new one
    expect(SC.save).not.toHaveBeenCalled();
  });

  test('★ an older request whose lookup finishes LAST does not replace the newer one', async () => {
    const SC = stubNative({ servers: [GOOD] });
    let releaseOld;
    SC.list
      .mockImplementationOnce(() => new Promise((r) => { releaseOld = () => r({ servers: [GOOD] }); }))
      .mockResolvedValue({ servers: [GOOD] });
    const older = nb.requestServerSwitch(GOOD);
    expect(await nb.requestServerSwitch('https://other.example')).toBe('refused');
    releaseOld();
    expect(await older).toBe('superseded');
    expect(nb.getServerSwitchPrompt()).toMatchObject({ kind: 'refused', origin: 'https://other.example' });
  });

  test('a newer request that needs no dialog closes the older dialog', async () => {
    stubNative({ servers: [GOOD] });
    await nb.requestServerSwitch(GOOD);
    expect(await nb.requestServerSwitch(CURRENT)).toBe('same');
    expect(nb.getServerSwitchPrompt()).toBeNull();
  });
});

describe('★ switchServer checks the saved list itself', () => {
  test('★ a caller that skips the dialog still cannot switch to an unsaved server, and nothing is torn down', async () => {
    const SC = stubNative({ servers: ['http://good.example', 'https://good.example.evil'] });
    expect(await nb.switchServer(GOOD)).toBe(false);
    expect(SC.save).not.toHaveBeenCalled();
    expect(window.Capacitor.Plugins.BackgroundAudio.stop).not.toHaveBeenCalled();
  });

  test('a saved server switches, with the stored string', async () => {
    const SC = stubNative({ servers: ['https://good.example:443'] });
    expect(await nb.switchServer('https://GOOD.example/')).toBe(true);
    expect(SC.save).toHaveBeenCalledWith({ url: 'https://good.example:443' });
    expect(SC.restart).toHaveBeenCalledTimes(1);
  });

  test('the server on screen, or an unusable address, is not a switch', async () => {
    const SC = stubNative({ servers: [CURRENT, 'https://good.example/path'] });
    expect(await nb.switchServer(CURRENT)).toBe(false);
    expect(await nb.switchServer('https://good.example/path')).toBe(false);
    expect(SC.save).not.toHaveBeenCalled();
  });

  test('a saved server that does not answer: no restart, and false', async () => {
    const SC = stubNative({ servers: [GOOD] });
    SC.save.mockRejectedValue(new Error('unreachable'));
    expect(await nb.switchServer(GOOD)).toBe(false);
    expect(SC.restart).not.toHaveBeenCalled();
  });
});

describe('★ takePendingServerRequest: the request the native shell is holding', () => {
  test('★ an app without takePending (iOS, older versions) rejects: that is "nothing pending", not an error', async () => {
    const SC = stubNative({ servers: [GOOD], takePending: vi.fn().mockRejectedValue(new Error('not implemented')) });
    await expect(nb.takePendingServerRequest()).resolves.toBeNull();
    expect(nb.getServerSwitchPrompt()).toBeNull();
    expect(SC.list).not.toHaveBeenCalled();
  });

  test('a plugin with no such method at all is the same', async () => {
    const SC = stubNative({ servers: [GOOD] });
    delete SC.takePending;
    await expect(nb.takePendingServerRequest()).resolves.toBeNull();
  });

  test('nothing held: nothing asked', async () => {
    const SC = stubNative({ servers: [GOOD] });
    expect(await nb.takePendingServerRequest()).toBeNull();
    expect(SC.list).not.toHaveBeenCalled();
  });

  test('a held request goes through the same check', async () => {
    stubNative({ servers: [GOOD], takePending: vi.fn().mockResolvedValue({ server: `${GOOD}/` }) });
    expect(await nb.takePendingServerRequest()).toBe('asked');
    expect(nb.getServerSwitchPrompt()).toMatchObject({ kind: 'confirm', origin: GOOD, entry: GOOD });
  });
});
