// #904: the faulty-microphone guard's pure rule (lib/micGuard.js). Each boundary is tested on both sides, one
// mutant each: change a constant or flip a comparison and exactly one of these goes red. The rule's effect on a
// whole night (computeNight) is tested in sleep-faulty-mic.test.js.
//
// Timelines are written as strings, one character per elapsed minute: `S` a watched spike-only minute, `q` a
// watched minute that is not spike-only (quiet, or a real sound), `.` an unwatched minute (no row, or no video).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

// SLEEP_THRESHOLDS lives in sleepAnalysis.js, which opens the database when it loads: a throwaway one. micGuard.js
// itself imports nothing (the threshold is passed in, see isSpikeOnlyMinute), so only this test needs it.
useTempDataDir();
const { SLEEP_THRESHOLDS } = await import('../src/lib/sleepAnalysis.js');
const { default: db } = await import('../src/db.js');
const {
  isSpikeOnlyMinute, discountedMinutes, SPIKE_P75_MAX, WINDOW_MIN, WINDOW_FRACTION, MIN_WATCHED,
} = await import('../src/lib/micGuard.js');

after(() => { db.close(); cleanupTempDataDirs(); });

const { SOUND_ACTIVE } = SLEEP_THRESHOLDS;

// '480S' style run-length pieces, so a 1,200-minute timeline is readable: tl('300S', '600.', '300S').
function tl(...pieces) {
  const out = [];
  for (const p of pieces) {
    const m = /^(\d+)([Sq.])$/.exec(p);
    assert.ok(m, `bad piece ${p}`);
    for (let k = 0; k < Number(m[1]); k++) out.push(m[2] === '.' ? null : { spikeOnly: m[2] === 'S' });
  }
  return out;
}
const count = (arr) => arr.filter(Boolean).length;
// Indices of the true entries, compressed into [from, to) runs, so a failure says WHERE.
function runs(arr) {
  const r = [];
  for (let i = 0; i < arr.length; i++) {
    if (!arr[i]) continue;
    let j = i;
    while (j < arr.length && arr[j]) j++;
    r.push([i, j]);
    i = j;
  }
  return r;
}

describe('#904 isSpikeOnlyMinute: loud only in brief spikes', () => {
  test('p75 boundary: at SPIKE_P75_MAX is spike-only, just over it is not', () => {
    assert.equal(isSpikeOnlyMinute({ soundPeak: 15, soundP75: 4 }, SOUND_ACTIVE), true);
    assert.equal(isSpikeOnlyMinute({ soundPeak: 15, soundP75: 4.01 }, SOUND_ACTIVE), false);
    assert.equal(isSpikeOnlyMinute({ soundPeak: 15, soundP75: 0 }, SOUND_ACTIVE), true, 'the fault: p75 at the floor');
    assert.equal(isSpikeOnlyMinute({ soundPeak: 25, soundP75: 12 }, SOUND_ACTIVE), false, 'a sustained cry raises p75');
  });

  test('peak boundary: a peak AT SOUND_ACTIVE is not loud, just over it is', () => {
    assert.equal(isSpikeOnlyMinute({ soundPeak: SOUND_ACTIVE, soundP75: 0 }, SOUND_ACTIVE), false);
    assert.equal(isSpikeOnlyMinute({ soundPeak: SOUND_ACTIVE + 0.01, soundP75: 0 }, SOUND_ACTIVE), true);
    assert.equal(isSpikeOnlyMinute({ soundPeak: 0.5, soundP75: 0 }, SOUND_ACTIVE), false, 'a quiet minute is not spike-only');
  });

  test('a NULL p75 is not spike-only (the safe default), nor is a NULL peak', () => {
    assert.equal(isSpikeOnlyMinute({ soundPeak: 15, soundP75: null }, SOUND_ACTIVE), false);
    assert.equal(isSpikeOnlyMinute({ soundPeak: 15, soundP75: undefined }, SOUND_ACTIVE), false);
    assert.equal(isSpikeOnlyMinute({ soundPeak: 15 }, SOUND_ACTIVE), false);
    assert.equal(isSpikeOnlyMinute({ soundPeak: null, soundP75: 0 }, SOUND_ACTIVE), false);
  });

  test('the threshold is required: a missing one throws instead of silently switching the guard off', () => {
    assert.throws(() => isSpikeOnlyMinute({ soundPeak: 15, soundP75: 0 }), TypeError);
    assert.throws(() => isSpikeOnlyMinute({ soundPeak: 15, soundP75: 0 }, '6'), TypeError);
    assert.throws(() => isSpikeOnlyMinute({ soundPeak: 15, soundP75: 0 }, NaN), TypeError);
  });
});

describe('#904 discountedMinutes: spike-only minutes inside a qualifying 8-hour window', () => {
  // Not a behaviour test: it says which numbers the boundaries below were written for, so a deliberate change to one
  // fails here with its name first. Each boundary test below also fails on its own when its constant moves.
  test('preconditions: the constants the boundaries below are written for', () => {
    assert.equal(SPIKE_P75_MAX, 4);
    assert.equal(WINDOW_MIN, 480);
    assert.equal(MIN_WATCHED, 384);
    assert.equal(WINDOW_FRACTION, 0.7);
  });

  test('a whole window of spike-only minutes is discounted; a quiet timeline is not; the output is the input length', () => {
    const all = discountedMinutes(tl('480S'));
    assert.equal(all.length, 480);
    assert.equal(count(all), 480);
    assert.equal(count(discountedMinutes(tl('1440q'))), 0);
    assert.deepEqual(discountedMinutes([]), []);
    assert.throws(() => discountedMinutes(null), TypeError);
  });

  test('WINDOW_MIN boundary: a timeline one minute short of a window is never judged (a window must fit whole)', () => {
    // 479 spike-only minutes: no window of 480 fits, so nothing is discounted, however faulty it looks. This is
    // what gives a night in progress no discount until 480 minutes of its timeline exist.
    assert.equal(count(discountedMinutes(tl('479S'))), 0);
    assert.equal(count(discountedMinutes(tl('480S'))), 480);
  });

  test('WINDOW_FRACTION boundary: exactly 70% of the watched minutes qualifies, one minute fewer does not', () => {
    // One window only (the timeline is exactly 480 long), all watched: 336/480 = 0.70 exactly.
    const at = discountedMinutes(tl('336S', '144q'));
    assert.equal(count(at), 336, '336 of 480 is 0.70: every spike-only minute is discounted');
    assert.deepEqual(runs(at), [[0, 336]], 'and only the spike-only ones');
    assert.equal(count(discountedMinutes(tl('335S', '145q'))), 0, '335 of 480 is just under 0.70');
  });

  test('MIN_WATCHED boundary: 384 watched minutes in the window is enough, 383 is not', () => {
    // Every watched minute is spike-only, so the share is 1.0 either way: only the watched count decides.
    assert.equal(count(discountedMinutes(tl('384S', '96.'))), 384);
    assert.equal(count(discountedMinutes(tl('383S', '97.'))), 0);
  });

  test('unwatched minutes count neither as spike-only nor as quiet in a window\'s share', () => {
    // 300 spike-only, 90 quiet, 90 unwatched in one window: 300 of 390 WATCHED = 0.77, qualifies. Counted as quiet,
    // the 90 unwatched would make it 300/480 = 0.625 and it would not.
    assert.equal(count(discountedMinutes(tl('300S', '90q', '90.'))), 300);
    // 260 spike-only, 130 quiet, 90 unwatched: 260/390 = 0.667, does not qualify. Counted as spike-only, the 90
    // unwatched would make it 350/480 = 0.73 and it would.
    assert.equal(count(discountedMinutes(tl('260S', '130q', '90.'))), 0);
  });

  test('the window is ELAPSED minutes: spike-only minutes either side of a long outage are not joined into one', () => {
    // 300 + 300 spike-only minutes with 600 unwatched between: every 480-minute window holds at most 300 watched
    // minutes, under MIN_WATCHED, so nothing qualifies. A window of 480 WATCHED minutes would join the two halves
    // across the gap into one all-spike window, and discount all 600.
    assert.equal(count(discountedMinutes(tl('300S', '600.', '300S'))), 0);
    // The plan's shape: nine spike-only minutes, a long outage, one more.
    assert.equal(count(discountedMinutes(tl('9S', '1000.', '1S'))), 0);
  });

  test('only spike-only minutes are discounted: a real sound inside a faulty stretch keeps counting', () => {
    // A faulty 8 hours with a 10-minute sustained cry (`q`: loud with a raised p75) in the middle.
    const d = discountedMinutes(tl('235S', '10q', '235S'));
    assert.equal(count(d), 470);
    assert.deepEqual(runs(d), [[0, 235], [245, 480]], 'the cry\'s minutes are never discounted');
  });

  test('a minute is discounted only when it lies inside a qualifying window, not merely near one', () => {
    // 480 spike-only minutes, 199 quiet, then one lone spike-only minute at 679. Every window containing 679 starts
    // at 200 or later and holds at most 281 spike-only minutes of 480 (0.585), so it is not discounted even though an
    // earlier window qualified.
    const d = discountedMinutes(tl('480S', '199q', '1S', '320q'));
    assert.deepEqual(runs(d), [[0, 480]]);
    assert.equal(d[679], false);
  });

  test('recovery: once the microphone is fixed its sound counts again, after the last qualifying window has passed', () => {
    // Faulty for 10 hours, then clean for 10, with one spike-only minute every hour of the clean half (an ordinary
    // short noise, or a short motionless cry) at 659, 719, 779, ... The faulty half is discounted. In the clean half
    // only the spike-only minutes that an 8-hour window still reaching back into the fault covers are: 719 sits in
    // [240, 720), 362 of 480 spike-only, so it is; 779 needs a window starting at 300 or later, at most 303 of 480,
    // so from 779 on the sound counts. The stated cost of an 8-hour window (micGuard.js, discountedMinutes): with no
    // gap in watching, up to (1 - 0.70) x 480 = 144 minutes either side of a fault; a gap lets it reach further (the
    // next test). A minute that is not spike-only never is.
    const pieces = ['600S'];
    for (let h = 0; h < 10; h++) pieces.push('59q', '1S');
    const d = discountedMinutes(tl(...pieces));
    assert.deepEqual(runs(d), [[0, 600], [659, 660], [719, 720]]);
  });

  // The documented bound (micGuard.js, discountedMinutes, "HOW FAR, derived"): a window must hold >= 384 watched
  // minutes of which >= 70% are spike-only, i.e. >= 269 spike-only (the minute itself among them), so at most 211
  // minutes of it are quiet or unwatched: 115 quiet watched (3/7 of 269, the 0.70 share) plus 96 unwatched (480 - 384).
  // Unwatched minutes do not count against a window's share, so a camera gap lets a spike-only minute be discounted
  // up to 212 minutes after the fault's last minute, not the 144 of the no-gap case. Each limit is tested at its
  // edge and one past it, so a change to MIN_WATCHED or WINDOW_FRACTION (or to a window that counts the gap as
  // quiet) turns exactly one of them.
  describe('how far past a fault a lone spike-only minute is still discounted', () => {
    // 600 faulty minutes, then `between` (the pieces between the fault and the minute), then one spike-only minute.
    // The fault itself is discounted either way (a whole window of it); only the last minute is under test.
    const lastIsDiscounted = (...between) => {
      const tail = tl('600S', ...between, '1S');
      const d = discountedMinutes(tail);
      assert.equal(d.slice(0, 600).every(Boolean), true, 'precondition: the fault itself is discounted');
      return d[tail.length - 1];
    };

    test('at the edge: 115 quiet + 96 unwatched minutes between (212 after the fault) is discounted', () => {
      assert.equal(lastIsDiscounted('115q', '96.'), true);
      // The order inside the gap does not matter, only the counts.
      assert.equal(lastIsDiscounted('96.', '115q'), true);
    });

    test('one past on WINDOW_FRACTION: a 116th quiet minute (268/384 = 0.698) is not', () => {
      assert.equal(lastIsDiscounted('116q', '96.'), false);
    });

    test('one past on the unwatched allowance: a 97th unwatched minute leaves the window under 384 watched', () => {
      assert.equal(lastIsDiscounted('115q', '97.'), false);
    });

    test('one past on MIN_WATCHED alone: 114 quiet + 97 unwatched is 383 watched, enough share (269/383) but too few', () => {
      assert.equal(lastIsDiscounted('114q', '97.'), false);
    });

    test('with no gap in watching the bound is the 144 quiet minutes: 144 is discounted, 145 is not', () => {
      assert.equal(lastIsDiscounted('144q'), true);
      assert.equal(lastIsDiscounted('145q'), false);
    });

    test('a 269-minute fault, a 96-minute gap, 110 quiet minutes, then a 5-minute spike-only run (the reviewer\'s case)', () => {
      // The run begins 207 minutes after the fault's last minute and is discounted whole (S = 274 of 384 watched =
      // 0.714). The same five minutes with a raised p75 (`q`) are never discounted, whatever window holds them.
      const d = discountedMinutes(tl('269S', '96.', '110q', '5S'));
      assert.deepEqual(runs(d), [[0, 269], [475, 480]]);
      assert.deepEqual(runs(discountedMinutes(tl('269S', '96.', '110q', '5q'))), [[0, 269]], 'a real cry there still counts');
    });
  });
});
