// The camera report ROUTE must not publish a credential — response body OR server log.
//
// This file exists because PR #335 shipped the redaction and then claimed the route's own scrub call
// could not be tested, "because the route spawns real ffprobe and CI has no ffmpeg". That reason was
// wrong, and an adversarial review proved it: with no ffmpeg on PATH, `spawn` raises 'error' and
// `probeRtspDetailed` RESOLVES `{ok:false, error:'Could not run ffprobe'}` — it does not throw and
// does not hang. The whole route answers in ~100 ms. The untested line was untested by assumption.
//
// ⚠️ THE FIXTURE IS HOSTILE. The sentinel goes in EVERY field an operator could put it in, not just
// the one known to leak — because the failure that started this was a field nobody thought to check.
// The `path` field matters most: the route copies it into the report verbatim as `camera.rtsp_path`,
// so only the route's own scrub stands between a pasted URL and the published file.
//
// ★ Real trigger, not a contrivance: nothing validates that "Camera IP address" is an address. An
// operator whose camera will not connect pastes the whole `rtsp://user:pass@host/path` they have in
// their notes. That is the moment this report is offered.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  useTempDataDir, cleanupTempDataDirs, makeUser, makeSession, signToken, mountRouter, call,
} from './helpers/harness.js';

useTempDataDir();

const { default: db } = await import('../src/db.js');
const { default: camerasRouter } = await import('../src/routes/cameras.js');
const { logger } = await import('../src/lib/logger.js');

const SENTINEL = 'LEAKPASS-9f3a2c';
const URL_WITH_SECRET = `rtsp://admin:${SENTINEL}@127.0.0.1:554/ch0`;

let server;
let adminToken;

before(async () => {
  server = await mountRouter('/api/cameras', camerasRouter);
  const admin = makeUser(db, { id: 'u-a', username: 'admin', role: 'admin' });
  adminToken = signToken({ id: admin.id, username: admin.username, role: 'admin', sid: makeSession(db, admin.id) });
});
after(async () => { await server.close(); cleanupTempDataDirs(); });

// Port 1 is closed, so the probe fails fast — and the failure path is the ONLY path this report is
// ever offered on, which is what made "it only leaks on error" a non-mitigation.
const buildReport = (over = {}) => call(`${server.url}/api/cameras/probe-report`, {
  method: 'POST',
  token: adminToken,
  body: { host: '127.0.0.1', port: '1', path: '/ch0', username: 'admin', password: SENTINEL, ...over },
});

// ⚠️ ONE REQUEST, ASSERTED SEVERAL WAYS — on purpose. Each call costs ~18 s (the ONVIF probe's own
// timeout against a dead port), so a test per assertion would add a minute and a half to the suite
// and get deleted by whoever next complains the suite is slow. This file proves the WIRING; the
// logic it wires up is pinned by fast unit tests in camera-report-redaction.test.js.
describe('POST /cameras/probe-report — nothing published carries the password', () => {
  let res;
  let logsAfter;
  before(async () => {
    // The sentinel goes in every operator-supplied field, including ones nobody suspected.
    res = await buildReport({ host: URL_WITH_SECRET, path: URL_WITH_SECRET, mqtt_topic: SENTINEL });
    logsAfter = logger.getRecent().join('\n');
  });

  test('★ the request still SUCCEEDS — redaction did not trip the fail-closed gate', () => {
    // Not a formality. On first run the gate rejected its own `***` marker, so the route 500'd on
    // every correctly-redacted report. A test that only looked for the password would have passed.
    assert.equal(res.status, 200, `route refused: ${JSON.stringify(res.body)}`);
  });

  test('★ the password is not in the response body', () => {
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes(SENTINEL), `password reached the response: ${body}`);
  });

  test('★ the password is not in the server log, which the diagnostics bundle republishes verbatim', () => {
    // routes/diagnostics.js puts `server_logs: logger.getRecent()` into the support bundle, under a
    // note promising "no passwords or tokens" — the same false assurance, on the same kind of file.
    const offending = logsAfter.split('\n').filter((l) => l.includes(SENTINEL));
    assert.equal(offending.length, 0, `password reached the log buffer:\n${offending.join('\n')}`);
  });

  test('the report is still USEFUL — redaction did not empty it', () => {
    // A scrubber that destroys the diagnostic it protects is one that gets switched off.
    assert.equal(res.body.camera.rtsp_username, 'admin', 'the username must survive — the report needs it');
    assert.equal(res.body.camera.rtsp_has_password, true);
    assert.ok(res.body.stream_main, 'the stream probe result went missing');
    assert.ok(res.body.app?.version, 'the app/version block went missing');
    assert.match(JSON.stringify(res.body), /rtsp:\/\/admin:\*\*\*@/, 'the address was destroyed rather than redacted');
  });
});
