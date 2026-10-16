// #371: the Sound detection screen says whether the detector is listening, how loud the room has been
// relative to its own ambient level, and what the detector deliberately cannot do.
//
// ★ WHAT THESE TESTS ARE FOR. The screen shows two kinds of claim and each fails differently:
//  1. NUMBERS derived from `GET /cameras/:id/activity-history` (`summariseSoundLevel`, pure). A wrong
//     weighting, a stale-data cut-off that never fires, or a unit slip would still render a calm, plausible
//     sentence, so the maths is pinned with values whose answer is not what a naive version gives.
//  2. STATIC LIMITS TEXT. Those sentences are the point of the issue (an amplitude detector, the 45 s / 5 min
//     absorption, the cooldown). They must be on the screen whenever sound detection is on, and the cooldown
//     figure must be the camera's own, not a copy of the default.
// The live ambient level is not served by any route, so "calibrated" is inferred from stored readings; the
// tests pin that wording as "Listening" / "No sound readings yet" rather than a claim about the baseline.
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, act } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { renderAsAdmin } from './helpers/render.jsx';
import DetectionSettings, { alertMarginDb, summariseSoundLevel } from '../src/pages/DetectionSettings.jsx';
import { api } from '../src/lib/api.js';
import { __resetForTests } from '../src/lib/detectionSaves.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
// A history row `minsAgo` minutes before NOW, in the 'YYYY-MM-DD HH:MM:SS' UTC shape the API returns.
const row = (minsAgo, over = {}) => ({
  t: new Date(NOW - minsAgo * 60000).toISOString().slice(0, 19).replace('T', ' '),
  sound_level: 2, sound_peak: 5, sound_windows: 300, ...over,
});

describe('#371 summariseSoundLevel', () => {
  test('no history at all is "not ready"', () => {
    expect(summariseSoundLevel([], NOW)).toEqual({ ready: false });
    expect(summariseSoundLevel(undefined, NOW)).toEqual({ ready: false });
  });

  test('★ readings older than ten minutes do not count as listening', () => {
    // A detector that stopped 11 minutes ago must not read "Listening" off its last stored minute.
    expect(summariseSoundLevel([row(11)], NOW).ready).toBe(false);
    expect(summariseSoundLevel([row(9)], NOW).ready).toBe(true);
  });

  test('a minute with no readings (sound_windows 0) is not evidence of listening', () => {
    expect(summariseSoundLevel([row(1, { sound_windows: 0 })], NOW).ready).toBe(false);
  });

  test('★ the level is averaged by readings per minute, over the last five minutes only', () => {
    const out = summariseSoundLevel([
      row(2, { sound_level: 10, sound_peak: 20, sound_windows: 100 }),
      row(1, { sound_level: 0, sound_peak: 4, sound_windows: 300 }),
      // Older than five minutes: ready is true because of the rows above, but this must not be averaged in.
      row(8, { sound_level: 40, sound_peak: 60, sound_windows: 300 }),
    ], NOW);
    // (10*100 + 0*300) / 400 = 2.5. An unweighted mean of the two recent minutes would be 5, and including
    // the old row would give 7.14.
    expect(out.avg).toBeCloseTo(2.5, 5);
    expect(out.peak).toBe(20); // the loudest recent minute, not the old row's 60
  });

  test('listening but quiet for five minutes has no figure rather than a made-up zero', () => {
    const out = summariseSoundLevel([row(7)], NOW); // ready (7 < 10) but nothing in the last 5
    expect(out).toEqual({ ready: true, avg: null, peak: null });
  });

  test('a row with an unparseable time is ignored, not turned into a figure', () => {
    expect(summariseSoundLevel([{ t: 'garbage', sound_level: 99, sound_peak: 99, sound_windows: 5 }], NOW).ready).toBe(false);
  });

  // The three boundaries below were unpinned: each mutant (drop the future filter, `>` to `>=`, `<=` to `<`)
  // survived because every other fixture sits well inside or outside a limit. Intended boundaries are the
  // code's: exactly 10 minutes old is still fresh, exactly 5 minutes old is still averaged.
  test('★ a reading dated in the future is ignored, not counted as fresh or averaged', () => {
    // Alone, a future row must not make the detector look like it is listening.
    expect(summariseSoundLevel([row(-3)], NOW)).toEqual({ ready: false });
    // Beside a real recent row, it must not drag the figures (level 50 / peak 90 would swamp 2 / 5).
    const out = summariseSoundLevel([row(1), row(-3, { sound_level: 50, sound_peak: 90 })], NOW);
    expect(out.avg).toBeCloseTo(2, 5);
    expect(out.peak).toBe(5);
  });

  test('★ a reading exactly ten minutes old is still fresh; one second older is not', () => {
    expect(summariseSoundLevel([row(10)], NOW).ready).toBe(true);
    const justOver = { ...row(10), t: new Date(NOW - 10 * 60000 - 1000).toISOString().slice(0, 19).replace('T', ' ') };
    expect(summariseSoundLevel([justOver], NOW).ready).toBe(false);
  });

  test('★ a reading exactly five minutes old is still averaged; one second older is not', () => {
    const at5 = summariseSoundLevel([row(5, { sound_level: 8, sound_peak: 12 })], NOW);
    expect(at5.avg).toBeCloseTo(8, 5);
    expect(at5.peak).toBe(12);
    const justOver = { ...row(5, { sound_level: 8, sound_peak: 12 }), t: new Date(NOW - 5 * 60000 - 1000).toISOString().slice(0, 19).replace('T', ' ') };
    expect(summariseSoundLevel([justOver], NOW)).toEqual({ ready: true, avg: null, peak: null });
  });
});

describe('#371 alertMarginDb', () => {
  test('matches the documented margins: about +18 dB at 1, +11 at 50, +4 at 100', () => {
    expect(alertMarginDb(1)).toBeCloseTo(18, 5);
    expect(alertMarginDb(50)).toBeCloseTo(11.07, 1);
    expect(alertMarginDb(100)).toBeCloseTo(4, 5);
  });
});

// --- the screen -----------------------------------------------------------------------------------------

const CAM = {
  id: 'cam-1', name: 'Nursery', detect_motion_enabled: 0, detect_source: 'framediff', detect_zone: [],
  detect_sound_enabled: 1, sound_sensitivity: 50, sound_confirm_s: 4, sound_cooldown_s: 200,
  detect_schedule_enabled: 0, detect_start: 0, detect_end: 0, detect_record_clips: 0, onvif_motion_capable: 0,
};

function mount(cam = CAM) {
  return renderAsAdmin(
    <Routes><Route path="/cameras/:id/:kind" element={<DetectionSettings />} /></Routes>,
    { cameras: [cam], route: `/cameras/${cam.id}/sound` }
  );
}

beforeEach(() => {
  __resetForTests();
  vi.spyOn(api, 'put').mockResolvedValue({});
  // Only the clock is faked: timers, microtasks and the debounce stay real, so findBy* works unchanged.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('#371 the Sound detection screen', () => {
  test('★ with recent readings it says Listening and gives the level relative to ambient, never absolute', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ hours: 1, samples: [row(1, { sound_level: 3.2, sound_peak: 9.4 })] });
    mount();
    expect(await screen.findByText('Listening.')).toBeInTheDocument();
    expect(screen.getByText('3.2 dB above')).toBeInTheDocument();
    expect(screen.getByText('9.4 dB above')).toBeInTheDocument();
    // The alert line at sensitivity 50, so the level can be read against it.
    expect(screen.getByText('11 dB')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/cameras/cam-1/activity-history?hours=1');
  });

  test('★ it never claims the room has been learned: a muted microphone stores zero readings with no baseline', async () => {
    // A muted microphone (digital silence) is stored as level 0 although the analyser never seeded a baseline,
    // so stored readings prove the detector is listening, not that it is calibrated (review of #711).
    vi.spyOn(api, 'get').mockResolvedValue({ hours: 1, samples: [row(1, { sound_level: 0, sound_peak: 0 })] });
    mount();
    expect(await screen.findByText('Listening.')).toBeInTheDocument();
    const box = screen.getByRole('status');
    expect(box).toHaveTextContent('Sound readings are coming in.');
    expect(box.textContent).not.toMatch(/learned|calibrat/i);
  });

  test('★ with no readings it says so and names the three possible reasons, not one', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ hours: 1, samples: [] });
    mount();
    expect(await screen.findByText('No sound readings yet.')).toBeInTheDocument();
    expect(screen.queryByText('Listening.')).not.toBeInTheDocument();
    expect(screen.getByText(/about 5 seconds to learn the room’s level/)).toBeInTheDocument();
    expect(screen.getByText(/no microphone or the detector may not be running/)).toBeInTheDocument();
  });

  test('★ a failed history request is an inline message, the rest of the screen still works', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('boom'));
    mount();
    expect(await screen.findByText(/Couldn’t read the recent sound levels/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Sensitivity/)).toBeInTheDocument();
    expect(screen.getByText(/What this detector can and can’t do/)).toBeInTheDocument();
  });

  test('★ the deliberate limits are on screen, with this camera’s own cooldown', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ hours: 1, samples: [] });
    mount();
    expect(await screen.findByText(/It measures loudness, not crying/)).toBeInTheDocument();
    expect(screen.getByText(/can’t tell a cry from speech, a television, or a/)).toBeInTheDocument();
    expect(screen.getByText(/after about 45 seconds/)).toBeInTheDocument();
    expect(screen.getByText(/after about\s+5 minutes/)).toBeInTheDocument();
    // 200 is the camera's value, not the 120 default: a hard-coded copy would pass with the default.
    expect(screen.getByText(/After an alert there is a 200-second wait/)).toBeInTheDocument();
    expect(screen.getByText(/no separate “still noisy” follow-up alert/)).toBeInTheDocument();
  });

  test('with sound detection off, neither the calibration nor the limits are shown and nothing is fetched', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ hours: 1, samples: [] });
    mount({ ...CAM, detect_sound_enabled: 0 });
    expect(await screen.findByText(/Turn on to alert when sound stays above/)).toBeInTheDocument();
    expect(screen.queryByText('Calibration')).not.toBeInTheDocument();
    expect(screen.queryByText(/What this detector can and can’t do/)).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  test('the Motion screen is unchanged: no calibration, no history request', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue({ hours: 1, samples: [] });
    renderAsAdmin(
      <Routes><Route path="/cameras/:id/:kind" element={<DetectionSettings />} /></Routes>,
      { cameras: [{ ...CAM, detect_motion_enabled: 1 }], route: '/cameras/cam-1/motion' }
    );
    expect((await screen.findAllByText(/Sensitivity/)).length).toBeGreaterThan(0);
    expect(screen.queryByText('Calibration')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  test('it refreshes every 30 seconds while open, and stops when closed', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const get = vi.spyOn(api, 'get').mockResolvedValue({ hours: 1, samples: [] });
    const { unmount } = mount();
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await act(async () => { vi.advanceTimersByTime(30000); });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    unmount();
    await act(async () => { vi.advanceTimersByTime(120000); });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
