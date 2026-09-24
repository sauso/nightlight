// backend/src/lib/detectSchedule.js's inActiveWindow() — the shared "is this camera inside its
// motion-alert window right now?" gate used by both the frame-diff and MQTT/ONVIF detection paths.
//
// ⚠️ UNTESTED BEFORE #443, and the fix for that issue makes its "start === end ⇒ always active"
// branch load-bearing for the first time in normal operation. Before #443, the frontend never let a
// saved schedule reach `schedule_enabled=1` with a genuinely equal start/end — DetectionSettings.jsx
// always substituted a real 20:00/07:00 window on the very next save. #443's fix makes "enabled,
// all-day" a normal, reachable, persisted state, so the correctness of preserving it now depends
// entirely on this function treating it as "always active" rather than "never active" or crashing.
// Found untested by adversarial review of that fix: mutating `if (start === end) return true;` to
// `return false;` left the full 1391-test backend suite green.
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { inActiveWindow } = await import('../src/lib/detectSchedule.js');

const CAM = 'cam-sched';

beforeEach(() => {
  db.prepare('DELETE FROM cameras WHERE id = ?').run(CAM);
  makeCamera(db, { id: CAM });
});

after(() => cleanupTempDataDirs());

describe('inActiveWindow', () => {
  test('★★ equal start/end means always active, even with scheduling ON (#443)', () => {
    // The exact rule #443's fix depends on: preserving a stored start===end value across an
    // unrelated edit is only the RIGHT thing to do because this returns true for it. A baby monitor
    // that silently stopped alerting because "all-day" got misread as "never" would be far worse
    // than the bug #443 fixed.
    const camera = { id: CAM, detect_schedule_enabled: 1, detect_start: 0, detect_end: 0 };
    assert.equal(inActiveWindow(camera), true);
  });

  test('a non-zero equal pair is also all-day, not just 0/0', () => {
    const camera = { id: CAM, detect_schedule_enabled: 1, detect_start: 630, detect_end: 630 };
    assert.equal(inActiveWindow(camera), true);
  });

  test('scheduling OFF is always active regardless of start/end', () => {
    const camera = { id: CAM, detect_schedule_enabled: 0, detect_start: 1140, detect_end: 400 };
    assert.equal(inActiveWindow(camera), true);
  });

  test('a snoozed camera is never active, even when the schedule would otherwise always allow it', () => {
    // Gives this file at least one case that must return FALSE — otherwise a mutant that makes the
    // whole function unconditionally `return true` would pass every test above.
    db.prepare('UPDATE cameras SET alerts_snoozed_until = ? WHERE id = ?').run(Date.now() + 60_000, CAM);
    const camera = { id: CAM, detect_schedule_enabled: 1, detect_start: 0, detect_end: 0 };
    assert.equal(inActiveWindow(camera), false);
  });

  test('an expired snooze no longer suppresses alerts', () => {
    db.prepare('UPDATE cameras SET alerts_snoozed_until = ? WHERE id = ?').run(Date.now() - 60_000, CAM);
    const camera = { id: CAM, detect_schedule_enabled: 1, detect_start: 0, detect_end: 0 };
    assert.equal(inActiveWindow(camera), true);
  });

  // A real (non-equal) window's truth depends on the wall-clock minute-of-day, computed here the
  // same way nowMinutesInAppTz() does for a fresh temp DB (no timezone row ⇒ falls back to UTC), so
  // these don't hard-code a specific clock time. A few minutes of margin keeps this from flaking at
  // the exact boundary while still proving the equal-start/end branch does NOT swallow the
  // unequal-window case into "always true" too.
  function currentUtcMinutes() {
    const d = new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }

  test('a real window containing "now" is active', () => {
    const now = currentUtcMinutes();
    const start = (now - 3 + 1440) % 1440;
    const end = (now + 3) % 1440;
    const camera = { id: CAM, detect_schedule_enabled: 1, detect_start: start, detect_end: end };
    assert.equal(inActiveWindow(camera), true);
  });

  test('a real window excluding "now" is NOT active', () => {
    const now = currentUtcMinutes();
    const start = (now + 30) % 1440;
    const end = (now + 40) % 1440;
    const camera = { id: CAM, detect_schedule_enabled: 1, detect_start: start, detect_end: end };
    assert.equal(inActiveWindow(camera), false);
  });
});
