// The push-notification hub and the three provider pages behind it (Pushover, Gotify, Firebase).
// ntfy lives in settingsSecrets.test.jsx with the other secret-bearing screens.
//
// ★ WHY THESE TOGETHER, AND WHY THEY ARE NOT INTERCHANGEABLE. Four screens that look like one screen
// four times, and the reason to test them as a set is that they QUIETLY DISAGREE with each other. The
// temptation when adding a fifth provider is to copy the nearest page; these tests pin what each one
// actually does so a copy inherits the right convention rather than a plausible one:
//
//   * blank-secret-on-save: MQTT OMITS the key, ntfy's token is SENT EMPTY, Pushover sends BOTH
//     secrets empty, Gotify sends its one token empty. All four mean "keep", via different routes.
//   * ⚠️ Pushover's `device` sits on the same form as its two secrets and has the OPPOSITE rule:
//     blank means CLEAR IT (alert every device), not keep. That is stated in the route and it is the
//     single most surprising thing on any of these pages.
//   * the Send test button is gated on `configured` (Pushover, Gotify) — ntfy's is not.
//   * Firebase has no secret at all: its credentials are files on disk, so the page is a switch, and
//     "not configured" is a thing the SERVER tells it rather than something a form can fix.
//
// Role gating is not tested here: every one of these routes is <AdminProtected> (routeGuards.test.jsx).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsPush from '../src/pages/SettingsPush.jsx';
import SettingsPushPushover from '../src/pages/SettingsPushPushover.jsx';
import SettingsPushGotify from '../src/pages/SettingsPushGotify.jsx';
import SettingsPushFirebase from '../src/pages/SettingsPushFirebase.jsx';
import { api } from '../src/lib/api.js';

let putSpy;
let postSpy;

afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------------------------
describe('the push hub', () => {
  // Every provider the hub offers. Listed in full on purpose: a hub that silently drops a provider
  // makes that provider unreachable — there is no other route to it in the UI — and nothing else in
  // the app would notice.
  const PROVIDERS = ['Pushover', 'Firebase', 'Gotify', 'ntfy'];

  const mockStatus = (status) => vi.spyOn(api, 'get').mockResolvedValue(status);
  const ALL_OFF = {
    pushover: { enabled: false, configured: false },
    firebase: { enabled: false, configured: false },
    gotify: { enabled: false, configured: false },
    ntfy: { enabled: false, configured: false },
  };

  // Scope every badge assertion to its own row. A badge asserted globally passes when it is hanging
  // off the WRONG provider, which would tell someone Pushover is on when it is actually ntfy — worse
  // than showing no badge at all. (Same trap the MQTT badge hit in settingsHub.test.jsx.)
  const row = async (label) => within((await screen.findByText(label)).closest('.list-row'));

  test('offers every provider', async () => {
    mockStatus(ALL_OFF);
    renderAsAdmin(<SettingsPush />);
    for (const p of PROVIDERS) expect(await screen.findByText(p)).toBeTruthy();
  });

  test('★ the badge says On for enabled, Off for configured-but-disabled, and NOTHING for untouched',
    async () => {
      // The three states are the whole point of the hub: it exists so someone can see at a glance
      // which providers are live. "Off" and "no badge" are deliberately different — "Off" means
      // credentials are saved and someone turned it off, while a blank row means never set up. A
      // provider that has never been configured must not read as though it was switched off.
      mockStatus({
        pushover: { enabled: true, configured: true },
        firebase: { enabled: false, configured: true },
        gotify: { enabled: false, configured: false },
        ntfy: { enabled: false, configured: false },
      });
      renderAsAdmin(<SettingsPush />);

      await waitFor(async () => expect((await row('Pushover')).getByText('On')).toBeTruthy());
      expect((await row('Firebase')).getByText('Off')).toBeTruthy();
      expect((await row('Gotify')).queryByText('Off')).toBeNull();
      expect((await row('Gotify')).queryByText('On')).toBeNull();
      expect((await row('ntfy')).queryByText('Off')).toBeNull();
    });

  test('an enabled provider reads On even if the server also calls it unconfigured', async () => {
    // Order matters in badgeFor: `enabled` is checked first. The states are not meant to overlap, but
    // if they ever do, "On" is the truthful answer — the server is what decides whether it delivers.
    mockStatus({ ...ALL_OFF, gotify: { enabled: true, configured: false } });
    renderAsAdmin(<SettingsPush />);
    await waitFor(async () => expect((await row('Gotify')).getByText('On')).toBeTruthy());
  });

  test('a failed status lookup leaves the hub usable, with no badges', async () => {
    // The rows are static, so asserting they render would pass with the rejection unhandled. Wait for
    // the request to have settled first, then assert both halves: still navigable, and not guessing.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('offline'));
    renderAsAdmin(<SettingsPush />);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/notifications/status'));
    for (const p of PROVIDERS) expect(screen.getByText(p)).toBeTruthy();
    expect(screen.queryByText('On')).toBeNull();
    expect(screen.queryByText('Off')).toBeNull();
  });

  describe('navigating into a provider', () => {
    // A real route table with a probe at the far end, rather than a mocked useNavigate: this asserts
    // the destination actually RESOLVES, which a spy on the navigate call cannot tell you.
    //
    // ⚠️ Deliberately NOT asserted: the `{ state: { from } }` the hub passes. Every provider page
    // declares the same parent as its own BackLink fallback, so the state changes nothing you can
    // observe — pinning it would be pinning an implementation detail, and a test that cannot fail is
    // worse than no test. If a provider is ever reachable from somewhere else, that is the moment the
    // state starts to matter and the moment to test it.
    const Probe = () => <div>at {useLocation().pathname}</div>;

    const mountHub = () =>
      renderAsAdmin(
        <Routes>
          <Route path="/settings/push" element={<SettingsPush />} />
          <Route path="*" element={<Probe />} />
        </Routes>,
        { route: '/settings/push' }
      );

    test('each row leads to its own provider page', async () => {
      mockStatus(ALL_OFF);
      const { user } = mountHub();
      await user.click(await screen.findByText('Pushover'));
      expect(await screen.findByText('at /settings/push/pushover')).toBeTruthy();
    });

    test('★ a row is reachable from the keyboard, not just the mouse', async () => {
      // The rows are <div role="button" tabIndex={0}>, so keyboard support is hand-written and can
      // simply be dropped without anything looking wrong. Without it these settings are unreachable
      // for anyone not using a pointer — an accessibility failure that renders perfectly.
      mockStatus(ALL_OFF);
      const { user } = mountHub();
      const first = (await screen.findByText('Pushover')).closest('.list-row');
      // Two tabs, not one: the header's own back button is the first thing in the order. Asserting
      // where focus LANDS is what makes this a reachability test — `tabIndex={0}` is the only reason
      // a div is in the tab order at all, and without it focus would simply skip every provider.
      await user.tab();
      await user.tab();
      expect(first, 'the first provider row must be reachable by tabbing').toBe(document.activeElement);
      await user.keyboard('{Enter}');
      expect(await screen.findByText('at /settings/push/pushover')).toBeTruthy();
    });

    test('Space activates a row too, without scrolling the page', async () => {
      // Space is the other half of the button contract, and it needs preventDefault or the page
      // scrolls as it navigates.
      mockStatus(ALL_OFF);
      const { user } = mountHub();
      const firebase = await screen.findByText('Firebase');
      const target = firebase.closest('.list-row');
      target.focus();
      const before = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      target.dispatchEvent(before);
      expect(before.defaultPrevented, 'Space must be prevented or the page scrolls').toBe(true);
      await user.keyboard(' ');
      expect(await screen.findByText('at /settings/push/firebase')).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Pushover
// ---------------------------------------------------------------------------------------------
describe('Pushover settings', () => {
  const CONFIG = {
    enabled: true,
    configured: true,
    app_token_set: true,
    app_token_masked: 'a1b…c3d',
    user_key_set: true,
    user_key_masked: 'u1v…w3x',
    device: 'nachos-phone',
  };

  function mockPushover(config = CONFIG) {
    vi.spyOn(api, 'get').mockResolvedValue(config);
    putSpy = vi.spyOn(api, 'put').mockResolvedValue(config);
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({ ok: true });
  }

  beforeEach(() => mockPushover());

  const save = async (user) => {
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    return putSpy.mock.calls[0][1];
  };

  test('loads the config with both secrets blank and their masked previews shown', async () => {
    renderAsAdmin(<SettingsPushPushover />);
    const token = await screen.findByLabelText('Application API token');
    expect(token.value, 'a saved token is never sent to the browser').toBe('');
    expect(screen.getByLabelText('User or group key').value).toBe('');
    // The masks are the only evidence either secret is stored — without them the empty boxes read as
    // "nothing set here", which invites someone to overwrite a working credential.
    expect(screen.getByText('a1b…c3d')).toBeTruthy();
    expect(screen.getByText('u1v…w3x')).toBeTruthy();
  });

  test('★★ saving without retyping sends both secrets EMPTY, which the route reads as keep', async () => {
    // Pushover's convention, and it is not MQTT's: MQTT omits the key entirely, this page always sends
    // both. Both are accepted today, so nothing fails if they are confused — until one side changes
    // and a routine edit to the device name silently wipes an app token.
    const { user } = renderAsAdmin(<SettingsPushPushover />);
    await screen.findByLabelText('Application API token');
    const body = await save(user);
    expect(body.app_token).toBe('');
    expect(body.user_key).toBe('');
  });

  test('★★ the device is ALWAYS sent, because here blank means CLEAR — not keep', async () => {
    // The asymmetry on this form. `device` is not a secret, so it round-trips in the clear and the
    // route saves exactly what arrives: submitting a blank device is how you go back to alerting all
    // your devices. If this page ever omitted a blank device the way MQTT omits a blank password,
    // clearing it would become impossible and the field would look broken with no error.
    vi.restoreAllMocks();
    mockPushover({ ...CONFIG, device: '' });
    const { user } = renderAsAdmin(<SettingsPushPushover />);
    await screen.findByLabelText(/^Device/);
    const body = await save(user);
    expect(body, 'a blank device must still be sent, or it can never be cleared').toHaveProperty('device', '');
  });

  test('an edited device reaches the payload', async () => {
    const { user } = renderAsAdmin(<SettingsPushPushover />);
    const device = await screen.findByLabelText(/^Device/);
    await user.clear(device);
    await user.type(device, 'kitchen-tablet');
    const body = await save(user);
    expect(body.device).toBe('kitchen-tablet');
  });

  test('typed secrets are sent, and both fields clear afterwards', async () => {
    // Clearing after a successful save is not cosmetic: the boxes now mean "leave blank to keep", so
    // leaving the typed values in them would resend them on the next save and put a live secret on
    // screen in the meantime.
    const { user } = renderAsAdmin(<SettingsPushPushover />);
    await user.type(await screen.findByLabelText('Application API token'), 'atoken123');
    await user.type(screen.getByLabelText('User or group key'), 'ukey456');
    const body = await save(user);
    expect(body.app_token).toBe('atoken123');
    expect(body.user_key).toBe('ukey456');
    await waitFor(() => expect(screen.getByLabelText('Application API token').value).toBe(''));
    expect(screen.getByLabelText('User or group key').value).toBe('');
  });

  test('the enable switch is sent as a boolean', async () => {
    const { user } = renderAsAdmin(<SettingsPushPushover />);
    await user.click(await screen.findByRole('switch'));
    const body = await save(user);
    expect(body.enabled).toBe(false);
  });

  test('★ a rejected save shows the reason and does not claim success', async () => {
    // The reason is load-bearing here more than on most screens: enabling Pushover makes the server
    // validate the tokens with Pushover itself, so this banner is where "your user key is invalid"
    // arrives. A generic failure would leave someone re-pasting a token that was never the problem.
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue({ ...CONFIG, enabled: false });
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('user key is invalid'));
    const { user } = renderAsAdmin(<SettingsPushPushover />);
    await screen.findByLabelText('Application API token');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('user key is invalid')).toBeTruthy();
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });

  test('★ Send test is refused until the server says it is configured', async () => {
    // Gated on the server's `configured`, not on the form: the test sends with the SAVED config, so
    // offering it against unsaved boxes would produce a confusing failure about credentials the
    // person can see on their screen. (ntfy does not gate its test button — the pages differ.)
    vi.restoreAllMocks();
    mockPushover({ ...CONFIG, configured: false, app_token_set: false, user_key_set: false });
    renderAsAdmin(<SettingsPushPushover />);
    await screen.findByLabelText('Application API token');
    expect(screen.getByRole('button', { name: /Send test/i }).disabled).toBe(true);
  });

  test('sending a test reports success', async () => {
    const { user } = renderAsAdmin(<SettingsPushPushover />);
    await screen.findByLabelText('Application API token');
    await user.click(screen.getByRole('button', { name: /Send test/i }));
    await waitFor(() => expect(postSpy).toHaveBeenCalledWith('/pushover/test'));
    expect(await screen.findByText(/Test sent/i)).toBeTruthy();
  });

  test('a failed test reports the reason rather than a generic failure', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue(CONFIG);
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Pushover: application token is invalid'));
    const { user } = renderAsAdmin(<SettingsPushPushover />);
    await screen.findByLabelText('Application API token');
    await user.click(screen.getByRole('button', { name: /Send test/i }));
    expect(await screen.findByText('Pushover: application token is invalid')).toBeTruthy();
  });

  test('★ stays usable when the config endpoint fails — the first-time setup case', async () => {
    // Every control is `disabled={busy || !loaded}`, and the catch that sets `loaded` is the only
    // reason a failed load does not leave the page permanently greyed out. Asserting the field renders
    // passes with that catch removed (it renders either way); asserting the button is USABLE is the
    // claim that actually discriminates.
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockRejectedValue(new Error('not configured'));
    renderAsAdmin(<SettingsPushPushover />);
    expect(await screen.findByLabelText('Application API token')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' }).disabled).toBe(false));
  });
});

// ---------------------------------------------------------------------------------------------
// Gotify
// ---------------------------------------------------------------------------------------------
describe('Gotify settings', () => {
  const CONFIG = {
    enabled: true,
    configured: true,
    server_url: 'https://gotify.example.com',
    app_token_set: true,
    app_token_masked: 'A1b…z9',
    priority: 7,
  };

  function mockGotify(config = CONFIG) {
    vi.spyOn(api, 'get').mockResolvedValue(config);
    putSpy = vi.spyOn(api, 'put').mockResolvedValue(config);
    postSpy = vi.spyOn(api, 'post').mockResolvedValue({ ok: true });
  }

  beforeEach(() => mockGotify());

  test('loads the stored server, priority and masked token', async () => {
    renderAsAdmin(<SettingsPushGotify />);
    expect((await screen.findByLabelText('Server URL')).value).toBe('https://gotify.example.com');
    expect(screen.getByLabelText('Priority (0–10)').value).toBe('7');
    expect(screen.getByLabelText('Application token').value).toBe('');
    expect(screen.getByText('A1b…z9')).toBeTruthy();
  });

  test('★★ a stored priority of ZERO survives, because 0 is in range here', async () => {
    // The documented range is 0–10, so 0 is a real choice — "deliver quietly" — not an absent value.
    // The default is written `priority ?? 5`; a single `||` would show 5 to somebody who deliberately
    // chose 0, and then SAVE that 5 back. Same class as the retention-zero trap on the Recording page.
    vi.restoreAllMocks();
    mockGotify({ ...CONFIG, priority: 0 });
    renderAsAdmin(<SettingsPushGotify />);
    expect((await screen.findByLabelText('Priority (0–10)')).value).toBe('0');
  });

  test('offers 5 when the server sends no priority at all', async () => {
    vi.restoreAllMocks();
    mockGotify({ ...CONFIG, priority: undefined });
    renderAsAdmin(<SettingsPushGotify />);
    expect((await screen.findByLabelText('Priority (0–10)')).value).toBe('5');
  });

  test('the priority input enforces the documented 0–10 range', async () => {
    renderAsAdmin(<SettingsPushGotify />);
    const p = await screen.findByLabelText('Priority (0–10)');
    expect(p.getAttribute('min')).toBe('0');
    expect(p.getAttribute('max')).toBe('10');
  });

  test('★ saves exactly the four fields the screen edits', async () => {
    // Asserted as an exact key set: a field added to the form but forgotten in this hand-written
    // payload would appear to save and silently never persist.
    const { user } = renderAsAdmin(<SettingsPushGotify />);
    await screen.findByLabelText('Server URL');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const [path, body] = putSpy.mock.calls[0];
    expect(path).toBe('/gotify/config');
    expect(Object.keys(body).sort()).toEqual(['app_token', 'enabled', 'priority', 'server_url']);
    expect(body.app_token, 'an untouched token is sent empty, which the route reads as keep').toBe('');
  });

  test('a typed token is sent and the field clears afterwards', async () => {
    const { user } = renderAsAdmin(<SettingsPushGotify />);
    await user.type(await screen.findByLabelText('Application token'), 'AnewToken');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].app_token).toBe('AnewToken');
    await waitFor(() => expect(screen.getByLabelText('Application token').value).toBe(''));
  });

  test('★★ no field accepts typing before the config arrives to overwrite it', async () => {
    // REGRESSION TEST. The load handler replaces the WHOLE form object, so any field left editable
    // during the fetch loses whatever was typed into it the moment the response lands — the user sees
    // their own text vanish with no error and no clue why. The switch and the token were
    // `disabled={busy || !loaded}`; Server URL and Priority were not, so those two had the hole.
    //
    // Asserted over EVERY control rather than the two that were broken: the defect is a missing guard,
    // and the next field added to this form can be added without it just as easily. This is the same
    // failure the repo already hit from the other direction, when a context value arriving a moment
    // after boot destroyed a user's typing (see helpers/render.jsx).
    vi.restoreAllMocks();
    let resolveConfig;
    vi.spyOn(api, 'get').mockReturnValue(new Promise((r) => { resolveConfig = r; }));
    putSpy = vi.spyOn(api, 'put').mockResolvedValue(CONFIG);

    const { user } = renderAsAdmin(<SettingsPushGotify />);
    const LABELS = ['Server URL', 'Priority (0–10)', 'Application token'];
    for (const label of LABELS) {
      expect(screen.getByLabelText(label).disabled, `${label} must not accept input it is about to throw away`).toBe(true);
    }
    expect(screen.getByRole('switch').disabled).toBe(true);

    // Once the config lands the form is editable, and what is typed then stays put.
    resolveConfig({ ...CONFIG, server_url: 'https://stored.example.com' });
    for (const label of LABELS) {
      await waitFor(() => expect(screen.getByLabelText(label).disabled).toBe(false));
    }
    await user.clear(screen.getByLabelText('Server URL'));
    await user.type(screen.getByLabelText('Server URL'), 'https://typed.example.com');
    expect(screen.getByLabelText('Server URL').value).toBe('https://typed.example.com');
  });

  test('★ Send test is refused until the server says it is configured', async () => {
    vi.restoreAllMocks();
    mockGotify({ ...CONFIG, configured: false });
    renderAsAdmin(<SettingsPushGotify />);
    await screen.findByLabelText('Server URL');
    expect(screen.getByRole('button', { name: /Send test/i }).disabled).toBe(true);
  });

  test('a failed test reports the reason', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue(CONFIG);
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Gotify returned 401'));
    const { user } = renderAsAdmin(<SettingsPushGotify />);
    await screen.findByLabelText('Server URL');
    await user.click(screen.getByRole('button', { name: /Send test/i }));
    expect(await screen.findByText('Gotify returned 401')).toBeTruthy();
  });

  test('a failed save says so and does not claim success', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockResolvedValue(CONFIG);
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('Server URL is not reachable'));
    const { user } = renderAsAdmin(<SettingsPushGotify />);
    await screen.findByLabelText('Server URL');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Server URL is not reachable')).toBeTruthy();
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });

  test('★ stays usable when the config endpoint fails', async () => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockRejectedValue(new Error('not configured'));
    renderAsAdmin(<SettingsPushGotify />);
    expect(await screen.findByLabelText('Application token')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' }).disabled).toBe(false));
  });
});

// ---------------------------------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------------------------------
describe('Firebase settings', () => {
  // The odd one out: no secret to type, because the credentials are two JSON files dropped into the
  // data directory. So the only thing this page can get wrong is telling the user something untrue
  // about a state they cannot see from here.
  const mockPush = (status) => {
    vi.spyOn(api, 'get').mockResolvedValue(status);
    putSpy = vi.spyOn(api, 'put').mockResolvedValue(status);
  };

  test('the switch reflects what the server reports', async () => {
    mockPush({ push_enabled: true, configured: true });
    renderAsAdmin(<SettingsPushFirebase />);
    await waitFor(() => expect(screen.getByRole('switch').checked).toBe(true));
  });

  test('saving sends the toggle to /push/enable', async () => {
    mockPush({ push_enabled: false, configured: true });
    putSpy = vi.spyOn(api, 'put').mockResolvedValue({ push_enabled: true, configured: true });
    const { user } = renderAsAdmin(<SettingsPushFirebase />);
    await waitFor(() => expect(screen.getByRole('switch').disabled).toBe(false));
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/push/enable', { enabled: true }));
    await waitFor(() => expect(screen.getByRole('switch').checked).toBe(true));
  });

  test('★★ a rejected save puts the switch BACK and says why', async () => {
    // The failure that would otherwise be actively misleading. Turning Firebase on makes the server
    // validate the credential files and 400 if they are missing — so this is the ORDINARY path for
    // anyone who has not dropped the files in yet, not an edge case. If the switch stayed on, the
    // screen would read "notifications enabled" while nothing can ever be delivered, and the error
    // banner would look like a transient blip rather than the reason the switch did not take.
    mockPush({ push_enabled: false, configured: false });
    putSpy = vi.spyOn(api, 'put').mockRejectedValue(new Error('firebase-service-account.json is missing'));
    const { user } = renderAsAdmin(<SettingsPushFirebase />);
    await waitFor(() => expect(screen.getByRole('switch').disabled).toBe(false));
    await user.click(screen.getByRole('switch'));
    expect(screen.getByRole('switch').checked, 'the toggle moves optimistically').toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('firebase-service-account.json is missing')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('switch').checked).toBe(false));
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });

  test('★ the missing-files hint appears only when the server says it is unconfigured', async () => {
    mockPush({ push_enabled: false, configured: false });
    renderAsAdmin(<SettingsPushFirebase />);
    expect(await screen.findByText(/files aren.{0,3}t detected/i)).toBeTruthy();
  });

  test('and never when it IS configured', async () => {
    mockPush({ push_enabled: false, configured: true });
    renderAsAdmin(<SettingsPushFirebase />);
    await waitFor(() => expect(screen.getByRole('switch').disabled).toBe(false));
    expect(screen.queryByText(/files aren.{0,3}t detected/i)).toBeNull();
  });

  test('★★ and NOT before the status has arrived — a guess here reads as a fact', async () => {
    // `pushStatus && !pushStatus.configured` — the first half is what stops a page that knows nothing
    // yet from telling a perfectly well-configured install that its credential files are missing.
    // Dropping it would put that claim on screen for every visitor on every load, briefly and
    // convincingly, and it is exactly the kind of message someone acts on.
    let resolveStatus;
    vi.spyOn(api, 'get').mockReturnValue(new Promise((r) => { resolveStatus = r; }));
    renderAsAdmin(<SettingsPushFirebase />);
    expect(screen.getByRole('switch').disabled, 'nothing is operable until the status lands').toBe(true);
    expect(screen.queryByText(/files aren.{0,3}t detected/i)).toBeNull();

    resolveStatus({ push_enabled: true, configured: true });
    await waitFor(() => expect(screen.getByRole('switch').disabled).toBe(false));
    expect(screen.queryByText(/files aren.{0,3}t detected/i)).toBeNull();
  });

  test('★★ a failed status lookup SAYS so instead of leaving a dead page', async () => {
    // REGRESSION TEST. This page has no `loaded` flag of its own: `pushStatus` is both the data and
    // the ready signal, so a rejected lookup leaves it null and every control disabled forever. That
    // much is deliberate and is the SAFER half of the choice — the alternative, defaulting the status,
    // would make the page assert "your Firebase files aren't detected" on no evidence at all.
    //
    // What was NOT deliberate is that the rejection was swallowed entirely, so the page sat greyed out
    // with nothing on screen to explain it and nothing to do but guess. The error is now surfaced. The
    // page stays disabled — that part is the design, and this test pins BOTH halves so a later "fix"
    // cannot quietly turn the dead page into a confident wrong claim.
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Network request failed'));
    renderAsAdmin(<SettingsPushFirebase />);
    expect(await screen.findByText('Network request failed')).toBeTruthy();
    expect(screen.getByRole('switch').disabled).toBe(true);
    expect(screen.queryByText(/files aren.{0,3}t detected/i), 'unknown is not the same as unconfigured').toBeNull();
  });
});
