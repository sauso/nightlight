// Basic-auth credentials in the snapshot URL: stripped on the way out, carried on the way back in.
// Issue #271.
//
// The defect: `publicCamera()` returned `snapshot_url` to admins VERBATIM while every other secret in
// the same function was reduced first. "Admin-only" was the mitigation, and admin-only is weaker than
// not-sent — a value that reaches the browser is in the DOM, in memory, and in any error report.
//
// ⚠️ The riskiest part of the fix is NOT the stripping, it is the carry-forward. The client can no
// longer send the password back, so a plain save has to keep the stored one — and a naive "keep it
// always" would forward the credential for camera A to whatever host the operator retyped. Most of
// the cases below exist to pin that boundary.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripUrlPassword, urlHasPassword, urlUsername, resolveUrlPassword } from '../src/lib/urlCredentials.js';

const SECRET = 'pw-marker-9d2f';

describe('what leaves the server', () => {
  test('the password is removed and the username kept', () => {
    assert.equal(stripUrlPassword(`http://admin:${SECRET}@cam.local/snap.jpg`), 'http://admin@cam.local/snap.jpg');
  });

  test('a URL with no credentials is unchanged', () => {
    assert.equal(stripUrlPassword('http://cam.local/snap.jpg'), 'http://cam.local/snap.jpg');
  });

  test('the marker appears in NO output, for every shape', () => {
    // Hostile: assert absence across all of them at once rather than one happy path, so a shape that
    // slips through cannot hide behind a sibling that does not.
    for (const url of [
      `http://admin:${SECRET}@cam.local/snap.jpg`,
      `https://u:${SECRET}@cam.local:8443/a/b?x=1#f`,
      `http://:${SECRET}@cam.local/snap.jpg`,
      `http://admin:${SECRET}@192.0.2.10/snap.jpg`,
    ]) {
      assert.ok(!stripUrlPassword(url).includes(SECRET), `password survived stripping: ${url}`);
      assert.equal(urlHasPassword(url), true, `has-password flag wrong for ${url}`);
    }
  });

  test('a password containing URL-special characters is still removed', () => {
    const nasty = 'p@ss:w/rd?#&=';
    const url = `http://admin:${encodeURIComponent(nasty)}@cam.local/snap.jpg`;
    const out = stripUrlPassword(url);
    assert.ok(!out.includes(encodeURIComponent(nasty)));
    assert.ok(!out.includes('w%2Frd'));
    assert.equal(urlHasPassword(url), true);
  });

  test('malformed free text does not throw, and never invents a URL', () => {
    // The operator types into this box; a half-finished value must still render the settings page.
    for (const v of ['not a url', 'http://', '', '   ', null, undefined, 42, {}]) {
      assert.doesNotThrow(() => stripUrlPassword(v), `threw on ${JSON.stringify(v)}`);
      assert.equal(typeof stripUrlPassword(v), 'string');
      assert.equal(urlHasPassword(v), false);
    }
  });

  test('unparseable text that contains an @ is NOT echoed back', () => {
    // ⚠️ Fails closed. `user:secret@host/x` with no scheme does not parse, and echoing it would put a
    // credential back on screen through the one path that skips the stripper.
    assert.equal(stripUrlPassword(`admin:${SECRET}@cam.local/snap.jpg`), '');
  });

  test('the username is reported, since it is not the secret', () => {
    assert.equal(urlUsername(`http://admin:${SECRET}@cam.local/x`), 'admin');
    assert.equal(urlUsername('http://cam.local/x'), '');
  });
});

describe('what happens on save', () => {
  const stored = `http://admin:${SECRET}@cam.local/snap.jpg`;

  test('a blank password keeps the stored one when the target is unchanged', () => {
    const out = resolveUrlPassword({ submitted: 'http://admin@cam.local/snap.jpg', stored, password: '' });
    assert.equal(out, stored, 'a plain save wiped the stored password');
  });

  test('a typed password replaces the stored one', () => {
    const out = resolveUrlPassword({ submitted: 'http://admin@cam.local/snap.jpg', stored, password: 'new-one' });
    assert.equal(out, 'http://admin:new-one@cam.local/snap.jpg');
    assert.ok(!out.includes(SECRET));
  });

  test('a password pasted into the URL itself wins', () => {
    const out = resolveUrlPassword({ submitted: 'http://admin:typed@cam.local/snap.jpg', stored, password: '' });
    assert.equal(out, 'http://admin:typed@cam.local/snap.jpg');
  });

  describe('★ the stored password is NEVER carried to a different target', () => {
    // The security-relevant half. The host lives in the same box the operator edits, so "keep the
    // existing password" must not mean "send it wherever they just typed".
    const cases = {
      'a different host': 'http://admin@attacker.example/snap.jpg',
      'a different port': 'http://admin@cam.local:8443/snap.jpg',
      'a different username': 'http://someone-else@cam.local/snap.jpg',
      'a different path': 'http://admin@cam.local/other.jpg',
      'a different scheme': 'https://admin@cam.local/snap.jpg',
    };
    for (const [name, submitted] of Object.entries(cases)) {
      test(name, () => {
        const out = resolveUrlPassword({ submitted, stored, password: '' });
        assert.ok(!out.includes(SECRET), `the stored password was forwarded to ${name}: ${out}`);
      });
    }
  });

  test('a query-string change alone does NOT drop the password', () => {
    // Cameras carry options in the query string; dropping the credential on every tweak would make the
    // feature unusable, and the target is unchanged.
    const out = resolveUrlPassword({ submitted: 'http://admin@cam.local/snap.jpg?size=full', stored, password: '' });
    assert.ok(out.includes(SECRET), 'a harmless query change dropped the password');
    assert.ok(out.includes('size=full'));
  });

  test('clearing the field clears the endpoint', () => {
    assert.equal(resolveUrlPassword({ submitted: '', stored, password: '' }), null);
    assert.equal(resolveUrlPassword({ submitted: '   ', stored, password: '' }), null);
  });

  test('there is no stored password to carry when there never was one', () => {
    const out = resolveUrlPassword({ submitted: 'http://cam.local/snap.jpg', stored: 'http://cam.local/snap.jpg', password: '' });
    assert.equal(out, 'http://cam.local/snap.jpg');
  });
});
