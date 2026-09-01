// General settings — the app's name, its timezone, and its colours.
//
// ★ WHY THIS SCREEN. The timezone lives here, and the timezone is the single setting in this app that
// most decides whether it works for somebody else. `settings.timezone` is what sleep analysis anchors
// every night on; get it wrong and a household sees a night that never happened. This repo has already
// shipped a window anchored on a literal `04:00Z`, which is midday only in Melbourne.
//
// The picker has a specific protection built into it — it keeps a stored zone that is NOT in the list
// it offers — and that protection is invisible until somebody in an unlisted zone opens this page.
// Nothing else tests it.
//
// Role gating is not tested here: the route is <AdminProtected> (routeGuards.test.jsx).
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsGeneral from '../src/pages/SettingsGeneral.jsx';
import { api } from '../src/lib/api.js';

let putSpy;

function mockApi({ putFails = null } = {}) {
  putSpy = vi.spyOn(api, 'put').mockImplementation(() =>
    putFails ? Promise.reject(new Error(putFails)) : Promise.resolve({})
  );
}

const renderWith = (settings = {}) => renderAsAdmin(<SettingsGeneral />, { settings });

beforeEach(() => mockApi());
afterEach(() => vi.restoreAllMocks());

describe('★ the timezone picker does not lose an unlisted zone', () => {
  // Zones `Intl.supportedValuesOf('timeZone')` does NOT return. Both are real and both matter:
  // 'UTC' is the app's own DEFAULT (db.js), so every fresh install lands on this path; 'Etc/GMT+5' is
  // the legacy-alias shape — an install can hold a zone the browser's list has since dropped.
  //
  // ⚠️ Choose these by CHECKING, not by looking exotic. This test first used 'Antarctica/Troll', which
  // sounds obscure and is in the list — so the option came from the map, the fallback was never
  // exercised, and the test asserted nothing its name claimed. Mutation testing caught it: deleting
  // the fallback entirely left the test green.
  test.each(['UTC', 'Etc/GMT+5'])(
    'a stored timezone the list does not offer (%s) is still shown, and still selected',
    async (zone) => {
      // THE test this file exists for. Without the extra <option> this component renders for that
      // case, the select has nothing matching its value, falls back to its first entry, and the next
      // Save silently moves the whole household to a different timezone. Nothing reports an error —
      // the nights just start being wrong, which is the failure this app can least afford.
      renderWith({ timezone: zone });
      const select = await screen.findByLabelText('Timezone');
      expect(select.value, 'the stored zone must survive being rendered').toBe(zone);
      expect(
        [...select.options].some((o) => o.value === zone),
        'an unlisted zone needs an option of its own or it cannot be the selected one'
      ).toBe(true);
    }
  );

  test('a LISTED timezone is offered exactly once, not duplicated by that fallback', async () => {
    // The other half: the extra option is conditional, so a zone already in the list must not appear
    // twice. A duplicate would be harmless to save but reads as a broken dropdown.
    //
    // ⚠️ It has to be a zone the list really contains, and 'UTC' is NOT one — `Intl.supportedValuesOf`
    // returns 418 IANA zones and UTC is not among them. Written with 'UTC' first, this test could not
    // fail: that zone takes the unlisted-option path too, so the mutant that renders the extra option
    // unconditionally produced the same single option and survived. Caught by mutation testing.
    //
    // ★ Worth knowing beyond this test: `settings.timezone` DEFAULTS to 'UTC', so every fresh install
    // reaches this screen on the unlisted path. The fallback option above is not an edge case for
    // unusual households — it is what the default install depends on.
    renderWith({ timezone: 'Australia/Melbourne' });
    const select = await screen.findByLabelText('Timezone');
    const matching = [...select.options].filter((o) => o.value === 'Australia/Melbourne');
    expect(matching).toHaveLength(1);
    expect(select.value).toBe('Australia/Melbourne');
  });

  test('"Use this device\'s timezone" fills in the browser zone without saving', async () => {
    // A convenience, not a commitment: it fills the field so the value can be reviewed, and Save is
    // still what writes it. The suite pins TZ to Pacific/Auckland (see vite.config.js), so that is what
    // the browser resolves to here — which is also why this assertion is deterministic at all.
    const { user } = renderWith({ timezone: 'UTC' });
    await user.click(await screen.findByRole('button', { name: "Use this device's timezone" }));

    expect(screen.getByLabelText('Timezone').value).toBe('Pacific/Auckland');
    expect(putSpy, 'filling the field must not write anything').not.toHaveBeenCalled();
  });

  test('the chosen timezone is what gets saved', async () => {
    const { user } = renderWith({ timezone: 'UTC', app_name: 'Nightlight' });
    await user.selectOptions(await screen.findByLabelText('Timezone'), 'Australia/Melbourne');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].timezone).toBe('Australia/Melbourne');
  });
});

describe('the app name', () => {
  test('renders the stored name and saves an edited one', async () => {
    const { user } = renderWith({ app_name: 'Nightlight' });
    const field = await screen.findByLabelText('App name');
    expect(field.value).toBe('Nightlight');

    await user.clear(field);
    await user.type(field, 'Nursery');
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].app_name).toBe('Nursery');
  });

  test('★ stays a controlled input when settings arrive after the first render', async () => {
    // `form.app_name || ''` exists for the moment this screen paints BEFORE the settings context has
    // resolved — which is the normal case, not an edge one. Without the fallback the input starts
    // uncontrolled (value undefined) and becomes controlled when the real name arrives, which React
    // treats as a bug: it warns, and the field can drop what someone had already typed. The render
    // helper carries a note about exactly this transition destroying a user's typing once.
    //
    // ⚠️ Asserted through React's own warning rather than through `.value`. My first version checked
    // that the box was empty — but an UNCONTROLLED input also reads as empty, so it passed with the
    // fallback removed. Mutation testing caught it; this version fails without the fallback.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerenderWith } = renderWith({ app_name: undefined });
    expect((await screen.findByLabelText('App name')).value).toBe('');

    rerenderWith({ settings: { app_name: 'Nightlight' } });
    await waitFor(() => expect(screen.getByLabelText('App name').value).toBe('Nightlight'));

    const complaints = warn.mock.calls.map((c) => String(c[0])).filter((m) => /uncontrolled|controlled/i.test(m));
    expect(complaints, `React complained: ${complaints[0] || ''}`).toHaveLength(0);
  });
});

describe('theme presets', () => {
  test('a preset sets all three colours at once', async () => {
    // The three are chosen to work together; applying one without the others leaves a palette nobody
    // designed. Asserted through the payload because that is where the combination has to survive.
    const { user } = renderWith({ accent_color: '#000000', live_color: '#000000', offline_color: '#000000' });
    await user.click(await screen.findByRole('button', { name: /Dusk lavender/ }));
    await user.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const body = putSpy.mock.calls[0][1];
    expect(body.accent_color).toBe('#C9B6F5');
    expect(body.live_color).toBe('#7FBFA3');
    expect(body.offline_color).toBe('#E08585');
  });
});

describe('saving', () => {
  test('a failed save shows the reason and does not claim success', async () => {
    vi.restoreAllMocks();
    mockApi({ putFails: 'Timezone is not recognised' });
    const { user } = renderWith({ app_name: 'Nightlight' });
    await user.click(await screen.findByRole('button', { name: /Save/ }));

    expect(await screen.findByText('Timezone is not recognised')).toBeTruthy();
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });

  test('★ does NOT write the on-demand settings, which live on the Recording page', async () => {
    // This screen used to post ondemand_enabled, ondemand_pre_roll_s and ondemand_max_duration_s —
    // left behind when on-demand recording moved out to its own page (see SettingsRecording.jsx's
    // header: keeping it here "read as one confusing feature with two pre-rolls"). The fields went;
    // these three lines of the payload did not.
    //
    // Writing back a setting nobody can see here is never useful, and is occasionally harmful: the
    // Recording page's switch applies the INSTANT it is flipped, so a General page still holding the
    // old value would silently revert it on its next Save. Omitting them is safe because the settings
    // route falls back to each field's stored value when the key is absent (routes/settings.js).
    //
    // Deliberately fed values that WOULD be sent if the lines came back, so this fails loudly rather
    // than passing on an empty fixture.
    const { user } = renderWith({
      app_name: 'Nightlight',
      ondemand_enabled: true,
      ondemand_pre_roll_s: 30,
      ondemand_max_duration_s: 120,
    });
    await user.click(await screen.findByRole('button', { name: /Save/ }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const body = putSpy.mock.calls[0][1];
    expect(body).not.toHaveProperty('ondemand_enabled');
    expect(body).not.toHaveProperty('ondemand_pre_roll_s');
    expect(body).not.toHaveProperty('ondemand_max_duration_s');
  });

  test('sends the general fields it does own', async () => {
    const { user } = renderWith({ app_name: 'Nightlight' });
    await user.click(await screen.findByRole('button', { name: /Save/ }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());

    const body = putSpy.mock.calls[0][1];
    for (const key of ['app_name', 'accent_color', 'live_color', 'offline_color', 'timezone', 'font_choice', 'temp_unit']) {
      expect(body, `${key} should be saved from this screen`).toHaveProperty(key);
    }
    // MQTT has its own sub-page and must not be touched from here — the settings route leaves out
    // fields alone, which is what makes splitting the screens safe.
    expect(body).not.toHaveProperty('mqtt_host');
    expect(body).not.toHaveProperty('mqtt_password');
  });
});
