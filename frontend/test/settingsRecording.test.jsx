// The Recording settings screen — where the numbers the docs promise are actually entered.
//
// ★ WHY THIS SCREEN. Three things make it worth real tests rather than a smoke check:
//
//  1. **`docs/recording.md` publishes a default and a range for every field here.** A doc that
//     disagrees with the app is worse than no doc, and nothing else in the repo compares the two.
//     These tests are that comparison, written so a change to either side has to face the other.
//  2. **Zero is a MEANINGFUL value on this screen** — the docs say "0 turns that limit off" for
//     retention and "0 keeps them forever" for wake clips. Every default here is written with `??`
//     rather than `||` for exactly that reason, and the difference is invisible until somebody sets a
//     limit to 0 and silently gets 14 days instead. One `||` is all it takes.
//  3. **The save sends a hand-written whitelist of nine fields** into a route that is one long
//     positional UPDATE. A field dropped from that list stops saving, with no error anywhere.
//
// Role gating is NOT tested here: the route sits under <AdminProtected> (covered in
// routeGuards.test.jsx), so this component never sees a caregiver and does no gating of its own.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { renderAsAdmin, ADMIN } from './helpers/render.jsx';
import SettingsRecording from '../src/pages/SettingsRecording.jsx';
import { api } from '../src/lib/api.js';
import { AuthContext } from '../src/lib/AuthContext.jsx';
import { SettingsContext } from '../src/lib/SettingsContext.jsx';
import { CamerasContext } from '../src/lib/CamerasContext.jsx';

// The defaults and ranges as docs/recording.md states them. Kept as one table so the assertions read
// as "the screen agrees with the documentation" rather than as a pile of magic numbers.
const DOCUMENTED = [
  { label: 'Pre-roll (seconds)', key: 'clip_pre_roll_s', value: '5', min: '0', max: '30' },
  { label: 'Post-roll (seconds)', key: 'clip_post_roll_s', value: '15', min: '5', max: '120' },
  { label: 'Keep clips for (days)', key: 'clip_retention_days', value: '14', min: '0', max: '365' },
  { label: 'Storage cap (GB)', key: 'clip_retention_max_gb', value: '5', min: '0', max: '2000' },
  { label: 'Clip length (seconds)', key: 'wake_clip_seconds', value: '30', min: '5', max: '120' },
  { label: 'Keep wake clips for (days)', key: 'wake_clip_retention_days', value: '14', min: '0', max: '365' },
  { label: 'Capture before (seconds)', key: 'ondemand_pre_roll_s', value: '30', min: '0', max: '60' },
  { label: 'Auto-stop after (seconds)', key: 'ondemand_max_duration_s', value: '120', min: '5', max: '600' },
];

let putSpy;

// `putImpl` (added for #449's T1b/T1c/T5) lets a test hold a PUT open — to inspect the optimistic,
// in-flight state before resolving or rejecting it on its own schedule — without duplicating this
// whole setup. `putFails`/no-arg behaviour is unchanged for every existing test.
function mockApi({ putFails = null, putImpl = null } = {}) {
  vi.spyOn(api, 'get').mockResolvedValue({ total_bytes: 0, clip_count: 0 });
  putSpy = vi.spyOn(api, 'put').mockImplementation(
    putImpl || (() => (putFails ? Promise.reject(new Error(putFails)) : Promise.resolve({})))
  );
}

// The screen reads its values from SettingsContext, so a "stored" setting is one injected there.
const renderWith = (settings = {}) => renderAsAdmin(<SettingsRecording />, { settings });

// A complete admin recording-settings object — every field this screen reads. Used by the #449 tests
// below, which must always publish a FULL settings object on a (simulated) context refresh: passing
// just the one changed key would silently drop every other field back to DEFAULT_SETTINGS (see
// helpers/render.jsx's `build` and its comment on `commit`/`rerenderWith`), which is not what a real
// refresh does — GET /settings always sends everything.
const FULL_SETTINGS = {
  clip_pre_roll_s: 5,
  clip_post_roll_s: 15,
  clip_retention_days: 14,
  clip_retention_max_gb: 5,
  wake_clips_enabled: true,
  wake_clip_seconds: 30,
  wake_clip_retention_days: 14,
  ondemand_enabled: true,
  ondemand_pre_roll_s: 30,
  ondemand_max_duration_s: 120,
};

beforeEach(() => mockApi());
afterEach(() => vi.restoreAllMocks());

describe('the screen agrees with the documentation', () => {
  test('every field offers the documented default when nothing is stored', async () => {
    // An install that has never touched these settings still has to show the values the docs promise,
    // because those numbers are what someone reads the docs to find out.
    renderWith();
    for (const { label, value } of DOCUMENTED) {
      const field = await screen.findByLabelText(label);
      expect(field.value, `${label} should default to ${value}`).toBe(value);
    }
  });

  test('every field enforces the documented range', async () => {
    // The range is half of what the docs promise, and it is the half that stops someone entering a
    // pre-roll deeper than the buffer can reach or a retention of -1.
    renderWith();
    for (const { label, min, max } of DOCUMENTED) {
      const field = await screen.findByLabelText(label);
      expect(field.getAttribute('min'), `${label} min`).toBe(min);
      expect(field.getAttribute('max'), `${label} max`).toBe(max);
    }
  });
});

describe('★ a stored value is shown as it is — including zero', () => {
  test('stored numbers replace the defaults', async () => {
    renderWith({ clip_pre_roll_s: 8, clip_retention_days: 30, ondemand_pre_roll_s: 45 });
    expect((await screen.findByLabelText('Pre-roll (seconds)')).value).toBe('8');
    expect((await screen.findByLabelText('Keep clips for (days)')).value).toBe('30');
    expect((await screen.findByLabelText('Capture before (seconds)')).value).toBe('45');
  });

  test('★★ a stored ZERO survives, because zero means something here', async () => {
    // THE test this file exists for. The docs say 0 turns a retention limit off and keeps wake clips
    // forever — so somebody who deliberately sets 0 must not be shown 14 and silently switched back
    // on. Every default on this screen uses `??`; a single `||` would swallow all of these, and
    // nothing else in the app would disagree.
    renderWith({
      clip_pre_roll_s: 0,
      clip_retention_days: 0,
      clip_retention_max_gb: 0,
      wake_clip_retention_days: 0,
      ondemand_pre_roll_s: 0,
    });
    expect((await screen.findByLabelText('Pre-roll (seconds)')).value).toBe('0');
    expect((await screen.findByLabelText('Keep clips for (days)')).value).toBe('0');
    expect((await screen.findByLabelText('Storage cap (GB)')).value).toBe('0');
    expect((await screen.findByLabelText('Keep wake clips for (days)')).value).toBe('0');
    expect((await screen.findByLabelText('Capture before (seconds)')).value).toBe('0');
  });
});

describe('saving', () => {
  test('★ sends every field the screen edits, and nothing it does not', async () => {
    // The payload is hand-written, so a field added to the form but forgotten here would appear to
    // save and quietly never persist. Asserted as an exact key set rather than a spot-check: that is
    // what catches the omission, and equally what catches a stray extra field being posted.
    const { user } = renderWith();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const [path, body] = putSpy.mock.calls[0];
    expect(path).toBe('/settings');
    expect(Object.keys(body).sort()).toEqual([
      'clip_post_roll_s',
      'clip_pre_roll_s',
      'clip_retention_days',
      'clip_retention_max_gb',
      'ondemand_max_duration_s',
      'ondemand_pre_roll_s',
      'wake_clip_retention_days',
      'wake_clip_seconds',
      'wake_clips_enabled',
    ]);
  });

  test('⚠️ does NOT resend the on/off switch, which applies on its own', async () => {
    // `ondemand_enabled` is deliberately absent from the save payload: the switch applies the instant
    // it is flipped. Including it here would let a stale form value undo a toggle the user had just
    // made — the two controls would fight each other.
    const { user } = renderWith({ ondemand_enabled: false });
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).not.toHaveProperty('ondemand_enabled');
  });

  test('sends the wake-clip switch as a real boolean even when it was never touched', async () => {
    // `wake_clips_enabled` defaults to on but is stored as undefined until somebody flips it. The save
    // materialises the default rather than posting undefined, which the route would read as "unset".
    const { user } = renderWith();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].wake_clips_enabled).toBe(true);
  });

  test('a typed value reaches the payload', async () => {
    const { user } = renderWith({ clip_retention_days: 14 });
    const field = await screen.findByLabelText('Keep clips for (days)');
    await user.clear(field);
    await user.type(field, '7');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].clip_retention_days).toBe('7');
  });

  test('a failed save says so and does not claim success', async () => {
    // The success banner and the error banner are mutually exclusive by construction; the thing worth
    // pinning is that a rejected request produces the error one and NOT the "Saved ✓" one.
    vi.restoreAllMocks();
    mockApi({ putFails: 'Disk is full' });
    const { user } = renderWith();
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Disk is full')).toBeTruthy();
    expect(screen.queryByText('Saved ✓')).toBeNull();
  });
});

describe('the wake-clip fields follow their switch', () => {
  test('they are hidden when wake clips are off', async () => {
    renderWith({ wake_clips_enabled: false });
    // Wait for something that is ALWAYS present first — the screen renders its form immediately, but
    // asserting an absence before anything has rendered would pass for the wrong reason.
    await screen.findByLabelText('Pre-roll (seconds)');
    expect(screen.queryByLabelText('Clip length (seconds)')).toBeNull();
    expect(screen.queryByLabelText('Keep wake clips for (days)')).toBeNull();
  });

  test('they appear when it is on', async () => {
    renderWith({ wake_clips_enabled: true });
    expect(await screen.findByLabelText('Clip length (seconds)')).toBeTruthy();
  });

  test('turning the switch off hides them without saving anything', async () => {
    // The switch here is an ordinary form field, unlike the on-demand one below — nothing is written
    // until Save. A regression that made it apply immediately would be a surprising, unasked-for write.
    const { user } = renderWith({ wake_clips_enabled: true });
    await user.click(await screen.findByLabelText('Record wake-ups without alerting'));
    expect(screen.queryByLabelText('Clip length (seconds)')).toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('★ the on-demand switch applies immediately', () => {
  const SWITCH = 'Show a Record button on each camera';

  test('flipping it writes straight away, without a Save', async () => {
    // Its pill shape promises this in this codebase, and turning the feature off is supposed to stop
    // every camera buffering at once rather than at the next Save.
    const { user } = renderWith({ ondemand_enabled: true });
    await user.click(await screen.findByLabelText(SWITCH));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/settings', { ondemand_enabled: false }));
  });

  test('★★ a rejected toggle puts the switch BACK and says why', async () => {
    // The failure that would otherwise be silent and actively misleading: the switch is moved
    // optimistically, so if the write fails and nothing puts it back, the screen shows "off" while
    // every camera carries on buffering. The user would have no reason to doubt it.
    vi.restoreAllMocks();
    mockApi({ putFails: 'Server unavailable' });
    const { user } = renderWith({ ondemand_enabled: true });

    const toggle = await screen.findByLabelText(SWITCH);
    expect(toggle.checked).toBe(true);
    await user.click(toggle);

    expect(await screen.findByText('Server unavailable')).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText(SWITCH).checked).toBe(true));
  });

  test('its fields are hidden when the feature is off, like the wake-clip block', async () => {
    // I expected these to stay visible — they don't. Both blocks hide their fields, which is the
    // consistent choice, and pinning it is what stops the two drifting apart later.
    // ⚠️ Absence is asserted only AFTER something known-present has rendered; checking straight after
    // render would pass because nothing had painted yet, not because the fields were hidden.
    renderWith({ ondemand_enabled: false });
    await screen.findByLabelText('Pre-roll (seconds)');
    expect(screen.queryByLabelText('Capture before (seconds)')).toBeNull();
    expect(screen.queryByLabelText('Auto-stop after (seconds)')).toBeNull();
  });

  test('and they come back when it is on', async () => {
    renderWith({ ondemand_enabled: true });
    expect(await screen.findByLabelText('Capture before (seconds)')).toBeTruthy();
    expect(screen.getByLabelText('Auto-stop after (seconds)')).toBeTruthy();
  });
});

// --- #449: the on-demand toggle discarding other unsaved recording settings --------------------
//
// Root cause: the old `useEffect(() => { if (settings) setForm(settings); }, [settings])` replaced
// the WHOLE form on any change to the SettingsContext object, including a change caused by the
// on-demand switch's own immediate save + refresh(). Every test above renders once and never
// publishes a new `settings` object afterwards, so none of them exercise that effect a second time —
// which is exactly why the bug shipped with a green suite. The tests below are the ones that do:
// each either uses `rerenderWith` (helpers/render.jsx) to publish a fresh, COMPLETE settings object,
// or a small stateful provider whose `commit`/`refresh` genuinely change what the screen reads (Codex
// F3) — the injected `refresh`/`commit` from `renderWith` are deliberately inert `vi.fn()`s and would
// let a naive version of these tests pass against the broken component.
describe('★ unsaved drafts survive a context refresh (#449)', () => {
  const SWITCH_LABEL = 'Show a Record button on each camera';
  const withOndemand = (enabled) => ({ ...FULL_SETTINGS, ondemand_enabled: enabled });

  // A REAL stateful settings context, for tests below that need `commit`/`refresh` to actually
  // change what the screen reads — the injected mocks from helpers/render.jsx are deliberately
  // inert (see its comment): a mocked `commit` there records the call but never updates `settings`,
  // so a test asserting what the screen shows AFTER a successful commit needs this instead.
  function renderStateful(initialSettings, refreshImpl) {
    function Harness() {
      const [settings, setSettings] = useState(initialSettings);
      const value = {
        settings,
        loading: false,
        commit: (s) => setSettings(s),
        refresh: refreshImpl || (async () => {}),
      };
      return (
        <MemoryRouter>
          <AuthContext.Provider
            value={{ user: ADMIN, loading: false, login: vi.fn(), logout: vi.fn(), refresh: vi.fn() }}
          >
            <SettingsContext.Provider value={value}>
              <CamerasContext.Provider value={{ kids: [], cameras: [], error: '', refresh: vi.fn() }}>
                <SettingsRecording />
              </CamerasContext.Provider>
            </SettingsContext.Provider>
          </AuthContext.Provider>
        </MemoryRouter>
      );
    }
    const result = render(<Harness />);
    return { ...result, user: userEvent.setup() };
  }

  test('T1: pre-roll, a wake-clip field, and a HIDDEN on-demand field all survive a toggle + context republish', async () => {
    const { user, rerenderWith } = renderWith(FULL_SETTINGS);

    const preRoll = await screen.findByLabelText('Pre-roll (seconds)');
    await user.clear(preRoll);
    await user.type(preRoll, '12');

    const wakeField = await screen.findByLabelText('Clip length (seconds)');
    await user.clear(wakeField);
    await user.type(wakeField, '45');

    const ondemandPre = await screen.findByLabelText('Capture before (seconds)');
    await user.clear(ondemandPre);
    await user.type(ondemandPre, '22');

    await user.click(screen.getByLabelText(SWITCH_LABEL));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/settings', { ondemand_enabled: false }));

    // Stands in for the real SettingsProvider re-fetching after the toggle's refresh() — a NEW
    // settings object, same shape a real GET /settings would return.
    rerenderWith({ settings: withOndemand(false) });

    // The on-demand fields correctly hide themselves while the feature is off — but a field being
    // off-screen must not be what clears its draft (Codex F4).
    await waitFor(() => expect(screen.queryByLabelText('Capture before (seconds)')).toBeNull());
    expect(screen.getByLabelText('Pre-roll (seconds)').value).toBe('12');
    expect(screen.getByLabelText('Clip length (seconds)').value).toBe('45');

    // Toggle back on — a second PUT, a second republish.
    await user.click(screen.getByLabelText(SWITCH_LABEL));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/settings', { ondemand_enabled: true }));
    rerenderWith({ settings: withOndemand(true) });

    // The on-demand pre-roll draft, typed before the field was ever hidden, is still there —
    const ondemandPreAgain = await screen.findByLabelText('Capture before (seconds)');
    expect(ondemandPreAgain.value).toBe('22');
    expect(screen.getByLabelText('Pre-roll (seconds)').value).toBe('12');
    expect(screen.getByLabelText('Clip length (seconds)').value).toBe('45');

    // — and it reaches the next Save payload, not just the screen.
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledWith('/settings', expect.objectContaining({
      clip_pre_roll_s: '12',
      ondemand_pre_roll_s: '22',
    })));
  });

  test('T1b: the switch shows the optimistic value and disables itself while the toggle is in flight, then re-enables and STAYS on success', async () => {
    // Uses renderStateful, not renderWith: with an inert commit(), pendingOndemand clearing on
    // success would make the switch flicker back to the OLD committed value (nothing ever updated
    // it) — a harness artifact, not the behaviour being pinned. A real commit is what "stays" means.
    vi.restoreAllMocks();
    let resolvePut;
    mockApi({ putImpl: () => new Promise((resolve) => { resolvePut = resolve; }) });
    const { user } = renderStateful(withOndemand(true));

    const toggle = await screen.findByLabelText(SWITCH_LABEL);
    expect(toggle.checked).toBe(true);
    await user.click(toggle);

    // Optimistic AND disabled the instant the request goes out, before the PUT resolves (Codex F5
    // for the value, F2 for the disable — a second click here must not be able to start a race).
    expect(screen.getByLabelText(SWITCH_LABEL).checked).toBe(false);
    expect(screen.getByLabelText(SWITCH_LABEL)).toBeDisabled();

    resolvePut({ ...FULL_SETTINGS, ondemand_enabled: false }); // the PUT's own response, as PUT /settings really answers
    await waitFor(() => expect(screen.getByLabelText(SWITCH_LABEL)).not.toBeDisabled());
    expect(screen.getByLabelText(SWITCH_LABEL).checked).toBe(false);
  });

  test('T1b: a rejected toggle re-enables the switch too, as well as reverting it', async () => {
    vi.restoreAllMocks();
    let rejectPut;
    mockApi({ putImpl: () => new Promise((_resolve, reject) => { rejectPut = reject; }) });
    const { user } = renderWith(withOndemand(true));

    const toggle = await screen.findByLabelText(SWITCH_LABEL);
    await user.click(toggle);
    expect(screen.getByLabelText(SWITCH_LABEL)).toBeDisabled();

    rejectPut(new Error('Server unavailable'));
    await waitFor(() => expect(screen.getByLabelText(SWITCH_LABEL)).not.toBeDisabled());
    expect(screen.getByLabelText(SWITCH_LABEL).checked).toBe(true);
    expect(await screen.findByText('Server unavailable')).toBeTruthy();
  });

  test('T1c: the PUT response is shown for both the toggle and Save even though refresh() fails, and a second Save is not stale', async () => {
    // #449 Codex F1: SettingsContext's refresh() swallows a failed GET, so "clear the draft, then
    // refresh()" can leave a stale value on screen next to a "Saved ✓" banner, ready to be re-sent by
    // the next Save. The fix is to never depend on refresh() landing at all after a successful write —
    // commit() uses the PUT's own response instead. This proves that: refresh() here always throws,
    // and the UI must still be correct.
    const failingRefresh = vi.fn(async () => { throw new Error('refresh boom'); });
    vi.spyOn(api, 'get').mockResolvedValue({ total_bytes: 0, clip_count: 0 });
    putSpy = vi.spyOn(api, 'put').mockImplementation((_path, body) =>
      'ondemand_enabled' in body
        ? Promise.resolve({ ...FULL_SETTINGS, ondemand_enabled: body.ondemand_enabled })
        // Deliberately returns a clip_retention_days that does NOT match what was typed (99), so a
        // passing assertion can only mean the UI is showing the RESPONSE, not coincidentally echoing
        // the input back.
        : Promise.resolve({ ...FULL_SETTINGS, ...body, clip_retention_days: 7 })
    );

    const { user } = renderStateful(FULL_SETTINGS, failingRefresh);

    const toggle = await screen.findByLabelText(SWITCH_LABEL);
    await user.click(toggle);
    await waitFor(() => expect(screen.getByLabelText(SWITCH_LABEL).checked).toBe(false));
    expect(failingRefresh).not.toHaveBeenCalled(); // commit() supersedes refresh() entirely (M7)

    const field = await screen.findByLabelText('Keep clips for (days)');
    await user.clear(field);
    await user.type(field, '99');
    // Grabbed once and reused for both clicks below — its accessible name changes to "Saved ✓" after
    // the first save (see the button's ternary), so re-querying by the "Save changes" name would fail
    // to find it for the second click.
    const saveBtn = screen.getByRole('button', { name: 'Save changes' });
    await user.click(saveBtn);
    // The button ALSO reads "Saved ✓" once saved (see its ternary), so getByRole('button', ...)
    // disambiguates it from the banner div — a plain getByText('Saved ✓') matches both.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved ✓' })).toBeTruthy());
    // Shows the server's normalised 7, not the 99 that was typed.
    expect(screen.getByLabelText('Keep clips for (days)').value).toBe('7');

    // A second Save, nothing further edited, must send what was actually just committed (7) — not a
    // stale pre-fix value that a dropped commit() would leave behind.
    await user.click(saveBtn);
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(3));
    expect(putSpy.mock.calls[2][1].clip_retention_days).toBe(7);
    expect(failingRefresh).not.toHaveBeenCalled();
  });

  test('T2: a failed toggle preserves an unsaved pre-roll draft (pinning existing behaviour, not a regression test — see the plan)', async () => {
    vi.restoreAllMocks();
    mockApi({ putFails: 'Server unavailable' });
    const { user } = renderWith(withOndemand(true));

    const preRoll = await screen.findByLabelText('Pre-roll (seconds)');
    await user.clear(preRoll);
    await user.type(preRoll, '19');

    await user.click(screen.getByLabelText(SWITCH_LABEL));
    await screen.findByText('Server unavailable');
    expect(screen.getByLabelText('Pre-roll (seconds)').value).toBe('19');
  });

  test('T3: an untouched field follows the server on a context refresh (kills a "never sync" implementation)', async () => {
    const { rerenderWith } = renderWith(FULL_SETTINGS);
    expect((await screen.findByLabelText('Keep clips for (days)')).value).toBe('14');

    rerenderWith({ settings: { ...FULL_SETTINGS, clip_retention_days: 30 } });
    await waitFor(() => expect(screen.getByLabelText('Keep clips for (days)').value).toBe('30'));
  });

  test('T4: Save clears the draft, and a LATER context change to that field still shows through', async () => {
    const { user, rerenderWith } = renderWith({ ...FULL_SETTINGS, clip_retention_days: 14 });
    const field = await screen.findByLabelText('Keep clips for (days)');
    await user.clear(field);
    await user.type(field, '30');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    // The button ALSO reads "Saved ✓" once saved (see its ternary), so getByRole('button', ...)
    // disambiguates it from the banner div — a plain getByText('Saved ✓') matches both.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved ✓' })).toBeTruthy());

    // The server normalises the typed "30" (string) to 30 (number) and the context republishes it.
    rerenderWith({ settings: { ...FULL_SETTINGS, clip_retention_days: 30 } });
    expect(screen.getByLabelText('Keep clips for (days)').value).toBe('30');

    // A LATER, DIFFERENT server value must still show through — proof the draft was actually dropped
    // by markSaved, not that it merely happened to still match the one above.
    rerenderWith({ settings: { ...FULL_SETTINGS, clip_retention_days: 45 } });
    await waitFor(() => expect(screen.getByLabelText('Keep clips for (days)').value).toBe('45'));
  });

  // Save and the toggle each commit a FULL settings snapshot from their own PUT response (commit() in
  // SettingsContext.jsx). The race this guards against: toggle PUT sent -> Save PUT sent -> Save's
  // response lands first and commits (markSaved clears the numeric drafts) -> the toggle's response —
  // a snapshot taken BEFORE the save — lands afterwards and commits, reverting the just-saved numeric
  // values on screen, ready for the NEXT Save to write them back over the server. Disabling each
  // control while the other's request is in flight makes that overlap impossible.
  describe('★ Save and the toggle exclude each other while either is in flight (#449 P1)', () => {
    test('holding the toggle PUT disables Save, and a submit while it is disabled sends no PUT', async () => {
      vi.restoreAllMocks();
      let resolveTogglePut;
      mockApi({ putImpl: () => new Promise((resolve) => { resolveTogglePut = resolve; }) });
      const { user } = renderWith(FULL_SETTINGS);

      const toggle = await screen.findByLabelText(SWITCH_LABEL);
      await user.click(toggle);
      await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));

      const saveBtn = screen.getByRole('button', { name: 'Save changes' });
      expect(saveBtn).toBeDisabled();

      await user.click(saveBtn); // a disabled button; userEvent does not fire its handler
      expect(putSpy).toHaveBeenCalledTimes(1); // still just the toggle's own PUT — no second one went out

      resolveTogglePut({ ...FULL_SETTINGS, ondemand_enabled: false });
      await waitFor(() => expect(saveBtn).not.toBeDisabled());
    });

    test('holding a Save PUT disables the toggle, and a click while it is disabled sends no PUT', async () => {
      vi.restoreAllMocks();
      let resolveSavePut;
      mockApi({ putImpl: () => new Promise((resolve) => { resolveSavePut = resolve; }) });
      const { user } = renderWith(FULL_SETTINGS);

      await screen.findByLabelText('Pre-roll (seconds)');
      await user.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));

      const toggle = screen.getByLabelText(SWITCH_LABEL);
      expect(toggle).toBeDisabled();

      await user.click(toggle); // a disabled switch; userEvent does not fire its handler
      expect(putSpy).toHaveBeenCalledTimes(1); // still just Save's own PUT — no toggle PUT went out

      resolveSavePut({ ...FULL_SETTINGS });
      await waitFor(() => expect(toggle).not.toBeDisabled());
    });
  });

  test('T5: an edit made while Save is in flight survives the save that was already sending', async () => {
    vi.restoreAllMocks();
    let resolvePut;
    mockApi({ putImpl: () => new Promise((resolve) => { resolvePut = resolve; }) });
    const { user } = renderWith({ ...FULL_SETTINGS, clip_pre_roll_s: 5 });

    const field = await screen.findByLabelText('Pre-roll (seconds)');
    await user.clear(field);
    await user.type(field, '10');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    // The PUT is hanging — edit again before it resolves.
    await user.clear(field);
    await user.type(field, '20');
    resolvePut({});

    // The button ALSO reads "Saved ✓" once saved (see its ternary), so getByRole('button', ...)
    // disambiguates it from the banner div — a plain getByText('Saved ✓') matches both.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saved ✓' })).toBeTruthy());
    expect(screen.getByLabelText('Pre-roll (seconds)').value).toBe('20');
  });
});
