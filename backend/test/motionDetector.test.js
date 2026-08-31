// motionDetector: the two pure functions on the detection path.
//
// Everything else in this module is welded to a spawned ffmpeg process, but these two decide what the
// detector can see at all, and nothing else validates them:
//   * `buildZoneMask` turns a painted `detect_zone` into the pixel mask. It is the single point where
//     "where the bed is" becomes a number, and a whole monitor phase is currently being scored on the
//     assumption that it does so faithfully.
//   * `activeFractionThreshold` decides how much of that zone must change to count as movement.
//
// ⚠️ Two behaviours here are silent failure modes, pinned deliberately below: a zone that is malformed,
// empty, or smaller than four pixels does not error — it falls back to watching the WHOLE FRAME, which
// looks like a working detector that has stopped discriminating.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs, makeChild, makeCamera } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const md = await import('../src/lib/motionDetector.js');

// The analysis frame is a fixed 320x180 gray8 buffer (aspect is deliberately squashed — irrelevant for
// frame-diff, and fixed dimensions let ffmpeg's stdout be sliced into exact frame-sized chunks).
const FW = 320;
const FH = 180;
const FULL_FRAME = FW * FH; // 57600

const zone = (...rects) => ({ detect_zone: JSON.stringify(rects) });

after(() => { db.close(); cleanupTempDataDirs(); });

// --- the sensitivity curve ----------------------------------------------------------------------

test('the sensitivity curve spans 10% of the zone down to 0.2%', () => {
  assert.equal(md.activeFractionThreshold(1).toFixed(4), '0.1000', 'least sensitive: a tenth of the zone');
  assert.equal(md.activeFractionThreshold(100).toFixed(4), '0.0020', 'most sensitive: a five-hundredth');
});

test('the curve is strictly decreasing in sensitivity', () => {
  // Higher sensitivity must always mean an easier trigger; a non-monotonic curve would make the slider
  // behave differently in different parts of its range.
  let prev = Infinity;
  for (let s = 1; s <= 100; s++) {
    const v = md.activeFractionThreshold(s);
    assert.ok(v < prev, `sensitivity ${s} must be easier to trigger than ${s - 1}`);
    prev = v;
  }
});

test('the waypoints the source comment claims are the ones it produces', () => {
  // The comment on this function used to say "~2.5% at 50". The formula has never produced that — it
  // gives 5.15%. A wrong number in a comment about a calibration constant is how a threshold gets
  // "corrected" toward a value nobody measured, so the claim is pinned here rather than trusted.
  assert.equal((md.activeFractionThreshold(50) * 100).toFixed(2), '5.15');
  assert.equal((md.activeFractionThreshold(90) * 100).toFixed(2), '1.19', 'both live cameras run at 90');
});

test('out-of-range and missing sensitivities are clamped, not propagated', () => {
  const at50 = md.activeFractionThreshold(50);
  const at1 = md.activeFractionThreshold(1);
  const at100 = md.activeFractionThreshold(100);
  assert.equal(md.activeFractionThreshold(0), at50, '0 is falsy, so it takes the 50 default');
  assert.equal(md.activeFractionThreshold(undefined), at50);
  assert.equal(md.activeFractionThreshold(NaN), at50);
  assert.equal(md.activeFractionThreshold(-20), at1, 'negatives clamp to the floor, not to the default');
  assert.equal(md.activeFractionThreshold(500), at100);
});

// --- the zone mask ------------------------------------------------------------------------------

test('a rectangle becomes exactly the pixels it covers', () => {
  const { mask, zonePixels } = md.buildZoneMask(zone({ x: 0, y: 0, w: 0.5, h: 0.5 }));
  assert.equal(zonePixels, 160 * 90, 'a quarter of the frame');
  assert.equal(mask[0], 1, 'top-left corner is inside');
  assert.equal(mask[159], 1, 'last pixel of the first row inside the zone');
  assert.equal(mask[160], 0, 'the pixel just past the right edge is outside');
  assert.equal(mask[90 * FW], 0, 'the row just past the bottom edge is outside');
});

// ★ The rounding rule, and why it is nearest-edge rather than outward. The zone picker paints on a
// 32x18 grid whose cells are exactly 10x10 pixels here, but the stored fractions are rounded, so a cell
// edge arrives as 10.016 rather than 10. Rounding outward turned that into a whole extra row AND column
// per rect — a painted cell measuring 121 pixels instead of 100, i.e. a 21% overstatement of the zone,
// compounding with every rect. This test uses the fractions the picker really stores.
test('a painted grid cell is pixel-exact, not inflated by rounding', () => {
  const cell = { x: 0.0313, y: 0.0556, w: 0.0313, h: 0.0556 }; // col 1, row 1 of a 32x18 grid, 4 dp
  const { zonePixels } = md.buildZoneMask(zone(cell));
  assert.equal(zonePixels, 100, 'exactly one 10x10 cell — floor/ceil would give 121');
});

test('overlapping rectangles count each pixel once', () => {
  // Diagonal or overlapping boxes are expected — the picker paints cell by cell — so double-counting
  // would silently shrink the active-fraction denominator and make the camera harder to trigger.
  const a = { x: 0, y: 0, w: 0.5, h: 0.5 };
  const b = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
  const { zonePixels } = md.buildZoneMask(zone(a, b));
  const each = 160 * 90;
  const overlap = 80 * 45;
  assert.equal(zonePixels, each * 2 - overlap);
});

test('rectangles are clamped to the frame rather than overflowing it', () => {
  const { mask, zonePixels } = md.buildZoneMask(zone({ x: -0.5, y: -0.5, w: 5, h: 5 }));
  assert.equal(zonePixels, FULL_FRAME, 'a zone larger than the frame is the whole frame');
  assert.equal(mask[FULL_FRAME - 1], 1, 'and the very last pixel really is set');
});

test('a legacy single-object zone is still honoured', () => {
  // Zones were once stored as one object rather than a list. Those rows still exist in the wild.
  const legacy = { detect_zone: JSON.stringify({ x: 0, y: 0, w: 0.5, h: 0.5 }) };
  assert.equal(md.buildZoneMask(legacy).zonePixels, 160 * 90);
});

// --- the silent fallbacks -----------------------------------------------------------------------

test('no zone means the whole frame, with no mask at all', () => {
  for (const camera of [{}, { detect_zone: null }, { detect_zone: '' }]) {
    const r = md.buildZoneMask(camera);
    assert.equal(r.mask, null, 'a null mask is the signal to skip masking entirely');
    assert.equal(r.zonePixels, FULL_FRAME);
  }
});

test('a malformed or unusable zone falls back to the whole frame instead of erroring', () => {
  // ⚠️ This is the silent failure mode: none of these throw, and the detector keeps running — it just
  // stops discriminating, which looks identical to a working camera until you check the numbers.
  const bad = [
    '{not json',                                   // corrupt
    '[]',                                          // painted then fully erased
    '[{"x":0,"y":0,"w":"0.5","h":0.5}]',           // width arrived as a string
    '[{"x":0,"y":0}]',                             // missing w/h
    '[null]',
    '"a string"',
  ];
  for (const detect_zone of bad) {
    const r = md.buildZoneMask({ detect_zone });
    assert.equal(r.mask, null, `fell back for ${detect_zone}`);
    assert.equal(r.zonePixels, FULL_FRAME);
  }
});

test('a zone under four pixels is treated as no zone', () => {
  // A guard against a zone so small that the active fraction is meaningless — one stray pixel would
  // otherwise be 100% of the zone and every frame would read as motion.
  const tiny = { x: 0, y: 0, w: 0.003, h: 0.005 }; // ~1x1 px
  const r = md.buildZoneMask(zone(tiny));
  assert.equal(r.mask, null);
  assert.equal(r.zonePixels, FULL_FRAME, 'falls back rather than making every frame active');

  // ...and four pixels is enough to be kept, so the boundary is where it claims to be.
  const justEnough = { x: 0, y: 0, w: 2 / FW, h: 2 / FH };
  assert.equal(md.buildZoneMask(zone(justEnough)).zonePixels, 4);
});

// --- which leg runs -----------------------------------------------------------------------------

test('only a framediff camera with motion enabled alerts', () => {
  const on = { detect_motion_enabled: 1, detect_source: 'framediff' };
  assert.equal(md.motionAlerting(on), true);
  // Explicitly '=== framediff', not "anything but mqtt": an ONVIF camera subscribes to camera events
  // and alerts from there, so treating it as a frame-diff alerter would double-alert.
  assert.equal(md.motionAlerting({ ...on, detect_source: 'onvif' }), false);
  assert.equal(md.motionAlerting({ ...on, detect_source: 'mqtt' }), false);
  assert.equal(md.motionAlerting({ ...on, detect_motion_enabled: 0 }), false);
  assert.equal(md.motionAlerting({ ...on, disabled: 1 }), false);
  assert.equal(md.motionAlerting(null), false);
  assert.equal(md.motionAlerting(undefined), false);
});

test('a disabled camera runs no leg at all', () => {
  assert.equal(md.motionLegWanted({ disabled: 1, detect_motion_enabled: 1, detect_source: 'framediff' }), false);
  assert.equal(md.motionLegWanted(null), false);
});

test('a camera with no child and no alerting runs no leg', () => {
  assert.equal(md.motionLegWanted({ detect_source: 'mqtt', detect_motion_enabled: 1 }), false);
});

test('an alerting camera runs its leg regardless of any sleep window', () => {
  // Alert legs are deliberately NOT window-gated — alerts run 24/7, unlike the activity-only leg.
  assert.equal(md.motionLegWanted({ detect_motion_enabled: 1, detect_source: 'framediff' }), true);
});

test('a sleep-tracked child runs the activity-only leg even with alerting off', () => {
  // The point of this leg: an MQTT-source camera (or one with motion alerts off) still feeds the
  // continuous motion timeline that sleep tracking reads, while firing no alerts of its own.
  makeChild(db, { id: 'kid-always', name: 'Always Tracked', track: 1, start: '00:00', end: '23:59' });
  const cam = makeCamera(db, { id: 'cam-kid', name: 'Kid Cam', childId: 'kid-always' });
  const row = { ...cam, child_id: 'kid-always', detect_source: 'mqtt', detect_motion_enabled: 0 };
  assert.equal(md.motionAlerting(row), false, 'it is not an alerting camera');
  assert.equal(md.motionLegWanted(row), true, 'but the leg still runs, to sample activity');
});

test('a child with sleep tracking off runs no activity-only leg', () => {
  makeChild(db, { id: 'kid-off', name: 'Untracked', track: 0, start: '00:00', end: '23:59' });
  const row = { id: 'cam-off', child_id: 'kid-off', detect_source: 'mqtt', detect_motion_enabled: 0 };
  assert.equal(md.motionLegWanted(row), false);
});

test('isDetecting is false for a camera that was never started', () => {
  assert.equal(md.isDetecting('no-such-camera'), false);
});
