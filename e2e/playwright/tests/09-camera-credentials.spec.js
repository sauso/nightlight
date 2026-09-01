const { test, expect } = require('@playwright/test');

// Camera credentials: the password must never reach the browser, and a blank password on edit must
// keep the stored one.
//
// ★ WHY THESE TWO TOGETHER. They are the same secret seen from both sides, and each one is what makes
// the other dangerous. The password is deliberately never returned, so the edit form cannot round-trip
// it — the browser sends a blank field and the server has to fill it back in. Get the first half wrong
// and the secret leaks into every camera list a caregiver's phone loads; get the second half wrong and
// an unrelated edit (renaming a camera) silently wipes a working camera's login. Both fail QUIETLY:
// nothing throws, the response looks fine, and the damage shows up later as a camera that "just
// stopped working".
//
// ★ WHY THIS RUNS AGAINST AN AUTHENTICATED FAKE CAMERA. Against the open `test` path the second claim
// is unfalsifiable. The only thing the API exposes is the boolean `rtsp_has_password`, which stays
// true if the server kept the WRONG password, a literal, or the string "undefined" — every one of
// which breaks the camera. So fakecam now also serves `secure`, which requires a real login (see
// e2e/fakecam/mediamtx.yml), and the assertion becomes "the stream still works", which no wrong
// password can satisfy. The third test proves that observable actually discriminates rather than
// assuming it does.
//
// This is a seam only e2e can reach: a frontend unit test mocks the server (so the blank field always
// "works"), and a backend unit test never sees what the form posts.

// The credentialed path on the synthetic camera. The password is deliberately URL-safe so that the
// value stored inside the assembled rtsp:// URL is byte-identical to this literal — the leak scan
// below searches for exactly this string, and percent-encoding would let a real leak slip past it.
const SECURE = {
  name: 'E2E Secure Cam',
  rtsp_host: 'fakecam',
  rtsp_port: '8554',
  rtsp_path: '/secure',
  rtsp_username: 'e2ecam',
  rtsp_password: 'e2e-cam-pw',
};

test.describe.configure({ mode: 'serial' });

let cameraId = null;

// ⚠️ Resolving auth visits '/', which NAVIGATES the page. Every test below calls this BEFORE opening
// the screen it is about — calling it later detaches everything already located (the trap that cost a
// rewrite in 08). Cached after the first call so the UI test doesn't navigate mid-flow.
let token = null;
async function auth(page) {
  if (!token) {
    await page.goto('/');
    token = await page.evaluate(() => localStorage.getItem('nightlight_token'));
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

async function cameras(page) {
  const res = await page.request.get('/api/cameras', await auth(page));
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function secureCam(page) {
  return (await cameras(page)).find((c) => c.id === cameraId) || null;
}

test('adding the camera with its real password succeeds — and validates for real', async ({ page }) => {
  // No `force`: the server runs ffprobe against the assembled URL before saving. On this path that
  // probe can only pass with the correct login, so a successful add is itself evidence that the
  // credential was assembled and used correctly — and it means every later test starts from a camera
  // that genuinely works, which is what makes "it still works" a meaningful assertion.
  const res = await page.request.post('/api/cameras', { ...(await auth(page)), data: SECURE });
  expect(res.status(), await res.text()).toBe(201);
  const cam = await res.json();
  cameraId = cam.id;
  expect(cam.rtsp_has_password).toBe(true);
});

test('the password is never returned to anyone', async ({ page }) => {
  const list = await cameras(page);
  const cam = list.find((c) => c.id === cameraId);

  // Scan the WHOLE serialized response, not named fields. A leak that mattered would most likely
  // arrive as a newly added field nobody thought to exclude — `rtsp_url` restored to the payload, a
  // debug dump, a copy of the row spread in wholesale. Checking a field list can only catch the
  // leaks already known about; checking the bytes catches the next one too.
  expect(JSON.stringify(list)).not.toContain(SECURE.rtsp_password);
  // The credentialed URL itself must not be there under any name — it embeds the password.
  expect(cam).not.toHaveProperty('rtsp_url');
  expect(cam.rtsp_display).not.toContain('@');

  // What an admin IS given: the address in fields, the username, and a flag. Pinned deliberately —
  // the username is not a secret and the edit form needs it, so a well-meaning "strip the
  // credentials" change that also removed this would break editing.
  expect(cam.rtsp_username).toBe(SECURE.rtsp_username);
  expect(cam.rtsp_has_password).toBe(true);
  expect(cam.rtsp_host).toBe(SECURE.rtsp_host);
});

test('a caregiver is not given the camera address at all', async ({ page, browser }) => {
  // A caregiver's phone loads the camera list on every dashboard paint. It has no reason to hold the
  // camera's address, let alone a hint about its login, so the sanitizer drops the whole block for
  // non-admins rather than merely omitting the password.
  const admin = await auth(page);
  const username = `cred-care-${Date.now()}`;
  const created = await page.request.post('/api/auth/users', {
    ...admin,
    data: { username, password: 'caregiver-pw-123', role: 'caregiver', first_name: 'Cred' },
  });
  expect(created.ok(), `could not create a caregiver: ${created.status()}`).toBeTruthy();

  const ctx = await browser.newContext();
  const login = await ctx.request.post('/api/auth/login', { data: { username, password: 'caregiver-pw-123' } });
  expect(login.ok()).toBeTruthy();
  const { token: careToken } = await login.json();

  const res = await ctx.request.get('/api/cameras', { headers: { Authorization: `Bearer ${careToken}` } });
  expect(res.ok()).toBeTruthy();
  const list = await res.json();
  await ctx.close();

  expect(JSON.stringify(list)).not.toContain(SECURE.rtsp_password);
  const cam = list.find((c) => c.id === cameraId);
  expect(cam, 'a caregiver should still SEE the camera').toBeTruthy();
  for (const field of ['rtsp_url', 'rtsp_host', 'rtsp_username', 'rtsp_has_password', 'rtsp_display', 'snapshot_url']) {
    expect(cam, `caregivers must not receive ${field}`).not.toHaveProperty(field);
  }
});

test('a WRONG password is refused — so this camera really is credential-gated', async ({ page }) => {
  // The control for everything below. If `secure` accepted any login, "the stream still works after
  // the edit" would pass no matter what the server did with the password, and the tests around it
  // would be decoration. Nothing is written here: the pre-save probe fails, so the 422 short-circuits
  // before any UPDATE — the camera is left exactly as it was.
  const res = await page.request.put(`/api/cameras/${cameraId}`, {
    ...(await auth(page)),
    data: { ...SECURE, rtsp_password: 'definitely-not-the-password' },
  });
  expect(res.status(), 'a bad camera password must be caught before saving').toBe(422);
  const body = await res.json();
  // needsConfirm is what lets the UI offer "Save anyway" for a camera that is merely offline.
  expect(body.needsConfirm).toBe(true);

  expect((await secureCam(page)).rtsp_has_password, 'a refused edit must not disturb the camera').toBe(true);
});

test('an edit with a blank password keeps the stored one — proven by the stream, not a flag', async ({ page }) => {
  // Exactly what the browser posts on a plain edit: every field it holds, with the password field
  // empty because it was never given one. This is the request that renames a camera, and it must not
  // cost that camera its login.
  const renamed = `${SECURE.name} (renamed)`;
  const res = await page.request.put(`/api/cameras/${cameraId}`, {
    ...(await auth(page)),
    data: { ...SECURE, name: renamed, rtsp_password: '' },
  });
  // Note what a failure here would mean: if the blank had been taken literally, the reassembled URL
  // would differ from the stored one, the server would re-probe it, and the probe would fail — so a
  // regression shows up as a 422 rather than a silent wipe. That is the pre-save check doing its job,
  // not the invariant being tested; the real proof is below.
  expect(res.status(), await res.text()).toBe(200);
  const saved = await res.json();
  expect(saved.name).toBe(renamed);
  expect(saved.rtsp_has_password).toBe(true);

  // THE ASSERTION. Restarting rebuilds the FFmpeg leg from the URL as it is stored right now, so the
  // stream can only come back if the password survived the edit intact. A boolean flag cannot tell a
  // kept password from a wrong one; the camera answering can.
  const restart = await page.request.post(`/api/cameras/${cameraId}/restart`, await auth(page));
  expect(restart.ok(), await restart.text()).toBeTruthy();
  await expectLiveAfterRestart(page);
});

test('the same edit through the real form keeps the camera working', async ({ page }) => {
  // The half the API tests cannot cover: what the FORM actually posts. The server's "blank keeps the
  // existing password" rule only helps if the browser really does send a blank — a field pre-filled
  // with a placeholder value, or one that posts the dots shown to the user, would sail through every
  // server-side test and wipe the login of every camera edited from the UI.
  //
  // ⚠️ Resolve auth first: it navigates.
  await auth(page);

  await page.goto(`/#/cameras/${cameraId}`);
  const password = page.getByLabel('Password', { exact: true });
  await expect(password).toBeVisible();
  // Blank, with the placeholder telling the user why it looks empty. Both halves matter: an empty box
  // with no explanation reads as "this camera has no password", which invites someone to retype it.
  await expect(password).toHaveValue('');
  await expect(password).toHaveAttribute('placeholder', /unchanged/);

  const finalName = 'E2E Secure Cam';
  await page.getByLabel('Name', { exact: true }).fill(finalName);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();

  // Saving navigates back to Family. A 422 (the shape a dropped password takes) would instead keep us
  // on the form showing an error, so leaving the page is itself part of the assertion.
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);

  const cam = await secureCam(page);
  expect(cam.name).toBe(finalName);
  expect(cam.rtsp_has_password).toBe(true);

  const restart = await page.request.post(`/api/cameras/${cameraId}/restart`, await auth(page));
  expect(restart.ok()).toBeTruthy();
  await expectLiveAfterRestart(page);
});

test('a camera saved with the wrong password never goes live — the check above can fail', async ({ page }) => {
  // Mutation testing, inside the spec. Everything above rests on "the stream comes back" meaning "the
  // password is right", and that is worth demonstrating rather than assuming: a stream that came back
  // regardless would make both preceding tests pass against a server that had thrown the password
  // away. So: save a camera with a knowingly wrong password (force skips the pre-save probe, the way
  // the UI's "Save anyway" does) and watch it fail to go live.
  const res = await page.request.post('/api/cameras', {
    ...(await auth(page)),
    data: { ...SECURE, name: 'E2E Wrong Password', rtsp_password: 'wrong-on-purpose', force: true },
  });
  expect(res.status()).toBe(201);
  const bad = await res.json();

  // ⚠️ The poll below treats a TIMEOUT as the pass, so anything that merely stops the observation from
  // happening — a bad id, a broken camera list — would look like success. Pin the preconditions first
  // so the timeout can only mean what it is supposed to mean: the camera exists, is listed, and is not
  // disabled (which would keep it from streaming for an unrelated reason).
  expect(bad.id).toBeTruthy();
  const listed = (await cameras(page)).find((c) => c.id === bad.id);
  expect(listed, 'the wrong-password camera must be in the list for its absence from live to mean anything').toBeTruthy();
  expect(listed.disabled).toBeFalsy();

  try {
    // Long enough to be past the transcoder's start and its first retries. A correct password reaches
    // ready in a few seconds (the tests above wait far less), so a wait this long failing to find one
    // is a real difference, not a slow start.
    await expect
      .poll(async () => (await cameras(page)).find((c) => c.id === bad.id)?.status?.ready, {
        timeout: 20_000,
        intervals: [2000],
        message: 'a camera with the wrong password must not reach a live stream',
      })
      .toBe(true);
    throw new Error('the wrong password produced a LIVE stream — "still works" proves nothing');
  } catch (err) {
    // The poll timing out is the expected outcome; anything else is a genuine failure.
    if (!/Timed out|exceeded while waiting/i.test(err.message)) throw err;
  } finally {
    // Always clean up: a camera whose FFmpeg leg can never connect would keep retrying for the rest of
    // the run.
    await page.request.delete(`/api/cameras/${bad.id}`, await auth(page));
  }
});

test('two-way-audio credentials follow the same blank-keeps-existing rule', async ({ page }) => {
  // The other stored secret on a camera, and the same failure: a plain edit must not disable talk-back
  // or blank its login.
  //
  // ⚠️ HONEST LIMIT, stated rather than papered over. Unlike the RTSP password there is no live check
  // available — nothing in the e2e stack speaks the Hikvision ISAPI protocol — so the observables here
  // are flags, and a server that kept the wrong talk password would pass. That is weaker than the
  // tests above and is not pretended otherwise; what it does catch is the failure that has actually
  // happened in this repo, which is talk-back being switched off or blanked by an unrelated edit.
  const h = await auth(page);
  const enable = await page.request.put(`/api/cameras/${cameraId}`, {
    ...h,
    data: { talk_username: 'talkuser', talk_password: 'talk-secret' },
  });
  expect(enable.status(), await enable.text()).toBe(200);
  expect((await enable.json()).talk_has_password).toBe(true);

  expect(JSON.stringify(await cameras(page)), 'the talk password must not be returned either')
    .not.toContain('talk-secret');

  // A later edit that carries the username but no password — the form's normal shape.
  const edit = await page.request.put(`/api/cameras/${cameraId}`, {
    ...h,
    data: { name: 'E2E Secure Cam', talk_username: 'talkuser', talk_password: '' },
  });
  expect(edit.status()).toBe(200);
  const after = await edit.json();
  expect(after.talk_has_password, 'a blank talk password must keep the stored one').toBe(true);
  expect(after.talk_username).toBe('talkuser');
  expect(after.talk_configured, 'talk-back must survive an unrelated edit').toBe(true);
});

// Leave the stack as it was found: later specs (and the docs screenshots, if ever reordered) expect
// one synthetic camera on the grid, and this one's transcoder would otherwise run for the rest of the
// suite. afterAll rather than a final test so it still runs when something above fails.
test.afterAll(async ({ browser }) => {
  if (!cameraId || !token) return;
  const ctx = await browser.newContext();
  await ctx.request.delete(`/api/cameras/${cameraId}`, { headers: { Authorization: `Bearer ${token}` } });
  await ctx.close();
});

// Ready again after a deliberate restart. The fixed settle is doing real work: `restart` returns once
// the old FFmpeg has been killed and a new one spawned, but MediaMTX learns the publisher has gone a
// moment later — so polling immediately can read a stale `ready: true` left over from the process that
// just died, and a camera that can no longer authenticate would look fine. Waiting past that window
// first means the `ready` being polled for can only have come from the new connection.
async function expectLiveAfterRestart(page) {
  await page.waitForTimeout(6000);
  await expect
    .poll(async () => (await secureCam(page))?.status?.ready, {
      timeout: 40_000,
      intervals: [2000],
      message: 'the camera should stream again after a restart, using the password it kept',
    })
    .toBe(true);
}
