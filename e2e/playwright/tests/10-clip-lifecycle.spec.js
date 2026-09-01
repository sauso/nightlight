const { test, expect } = require('@playwright/test');
const { CAMERA } = require('./helpers');

// The life of a recording, both kinds, from capture to deletion.
//
// Nightlight stores video in two separate places for two separate reasons, and the difference between
// them is what this spec is really about:
//   * an ON-DEMAND RECORDING is a keepsake someone pressed Record for. Its own `recordings` table, no
//     automatic retention, deleted only by hand.
//   * an ALERT CLIP is evidence attached to a detection. It lives in `detection_events.clip_*` and is
//     swept by retention — and deleting it must leave the alert itself standing.
// ★ That last invariant is the one worth a browser test. Deleting a clip is a row UPDATE that nulls
// four columns; the failure mode is someone writing the obvious DELETE instead, which silently takes
// the alert, its time and its snapshot with it. Nothing about the request looks different when that
// happens — the button works, the clip goes away, and the history quietly shrinks.
//
// ★ WHY A CAMERA HAS TO BE ADDED HERE RATHER THAN REUSED. The first test asserts something about a
// camera that has JUST been added and NOT been edited — see its comment. Reusing the camera from 02
// (which has been through the edit screen) would destroy exactly the condition under test.
//
// Detection is real here, not seeded: the synthetic camera's test pattern has a moving counter, so
// frame-diff motion genuinely fires on it. That makes this the one spec that exercises the whole
// detection → alert → clip chain end to end.
const CHILD = { name: 'Clip Kid' };
const CAM = { ...CAMERA, name: 'E2E Clip Cam' };

test.describe.configure({ mode: 'serial' });

let token = null;
let cameraId = null;
let childId = null;

// ⚠️ Visiting '/' NAVIGATES. Resolve this before opening any screen under test (the trap from 08).
async function auth(page) {
  if (!token) {
    await page.goto('/');
    token = await page.evaluate(() => localStorage.getItem('nightlight_token'));
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

const getJson = async (page, path) => {
  const res = await page.request.get(path, await auth(page));
  expect(res.ok(), `${path} -> ${res.status()}`).toBeTruthy();
  return res.json();
};

test('a camera can record the moment it is added, with nobody editing it first', async ({ page }) => {
  // ★ THE REGRESSION TEST. On-demand recording reaches BACKWARD in time, so it only works if the
  // camera is already buffering — and the Record button hides itself (`can_record`) when it isn't.
  // Three of the five places that start that buffering used to ask only whether DETECTION clips were
  // turned on — which is off by default and configured on a different screen — and a fourth, adding a
  // camera, never started it at all. The result: on a default install the ring never started, the
  // Record button never appeared, and the feature was inert for anyone who hadn't also enabled
  // detection clips. It worked in the house it was written in because both cameras there had
  // detection clips on, which armed the ring for the other reason.
  //
  // So: add a camera, touch nothing else, and require the button to be there. This test fails against
  // the code as it was — verified by reverting the fix and running it.
  const child = await page.request.post('/api/children', { ...(await auth(page)), data: { name: CHILD.name } });
  expect(child.ok(), `creating a child failed: ${child.status()}`).toBeTruthy();
  childId = (await child.json()).id;

  const res = await page.request.post('/api/cameras', {
    ...(await auth(page)),
    // force: liveness is proven in 02; this spec is about what happens AFTER a camera exists.
    // child_id at creation matters — a recording captures the camera's child at the moment Record is
    // pressed, so assigning it later would leave the recording orphaned off the child's page.
    data: { ...CAM, child_id: childId, force: true },
  });
  expect(res.status(), await res.text()).toBe(201);
  cameraId = (await res.json()).id;

  await expect
    .poll(async () => (await getJson(page, '/api/cameras')).find((c) => c.id === cameraId)?.can_record, {
      timeout: 30_000,
      intervals: [1000],
      message: 'a newly added camera should start buffering, so the Record button can appear',
    })
    .toBe(true);

  // And the button really is on the tile — `can_record` is what gates rendering it.
  await page.goto('/');
  const tile = page.locator('.camera-tile', { hasText: CAM.name }).first();
  await expect(tile.getByRole('button', { name: `Record ${CAM.name}`, exact: true })).toBeVisible();
});

test('turning a camera off and on again brings the ring back with it', async ({ page }) => {
  // ★ Found by an adversarial review of the fix above, which was itself wrong here. `PUT /:id/enabled`
  // reads the camera row at the top of the handler and writes `disabled` at the bottom, so everything
  // in between saw `disabled: 1` — and motionLegWanted, onvifMotionWanted, startSoundDetector and
  // clipRingWanted all bail out for a disabled camera. Re-enabling therefore restarted the stream and
  // nothing else; the ring, motion, ONVIF motion and sound detection all stayed down until the
  // five-minute reconcile tick swept them up, which is far longer than anyone watches a screen for.
  //
  // The ring is the half this spec can see, and it is the strictest of the four: the assertion is that
  // it comes back QUICKLY. A generous timeout here would pass on the reconcile tick alone and prove
  // nothing, so it deliberately sits far below 5 minutes.
  await auth(page);
  const off = await page.request.put(`/api/cameras/${cameraId}/enabled`, {
    ...(await auth(page)),
    data: { enabled: false },
  });
  expect(off.status()).toBe(200);
  expect((await off.json()).can_record, 'a disabled camera cannot record').toBeFalsy();

  const on = await page.request.put(`/api/cameras/${cameraId}/enabled`, {
    ...(await auth(page)),
    data: { enabled: true },
  });
  expect(on.status(), await on.text()).toBe(200);

  await expect
    .poll(async () => (await getJson(page, '/api/cameras')).find((c) => c.id === cameraId)?.can_record, {
      timeout: 30_000,
      intervals: [1000],
      message: 're-enabling a camera should restart its ring, not wait for the reconcile tick',
    })
    .toBe(true);
});

test('recording through the tile produces a playable video on the child’s page', async ({ page }) => {
  await auth(page);
  await page.goto('/');
  const tile = page.locator('.camera-tile', { hasText: CAM.name }).first();

  // ⚠️ Let the ring accumulate some history first. The pre-roll can only reach back as far as the
  // buffer has actually been running, and this camera was added seconds ago — pressing Record
  // immediately yields a video exactly as long as the button was held, which would make the pre-roll
  // assertion below fail against a perfectly working app. (Measured: recording straight after the
  // camera appeared gave 6s for a 5s hold; the same hold after the ring had been up a while gave 14s.)
  await page.waitForTimeout(20_000);

  await tile.getByRole('button', { name: `Record ${CAM.name}`, exact: true }).click();
  // The button becomes its own Stop — the server owns the state, so this also confirms the start was
  // accepted rather than optimistically rendered.
  const stop = tile.getByRole('button', { name: `Stop recording ${CAM.name}`, exact: true });
  await expect(stop).toBeVisible();

  // Long enough to be a real capture rather than an empty container.
  await page.waitForTimeout(5000);
  await stop.click();
  await expect(tile.getByRole('button', { name: `Record ${CAM.name}`, exact: true })).toBeVisible();

  // Stopping resolves only once the clip has been cut, so the recording should be listed and finished.
  await expect
    .poll(async () => (await getJson(page, `/api/recordings/child/${childId}`)).length, {
      timeout: 30_000,
      intervals: [1000],
      message: 'the finished recording should appear on the child',
    })
    .toBe(1);

  const [rec] = await getJson(page, `/api/recordings/child/${childId}`);
  expect(rec.status).toBe('ready');
  // The pre-roll is the whole point of the feature: the video must be substantially LONGER than the
  // ~5s the button was held, because it reaches back before the press. A capture that only started at
  // the tap would land at ~5s and would still sail through a mere "duration > 0" check — which is why
  // the threshold sits clear of the hold rather than just above zero.
  expect(rec.duration_s, 'the recording should include pre-roll from before the tap').toBeGreaterThan(10);

  // It plays, and it seeks: <video> scrubbing needs range requests, which is a property of how the
  // route serves the file rather than of the file existing.
  const video = await page.request.get(`/api/recordings/${rec.id}/video`, await auth(page));
  expect(video.status()).toBe(200);
  expect(video.headers()['content-type']).toContain('video/mp4');
  expect((await video.body()).length).toBeGreaterThan(1000);

  const ranged = await page.request.get(`/api/recordings/${rec.id}/video`, {
    ...(await auth(page)),
    headers: { ...(await auth(page)).headers, Range: 'bytes=0-99' },
  });
  expect(ranged.status(), 'seeking in the player needs a 206').toBe(206);
});

test('deleting a recording through the UI removes it for good', async ({ page }) => {
  await auth(page);
  const [rec] = await getJson(page, `/api/recordings/child/${childId}`);

  await page.goto(`/#/children/${childId}`);
  await expect(page.getByText('Recordings')).toBeVisible();

  // Open the recording, then delete it — deliberately two steps behind a confirm, since a recording
  // has no retention and nothing else can bring it back.
  await page.locator('.rec-strip__item').first().click();
  await page.getByRole('button', { name: 'Delete recording' }).click();
  await expect(page.getByText(/This can’t be undone/)).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();

  // The card renders nothing at all when a child has no recordings, so its title disappearing is the
  // signal the list is genuinely empty rather than merely re-rendered.
  await expect(page.getByText('Recordings')).toHaveCount(0);
  expect(await getJson(page, `/api/recordings/child/${childId}`)).toHaveLength(0);
  // The file is gone too, not just the row — this is the only way to reclaim the space.
  const gone = await page.request.get(`/api/recordings/${rec.id}/video`, await auth(page));
  expect(gone.status()).toBe(404);
});

test('a detection records a clip and attaches it to its alert', async ({ page }) => {
  // Real detection, not a fixture: the synthetic camera's test pattern animates, so frame-diff motion
  // fires on it. Sensitivity is turned up and the cooldown down purely to make that happen inside a
  // test's patience — the mechanism being exercised is the shipped one.
  const res = await page.request.put(`/api/cameras/${cameraId}/detection`, {
    ...(await auth(page)),
    data: {
      motion_enabled: true, sensitivity: 95, cooldown_s: 5, confirm_s: 0,
      schedule_enabled: false, source: 'framediff', record_clips: true,
    },
  });
  expect(res.status(), await res.text()).toBe(200);

  // A clip spans the post-roll AFTER its trigger, so it appears a good while after the alert does.
  await expect
    .poll(async () => (await getJson(page, '/api/cameras/clips')).length, {
      timeout: 60_000,
      intervals: [2000],
      message: 'a motion alert on a clip-recording camera should produce a clip',
    })
    .toBeGreaterThan(0);

  const [clip] = await getJson(page, '/api/cameras/clips');
  expect(clip.clip_duration_s).toBeGreaterThan(0);
  const video = await page.request.get(`/api/cameras/alerts/${clip.id}/clip`, await auth(page));
  expect(video.status()).toBe(200);
  expect((await video.body()).length).toBeGreaterThan(1000);
});

test('deleting an alert’s clip keeps the alert, its time and its snapshot', async ({ page }) => {
  // ★ THE INVARIANT. A clip is deleted by nulling four columns on the event row; the alert, when it
  // happened, and the still image captured at the moment are all kept. The tempting implementation —
  // deleting the row — passes every "the clip is gone" check while quietly erasing history, and the
  // person who tidied up their clips would never be told the alerts went with them.
  // ⚠️ QUIETEN THE CAMERA FIRST. Everything below compares two reads of the alert feed, and
  // `GET /api/cameras/alerts` is `getRecentDetectionEvents(200)` — a newest-first list with a LIMIT.
  // Leaving the detector firing means asserting about a list that is moving underneath the assertions,
  // and an alert can leave that window without anything having deleted it.
  // This spec failed exactly once, on a clean run, with the target alert present in the first read and
  // absent from the second. Falling off the 200-row window is the only mechanism of the right shape —
  // deleting a clip is an UPDATE, and the two prunes are far out of reach at 2000 rows and 30 days —
  // though at a 5s cooldown it should take ~17 minutes of firing to get there, so I could not
  // reproduce it and cannot claim it as the cause. Either way the fix is the same: stop asserting
  // against a moving list. Turning the detector off is also what a person deleting old clips would
  // realistically be doing.
  const quiet = await page.request.put(`/api/cameras/${cameraId}/detection`, {
    ...(await auth(page)),
    data: { motion_enabled: false },
  });
  expect(quiet.status()).toBe(200);

  const clips = await getJson(page, '/api/cameras/clips');
  const target = clips[0];
  const before = await getJson(page, '/api/cameras/alerts');
  const alertIds = before.map((a) => a.id);
  expect(alertIds, 'the alert under test must be in the feed to begin with').toContain(target.id);
  const snapshotBefore = await page.request.get(`/api/cameras/alerts/${target.id}/snapshot`, await auth(page));
  expect(snapshotBefore.status(), 'this alert needs a snapshot for the test to mean anything').toBe(200);

  const del = await page.request.delete(`/api/cameras/alerts/${target.id}/clip`, await auth(page));
  expect(del.status()).toBe(204);

  // The clip really is gone — otherwise everything below would pass trivially.
  expect((await getJson(page, '/api/cameras/clips')).map((c) => c.id)).not.toContain(target.id);
  const goneVideo = await page.request.get(`/api/cameras/alerts/${target.id}/clip`, await auth(page));
  expect(goneVideo.status()).toBe(404);

  // ...and the alert survived it, whole. Compared by id against the feed as it was, so an
  // implementation that deleted the row (or any other row) is caught, not just one that emptied it.
  const after = await getJson(page, '/api/cameras/alerts');
  const kept = after.find((a) => a.id === target.id);
  expect(
    kept,
    `deleting a clip must not delete the alert it belonged to — alert ${target.id} was in a feed of ` +
      `${before.length} (ids ${alertIds.slice(0, 5)}…) and is missing from a feed of ${after.length} ` +
      `(ids ${after.map((a) => a.id).slice(0, 5)}…)`
  ).toBeTruthy();
  expect(kept.type).toBe('motion');
  expect(kept.created_at).toBe(before.find((a) => a.id === target.id).created_at);
  expect(kept.clip_status, 'the alert should no longer claim to have a clip').toBeFalsy();
  for (const id of alertIds) {
    expect(after.map((a) => a.id), `alert ${id} disappeared alongside the deleted clip`).toContain(id);
  }

  // The snapshot is a separate file and is deliberately NOT deleted with the video — it is what makes
  // an old alert still readable once its clip has been swept by retention.
  const snapshotAfter = await page.request.get(`/api/cameras/alerts/${target.id}/snapshot`, await auth(page));
  expect(snapshotAfter.status(), 'the alert snapshot must outlive the clip').toBe(200);
  expect((await snapshotAfter.body()).length).toBeGreaterThan(100);
});

// Turn detection back off and remove the camera this spec added: it is the only one running motion
// detection, and left behind it would keep firing alerts through any spec that follows.
test.afterAll(async ({ browser }) => {
  if (!token || !cameraId) return;
  const ctx = await browser.newContext();
  const headers = { Authorization: `Bearer ${token}` };
  await ctx.request.delete(`/api/cameras/${cameraId}`, { headers });
  if (childId) await ctx.request.delete(`/api/children/${childId}`, { headers });
  await ctx.close();
});
