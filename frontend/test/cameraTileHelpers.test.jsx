// The pure helpers inside CameraTile.
//
// ⚠️ SCOPE, stated plainly: the tile itself is 1039 lines that mount live WebRTC and HLS players, and
// jsdom has no media stack — so the tile's RENDERING, and the three-state audio button in particular,
// are NOT covered here and cannot be. That behaviour belongs to the Playwright e2e suite, which runs a
// real browser against a real image. What follows is the logic that can be tested honestly.
//
// `togglePatch` is the one that earns its keep. Until issue #444, the quick motion/sound toggles on a
// tile sent the WHOLE detection settings object (the old `detectionPayload` helper this replaces) —
// every field had to be carried across from the camera, or flipping motion from a tile silently
// rewrote the camera's sensitivity, cooldown, schedule and MQTT wiring to whatever its fallbacks said.
// Since #444 the tile sends only a PATCH — the fields this toggle actually changes — through the same
// save queue DetectionSettings uses (detectionSaves.js), so the risk `togglePatch` has to guard
// against is narrower but still real: naming a field it did NOT mean to touch, or getting the
// schedule's "seed a real window" default wrong.
import { describe, test, expect } from 'vitest';
import { togglePatch, readingParts, fmtElapsed } from '../src/components/CameraTile.jsx';

describe('togglePatch — a quick toggle sends only what it means to change', () => {
  test('motion: flips just the enabled flag', () => {
    expect(togglePatch({ detect_motion_enabled: 1 }, 'motion')).toEqual({ motion_enabled: false });
    expect(togglePatch({ detect_motion_enabled: 0 }, 'motion')).toEqual({ motion_enabled: true });
  });

  test('sound: flips just the enabled flag', () => {
    expect(togglePatch({ detect_sound_enabled: 1 }, 'sound')).toEqual({ sound_enabled: false });
    expect(togglePatch({ detect_sound_enabled: 0 }, 'sound')).toEqual({ sound_enabled: true });
  });

  test('schedule: enabling a camera that never had a real window seeds the same overnight default the settings screen offers', () => {
    // start === end is how "no real window yet" is stored. The seeded value is given as an HH:MM
    // string — the same shape DetectionSettings' own form state uses — because that's what the save
    // queue's shared field-conversion table (toPartialPayload) expects; it is converted back to
    // minutes (1200/420) on the way out, same as a real edit on the schedule screen would be.
    expect(togglePatch({ detect_schedule_enabled: 0, detect_start: 0, detect_end: 0 }, 'schedule'))
      .toEqual({ schedule_enabled: true, start: '20:00', end: '07:00' });
    // Missing entirely (both default to 0 via `?? 0`) counts as "no window" too.
    expect(togglePatch({ detect_schedule_enabled: 0 }, 'schedule'))
      .toEqual({ schedule_enabled: true, start: '20:00', end: '07:00' });
  });

  test('schedule: enabling a camera that already has a real window leaves it alone — no start/end sent at all', () => {
    // The point of a PATCH: an untouched field isn't resent with its current value, it's just absent,
    // and the server (PUT /:id/detection, issue #443) keeps whatever it already has.
    const out = togglePatch({ detect_schedule_enabled: 0, detect_start: 1140, detect_end: 400 }, 'schedule');
    expect(out).toEqual({ schedule_enabled: true });
    expect('start' in out).toBe(false);
    expect('end' in out).toBe(false);
  });

  test('schedule: disabling never touches start/end, real window or not', () => {
    expect(togglePatch({ detect_schedule_enabled: 1, detect_start: 1140, detect_end: 400 }, 'schedule'))
      .toEqual({ schedule_enabled: false });
    expect(togglePatch({ detect_schedule_enabled: 1, detect_start: 0, detect_end: 0 }, 'schedule'))
      .toEqual({ schedule_enabled: false });
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
