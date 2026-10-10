// #552 (PR3): what the long-silence notice says and which channel it is handed to (lib/cameraStatusAlert.js).
// lib/silences.js decides WHEN (silences.test.js); lib/push.js decides which devices the app's own push reaches
// (push.test.js). This file pins the hand-off between them, which neither of those can see:
//   C4  the narrowing (admins only, not the person who set the silence) and the tag go to the app's OWN push
//       (sendToAll) and to nothing else: Pushover, ntfy and Gotify have no per-person address and are sent the
//       message as before, so everyone on them receives it (stated, and *unverified* against the real services);
//       the offline and back-online notices are unchanged (every device, no tag).
// Plus the text: a duration, never a clock time; the username in the notice, not in the log.
//
// Faked: the four channel modules (none is in test:core's coverage include list, so mock.module is safe), each
// recording what it was asked to send. NOT covered (negative space): any real delivery.
import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDataDir } from './helpers/harness.js';

useTempDataDir();

const sent = { push: [], pushover: [], ntfy: [], gotify: [] };
const on = { push: true, pushover: true, ntfy: true, gotify: true };
mock.module('../src/lib/push.js', {
  exports: {
    pushEnabled: () => on.push,
    sendToAll: async (...args) => { sent.push.push(args); },
    getPublicBaseUrl: () => 'https://nightlight.example',
  },
});
mock.module('../src/lib/pushover.js', {
  exports: { pushoverEnabled: () => on.pushover, sendPushover: async (...args) => { sent.pushover.push(args); } },
});
mock.module('../src/lib/ntfy.js', {
  exports: { ntfyEnabled: () => on.ntfy, sendNtfy: async (...args) => { sent.ntfy.push(args); } },
});
mock.module('../src/lib/gotify.js', {
  exports: { gotifyEnabled: () => on.gotify, sendGotify: async (...args) => { sent.gotify.push(args); } },
});

const { notifyLongSilence, notifyCameraOffline, notifyCameraRecovered, formatSilenceLength } =
  await import('../src/lib/cameraStatusAlert.js');
const { logger } = await import('../src/lib/logger.js');

const CAM = { id: '0b5f1c2e-7d4a-4e8b-9f1a-3c6d2e8b7a90', name: 'Nursery Cam' };

beforeEach(() => {
  for (const k of Object.keys(sent)) sent[k].length = 0;
  for (const k of Object.keys(on)) on[k] = true;
  logger.clear();
});

describe('C4: who each channel is asked to reach', () => {
  test('★ the app\'s own push is narrowed to admins, minus the person who set the silence, and tagged per camera', () => {
    notifyLongSilence(CAM, 125, 'carer-login', 'u-carer');
    assert.equal(sent.push.length, 1);
    const [title, body, data, image, opts] = sent.push[0];
    assert.equal(title, 'Alerts silenced on Nursery Cam');
    assert.ok(body.includes('Nursery Cam'));
    assert.deepEqual(data, { cameraId: CAM.id, type: 'silence' });
    assert.equal(image, null);
    assert.deepEqual(opts, { tag: `silence_${CAM.id}`, adminsOnly: true, excludeUserId: 'u-carer' });
    assert.ok(Buffer.byteLength(opts.tag) <= 64, 'inside the APNs collapse-id limit');
  });

  test('★ Pushover, ntfy and Gotify are sent the same text with NO recipient narrowing (they cannot address one person)', () => {
    notifyLongSilence(CAM, 125, 'carer-login', 'u-carer');
    const [pushBody] = [sent.push[0][1]];
    for (const [name, calls] of [['pushover', sent.pushover], ['ntfy', sent.ntfy], ['gotify', sent.gotify]]) {
      assert.equal(calls.length, 1, `${name} was not sent the notice`);
      const [msg, ...rest] = calls[0];
      assert.deepEqual(rest, [], `${name} got a second argument`);
      assert.equal(msg.message, pushBody, `${name}: the same text`);
      assert.equal(msg.title, 'Alerts silenced on Nursery Cam');
      for (const key of ['adminsOnly', 'excludeUserId', 'tag', 'user', 'userId']) {
        assert.ok(!(key in msg), `${name} was handed "${key}", which it cannot honour`);
      }
    }
  });

  test('★ the offline and back-online notices are unchanged: every device, no tag', () => {
    notifyCameraOffline(CAM, 5);
    notifyCameraRecovered(CAM, Date.now() - 10 * 60_000);
    assert.equal(sent.push.length, 2);
    for (const [, , data, , opts] of sent.push) {
      assert.ok(['offline', 'online'].includes(data.type));
      assert.deepEqual(opts, { tag: undefined, adminsOnly: false, excludeUserId: null });
    }
    assert.equal(sent.pushover.length, 2);
  });

  test('a channel that is off is not called', () => {
    on.pushover = false;
    on.push = false;
    notifyLongSilence(CAM, 125, 'carer-login', 'u-carer');
    assert.equal(sent.push.length, 0);
    assert.equal(sent.pushover.length, 0);
    assert.equal(sent.ntfy.length, 1);
  });
});

describe('the text', () => {
  test('a duration, never a clock time', () => {
    assert.equal(formatSilenceLength(45), '45 min');
    assert.equal(formatSilenceLength(60), '1 h');
    assert.equal(formatSilenceLength(125), '2 h 5 min');
    assert.equal(formatSilenceLength(720), '12 h');
    notifyLongSilence(CAM, 125, 'carer-login', 'u-carer');
    const body = sent.push[0][1];
    assert.equal(body, 'Alerts from "Nursery Cam" are silenced for 2 h 5 min in a row, counting renewals (latest by carer-login).');
    assert.doesNotMatch(body, /\d{1,2}:\d{2}|\b(AM|PM)\b/i, 'no clock time');
  });

  test('no username known: the notice says nothing about who, rather than inventing one', () => {
    notifyLongSilence(CAM, 61, null, null);
    assert.equal(sent.push[0][1], 'Alerts from "Nursery Cam" are silenced for 1 h 1 min in a row, counting renewals.');
    assert.equal(sent.push[0][4].excludeUserId, null);
  });

  test('★ the username is in the notice but NOT in the log (logs go into the diagnostics bundle)', () => {
    notifyLongSilence(CAM, 125, 'ZZ-USERNAME-MARKER', 'u-1');
    const lines = logger.getRecent().join('\n');
    assert.ok(lines.includes('[silence-alert]'), 'the notice is logged');
    assert.ok(!lines.includes('ZZ-USERNAME-MARKER'), 'but without the username');
  });
});
