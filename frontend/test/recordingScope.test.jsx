// "Recording and alerts" panel on a camera's settings page (#394).
//
// ★ WHAT IS PINNED, and why it is shaped this way:
//   1. The two pure functions (describeSetup, describeReady) row by row, because every sentence the panel
//      shows is chosen there. The panel's job is to tell an admin the truth about a camera, so the
//      wording of each state is the behaviour.
//   2. The panel rendered in each state: still loading, check failed, every buffer answer, a silenced
//      camera, a camera outside its schedule, wake clips with each missing input.
//   3. READ-ONLY: the panel makes exactly one request (a GET) per check, and no control in it writes.
//   4. Role: the page is <AdminProtected>, so a caregiver never reaches the panel and never causes the
//      request. Tested through the real guard, not by assuming it.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin, renderAsCaregiver } from './helpers/render.jsx';
import CameraSettings from '../src/pages/CameraSettings.jsx';
import { AdminProtected } from '../src/App.jsx';
import { describeSetup, describeReady } from '../src/lib/recordingScope.js';
import { api } from '../src/lib/api.js';

const NOW = 1_800_000_000_000;
const CAM = {
  id: 'cam-1', name: 'Camera', rtsp_host: '192.0.2.5', rtsp_port: '554', rtsp_path: '/s', rtsp_username: '', rtsp_has_password: false,
  child_id: 'kid-1', detect_motion_enabled: 1, detect_source: 'framediff', detect_sound_enabled: 0,
  detect_schedule_enabled: 0, detect_start: 0, detect_end: 0, detect_record_clips: 0, alerts_snoozed_until: null,
};
const KIDS = [{ id: 'kid-1', name: 'Child A', track_sleep: 1 }, { id: 'kid-2', name: 'Child B', track_sleep: 0 }];
const READY = {
  buffer: 'ready', storage_ready: true, wake_clip_ready: true, manual_recording_available: true,
  motion: 'running', sound: 'off', alerting_now: true,
};

const setupOf = (over = {}, settings = {}, kids = KIDS) =>
  describeSetup({ cam: { ...CAM, ...over }, kids, settings: { timezone: 'UTC', ...settings }, now: NOW });
const rowOf = (rows, key) => rows.find((r) => r.key === key);
const readyOf = (over = {}, camOver = {}, settings = {}) => {
  const cam = { ...CAM, ...camOver };
  const setup = describeSetup({ cam, kids: KIDS, settings: { timezone: 'UTC', ...settings }, now: NOW });
  return describeReady({ cam, setup, readiness: { ...READY, ...over } });
};

describe('describeSetup: configuration, from the camera’s own fields', () => {
  test('the motion source, in the words of the Motion screen; off when motion is off', () => {
    expect(rowOf(setupOf(), 'motion').value).toBe('Nightlight compares frames');
    expect(rowOf(setupOf({ detect_source: 'onvif' }), 'motion').value).toBe('The camera’s own motion events (ONVIF)');
    expect(rowOf(setupOf({ detect_source: 'mqtt' }), 'motion').value).toBe('The camera’s own motion events (MQTT)');
    expect(rowOf(setupOf({ detect_source: 'future-source' }), 'motion').value).toBe('future-source');
    // The source column keeps its value when motion is off, so the answer has to come from the switch.
    expect(rowOf(setupOf({ detect_motion_enabled: 0 }), 'motion')).toMatchObject({ value: 'Off', on: false });
  });

  test('sound alerts on and off', () => {
    expect(rowOf(setupOf({ detect_sound_enabled: 1 }), 'sound')).toMatchObject({ value: 'On', on: true });
    expect(rowOf(setupOf(), 'sound')).toMatchObject({ value: 'Off', on: false });
  });

  test('the schedule shows its hours AND the app’s timezone, or "Always"', () => {
    expect(rowOf(setupOf(), 'schedule').value).toBe('Always');
    const s = setupOf({ detect_schedule_enabled: 1, detect_start: 1200, detect_end: 420 }, { timezone: 'Pacific/Auckland' });
    expect(rowOf(s, 'schedule').value).toBe('20:00–07:00 (Pacific/Auckland)');
    expect(rowOf(s, 'schedule').note).toMatch(/app’s timezone, not this device’s/);
    // Start == end is "no window" to the server (always on), so it must not read as a 24-hour-closed one.
    expect(rowOf(setupOf({ detect_schedule_enabled: 1, detect_start: 600, detect_end: 600 }), 'schedule').value).toBe('Always');
  });

  test('a silence in the future shows when it ends and who set it; one that has ended is not shown', () => {
    const live = rowOf(setupOf({ alerts_snoozed_until: NOW + 3600000, alerts_snoozed_by: 'someone' }, { timezone: 'UTC' }), 'snooze');
    expect(live.on).toBe(true);
    expect(live.value).toMatch(/^Until .+ by someone$/);
    expect(rowOf(setupOf({ alerts_snoozed_until: NOW + 3600000 }), 'snooze').value).toMatch(/^Until [^b]+$/);
    expect(rowOf(setupOf({ alerts_snoozed_until: NOW - 1 }), 'snooze')).toMatchObject({ value: 'Not silenced', on: false });
    expect(rowOf(setupOf(), 'snooze').value).toBe('Not silenced');
  });

  test('the silence time is read in the app’s timezone, not the device’s', () => {
    const at = NOW + 3600000;
    const a = rowOf(setupOf({ alerts_snoozed_until: at }, { timezone: 'UTC' }), 'snooze').value;
    const b = rowOf(setupOf({ alerts_snoozed_until: at }, { timezone: 'Pacific/Auckland' }), 'snooze').value;
    expect(a).not.toBe(b);
  });

  test('alert clips: yes says when a clip is cut; no says what is still kept', () => {
    const yes = rowOf(setupOf({ detect_record_clips: 1 }), 'alertClips');
    expect(yes).toMatchObject({ value: 'Yes', on: true });
    expect(yes.note).toMatch(/silenced camera, or one outside its schedule, raises no alert and so saves no clip/);
    const no = rowOf(setupOf(), 'alertClips');
    expect(no).toMatchObject({ value: 'No', on: false });
    expect(no.note).toMatch(/still logged with a snapshot, without video/);
  });

  test('wake clips: eligible only with the global option, a child, and sleep tracking; every missing input is named', () => {
    expect(rowOf(setupOf(), 'wake')).toMatchObject({ value: 'Eligible', on: true });
    expect(rowOf(setupOf(), 'wake').note).toMatch(/silent, and not stopped by a silence or the schedule/);

    const off = rowOf(setupOf({}, { wake_clips_enabled: 0 }), 'wake');
    expect(off).toMatchObject({ value: 'Not eligible', on: false });
    expect(off.note).toMatch(/Record wake-ups without alerting.+off in Settings → Camera and Recording → Recording/);

    const none = rowOf(setupOf({ child_id: null }), 'wake');
    expect(none.on).toBe(false);
    expect(none.note).toMatch(/no child is assigned/);

    const untracked = rowOf(setupOf({ child_id: 'kid-2' }), 'wake');
    expect(untracked.on).toBe(false);
    expect(untracked.note).toMatch(/sleep tracking is off for the assigned child/);

    // All reasons at once, not just the first.
    const all = rowOf(setupOf({ child_id: null }, { wake_clips_enabled: 0 }), 'wake').note;
    expect(all).toMatch(/off in Settings → Camera and Recording → Recording; no child is assigned/);
  });

  test('a setting that has not arrived yet is the server’s default (on), not "off"', () => {
    // Settings render empty for a moment after boot; claiming "off" would be a false alarm.
    const rows = describeSetup({ cam: CAM, kids: KIDS, settings: {}, now: NOW });
    expect(rowOf(rows, 'wake').on).toBe(true);
    expect(rowOf(rows, 'manual')).toMatchObject({ value: 'On', on: true });
    expect(rowOf(rows, 'schedule').value).toBe('Always');
  });

  test('manual recording on and off, naming the setting that turns it off', () => {
    expect(rowOf(setupOf({}, { ondemand_enabled: 1 }), 'manual').value).toBe('On');
    const off = rowOf(setupOf({}, { ondemand_enabled: 0 }), 'manual');
    expect(off).toMatchObject({ value: 'Off', on: false });
    expect(off.note).toMatch(/Show a Record button on each camera.+Settings → Camera and Recording → Recording/);
  });
});

describe('describeReady: runtime, from the server’s answer', () => {
  const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r]));

  test('nothing is shown until the server has answered', () => {
    expect(describeReady({ cam: CAM, setup: setupOf(), readiness: null })).toBeNull();
  });

  test('everything ready', () => {
    const r = byKey(readyOf({}, { detect_record_clips: 1 }));
    expect(r.motion).toMatchObject({ state: 'ok', text: 'Running' });
    expect(r.alerting).toMatchObject({ state: 'ok', text: 'Yes' });
    expect(r.buffer).toMatchObject({ state: 'ok', text: 'Ready' });
    expect(r.alertClips).toMatchObject({ state: 'ok', text: 'Will be saved' });
    expect(r.wake).toMatchObject({ state: 'ok', text: 'Ready' });
    expect(r.manual).toMatchObject({ state: 'ok', text: 'Available' });
  });

  test('★ configured but no buffer: each thing that cuts from it is a PROBLEM, not "off" (the #387 shape)', () => {
    const r = byKey(readyOf(
      { buffer: 'not_running', wake_clip_ready: false, manual_recording_available: false },
      { detect_record_clips: 1 },
    ));
    expect(r.buffer).toMatchObject({ state: 'bad', text: 'Not running' });
    for (const k of ['alertClips', 'wake', 'manual']) expect(r[k], k).toMatchObject({ state: 'bad', text: 'Waiting on the buffer' });
  });

  test('not configured is "off", not a problem, whatever the buffer is doing', () => {
    const r = byKey(readyOf({ buffer: 'not_running' }, { detect_record_clips: 0 }, { wake_clips_enabled: 0, ondemand_enabled: 0 }));
    expect(r.alertClips).toMatchObject({ state: 'off', text: 'Not saving' });
    expect(r.wake).toMatchObject({ state: 'off', text: 'Not eligible' });
    expect(r.manual).toMatchObject({ state: 'off', text: 'Off' });
  });

  test('every buffer answer has its own state and words', () => {
    const expected = {
      ready: ['ok', 'Ready'],
      not_running: ['bad', 'Not running'],
      not_needed: ['off', 'Not needed'],
      storage_unavailable: ['bad', 'Storage unavailable'],
      camera_disabled: ['off', 'Camera disabled'],
    };
    for (const [buffer, [state, text]] of Object.entries(expected)) {
      const row = byKey(readyOf({ buffer })).buffer;
      expect([row.state, row.text], buffer).toEqual([state, text]);
    }
    expect(byKey(readyOf({ buffer: 'storage_unavailable' })).buffer.note).toMatch(/clips folder is not usable/);
    expect(byKey(readyOf({ buffer: 'not_needed' })).buffer.note).toMatch(/Nothing is set up to record/);
    expect(byKey(readyOf({ buffer: 'ready' })).buffer.note).toBeNull();
    // A word the server adds later is shown, not dropped.
    expect(byKey(readyOf({ buffer: 'something_new' })).buffer.text).toBe('something_new');
  });

  test('a disabled camera says so on each recording row rather than "waiting on the buffer"', () => {
    const r = byKey(readyOf({ buffer: 'camera_disabled', wake_clip_ready: false, manual_recording_available: false }, { detect_record_clips: 1 }));
    for (const k of ['alertClips', 'wake', 'manual']) expect(r[k], k).toMatchObject({ state: 'off', text: 'Camera disabled' });
  });

  test('every detector answer, motion and sound alike', () => {
    const expected = {
      running: ['ok', 'Running'], not_running: ['bad', 'Not running'], camera_side: ['off', 'Reported by the camera'], off: ['off', 'Off'],
    };
    for (const [v, [state, text]] of Object.entries(expected)) {
      const r = byKey(readyOf({ motion: v, sound: v }));
      expect([r.motion.state, r.motion.text], `motion ${v}`).toEqual([state, text]);
      expect([r.sound.state, r.sound.text], `sound ${v}`).toEqual([state, text]);
    }
  });

  test('alerts firing now: yes; silenced; outside the schedule; nothing to alert on', () => {
    expect(byKey(readyOf()).alerting.text).toBe('Yes');

    const silenced = byKey(readyOf({ alerting_now: false }, { alerts_snoozed_until: NOW + 60000 })).alerting;
    expect(silenced).toMatchObject({ state: 'off', text: 'Silenced' });
    expect(silenced.note).toMatch(/no alert clip until the silence ends/);

    const outside = byKey(readyOf({ alerting_now: false }, { detect_schedule_enabled: 1, detect_start: 60, detect_end: 120 })).alerting;
    expect(outside).toMatchObject({ state: 'off', text: 'Outside the schedule' });
    expect(outside.note).toMatch(/no alert clip until the schedule opens/);

    // When both alert switches are off the question does not apply, whatever the server says.
    const none = byKey(readyOf({ alerting_now: true }, { detect_motion_enabled: 0, detect_sound_enabled: 0 })).alerting;
    expect(none).toMatchObject({ state: 'off', text: 'Nothing to alert on' });
    // Sound alone is enough to alert on.
    expect(byKey(readyOf({}, { detect_motion_enabled: 0, detect_sound_enabled: 1 })).alerting.text).toBe('Yes');
  });

  test('the server’s alert_pause_reason wins over what a stale camera row says (#713 review)', () => {
    // The row (up to 15 s old) still shows a silence, the server says it is the schedule now, and vice versa.
    const staleSilence = { alerts_snoozed_until: NOW + 60000 };
    expect(byKey(readyOf({ alerting_now: false, alert_pause_reason: 'schedule' }, staleSilence)).alerting)
      .toMatchObject({ state: 'off', text: 'Outside the schedule' });
    expect(byKey(readyOf({ alerting_now: false, alert_pause_reason: 'silenced' }, { alerts_snoozed_until: null })).alerting)
      .toMatchObject({ state: 'off', text: 'Silenced' });
    // A server that does not send the field is still read the old way.
    expect(byKey(readyOf({ alerting_now: false }, staleSilence)).alerting.text).toBe('Silenced');
    expect(byKey(readyOf({ alerting_now: false }, {})).alerting.text).toBe('Outside the schedule');
  });

  test('a disabled camera is never "Yes", from the reason or (older server) from the buffer word alone', () => {
    expect(byKey(readyOf({ alerting_now: false, alert_pause_reason: 'disabled', buffer: 'camera_disabled' })).alerting)
      .toMatchObject({ state: 'off', text: 'Camera disabled' });
    // An older server reported alerting_now true for a disabled camera; the panel must not repeat it.
    expect(byKey(readyOf({ alerting_now: true, buffer: 'camera_disabled' })).alerting.text).toBe('Camera disabled');
  });
});

// ---- the panel on its page ---------------------------------------------------------------------------------

let getSpy;
let writeSpies;

const mount = ({ cam = CAM, settings = {}, as = renderAsAdmin, guarded = false } = {}) => {
  const page = <CameraSettings />;
  return as(
    <Routes>
      <Route path="/cameras/:id" element={guarded ? <AdminProtected>{page}</AdminProtected> : page} />
      <Route path="*" element={<div>home</div>} />
    </Routes>,
    { cameras: [cam], kids: KIDS, settings, route: `/cameras/${cam.id}` }
  );
};
const panel = async () => within(await screen.findByRole('region', { name: 'Recording and alerts' }));
const readinessCalls = () => getSpy.mock.calls.filter(([p]) => String(p).includes('recording-readiness'));

beforeEach(() => {
  getSpy = vi.spyOn(api, 'get').mockResolvedValue(READY);
  writeSpies = [vi.spyOn(api, 'post'), vi.spyOn(api, 'put'), vi.spyOn(api, 'del')].map((s) => s.mockResolvedValue({}));
});
afterEach(() => vi.restoreAllMocks());

describe('the panel, as an admin', () => {
  test('both groups render, set-up rows from the camera and ready rows from the server', async () => {
    mount({ cam: { ...CAM, detect_record_clips: 1 } });
    const p = await panel();
    expect(p.getByText('Set up')).toBeTruthy();
    expect(p.getByText('Ready right now')).toBeTruthy();
    expect(await p.findByText('Will be saved')).toBeTruthy();
    expect(p.getByText('Nightlight compares frames')).toBeTruthy();
    expect(p.getByText('Recording buffer')).toBeTruthy();
    expect(readinessCalls().map(([path]) => path)).toEqual(['/cameras/cam-1/recording-readiness']);
  });

  test('while the answer is on its way the set-up rows are already there', async () => {
    getSpy.mockReturnValue(new Promise(() => {}));
    mount();
    const p = await panel();
    expect(p.getByText('Nightlight compares frames')).toBeTruthy();
    expect(p.getByRole('status').textContent).toBe('Checking…');
    expect(p.queryByText('Recording buffer')).toBeNull();
  });

  test('a failed check says so inline and leaves the set-up rows alone; Check again recovers', async () => {
    getSpy.mockRejectedValueOnce(new Error('boom'));
    const { user } = mount();
    const p = await panel();
    expect((await p.findByRole('alert')).textContent).toMatch(/Couldn’t check whether this camera is ready right now/);
    expect(p.getByText('Nightlight compares frames')).toBeTruthy();
    expect(p.queryByText('Recording buffer')).toBeNull();

    await user.click(p.getByRole('button', { name: 'Check again' }));
    expect(await p.findByText('Recording buffer')).toBeTruthy();
    expect(p.queryByRole('alert')).toBeNull();
    expect(readinessCalls()).toHaveLength(2);
  });

  test('a success followed by a FAILED Check again shows the failure, not the old answer (#713 review)', async () => {
    const { user } = mount();
    const p = await panel();
    expect(await p.findByText('Recording buffer')).toBeTruthy();
    getSpy.mockRejectedValueOnce(new Error('boom'));
    await user.click(p.getByRole('button', { name: 'Check again' }));
    expect((await p.findByRole('alert')).textContent).toMatch(/Couldn’t check whether this camera is ready right now/);
    // The stale answer must be gone, or the admin reads it as the result of the recheck.
    expect(p.queryByText('Recording buffer')).toBeNull();
    expect(p.getByText('Nightlight compares frames')).toBeTruthy();
    // And a later success replaces the message again.
    await user.click(p.getByRole('button', { name: 'Check again' }));
    expect(await p.findByText('Recording buffer')).toBeTruthy();
    expect(p.queryByRole('alert')).toBeNull();
  });

  test('a buffer that is not running is shown as a problem with its explanation', async () => {
    getSpy.mockResolvedValue({ ...READY, buffer: 'not_running', wake_clip_ready: false, manual_recording_available: false });
    mount({ cam: { ...CAM, detect_record_clips: 1 } });
    const p = await panel();
    expect(await p.findByText(/It should be running but is not/)).toBeTruthy();
    expect(p.getAllByText('Waiting on the buffer')).toHaveLength(3);
    expect(p.getByText('Not running').className).toMatch(/status-badge--bad/);
  });

  test('a silenced camera: the silence is in "Set up" and "Silenced" is in "Ready right now"', async () => {
    getSpy.mockResolvedValue({ ...READY, alerting_now: false });
    mount({ cam: { ...CAM, alerts_snoozed_until: Date.now() + 3600000, alerts_snoozed_by: 'someone' } });
    const p = await panel();
    expect(await p.findByText('Silenced')).toBeTruthy();
    expect(p.getByText(/^Until .+ by someone$/)).toBeTruthy();
  });

  test('wake clips with no child assigned say why', async () => {
    mount({ cam: { ...CAM, child_id: null } });
    const p = await panel();
    expect(await p.findByText(/Not eligible: no child is assigned to this camera/)).toBeTruthy();
  });

  test('a wake-up setting turned off in Settings → Camera and Recording → Recording is reflected', async () => {
    mount({ settings: { wake_clips_enabled: 0 } });
    const p = await panel();
    expect(await p.findByText(/“Record wake-ups without alerting” is off/)).toBeTruthy();
  });

  test('★ READ-ONLY: no switch, no input, no link in the panel, and no write request from it', async () => {
    const { user } = mount();
    const p = await panel();
    await p.findByText('Recording buffer');
    expect(p.queryAllByRole('switch')).toHaveLength(0);
    expect(p.queryAllByRole('checkbox')).toHaveLength(0);
    expect(p.queryAllByRole('textbox')).toHaveLength(0);
    expect(p.queryAllByRole('link')).toHaveLength(0);
    // The only control is Check again, and it only reads.
    expect(p.getAllByRole('button').map((b) => b.textContent)).toEqual(['Check again']);
    await user.click(p.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(readinessCalls()).toHaveLength(2));
    for (const s of writeSpies) expect(s).not.toHaveBeenCalled();
  });

  test('the panel is not on the add-camera page (there is no camera to describe yet)', async () => {
    renderAsAdmin(
      <Routes><Route path="/cameras/new" element={<CameraSettings />} /></Routes>,
      { cameras: [], kids: KIDS, route: '/cameras/new' }
    );
    await screen.findByLabelText('Name');
    expect(screen.queryByRole('region', { name: 'Recording and alerts' })).toBeNull();
    expect(readinessCalls()).toHaveLength(0);
  });
});

describe('role: the page is admin-only, so the panel and its request are too', () => {
  test('an admin gets the panel through the real guard', async () => {
    mount({ guarded: true });
    expect(await screen.findByRole('region', { name: 'Recording and alerts' })).toBeTruthy();
    await waitFor(() => expect(readinessCalls()).toHaveLength(1));
  });

  test('a caregiver is sent home: no panel, no camera settings, and the readiness route is never asked', async () => {
    mount({ as: renderAsCaregiver, guarded: true });
    expect(await screen.findByText('home')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Recording and alerts' })).toBeNull();
    expect(screen.queryByText('Set up')).toBeNull();
    expect(readinessCalls()).toHaveLength(0);
  });
});
