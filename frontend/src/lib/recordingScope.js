// What a camera is set up to alert on and record, and whether it is ready to, as plain rows (#394).
//
// Two halves, kept apart on purpose because they answer different questions:
//   describeSetup  SET UP: read straight from the camera's own fields, the children list and the app
//                  settings. Nothing here asks the server anything.
//   describeReady  READY RIGHT NOW: the server's GET /cameras/:id/recording-readiness answer, because only the
//                  server knows whether a process is running. A camera whose setup says "on" can still
//                  have no buffer (#387 was exactly that), and that gap is what this panel exists to show.
//
// READ-ONLY. Nothing in this file writes, and the panel it feeds has no control. Where a row names the
// setting that changes it, it names the SCREEN (the words the screen uses), never a link or a switch.
//
// ⚠️ WORDING THAT MUST STAY TRUE. "A silenced camera, or one outside its schedule, saves no alert clip"
// is not a UI choice, it is how the server works: the schedule and the silence stop the alert itself, and
// a clip belongs to an alert (docs/recording.md, "Alert clips"). Do not soften it to "may": it is
// the sentence the issue asks to have beside the controls so that "stop the notifications" is not mistaken
// for "keep every alert clip".
import { formatInZone, resolveZone, TIME } from './homeTime.js';

const minToHHMM = (m) => `${String(Math.floor((m || 0) / 60)).padStart(2, '0')}:${String((m || 0) % 60).padStart(2, '0')}`;

// The motion sources, in the words the Motion screen uses. An unknown value (a source added by a newer
// server) is shown as it is rather than hidden or guessed at.
const SOURCE_TEXT = {
  framediff: 'Nightlight compares frames',
  onvif: 'The camera’s own motion events (ONVIF)',
  mqtt: 'The camera’s own motion events (MQTT)',
};

// `kids` is the children list the app already holds; `settings` the admin settings. A settings value that
// is absent is treated as the server's own default (all three of these default to ON), exactly as
// SettingsRecording does with `??`, so a screen that renders before settings arrive does not claim "off".
export function describeSetup({ cam, kids = [], settings = {}, now = Date.now() }) {
  const zone = resolveZone(settings.timezone);
  const kid = cam.child_id ? kids.find((k) => k.id === cam.child_id) : null;
  const wakeOn = settings.wake_clips_enabled ?? true;
  const manualOn = settings.ondemand_enabled ?? true;
  const snoozedUntil = cam.alerts_snoozed_until && cam.alerts_snoozed_until > now ? cam.alerts_snoozed_until : null;

  // Why a wake clip is NOT possible, as every reason that applies (not just the first): an admin who fixes
  // one should not be surprised by the next.
  const wakeWhy = [];
  if (!wakeOn) wakeWhy.push('“Record wake-ups without alerting” is off in Settings → Recording');
  if (!cam.child_id) wakeWhy.push('no child is assigned to this camera');
  else if (kid && !kid.track_sleep) wakeWhy.push('sleep tracking is off for the assigned child');

  return [
    {
      key: 'motion',
      label: 'Motion alerts',
      value: cam.detect_motion_enabled ? (SOURCE_TEXT[cam.detect_source] || String(cam.detect_source || 'Unknown source')) : 'Off',
      on: !!cam.detect_motion_enabled,
    },
    { key: 'sound', label: 'Sound alerts', value: cam.detect_sound_enabled ? 'On' : 'Off', on: !!cam.detect_sound_enabled },
    {
      key: 'schedule',
      // Not "Alert schedule": that is the Detection row's own label on the same page, and two
      // identical labels read as one control to a screen reader and to the tests that find it by text.
      label: 'Schedule and timezone',
      value: cam.detect_schedule_enabled && (cam.detect_start | 0) !== (cam.detect_end | 0)
        ? `${minToHHMM(cam.detect_start)}–${minToHHMM(cam.detect_end)} (${zone})`
        : 'Always',
      // Equal start and end is how the server reads "no window" (lib/detectSchedule.js): always on, never off.
      note: cam.detect_schedule_enabled ? 'Judged in the app’s timezone, not this device’s.' : null,
    },
    {
      key: 'snooze',
      label: 'Silence',
      value: snoozedUntil
        ? `Until ${formatInZone(new Date(snoozedUntil), zone, TIME)}${cam.alerts_snoozed_by ? ` by ${cam.alerts_snoozed_by}` : ''}`
        : 'Not silenced',
      on: !!snoozedUntil,
      note: 'Silencing, like the schedule, stops the alert itself, not just the notification.',
    },
    {
      key: 'alertClips',
      label: 'Alerts save a clip',
      value: cam.detect_record_clips ? 'Yes' : 'No',
      on: !!cam.detect_record_clips,
      note: cam.detect_record_clips
        ? 'A clip is cut only when an alert fires. A silenced camera, or one outside its schedule, raises no alert and so saves no clip. “Save a clip when triggered” is under Motion or Sound detection.'
        : 'Alerts are still logged with a snapshot, without video. “Save a clip when triggered” is under Motion or Sound detection.',
    },
    {
      key: 'wake',
      label: 'Wake clips',
      value: wakeWhy.length ? 'Not eligible' : 'Eligible',
      on: !wakeWhy.length,
      // Wake clips have their own trigger (the sleep tracker), so the silence and the schedule do not stop
      // them, and they send nothing.
      note: wakeWhy.length
        ? `Not eligible: ${wakeWhy.join('; ')}.`
        : 'Triggered by the sleep tracker, not by an alert: silent, and not stopped by a silence or the schedule.',
    },
    {
      key: 'manual',
      label: 'Manual recording',
      value: manualOn ? 'On' : 'Off',
      on: !!manualOn,
      note: manualOn ? 'The Record button on the camera’s tile.' : '“Show a Record button on each camera” is off in Settings → Recording.',
    },
  ];
}

const DETECTOR_TEXT = {
  running: { state: 'ok', text: 'Running' },
  not_running: { state: 'bad', text: 'Not running' },
  camera_side: { state: 'off', text: 'Reported by the camera' },
  off: { state: 'off', text: 'Off' },
};

// Why the buffer is not ready, in the words of the thing to do. 'not_running' is the residual: the server
// cannot tell "still starting" from "failed to start", so the text does not pretend to.
const BUFFER_TEXT = {
  ready: { state: 'ok', text: 'Ready', note: null },
  not_running: {
    state: 'bad',
    text: 'Not running',
    note: 'It should be running but is not. This is normal for a moment after a change; if it stays, check the clips folder and the logs.',
  },
  not_needed: {
    state: 'off',
    text: 'Not needed',
    note: 'Nothing is set up to record from this camera: alert clips, the Record button and wake clips are all off for it.',
  },
  storage_unavailable: {
    state: 'bad',
    text: 'Storage unavailable',
    note: 'The clips folder is not usable (not writable, or not a mapped volume), so nothing can be recorded. See the README’s recording storage section.',
  },
  camera_disabled: { state: 'off', text: 'Camera disabled', note: null },
};

// `setup` is describeSetup's rows (so the "ready" text can say WHY, using what the panel already shows);
// `readiness` is the server's answer, or null while it is loading or when it could not be fetched.
export function describeReady({ cam, setup, readiness }) {
  if (!readiness) return null;
  const on = (key) => !!setup.find((r) => r.key === key)?.on;
  const buffer = BUFFER_TEXT[readiness.buffer] || { state: 'off', text: String(readiness.buffer), note: null };
  const bufferReady = readiness.buffer === 'ready';
  const motion = DETECTOR_TEXT[readiness.motion] || { state: 'off', text: String(readiness.motion) };
  const sound = DETECTOR_TEXT[readiness.sound] || { state: 'off', text: String(readiness.sound) };

  // The three things that cut from the buffer, each judged against it: a setting that is "on" with no
  // buffer is the gap this panel is for, and is shown as a problem, not as "off".
  const disabled = readiness.buffer === 'camera_disabled';

  // "Alerts firing now" needs a reason when it is no. The server names it (`alert_pause_reason`, computed
  // in the same instant as `alerting_now`). The camera row this panel holds can be up to 15 s stale, so the
  // old inference from it (a silence still in the row, else "the schedule") is only the fallback for a
  // server that does not send the field, and it must never override a reason the server did send.
  const reason = readiness.alert_pause_reason;
  let alerting;
  if (!on('motion') && !on('sound')) alerting = { state: 'off', text: 'Nothing to alert on', note: 'Motion and sound alerts are both off.' };
  else if (disabled || reason === 'disabled') alerting = { state: 'off', text: 'Camera disabled', note: null };
  else if (readiness.alerting_now) alerting = { state: 'ok', text: 'Yes', note: null };
  else if (reason === 'silenced' || (reason !== 'schedule' && on('snooze'))) alerting = { state: 'off', text: 'Silenced', note: 'No alert, no notification and no alert clip until the silence ends.' };
  else alerting = { state: 'off', text: 'Outside the schedule', note: 'No alert, no notification and no alert clip until the schedule opens.' };
  const clip = (wanted, ready, okText, offText) => {
    if (disabled) return { state: 'off', text: 'Camera disabled' };
    if (!wanted) return { state: 'off', text: offText };
    return ready ? { state: 'ok', text: okText } : { state: 'bad', text: 'Waiting on the buffer' };
  };

  return [
    { key: 'motion', label: 'Motion detector', ...motion },
    { key: 'sound', label: 'Sound detector', ...sound },
    { key: 'alerting', label: 'Alerts firing now', ...alerting },
    { key: 'buffer', label: 'Recording buffer', ...buffer },
    {
      key: 'alertClips',
      label: 'Alert clips',
      ...clip(!!cam.detect_record_clips, bufferReady, 'Will be saved', 'Not saving'),
    },
    {
      key: 'wake',
      label: 'Wake clips',
      ...clip(on('wake'), readiness.wake_clip_ready, 'Ready', 'Not eligible'),
    },
    {
      key: 'manual',
      label: 'Manual recording',
      ...clip(on('manual'), readiness.manual_recording_available, 'Available', 'Off'),
    },
  ];
}
