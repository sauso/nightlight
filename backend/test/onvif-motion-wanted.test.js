// Which cameras run an ONVIF motion subscription (issue #564: onvifMotion.js had no test file at all).
//
// `onvifMotionWanted` is the pure half of that module: the reconciler asks it for every camera, and a wrong
// answer either subscribes a camera that should be quiet (a disabled one keeps an ONVIF session open on the
// camera and alerts for a camera the household turned off) or leaves a camera that chose the ONVIF source with no
// alerts at all, silently, because the pixel-diff leg is activity-only for it. Each condition is varied alone
// against an otherwise-wanted camera, so no case can pass through another condition's refusal.
//
// Known limit, documented: startOnvifMotion needs a camera speaking ONVIF events, so the subscription itself is
// the device-bound layer (e2e/manual), not covered here.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const { onvifMotionWanted } = await import('../src/lib/onvifMotion.js');
after(() => cleanupTempDataDirs());

const wanted = { id: 'c1', disabled: 0, detect_motion_enabled: 1, detect_source: 'onvif' };

test('an enabled camera on the ONVIF source with motion detection on is wanted', () => {
  assert.equal(onvifMotionWanted(wanted), true);
});

test('★ each condition alone refuses: disabled, detection off, another source, no camera', () => {
  assert.equal(onvifMotionWanted({ ...wanted, disabled: 1 }), false, 'a disabled camera kept its subscription');
  assert.equal(onvifMotionWanted({ ...wanted, detect_motion_enabled: 0 }), false, 'detection is off but it subscribed');
  for (const source of ['framediff', 'mqtt', '', null, undefined, 'ONVIF']) {
    assert.equal(onvifMotionWanted({ ...wanted, detect_source: source }), false, `source ${JSON.stringify(source)} was treated as ONVIF`);
  }
  assert.equal(onvifMotionWanted(null), false);
  assert.equal(onvifMotionWanted(undefined), false);
});

test('the answer is a real boolean, not a truthy value, for the reconciler\'s strict comparisons', () => {
  assert.strictEqual(onvifMotionWanted({ ...wanted, detect_motion_enabled: 5 }), true);
  assert.strictEqual(onvifMotionWanted({ ...wanted, detect_motion_enabled: 0 }), false);
});
