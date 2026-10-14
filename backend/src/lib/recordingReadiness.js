import { isClipCapturing, clipRingWanted } from './clipCapture.js';
import { clipStorageReady } from './clipStorage.js';
import { getOndemandSettings, getWakeClipSettings } from './recordings.js';
import { isDetecting } from './motionDetector.js';
import { isOnvifMotion } from './onvifMotion.js';
import { isSoundDetecting } from './soundDetector.js';
import { inActiveWindow } from './detectSchedule.js';
import { childTracksSleep } from './sleepAnalysis.js';

// "Is this camera ready RIGHT NOW to save what it is configured to save?" (#394).
//
// The camera settings page shows two things side by side: what is SET UP (read from the camera's own
// fields, in the browser) and what is READY (this module, because only the server knows whether a
// process is running). Both exist because the ring buffer that every kind of recording reaches back into
// is a hidden dependency: three features share it (detection clips, manual recording, wake clips), it
// only runs when one of them wants it AND the clips folder is usable, and a camera whose settings all
// read "on" can still have no buffer. #387 was exactly that for wake clips: configured, silently inert.
//
// READ-ONLY, AND NOT A SECOND SOURCE OF TRUTH. Every answer below is asked of the module that owns it
// (clipCapture, motionDetector, onvifMotion, soundDetector, detectSchedule); nothing is re-derived
// here. The one exception is `manual_recording_available`, which restates publicCamera's `can_record`
// expression because that function is private to routes/cameras.js; recording-readiness.test.js
// asserts the two agree, so a change to one fails until the other follows.
//
// WHAT IS RETURNED: booleans and short enums only. No name, no address, no path, no number of
// bytes, no error text: this is a status page, and anything richer is a place for a secret to leak.

// The ring buffer, as one word. Order matters: a running ring is "ready" whatever else is true (a
// deferred stop, or a camera whose settings just changed), and only a ring that is NOT running needs
// a reason. 'storage_unavailable' is checked before 'not_running' because it is the cause the person
// can act on (map the clips folder); 'not_running' is the residual "should be up, is not": starting,
// or ffmpeg failing to launch. It is deliberately NOT split further: the server cannot tell those two apart.
export function bufferState({ disabled, running, wanted, storageReady }) {
  if (disabled) return 'camera_disabled';
  if (running) return 'ready';
  if (!wanted) return 'not_needed';
  if (!storageReady) return 'storage_unavailable';
  return 'not_running';
}

// The motion source's process, as an enum. 'off' covers both "motion detection is off" and "the camera
// is disabled": neither runs, and both mean "nothing is expected". 'camera_side' is the MQTT source:
// the camera (or its hub) decides and Nightlight only listens, so there is no per-camera process to
// be running or not, and claiming 'running' would be a statement nobody checked.
export function motionState(cam, { framediffRunning, onvifRunning }) {
  if (cam.disabled || !cam.detect_motion_enabled) return 'off';
  if (cam.detect_source === 'mqtt') return 'camera_side';
  if (cam.detect_source === 'onvif') return onvifRunning ? 'running' : 'not_running';
  return framediffRunning ? 'running' : 'not_running';
}

// Sound detection has one source (the camera's audio), so only on/off and running.
export function soundState(cam, { running }) {
  if (cam.disabled || !cam.detect_sound_enabled) return 'off';
  return running ? 'running' : 'not_running';
}

/**
 * The full readiness answer for one camera row (SELECT * FROM cameras).
 * Pure reads; never starts, stops or reconciles anything (reconciling writes to MediaMTX and
 * restarts publishers, see the architecture invariants).
 */
export function recordingReadiness(cam) {
  const running = isClipCapturing(cam.id);
  const disabled = !!cam.disabled;
  const storageReady = clipStorageReady();
  const wakeCapable = !disabled && !!cam.child_id && childTracksSleep(cam.child_id) && getWakeClipSettings().enabled;
  return {
    buffer: bufferState({ disabled, running, wanted: clipRingWanted(cam), storageReady }),
    storage_ready: storageReady,
    // A wake clip is cut from the ring, so "eligible" (settings) is not "ready" (settings AND a ring).
    wake_clip_ready: wakeCapable && running,
    manual_recording_available: getOndemandSettings().enabled && running && !disabled,
    motion: motionState(cam, { framediffRunning: isDetecting(cam.id), onvifRunning: isOnvifMotion(cam.id) }),
    sound: soundState(cam, { running: isSoundDetecting(cam.id) }),
    // inActiveWindow is the SAME function the detectors call before raising an alert, so this is the
    // server's verdict in the app's timezone, not a browser re-computation of it. False while
    // silenced or outside the schedule; true when there is no schedule.
    alerting_now: inActiveWindow(cam),
  };
}
