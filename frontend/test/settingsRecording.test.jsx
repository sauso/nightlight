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
import { screen, waitFor } from '@testing-library/react';
import { renderAsAdmin } from './helpers/render.jsx';
import SettingsRecording from '../src/pages/SettingsRecording.jsx';
import { api } from '../src/lib/api.js';

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

function mockApi({ putFails = null } = {}) {
  vi.spyOn(api, 'get').mockResolvedValue({ total_bytes: 0, clip_count: 0 });
  putSpy = vi.spyOn(api, 'put').mockImplementation(() =>
    putFails ? Promise.reject(new Error(putFails)) : Promise.resolve({})
  );
}

// The screen reads its values from SettingsContext, so a "stored" setting is one injected there.
const renderWith = (settings = {}) => renderAsAdmin(<SettingsRecording />, { settings });

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
