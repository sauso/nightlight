// fireDetectionAlert: the one downstream every detector shares (issue #564). It sat at 28% lines with no test file
// referencing it; the long-silence tests mock the channels away, so the alert's own decisions never ran: what is
// recorded, which channels fire, what the title and tap target say, and what happens when the image or a channel
// fails.
//
// Everything real except the network edge: a real database, real detectionEvents/snapshot code, real ntfy and
// Gotify modules talking to local HTTP servers that record what arrives. Pushover's host is a constant, so its
// one URL is intercepted at fetch (same technique and reason as push-provider-payloads.test.js). Firebase push is
// not configured in a test database, so `pushEnabled()` is genuinely false, not stubbed.
//
// The sends are fire-and-forget (that is the design: a slow channel must not delay detection), so a test waits
// for the arrival it expects. An ABSENCE is only asserted after another channel from the SAME alert has arrived,
// which is the barrier that makes "it did not send" mean something.
//
// Known limit, documented: the ffmpeg stream-grab fallback is not exercised with a real stream (that is the
// device-bound layer); the failed-image case empties PATH so the grab cannot start, the same technique as
// spawn-failure.test.js.
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { useTempDataDir, cleanupTempDataDirs, makeCamera } from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { fireDetectionAlert } = await import('../src/lib/detectionAlert.js');
const { ALERT, getRecentDetectionEvents, getEventSnapshotFile } = await import('../src/lib/detectionEvents.js');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x0a, 0x0b, 0xff, 0xd9]);
const setting = (cols) => {
  for (const [k, v] of Object.entries(cols)) db.prepare(`UPDATE settings SET ${k} = ? WHERE id = 'app'`).run(v);
};
const until = async (cond, what) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > 5000) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

let hub; // one server standing in for the camera, ntfy and Gotify, told apart by path
let ntfy;
let gotify;
let cameraSnap; // what the camera's snapshot endpoint answers
let gotifyStatus;
let pushover;
const realFetch = globalThis.fetch;
const realPath = process.env.PATH;
let cam;

before(async () => {
  hub = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.url.startsWith('/snap')) return cameraSnap(res);
      if (req.url.startsWith('/message')) {
        gotify.push({ url: req.url, body: JSON.parse(body.toString('utf8')) });
        return res.writeHead(gotifyStatus).end('{}');
      }
      ntfy.push({ url: req.url, headers: req.headers, body });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise((r) => hub.listen(0, '127.0.0.1', r));
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.pushover.net/')) return realFetch(url, init);
    pushover.push(init.body);
    return new Response('{"status":1}', { status: 200 });
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  process.env.PATH = realPath;
  hub.closeAllConnections();
  await new Promise((r) => hub.close(r));
  cleanupTempDataDirs();
});

beforeEach(() => {
  ntfy = [];
  gotify = [];
  pushover = [];
  gotifyStatus = 200;
  cameraSnap = (res) => res.writeHead(200).end(JPEG);
  process.env.PATH = realPath;
  db.prepare('DELETE FROM detection_events').run();
  db.prepare('DELETE FROM cameras').run();
  makeCamera(db, { id: 'cam-1', name: 'Nursery', extra: { snapshot_url: `http://127.0.0.1:${hub.address().port}/snap.jpg` } });
  cam = db.prepare('SELECT * FROM cameras WHERE id = ?').get('cam-1');
  const base = `http://127.0.0.1:${hub.address().port}`;
  setting({
    public_base_url: null,
    ntfy_enabled: 0, ntfy_server_url: base, ntfy_topic: 'nl',
    gotify_enabled: 0, gotify_server_url: base, gotify_app_token: 'tok', gotify_priority: 5,
    pushover_enabled: 0, pushover_app_token: 'a', pushover_user_key: 'u', pushover_device: '',
  });
});

describe('with no channel switched on', () => {
  test('the event is still recorded, with the snapshot, so the in-app feed works on a push-less install', async () => {
    await fireDetectionAlert(cam, ALERT.MOTION, 'peak 12%');
    const events = getRecentDetectionEvents();
    assert.equal(events.length, 1);
    assert.deepEqual(
      { camera_id: events[0].camera_id, camera_name: events[0].camera_name, type: events[0].type, detail: events[0].detail },
      { camera_id: 'cam-1', camera_name: 'Nursery', type: 'motion', detail: 'peak 12%' }
    );
    assert.ok(getEventSnapshotFile(events[0].id), 'the snapshot was not stored against the event');
    assert.equal(ntfy.length + gotify.length + pushover.length, 0, 'something was sent with every channel off');
  });
});

describe('with every channel switched on', () => {
  beforeEach(() => setting({ ntfy_enabled: 1, gotify_enabled: 1, pushover_enabled: 1 }));
  const arrived = () => until(() => ntfy.length && gotify.length && pushover.length, 'all three channels');

  test('★ each channel gets the same title, wording and tap target, and the image where the channel can carry one', async () => {
    await fireDetectionAlert(cam, ALERT.MOTION, 'peak 12%');
    await arrived();
    const link = 'nightlight://camera/cam-1';

    // ntfy carries the title in an HTTP header, which is Latin-1: ntfy.js strips what does not fit, and the em
    // dash in "<camera> — motion" does not. So ntfy shows "Nursery  motion" (two spaces) while Gotify and
    // Pushover show the dash. Pinned as it behaves today, not as an endorsement: see the PR's observations.
    assert.equal(ntfy[0].headers.title, 'Nursery  motion');
    assert.equal(ntfy[0].headers.message, 'Motion detected');
    assert.equal(ntfy[0].headers.click, link);
    assert.equal(ntfy[0].headers.priority, '4', 'an alert is ntfy high priority');
    assert.ok(ntfy[0].body.equals(JPEG), 'ntfy was not sent the snapshot as its body');

    assert.equal(gotify[0].body.title, 'Nursery — motion');
    assert.equal(gotify[0].body.message, 'Motion detected');
    assert.equal(gotify[0].body.extras['client::notification'].click.url, link);

    const form = pushover[0];
    assert.equal(form.get('title'), 'Nursery — motion');
    assert.equal(form.get('message'), 'Motion detected');
    assert.equal(form.get('url'), link);
    assert.equal(form.get('url_title'), 'Open in Nightlight');
    // The bytes, not only the size: a same-length buffer of zeros would be a corrupt snapshot (#714 review).
    assert.ok(Buffer.from(await form.get('attachment').arrayBuffer()).equals(JPEG), 'Pushover was not sent the snapshot');
  });

  test('a sound alert says so, and an unknown type falls back to a plain "Alert" rather than throwing', async () => {
    await fireDetectionAlert(cam, ALERT.SOUND, '9 dB over baseline');
    await arrived();
    assert.equal(gotify[0].body.title, 'Nursery — sound');
    assert.equal(gotify[0].body.message, 'Sound detected');

    gotify.length = 0;
    await fireDetectionAlert(cam, 'something-new', 'x');
    await until(() => gotify.length, 'the fallback alert');
    assert.equal(gotify[0].body.title, 'Nursery — alert');
    assert.equal(gotify[0].body.message, 'Alert');
  });

  test('★ once the app has taught the server its public address, the tap target carries it so the right server opens', async () => {
    setting({ public_base_url: 'https://home.example.net:8443' });
    await fireDetectionAlert(cam, ALERT.MOTION, 'd');
    await arrived();
    const expected = `nightlight://camera/cam-1?server=${encodeURIComponent('https://home.example.net:8443')}`;
    assert.equal(ntfy[0].headers.click, expected);
    assert.equal(gotify[0].body.extras['client::notification'].click.url, expected);
    assert.equal(pushover[0].get('url'), expected);
  });

  test('★ no image (the camera refuses and the stream grab cannot start): the alert still goes out, text-only, and the feed row has no picture', async () => {
    cameraSnap = (res) => res.writeHead(503).end('busy');
    process.env.PATH = ''; // no ffmpeg to find, so the fallback grab resolves null instead of touching a stream
    await fireDetectionAlert(cam, ALERT.MOTION, 'd');
    await arrived();
    assert.equal(ntfy[0].headers.filename, undefined, 'ntfy was told it was getting a file');
    assert.equal(ntfy[0].body.toString('utf8'), 'Motion detected', 'without an image the message is the body');
    assert.equal(pushover[0].has('attachment'), false);
    assert.equal(getEventSnapshotFile(getRecentDetectionEvents()[0].id), null, 'a snapshot was recorded that never existed');
  });

  test('a channel that fails does not stop the others and does not make the alert throw', async () => {
    gotifyStatus = 500;
    await assert.doesNotReject(fireDetectionAlert(cam, ALERT.MOTION, 'd'));
    await arrived();
    assert.equal(ntfy.length, 1, 'ntfy was lost because Gotify failed');
    assert.equal(pushover.length, 1, 'Pushover was lost because Gotify failed');
    assert.equal(getRecentDetectionEvents().length, 1);
  });
});

describe('only the channels that are switched on are used', () => {
  test('★ ntfy alone: Gotify and Pushover are not contacted (the ntfy arrival is the barrier)', async () => {
    setting({ ntfy_enabled: 1 });
    await fireDetectionAlert(cam, ALERT.MOTION, 'd');
    await until(() => ntfy.length, 'ntfy');
    assert.equal(gotify.length, 0);
    assert.equal(pushover.length, 0);
  });

  test('a channel that is on but missing its credential is treated as off (Gotify with no token)', async () => {
    setting({ ntfy_enabled: 1, gotify_enabled: 1, gotify_app_token: '' });
    await fireDetectionAlert(cam, ALERT.MOTION, 'd');
    await until(() => ntfy.length, 'ntfy');
    assert.equal(gotify.length, 0);
  });
});
