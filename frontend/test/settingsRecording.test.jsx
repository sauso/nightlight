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
//  3. **The save sends a hand-written whitelist of ten fields** into a route that is one long
//     positional UPDATE. A field dropped from that list stops saving, with no error anywhere.
//
// Role gating is NOT tested here: the route sits under <AdminProtected> (covered in
// routeGuards.test.jsx), so this component never sees a caregiver and does no gating of its own.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
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

// The server's dry run (GET /settings/clip-retention-preview) for a save that deletes nothing, and for one that does.
const PREVIEW_NONE = { storageReady: true, count: 0, bytes: 0, oldestAt: null, byAge: { count: 0, bytes: 0 }, bySize: { count: 0, bytes: 0 } };
const PREVIEW_SOME = { storageReady: true, count: 3, bytes: 3 * 1024 ** 3, oldestAt: '2026-09-01 08:30:00', byAge: { count: 3, bytes: 3 * 1024 ** 3 }, bySize: { count: 0, bytes: 0 } };

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
    // The two alert-clip limits are absent on purpose when untouched (#395, next test).
    expect(Object.keys(body).sort()).toEqual([
      'clip_post_roll_s',
      'clip_pre_roll_s',
      'ondemand_enabled',
      'ondemand_max_duration_s',
      'ondemand_pre_roll_s',
      'wake_clip_retention_days',
      'wake_clip_seconds',
      'wake_clips_enabled',
    ]);
  });

  test('★★ editing only another field sends NO retention keys, so a stale page cannot trigger a sweep (#395 review)', async () => {
    // Tab A loaded a 5 GB cap, tab B set it to 0. If tab A re-sent its stale 5 here the server would see a change
    // against its current 0, sweep, and nobody would have been asked. Omitted = keep on the server.
    const { user } = renderWith({ ...FULL_SETTINGS, clip_retention_max_gb: 5 });
    const pre = await screen.findByLabelText('Pre-roll (seconds)');
    await user.clear(pre);
    await user.type(pre, '9');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const body = putSpy.mock.calls[0][1];
    expect(body.clip_pre_roll_s).toBe('9');
    expect(body).not.toHaveProperty('clip_retention_days');
    expect(body).not.toHaveProperty('clip_retention_max_gb');
    expect(api.get.mock.calls.filter(([p]) => String(p).includes('clip-retention-preview'))).toHaveLength(0);
  });

  test('changing one limit sends only that limit, to the save and to the dry run', async () => {
    api.get.mockImplementation(async (path) => (String(path).includes('clip-retention-preview') ? PREVIEW_NONE : {}));
    const { user } = renderWith(FULL_SETTINGS);
    const field = await screen.findByLabelText('Storage cap (GB)');
    await user.clear(field);
    await user.type(field, '2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    const body = putSpy.mock.calls[0][1];
    expect(body.clip_retention_max_gb).toBe('2');
    expect(body).not.toHaveProperty('clip_retention_days');
    const asked = api.get.mock.calls.map(([p]) => String(p)).find((p) => p.includes('clip-retention-preview'));
    expect(asked).toMatch(/max_gb=2/);
    expect(asked).not.toMatch(/days=/);
  });

  test('★ the on/off switch rides in the same Save, as a real boolean (#391)', async () => {
    // `ondemand_enabled` used to be deliberately absent from this payload because the switch wrote on its
    // own. It is one of the page's drafts now, so Save must carry it, and carry the STORED value when the
    // switch was not touched (false here) rather than a default of true that would re-enable the feature.
    const { user } = renderWith({ ondemand_enabled: false });
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].ondemand_enabled).toBe(false);
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
    // 14 -> 7 is a tighter limit, so the screen asks the server what it would delete first (#395); none, so it saves.
    api.get.mockImplementation(async (path) => (String(path).includes('clip-retention-preview') ? PREVIEW_NONE : {}));
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
    // The switch is an ordinary form field, like the on-demand one (#391) — nothing is written until Save.
    // A regression that made it apply immediately would be a surprising, unasked-for write.
    const { user } = renderWith({ wake_clips_enabled: true });
    await user.click(await screen.findByLabelText('Record wake-ups without alerting'));
    expect(screen.queryByLabelText('Clip length (seconds)')).toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
  });
});

describe('★ the on-demand switch is a draft like every other control (#391)', () => {
  const SWITCH = 'Show a Record button on each camera';

  test('flipping it sends NOTHING, and says there are unsaved changes', async () => {
    // Two pills on this page used to commit differently: this one wrote at once, the wake-clip one waited
    // for Save. Someone who turned a feature off and left believed it had stopped. One model now.
    const { user } = renderWith({ ondemand_enabled: true });
    expect(screen.queryByText('Unsaved changes.')).toBeNull();
    await user.click(await screen.findByLabelText(SWITCH));
    expect(putSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  });

  test('Save sends it, once, with the rest of the page', async () => {
    const { user } = renderWith({ ondemand_enabled: true });
    await user.click(await screen.findByLabelText(SWITCH));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy.mock.calls[0][1]).toMatchObject({ ondemand_enabled: false, wake_clips_enabled: true });
  });

  test('★ a switch stored as 1/0 (what the database returns) flipped twice is still "no change"', async () => {
    // The database hands back 1, the switch hands back true; compared raw, 1 -> true -> 1 would read as an
    // edit forever and the notice (and a stored draft) would never go away.
    const { user } = renderWith({ ondemand_enabled: 1, wake_clips_enabled: 1 });
    const toggle = await screen.findByLabelText(SWITCH);
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.queryByText('Unsaved changes.')).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });

  test('with nothing stored the switch is ON and Save carries that, not a false', async () => {
    const { user } = renderWith();
    expect((await screen.findByLabelText(SWITCH)).checked).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1]).toMatchObject({ ondemand_enabled: true, wake_clips_enabled: true });
  });

  test('flipping it back clears the notice: unsaved is derived, not a flag', async () => {
    const { user } = renderWith({ ondemand_enabled: true });
    const toggle = await screen.findByLabelText(SWITCH);
    await user.click(toggle);
    await user.click(toggle);
    expect(screen.queryByText('Unsaved changes.')).toBeNull();
  });

  test('★★ a rejected Save keeps the draft and the notice, and says why', async () => {
    // Nothing on screen may read as "recording stopped" once the write failed: the notice stays, the error
    // shows, and the stored value (still on) is what a reload would bring back.
    vi.restoreAllMocks();
    mockApi({ putFails: 'Server unavailable' });
    const { user } = renderWith({ ondemand_enabled: true });
    await user.click(await screen.findByLabelText(SWITCH));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Server unavailable')).toBeTruthy();
    expect(screen.getByText('Unsaved changes.')).toBeTruthy();
  });

  test('after a successful Save the notice is gone', async () => {
    const { user } = renderWith({ ondemand_enabled: true });
    await user.click(await screen.findByLabelText(SWITCH));
    // PUT /settings answers with the settings as stored, so commit() republishes the new value.
    putSpy.mockResolvedValue({ ...FULL_SETTINGS, ondemand_enabled: false });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByText('Unsaved changes.')).toBeNull());
    expect(screen.getByLabelText(SWITCH).checked).toBe(false);
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

  test('T1: pre-roll, a wake-clip field, and a HIDDEN on-demand field all survive a switch flip + context republish', async () => {
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
    expect(putSpy).not.toHaveBeenCalled(); // a draft now (#391), not an immediate write

    // Stands in for the real SettingsProvider re-fetching for some unrelated reason — a NEW settings object.
    rerenderWith({ settings: { ...FULL_SETTINGS, temp_unit: 'F' } });

    // The on-demand fields correctly hide themselves while the feature is off — but a field being
    // off-screen must not be what clears its draft (Codex F4).
    await waitFor(() => expect(screen.queryByLabelText('Capture before (seconds)')).toBeNull());
    expect(screen.getByLabelText('Pre-roll (seconds)').value).toBe('12');
    expect(screen.getByLabelText('Clip length (seconds)').value).toBe('45');

    await user.click(screen.getByLabelText(SWITCH_LABEL));

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

  test('T1c: the PUT response is shown after Save even though refresh() fails, and a second Save is not stale', async () => {
    // #449 Codex F1: SettingsContext's refresh() swallows a failed GET, so "clear the draft, then
    // refresh()" can leave a stale value on screen next to a "Saved ✓" banner, ready to be re-sent by
    // the next Save. The fix is to never depend on refresh() landing at all after a successful write —
    // commit() uses the PUT's own response instead. This proves that: refresh() here always throws,
    // and the UI must still be correct.
    const failingRefresh = vi.fn(async () => { throw new Error('refresh boom'); });
    // A changed retention limit asks the dry run first (#395); it reports nothing to delete, so Save goes straight on.
    vi.spyOn(api, 'get').mockImplementation(async (path) =>
      (String(path).includes('clip-retention-preview') ? PREVIEW_NONE : { total_bytes: 0, clip_count: 0 }));
    putSpy = vi.spyOn(api, 'put').mockImplementation((_path, body) =>
      // Deliberately returns a clip_retention_days that does NOT match what was typed (99), so a
      // passing assertion can only mean the UI is showing the RESPONSE, not coincidentally echoing
      // the input back.
      Promise.resolve({ ...FULL_SETTINGS, ...body, clip_retention_days: 7 })
    );

    const { user } = renderStateful(FULL_SETTINGS, failingRefresh);

    // The switch is saved by the SAME request as the number below (#391): one PUT carries both.
    await user.click(await screen.findByLabelText(SWITCH_LABEL));

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
    expect(putSpy.mock.calls[0][1].ondemand_enabled).toBe(false);
    expect(screen.getByLabelText(SWITCH_LABEL).checked).toBe(false);
    // Shows the server's normalised 7, not the 99 that was typed.
    expect(screen.getByLabelText('Keep clips for (days)').value).toBe('7');

    // A second Save, nothing further edited, must not send the stale 99 that a dropped commit() would leave
    // behind. Since #395 a limit that did not change from the committed value (7) is not sent at all, so the
    // proof is that the key is absent (a stale 99 differs from 7 and WOULD be sent) and the field still reads 7.
    await user.click(saveBtn);
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(2));
    expect(putSpy.mock.calls[1][1]).not.toHaveProperty('clip_retention_days');
    expect(screen.getByLabelText('Keep clips for (days)').value).toBe('7');
    expect(failingRefresh).not.toHaveBeenCalled();
  });

  test('T3: an untouched field follows the server on a context refresh (kills a "never sync" implementation)', async () => {
    const { rerenderWith } = renderWith(FULL_SETTINGS);
    expect((await screen.findByLabelText('Keep clips for (days)')).value).toBe('14');

    rerenderWith({ settings: { ...FULL_SETTINGS, clip_retention_days: 30 } });
    await waitFor(() => expect(screen.getByLabelText('Keep clips for (days)').value).toBe('30'));
  });

  test('T4: Save clears the draft, and a LATER context change to that field still shows through', async () => {
    // 14 -> 30 changes a retention limit, so the dry run is asked first (#395); it reports nothing to delete.
    api.get.mockImplementation(async (path) => (String(path).includes('clip-retention-preview') ? PREVIEW_NONE : {}));
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

  // While a Save is in flight both switches are disabled: nothing may change under a request that is
  // already carrying the old values. (The matching guard against a SECOND, overlapping write — the old
  // toggle-versus-Save race of #449 — no longer has two writers to guard, because the switch no longer
  // writes by itself, #391.)
  test('holding a Save PUT disables both switches', async () => {
    vi.restoreAllMocks();
    let resolveSavePut;
    mockApi({ putImpl: () => new Promise((resolve) => { resolveSavePut = resolve; }) });
    const { user } = renderWith(FULL_SETTINGS);

    await screen.findByLabelText('Pre-roll (seconds)');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));

    expect(screen.getByLabelText(SWITCH_LABEL)).toBeDisabled();
    expect(screen.getByLabelText('Record wake-ups without alerting')).toBeDisabled();

    resolveSavePut({ ...FULL_SETTINGS });
    await waitFor(() => expect(screen.getByLabelText(SWITCH_LABEL)).not.toBeDisabled());
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

describe('★ lowering a retention limit asks before it deletes video (#395)', () => {
  const previewCalls = () => api.get.mock.calls.filter(([p]) => String(p).includes('clip-retention-preview'));
  const mockPreview = (impl) =>
    api.get.mockImplementation(async (path) => (String(path).includes('clip-retention-preview') ? impl(path) : {}));
  const lower = async (user, value = '7') => {
    const field = await screen.findByLabelText('Keep clips for (days)');
    await user.clear(field);
    await user.type(field, value);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
  };

  test('★★ when clips would go, nothing is saved until the person confirms, and the dialog says how many', async () => {
    mockPreview(() => PREVIEW_SOME);
    const { user } = renderWith({ clip_retention_days: 14 });
    await lower(user);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/3 alert clips/);
    expect(dialog.textContent).toMatch(/about\s*3\.00 GB/);
    expect(dialog.textContent).toMatch(/oldest is from/);
    expect(putSpy).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Save and delete clips' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].clip_retention_days).toBe('7');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('Cancel saves nothing and leaves the edit in place', async () => {
    mockPreview(() => PREVIEW_SOME);
    const { user } = renderWith({ clip_retention_days: 14 });
    await lower(user);
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(putSpy).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Keep clips for (days)').value).toBe('7');
  });

  test('a lower limit that would delete nothing saves straight away', async () => {
    mockPreview(() => PREVIEW_NONE);
    const { user } = renderWith({ clip_retention_days: 14 });
    await lower(user);
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('★ leaving both limits alone never asks the server what would be deleted', async () => {
    mockPreview(() => PREVIEW_SOME);
    const { user } = renderWith({ clip_retention_days: 14 });
    await user.click(await screen.findByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(previewCalls()).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('★★ RAISING a limit still asks the dry run, and still warns when the other limit (the cap) would delete (#395 review)', async () => {
    // The sweep enforces both limits on any retention change, so a larger "Keep clips for" can delete clips when
    // storage is already over the cap. The old direction-of-change rule skipped the question here.
    mockPreview(() => PREVIEW_SOME);
    const { user } = renderWith({ clip_retention_days: 14 });
    await lower(user, '30');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(previewCalls()[0][0]).toMatch(/days=30/);
    expect(putSpy).not.toHaveBeenCalled();
  });

  test('raising a limit that deletes nothing saves straight away', async () => {
    mockPreview(() => PREVIEW_NONE);
    const { user } = renderWith({ clip_retention_days: 14 });
    await lower(user, '30');
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(previewCalls()).toHaveLength(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('turning a limit ON (0 -> 30) or OFF (14 -> 0) both ask the dry run, which decides', async () => {
    mockPreview(() => PREVIEW_SOME);
    const first = renderWith({ clip_retention_days: 0 });
    await lower(first.user, '30');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    first.unmount();

    putSpy.mockClear();
    api.get.mockClear();
    const second = renderWith({ clip_retention_days: 14 });
    await lower(second.user, '0');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(previewCalls()[0][0]).toMatch(/days=0/);
  });

  test.each(['1e2', '', '1.5', '-1', '366'])(
    '★★ %j is refused on the page and sent nowhere: the server would read it differently (#395 review)',
    async (typed) => {
      // parseInt on the server reads "1e2" as 1; Number() on the screen read it as 100 and skipped the question
      // while the server then kept 1 day. The screen now only sends plain whole numbers in range.
      mockPreview(() => PREVIEW_NONE);
      renderWith({ clip_retention_days: 14 });
      const field = await screen.findByLabelText('Keep clips for (days)');
      // fireEvent, not user.type: a number input would not accept every one of these characters from a keyboard,
      // and submitting the form directly skips the browser's own min/max/step check, which is not what is tested.
      fireEvent.change(field, { target: { value: typed } });
      fireEvent.submit(field.closest('form'));
      expect(await screen.findByText(/Keep clips for must be a whole number between 0 and 365/)).toBeTruthy();
      expect(putSpy).not.toHaveBeenCalled();
      expect(previewCalls()).toHaveLength(0);
    }
  );

  test('the storage cap is range-checked the same way', async () => {
    mockPreview(() => PREVIEW_NONE);
    renderWith({ clip_retention_max_gb: 5 });
    const field = await screen.findByLabelText('Storage cap (GB)');
    fireEvent.change(field, { target: { value: '2001' } });
    fireEvent.submit(field.closest('form'));
    expect(await screen.findByText(/Storage cap must be a whole number between 0 and 2000/)).toBeTruthy();
    expect(putSpy).not.toHaveBeenCalled();
  });

  test('★★ the values that were previewed are the values saved, even if the form moves while the check is pending (#395 review)', async () => {
    let resolvePreview;
    mockPreview(() => new Promise((resolve) => { resolvePreview = resolve; }));
    const { user } = renderWith({ ...FULL_SETTINGS });
    await lower(user, '7');
    await waitFor(() => expect(previewCalls()).toHaveLength(1));

    // The limit fields lock while the check is out ...
    expect(screen.getByLabelText('Keep clips for (days)')).toBeDisabled();
    expect(screen.getByLabelText('Storage cap (GB)')).toBeDisabled();
    // ... and a field that is still editable is not part of what is saved from this click.
    const pre = screen.getByLabelText('Pre-roll (seconds)');
    await user.clear(pre);
    await user.type(pre, '9');

    resolvePreview(PREVIEW_SOME);
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByLabelText('Keep clips for (days)')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save and delete clips' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(putSpy.mock.calls[0][1].clip_retention_days).toBe('7');
    expect(putSpy.mock.calls[0][1].clip_pre_roll_s).toBe(5);
  });

  test('the storage cap asks the same way, and names only the limit that changed', async () => {
    mockPreview(() => PREVIEW_SOME);
    const { user } = renderWith({ clip_retention_days: 14, clip_retention_max_gb: 5 });
    const field = await screen.findByLabelText('Storage cap (GB)');
    await user.clear(field);
    await user.type(field, '2');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(previewCalls()[0][0]).not.toMatch(/days=/);
    expect(previewCalls()[0][0]).toMatch(/max_gb=2/);
  });

  test('if the dry run fails the person is still asked, in words that do not invent a number', async () => {
    api.get.mockImplementation(async (path) => {
      if (String(path).includes('clip-retention-preview')) throw new Error('boom');
      return {};
    });
    const { user } = renderWith({ clip_retention_days: 14 });
    await lower(user);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/couldn't check/i);
    expect(dialog.textContent).not.toMatch(/\d+ alert clips?/);
    expect(putSpy).not.toHaveBeenCalled();
  });

  test('★ with storage down the dialog says nothing is deleted until it returns, and gives no count (#395 review)', async () => {
    mockPreview(() => ({ ...PREVIEW_NONE, storageReady: false }));
    const { user } = renderWith({ clip_retention_days: 14 });
    await lower(user);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/nothing is deleted until it is/);
    expect(dialog.textContent).not.toMatch(/\d+ alert clips?/);
    expect(dialog.textContent).not.toMatch(/right away/);
    expect(putSpy).not.toHaveBeenCalled();
  });

  test('a save the server refuses is explained inside the dialog, which stays open', async () => {
    vi.restoreAllMocks();
    mockApi({ putFails: 'Disk is full' });
    mockPreview(() => PREVIEW_SOME);
    const { user } = renderWith({ clip_retention_days: 14 });
    await lower(user);
    await user.click(await screen.findByRole('button', { name: 'Save and delete clips' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Disk is full')).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Save and delete clips' }).disabled).toBe(false);
  });

  test('wake clip retention is not previewed (it is applied by its own periodic sweep)', async () => {
    mockPreview(() => PREVIEW_SOME);
    const { user } = renderWith({ wake_clip_retention_days: 14 });
    const field = await screen.findByLabelText('Keep wake clips for (days)');
    await user.clear(field);
    await user.type(field, '3');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(putSpy).toHaveBeenCalled());
    expect(previewCalls()).toHaveLength(0);
  });
});
