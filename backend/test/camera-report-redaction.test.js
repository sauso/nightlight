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
const { redactCredentials, scrubSecrets, findCredentialLeak } = await import('../src/lib/urlCredentials.js');

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

  test('handles a percent-encoded password', () => {
    // ⚠️ THIS TEST USED TO BE NAMED "containing : and %" and its fixture contained NO literal colon —
    // encodeURIComponent emits '%3A', never ':'. So the name stated an invariant the fixture sat
    // clear of, and forbidding ':' in the password character class left it green. The colon case is
    // real but arrives by a different route; it is pinned separately below.
    const enc = encodeURIComponent('p@ss:w%rd!');
    assert.ok(!enc.includes(':'), 'fixture assumption broke: encodeURIComponent emitted a literal colon');
    const out = redactCredentials(`rtsp://${USER}:${enc}@h/ch0: 401`);
    assert.ok(!out.includes(enc), `encoded password survived: ${out}`);
  });

  test('★ a RAW colon inside the password is still redacted', () => {
    // Reachable: an operator pastes `rtsp://admin:pa:ss@host/ch0` into the address box (nothing
    // validates it as an address), and the route copies that field into the report. assembleRtspUrl
    // would have encoded it, but this string never went through assembleRtspUrl.
    // Kills the mutant that forbids ':' in the password class.
    const out = redactCredentials('rtsp://admin:pa:ss:word@192.0.2.10:554/ch0: 401');
    assert.ok(!out.includes('pa:ss:word'), `colon-bearing password survived: ${out}`);
    assert.ok(out.includes('admin'), 'the username was lost');
  });

  test('★ an empty username (`//:pass@`) is still redacted', () => {
    // The docstring says the user may be empty; nothing tested it, so `*`→`+` in the username class
    // survived. ffmpeg emits this shape for a URL built with no user but a password.
    const out = redactCredentials(`rtsp://:${PASS}@192.0.2.10:554/ch0: 401`);
    assert.ok(!out.includes(PASS), `password survived with an empty username: ${out}`);
  });

  test('★ `user:@host` — an EMPTY password is left alone, not turned into `***`', () => {
    // Kills `+`→`*` on the password class. There is no secret here; inventing a `***` would tell the
    // reader a password was present and hidden, which is a different and false statement.
    const line = 'rtsp://admin:@192.0.2.10:554/ch0: 401';
    assert.equal(redactCredentials(line), line);
  });

  test('★ the `//` anchor holds — a `scheme:user@host` URI is NOT mangled', () => {
    // Kills the mutant that makes the leading `//` optional. Without the anchor, anything shaped
    // like `word:word@word` is eaten — and SIP/mailto URIs of exactly that shape turn up in ONVIF
    // faults and SDP dumps, which is most of what this report carries. Redacting one would invent a
    // password that was never there and destroy a real diagnostic detail.
    //
    // ⚠️ The first version of this test used `contact=support@example.com` with a colon EARLIER in
    // the line, and the mutant SURVIVED it: whitespace between the colon and the '@' already blocks
    // the match, anchor or not. The fixture has to be colon-to-'@' unbroken to test the anchor.
    for (const line of ['sip:admin@192.0.2.10', 'mailto:ops@example.com reported the fault']) {
      assert.equal(redactCredentials(line), line, `mangled a non-URL: ${line}`);
    }
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

  test('the URL-ENCODED form of the password is removed OUTSIDE url form', () => {
    // ⚠️ THIS TEST USED TO PASS FOR THE WRONG REASON: its fixture was a full `rtsp://u:pass@h` URL,
    // which `redactCredentials` already handles — so deleting the entire encodeURIComponent branch
    // left it green. The branch exists for the encoded form appearing on its OWN, which is what this
    // fixture now is. assembleRtspUrl percent-encodes, so this is the form that reaches ffmpeg.
    const raw = 'p@ss word';
    const enc = encodeURIComponent(raw);
    assert.notEqual(enc, raw, 'fixture must actually encode to something different');
    const out = scrubSecrets({ e: `authentication failed for ${enc} (retrying)` }, raw);
    assert.ok(!JSON.stringify(out).includes(enc), `encoded password survived outside URL form: ${JSON.stringify(out)}`);
  });

  test('★ the 4-character boundary on the literal scrub is where the comment says', () => {
    // Kills `>= 4` → `>= 5`. The threshold is a deliberate trade-off (see scrubSecrets), so it is
    // pinned on BOTH sides — a boundary asserted only from the passing side is not a boundary.
    assert.ok(!JSON.stringify(scrubSecrets({ e: 'tried abcd' }, 'abcd')).includes('abcd'), '4 chars must be scrubbed');
    assert.ok(JSON.stringify(scrubSecrets({ e: 'tried abc' }, 'abc')).includes('abc'), '3 chars must NOT be (it would mangle the report)');
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

  test('a non-string secret does not silently disable the literal scrub', () => {
    // `password` was the one request field not String()-wrapped in the route, and scrubSecrets
    // type-checks its argument — so a JSON number quietly reduced protection to the URL pattern.
    // The route now coerces; this pins what happens if a caller does not.
    const out = scrubSecrets({ e: 'tried 12345678' }, 12345678);
    assert.equal(out.e, 'tried 12345678', 'a non-string is ignored — the route must coerce, and does');
    assert.ok(!JSON.stringify(scrubSecrets({ e: 'tried 12345678' }, '12345678')).includes('12345678'));
  });

  test('a lone surrogate in the password does not make the scrubber throw', () => {
    // encodeURIComponent throws URIError on an unpaired surrogate, and a password is arbitrary user
    // input. Before the guard this rejected the request AFTER ~30s of probing, so it never answered.
    const lit = '\uD800abcd';
    const out = scrubSecrets({ e: `tried ${lit} here` }, lit);
    assert.ok(!out.e.includes(lit), 'the literal form must still be scrubbed');
  });

  test('findCredentialLeak passes a correctly-redacted report and catches an unredacted one', () => {
    // ⚠️ BOTH DIRECTIONS. The first assertion is the one that matters: the gate's own `***` marker
    // matches the credential pattern, so a naive check rejects every correct report — which is
    // exactly what happened on first run, and a one-sided test would not have shown it.
    assert.equal(findCredentialLeak({ e: `rtsp://${USER}:***@h/ch0` }, PASS), null, 'a redacted report was refused');
    assert.ok(findCredentialLeak({ e: `rtsp://${USER}:${PASS}@h/ch0` }, PASS), 'an embedded credential got through');
    assert.ok(findCredentialLeak({ e: `bare ${PASS}` }, PASS), 'a bare password got through');
    // A class instance scrubSecrets passes through untouched is the case this gate exists for.
    assert.ok(findCredentialLeak({ e: new String(`rtsp://u:${PASS}@h`) }, PASS), 'a String object got through');
  });

  test('findCredentialLeak refuses a payload it cannot even inspect', () => {
    // A circular or unserialisable report cannot be published either, so "I could not check it" must
    // mean "do not send it". The alternative — treating an uninspectable payload as clean — is the
    // exact fail-open shape this gate exists to remove.
    const circular = { a: 1 };
    circular.self = circular;
    assert.ok(findCredentialLeak(circular, PASS), 'an uninspectable payload was declared safe');
    assert.ok(findCredentialLeak(undefined, PASS), 'a payload that serialises to nothing was declared safe');
  });

  test('works with no secret supplied, falling back to the pattern alone', () => {
    const out = scrubSecrets({ e: `rtsp://${USER}:${PASS}@h/1` });
    assert.ok(!JSON.stringify(out).includes(PASS));
  });
});
