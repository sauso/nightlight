// The camera report must not publish the RTSP password (GHSA-wcgj-6p3c-vr9h).
//
// The "unsupported camera" report exists to be downloaded and attached to a PUBLIC GitHub issue, and
// the app pre-writes the user's own assertion that it is safe. It shipped the password for two
// releases: ffprobe prefixes its failure line with the input URL, and that stderr was pasted into the
// report verbatim. The allow-list discipline was real but only covered the `camera` block; the two
// fields assembled from external tools were not covered by it.
//
// ⚠️ THESE TESTS ARE HOSTILE ON PURPOSE. Every string field that could carry the credential gets a
// recognisable sentinel planted in it, and the assertion is on the SHAPE of the mistake — "the
// sentinel appears nowhere in the serialised report" — not on the names of the two fields that
// leaked. A third field pasted in later fails these too. The alternative (assert those two fields
// are clean) passes for the wrong reason the moment someone adds a third.
//
// ⚠️ CI has no ffmpeg (see .github/workflows/test.yml), so nothing here spawns ffprobe. That is why
// `shapeProbeFailure` is exported: the redaction point is reachable without a live camera and a live
// failure, which is part of why the leak survived review.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { shapeProbeFailure } = await import('../src/lib/rtspProbe.js');
const { redactCredentials, scrubSecrets } = await import('../src/lib/urlCredentials.js');

const PASS = 'FAKEPASS_SENTINEL_123';
const USER = 'demouser';

// Captured verbatim from the advisory's reproduction against the shipped :dev image, probing a dead
// local port. The last line is the one `error` is taken from and the one that carries the password.
const REAL_FFPROBE_STDERR = [
  '[tcp @ 0x5581] Connection to tcp://127.0.0.1:1?timeout=0 failed: Connection refused',
  `rtsp://${USER}:${PASS}@127.0.0.1:1/x: Connection refused`,
].join('\n');

// What a wrong password actually produces — the case the report exists to diagnose, so the case
// where the credential is most certain to be present.
const AUTH_FAILURE_STDERR = [
  `[rtsp @ 0x7f2] method DESCRIBE failed: 401 Unauthorized`,
  `rtsp://${USER}:${PASS}@192.0.2.10:554/ch0: Server returned 401 Unauthorized`,
].join('\n');

describe('redactCredentials', () => {
  test('strips the password out of an ffprobe failure line, keeping the username', () => {
    const out = redactCredentials(`rtsp://${USER}:${PASS}@192.0.2.10:554/ch0: Connection refused`);
    assert.ok(!out.includes(PASS), 'password survived redaction');
    assert.ok(out.includes(USER), 'username was removed too — the report needs it');
    assert.ok(out.includes('Connection refused'), 'the diagnostic text was destroyed');
  });

  test('redacts a URL that is NOT at the start of the line', () => {
    // The whole reason this scrubs a pattern instead of stripping a prefix: ffmpeg's wording is not
    // ours to control, and a future version could place the URL anywhere.
    const out = redactCredentials(`Could not open input rtsp://${USER}:${PASS}@h/ch0 (retrying)`);
    assert.ok(!out.includes(PASS));
  });

  test('redacts every occurrence, not just the first', () => {
    const line = `rtsp://a:${PASS}@h/1 failed; falling back to rtsp://b:${PASS}@h/2`;
    assert.equal(redactCredentials(line).match(new RegExp(PASS, 'g')), null);
  });

  test('handles a URL-encoded password containing : and %', () => {
    const enc = encodeURIComponent('p@ss:w%rd!');
    const out = redactCredentials(`rtsp://${USER}:${enc}@h/ch0: 401`);
    assert.ok(!out.includes(enc), `encoded password survived: ${out}`);
  });

  test('leaves a credential-free line completely alone', () => {
    // A redactor that mangles ordinary diagnostics gets turned off by the next person.
    const line = 'rtsp://192.0.2.10:554/ch0: Connection refused';
    assert.equal(redactCredentials(line), line);
  });

  test('is safe on non-strings', () => {
    for (const v of [null, undefined, 42, {}]) assert.equal(redactCredentials(v), v);
  });
});

describe('shapeProbeFailure — the redaction is actually wired to the output', () => {
  for (const [name, stderr] of [['connection refused', REAL_FFPROBE_STDERR], ['401 auth failure', AUTH_FAILURE_STDERR]]) {
    test(`${name}: neither error nor stderr carries the password`, () => {
      const out = shapeProbeFailure(stderr, { timedOut: false, code: 1 });
      assert.ok(!out.error.includes(PASS), `error leaked the password: ${out.error}`);
      assert.ok(!JSON.stringify(out.stderr).includes(PASS), `stderr leaked the password: ${JSON.stringify(out.stderr)}`);
      // and it is still a useful diagnostic
      assert.ok(out.stderr.length >= 2, 'the stderr lines were dropped rather than redacted');
      assert.ok(out.error.length > 0);
    });
  }

  test('a timeout reports reachability, not "ffprobe exited null"', () => {
    const out = shapeProbeFailure('', { timedOut: true, code: null });
    assert.match(out.error, /Timed out after \d+s/);
    assert.ok(!out.error.includes('null'));
  });
});

describe('scrubSecrets — the backstop on the assembled report', () => {
  // The report shape, with the sentinel planted in EVERY string field that is assembled from an
  // external tool rather than from our own allow-list. Derived from the fields the route builds, not
  // from the two that were known to leak.
  const hostileReport = () => ({
    report: 'nightlight-camera-probe',
    note: 'Passwords are redacted (***). Review before sharing.',
    camera: { rtsp_host: '192.0.2.10', rtsp_username: USER, rtsp_has_password: true, rtsp_port: '554' },
    onvif: { ok: false, error: `ONVIF fault: auth failed for rtsp://${USER}:${PASS}@192.0.2.10` },
    stream_main: {
      ok: false,
      error: `rtsp://${USER}:${PASS}@192.0.2.10:554/ch0: 401`,
      stderr: [`rtsp://${USER}:${PASS}@192.0.2.10:554/ch0: 401`, 'method DESCRIBE failed'],
    },
    stream_low: null,
  });

  test('the sentinel appears nowhere in the serialised report', () => {
    const out = JSON.stringify(scrubSecrets(hostileReport(), PASS));
    assert.ok(!out.includes(PASS), `password reached the response: ${out}`);
  });

  test('a password that is NOT in URL form is still removed', () => {
    // No pattern can recognise a bare password. This is the only thing the literal pass buys, and
    // it is why the route passes the password in rather than relying on the regex alone.
    const out = scrubSecrets({ onvif: { error: `Authentication failed (tried ${PASS})` } }, PASS);
    assert.ok(!JSON.stringify(out).includes(PASS));
  });

  test('the URL-ENCODED form of the password is removed too', () => {
    // assembleRtspUrl percent-encodes, so this is the form that actually appears in ffprobe output.
    const raw = 'p@ss word';
    const out = scrubSecrets({ e: `rtsp://u:${encodeURIComponent(raw)}@h/1 failed` }, raw);
    assert.ok(!JSON.stringify(out).includes(encodeURIComponent(raw)));
  });

  test('the report survives scrubbing intact — structure, non-strings, and nulls', () => {
    const out = scrubSecrets(hostileReport(), PASS);
    assert.equal(out.camera.rtsp_host, '192.0.2.10');
    assert.equal(out.camera.rtsp_has_password, true, 'a boolean was stringified');
    assert.equal(out.stream_low, null);
    assert.equal(out.stream_main.stderr.length, 2, 'an array became something else');
    assert.equal(out.stream_main.stderr[1], 'method DESCRIBE failed', 'clean text was altered');
  });

  test('a short password is not used as a literal, so the report is not mangled', () => {
    // '554' as a password must not blank out every port in the diagnostic. The URL pattern still
    // covers it; see the comment on scrubSecrets.
    const out = scrubSecrets({ e: 'connected to 192.0.2.10:554 ok' }, '554');
    assert.equal(out.e, 'connected to 192.0.2.10:554 ok');
  });

  test('a Date or a Buffer is passed through, not flattened into {}', () => {
    // Found by review of #335: the walk rebuilds objects from Object.entries, which turns a Date into
    // `{}` and a Buffer into a map of numeric keys — DESTROYING the field rather than scrubbing it.
    // Nothing in the report is a class instance today, so this pins the guard for whoever adds one.
    const d = new Date('2026-09-09T08:30:56Z');
    const b = Buffer.from('hello');
    const out = scrubSecrets({ when: d, blob: b, nested: { when: d } }, PASS);
    assert.ok(out.when instanceof Date, `Date became ${JSON.stringify(out.when)}`);
    assert.equal(out.when.toISOString(), d.toISOString());
    assert.ok(Buffer.isBuffer(out.blob), 'Buffer was flattened');
    assert.ok(out.nested.when instanceof Date, 'a Date one level down was flattened');
  });

  test('an object with a null prototype is still walked', () => {
    // Object.create(null) is a plain bag of data, not a class instance — it must still be scrubbed.
    const bag = Object.create(null);
    bag.e = `rtsp://u:${PASS}@h/1`;
    assert.ok(!JSON.stringify(scrubSecrets(bag, PASS)).includes(PASS));
  });

  test('works with no secret supplied, falling back to the pattern alone', () => {
    const out = scrubSecrets({ e: `rtsp://${USER}:${PASS}@h/1` });
    assert.ok(!JSON.stringify(out).includes(PASS));
  });
});
