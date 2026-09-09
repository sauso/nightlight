// The pure helpers inside CameraTile.
//
// ⚠️ SCOPE, stated plainly: the tile itself is 1039 lines that mount live WebRTC and HLS players, and
// jsdom has no media stack — so the tile's RENDERING, and the three-state audio button in particular,
// are NOT covered here and cannot be. That behaviour belongs to the Playwright e2e suite, which runs a
// real browser against a real image. What follows is the logic that can be tested honestly.
//
// `detectionPayload` is the one that earns its keep. The quick motion/sound toggles on a tile do not
// PATCH — they send the WHOLE detection settings object. So every field has to be carried across from
// the camera, or flipping motion from a tile silently rewrites the camera's sensitivity, cooldown,
// schedule and MQTT wiring to whatever these fallbacks say.
import { describe, test, expect } from 'vitest';
import { detectionPayload, readingParts, fmtElapsed } from '../src/components/CameraTile.jsx';

// A camera with every field set to something distinctive, so anything dropped on the way through is
// visible rather than coincidentally equal to a default.
const FULL_CAM = {
  detect_motion_enabled: 1,
  detect_sensitivity: 90,
  detect_cooldown_s: 45,
  detect_confirm_s: 7,
  detect_schedule_enabled: 1,
  detect_start: 1140,
  detect_end: 400,
  detect_source: 'mqtt',
  motion_mqtt_topic: 'testcam/motion',
  motion_mqtt_value: 'ON',
  snapshot_url: 'http://cam/snap.jpg',
  detect_sound_enabled: 1,
  sound_sensitivity: 70,
  sound_confirm_s: 6,
  sound_cooldown_s: 240,
};

describe('detectionPayload — a quick toggle must not rewrite everything else', () => {
  test('every configured value is carried across untouched', () => {
    // If a field is ever dropped from this function, the server receives the fallback instead and the
    // camera is silently reconfigured by someone tapping the motion icon.
    expect(detectionPayload(FULL_CAM, {})).toEqual({
      motion_enabled: true,
      sensitivity: 90,
      cooldown_s: 45,
      confirm_s: 7,
      schedule_enabled: true,
      start: 1140,
      end: 400,
      source: 'mqtt',
      motion_mqtt_topic: 'testcam/motion',
      motion_mqtt_value: 'ON',
      snapshot_url: 'http://cam/snap.jpg',
      sound_enabled: true,
      sound_sensitivity: 70,
      sound_confirm_s: 6,
      sound_cooldown_s: 240,
    });
  });

  test('the patch is applied last, so it wins over the current value', () => {
    const out = detectionPayload(FULL_CAM, { motion_enabled: false });
    expect(out.motion_enabled).toBe(false);
    expect(out.sensitivity).toBe(90); // and nothing else moved
  });

  // ⚠️ These fallbacks only fire when a field is ABSENT from the API response — the columns are all
  // NOT NULL in the schema. Where they differ from the schema default that difference is pinned here,
  // so changing either side becomes a deliberate act:
  //   sensitivity 50, cooldown 60, confirm 3, sound 50/4/120  — all match db.js.
  //   start 1200 / end 420 (20:00–07:00) do NOT: the schema defaults both to 0. Harmless in practice
  //   because schedule_enabled defaults to off, and a bedtime window is a saner "unset" than
  //   midnight-to-midnight — but it is a divergence, not an accident to be tidied away silently.
  test('an empty camera falls back to the documented defaults', () => {
    expect(detectionPayload({}, {})).toEqual({
      motion_enabled: false,
      sensitivity: 50,
      cooldown_s: 60,
      confirm_s: 3,
      schedule_enabled: false,
      start: 1200,
      end: 420,
      source: 'framediff',
      motion_mqtt_topic: '',
      motion_mqtt_value: '',
      snapshot_url: '',
      sound_enabled: false,
      sound_sensitivity: 50,
      sound_confirm_s: 4,
      sound_cooldown_s: 120,
    });
  });

  test('zero is kept on EVERY numeric field, not swallowed by the fallback', () => {
    // `??` rather than `||`: a sensitivity of 0 is not "unset", a cooldown of 0 means no cooldown, and
    // an end time of 0 is midnight. `||` would quietly replace each with a default.
    //
    // ⚠️ All eight are listed on purpose. An earlier version passed zero for only three of them, so
    // switching the other five to `||` changed real behaviour with the suite still green.
    const out = detectionPayload({
      detect_sensitivity: 0,
      detect_cooldown_s: 0,
      detect_confirm_s: 0,
      detect_start: 0,
      detect_end: 0,
      sound_sensitivity: 0,
      sound_confirm_s: 0,
      sound_cooldown_s: 0,
    }, {});
    expect(out).toMatchObject({
      sensitivity: 0, cooldown_s: 0, confirm_s: 0, start: 0, end: 0,
      sound_sensitivity: 0, sound_confirm_s: 0, sound_cooldown_s: 0,
    });
  });

  test('the source is restricted to the three the server knows', () => {
    expect(detectionPayload({ detect_source: 'mqtt' }, {}).source).toBe('mqtt');
    expect(detectionPayload({ detect_source: 'onvif' }, {}).source).toBe('onvif');
    expect(detectionPayload({ detect_source: 'framediff' }, {}).source).toBe('framediff');
    // Anything unrecognised falls back to frame-diff rather than being sent through as-is.
    for (const bad of ['MQTT', 'rubbish', '', null, undefined]) {
      expect(detectionPayload({ detect_source: bad }, {}).source).toBe('framediff');
    }
  });

  test('truthy database integers become real booleans', () => {
    // SQLite stores these as 0/1; the API expects booleans.
    const out = detectionPayload({ detect_motion_enabled: 1, detect_sound_enabled: 0 }, {});
    expect(out.motion_enabled).toBe(true);
    expect(out.sound_enabled).toBe(false);
  });
});

describe('readingParts — room temperature and humidity', () => {
  test('no MQTT data means no readings, not a blank row', () => {
    expect(readingParts(null, 'C')).toEqual([]);
    expect(readingParts(undefined, 'C')).toEqual([]);
    expect(readingParts({}, 'C')).toEqual([]);
  });

  test('celsius is shown to one decimal', () => {
    const [temp] = readingParts({ temperature: 22.46 }, 'C');
    expect(temp.text).toBe('22.5°C');
  });

  test('fahrenheit is converted, not merely relabelled', () => {
    // The bug this catches is a unit switch that changes the suffix and leaves the number alone.
    expect(readingParts({ temperature: 0 }, 'F')[0].text).toBe('32.0°F');
    expect(readingParts({ temperature: 22.5 }, 'F')[0].text).toBe('72.5°F');
    expect(readingParts({ temperature: -10 }, 'F')[0].text).toBe('14.0°F');
  });

  test('humidity is a whole number', () => {
    expect(readingParts({ humidity: 45.6 }, 'C')[0].text).toBe('46%');
  });

  test('each reading appears only when present, in a stable order', () => {
    expect(readingParts({ temperature: 20 }, 'C').map((p) => p.key)).toEqual(['temp']);
    expect(readingParts({ humidity: 50 }, 'C').map((p) => p.key)).toEqual(['humidity']);
    expect(readingParts({ temperature: 20, humidity: 50 }, 'C').map((p) => p.key)).toEqual(['temp', 'humidity']);
  });

  test('a non-numeric reading is skipped rather than rendered as text', () => {
    // MQTT payloads are strings until something parses them, and Number() on a malformed one yields
    // NaN. Neither may reach the screen: a missing reading renders as nothing, not as "NaN°C".
    //
    // ⚠️ The NaN half is why this test exists. It previously ASSERTED that 'NaN°C' was produced —
    // under a name saying the opposite — which locked the leak in and would have failed the moment
    // anyone fixed it. `typeof NaN === 'number'`, so the old guard let it straight through.
    expect(readingParts({ temperature: '22.5', humidity: '50' }, 'C')).toEqual([]);
    expect(readingParts({ temperature: NaN, humidity: NaN }, 'C')).toEqual([]);
    expect(readingParts({ temperature: Infinity, humidity: -Infinity }, 'C')).toEqual([]);
  });

  test('zero is a real reading, not a missing one', () => {
    expect(readingParts({ temperature: 0, humidity: 0 }, 'C').map((p) => p.text)).toEqual(['0.0°C', '0%']);
  });
});

describe('fmtElapsed — the recording timer', () => {
  test('formats as M:SS with a padded seconds field', () => {
    expect(fmtElapsed(0)).toBe('0:00');
    expect(fmtElapsed(5)).toBe('0:05');
    expect(fmtElapsed(59)).toBe('0:59');
    expect(fmtElapsed(60)).toBe('1:00');
    expect(fmtElapsed(65)).toBe('1:05');
    expect(fmtElapsed(600)).toBe('10:00');
  });

  test('rounds fractional seconds rather than showing them', () => {
    expect(fmtElapsed(4.4)).toBe('0:04');
    expect(fmtElapsed(4.6)).toBe('0:05');
  });

  test('a negative elapsed time clamps to zero instead of showing "-1:-1"', () => {
    // Clock skew between the server's start time and the browser can produce this.
    expect(fmtElapsed(-5)).toBe('0:00');
  });

  test('minutes are not capped at 59', () => {
    expect(fmtElapsed(3600)).toBe('60:00');
  });
});
