// TOTP two-factor. Pure logic (no DB, no network), and the traps here are all version-migration ones:
// the app moved from otplib v12 to v13, where the API is entirely different and several units changed
// meaning. Each of those cost real debugging time, so each gets a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTempDataDir, cleanupTempDataDirs } from './helpers/harness.js';

useTempDataDir();
const require = createRequire(import.meta.url);
const otplib = require('otplib');

const mfa = await import('../src/lib/mfa.js');

// --- secret generation ------------------------------------------------------------------------

test('generateSecret produces a fresh base32 secret each time', () => {
  const a = mfa.generateSecret();
  const b = mfa.generateSecret();
  assert.match(a, /^[A-Z2-7]+=*$/, 'base32 alphabet');
  assert.notEqual(a, b, 'two enrolments must not share a secret');
});

test('a newly generated secret is NOT flagged as legacy', () => {
  // v13 enforces RFC 4226's 16-byte minimum; generation always uses the strict default, so anything
  // we create now is full strength.
  assert.equal(mfa.isLegacySecret(mfa.generateSecret()), false);
});

// --- legacy-secret detection ------------------------------------------------------------------

test('isLegacySecret spots an old 80-bit (16-char) secret', () => {
  // What otplib v12 used to produce. These must keep working rather than locking someone out of their
  // own baby monitor, so they're detected and given a relaxed guardrail on the verify path only.
  assert.equal(mfa.isLegacySecret('JBSWY3DPEHPK3PXP'), true);
});

test('isLegacySecret handles empty and null input without throwing', () => {
  assert.equal(mfa.isLegacySecret(''), false);
  assert.equal(mfa.isLegacySecret(null), false);
  assert.equal(mfa.isLegacySecret(undefined), false);
});

test('isLegacySecret ignores base32 padding when measuring length', () => {
  // Trailing '=' is padding, not entropy — counting it would misclassify a short secret as strong.
  assert.equal(mfa.isLegacySecret('JBSWY3DPEHPK3PXP===='), true);
});

// --- token verification -----------------------------------------------------------------------

test('verifyToken accepts the current code for a modern secret', () => {
  const secret = mfa.generateSecret();
  assert.equal(mfa.verifyToken(secret, otplib.generateSync({ secret })), true);
});

test('★ verifyToken accepts the current code for a LEGACY 80-bit secret', () => {
  // The whole point of the guardrail override: v13 would otherwise THROW on a short secret, which
  // would lock out anyone enrolled before the upgrade.
  const secret = 'JBSWY3DPEHPK3PXP';
  const code = otplib.generateSync({ secret, guardrails: otplib.createGuardrails({ MIN_SECRET_BYTES: 10 }) });
  assert.equal(mfa.verifyToken(secret, code), true);
});

test('verifyToken rejects a wrong code', () => {
  const secret = mfa.generateSecret();
  const right = otplib.generateSync({ secret });
  const wrong = right === '000000' ? '111111' : '000000';
  assert.equal(mfa.verifyToken(secret, wrong), false);
});

test('verifyToken tolerates whitespace in what the user typed', () => {
  // Authenticator apps display "123 456"; people paste it with the space.
  const secret = mfa.generateSecret();
  const code = otplib.generateSync({ secret });
  assert.equal(mfa.verifyToken(secret, `${code.slice(0, 3)} ${code.slice(3)}`), true);
});

test('verifyToken returns false (never throws) for missing secret or token', () => {
  assert.equal(mfa.verifyToken(null, '123456'), false);
  assert.equal(mfa.verifyToken(mfa.generateSecret(), null), false);
  assert.equal(mfa.verifyToken(null, null), false);
  assert.equal(mfa.verifyToken('', ''), false);
});

test('verifyToken returns false for a malformed secret instead of throwing', () => {
  // A corrupted DB value must fail closed, not crash the login route.
  assert.equal(mfa.verifyToken('not-valid-base32!!!', '123456'), false);
});

test('★ verifyToken allows one time-step of drift, and no more', () => {
  // epochTolerance is in SECONDS in v13, not time steps — passing v12's `1` would mean +/-1 second and
  // reject nearly every real code. This pins the intended +/-30s.
  const secret = mfa.generateSecret();
  const now = Math.floor(Date.now() / 1000);
  const prev = otplib.generateSync({ secret, epoch: now - 30 });
  const wayOff = otplib.generateSync({ secret, epoch: now - 300 });
  assert.equal(mfa.verifyToken(secret, prev), true, 'the previous 30s step should still be accepted');
  assert.equal(mfa.verifyToken(secret, wayOff), false, 'five minutes ago must not be accepted');
});

// --- enrolment URI ----------------------------------------------------------------------------

test('keyUri builds a scannable otpauth URI with the account and issuer', () => {
  const secret = mfa.generateSecret();
  const uri = mfa.keyUri('nacho', secret);
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /nacho/);
  assert.match(uri, /issuer=Nightlight/);
  assert.match(uri, new RegExp(`secret=${secret}`));
});

test('keyUri accepts a custom issuer', () => {
  assert.match(mfa.keyUri('nacho', mfa.generateSecret(), 'Nursery'), /issuer=Nursery/);
});

test('keyUri percent-encodes a username with spaces', () => {
  const uri = mfa.keyUri('two words', mfa.generateSecret());
  assert.ok(!uri.includes('two words'), 'a raw space would produce an unscannable URI');
});

// --- matchTokenStep (#550: what the replay check keys on) -------------------------------------

test('matchTokenStep returns the step the code belongs to, and null for a wrong or empty code', () => {
  const secret = mfa.generateSecret();
  const now = Math.floor(Date.now() / 1000);
  const step = (offsetSec) => Math.floor((now + offsetSec) / 30);
  assert.equal(mfa.matchTokenStep(secret, otplib.generateSync({ secret, epoch: now })), step(0));
  // A code from the previous step is reported as THAT step: if it reported the server's current one, a
  // replayed old code would look newer than it is and slip past a "greater than last" check.
  assert.equal(mfa.matchTokenStep(secret, otplib.generateSync({ secret, epoch: now - 30 })), step(-30));
  assert.equal(mfa.matchTokenStep(secret, otplib.generateSync({ secret, epoch: now + 30 })), step(30));
  assert.equal(mfa.matchTokenStep(secret, otplib.generateSync({ secret, epoch: now - 300 })), null);
  assert.equal(mfa.matchTokenStep(secret, null), null);
  assert.equal(mfa.matchTokenStep(null, '123456'), null);
  assert.equal(mfa.matchTokenStep('not-valid-base32!!!', '123456'), null);
});

test('★ matchTokenStep gives a step for a LEGACY 80-bit secret too', () => {
  const secret = 'JBSWY3DPEHPK3PXP';
  // One clock reading for both the code and the expected step (review of #720): reading Date.now() again
  // for the expectation failed the case whenever a 30 s step boundary passed in between.
  const now = Date.now();
  const code = otplib.generateSync({
    secret, epoch: Math.floor(now / 1000), guardrails: otplib.createGuardrails({ MIN_SECRET_BYTES: 10 }),
  });
  assert.equal(mfa.matchTokenStep(secret, code), Math.floor(now / 30000));
});

// --- backup codes -----------------------------------------------------------------------------

test('generateBackupCodes returns display codes plus a hashed JSON blob', async () => {
  const { codes, hashesJson } = await mfa.generateBackupCodes();
  assert.ok(Array.isArray(codes) && codes.length > 0);
  assert.equal(mfa.backupCodesRemaining(hashesJson), codes.length);
  for (const c of codes) assert.match(c, /^[0-9a-f]{4}-[0-9a-f]{4}$/, 'shown to the user in xxxx-xxxx form');
  // Stored hashed, never in plain text — the DB blob must not contain a usable code.
  for (const c of codes) assert.ok(!hashesJson.includes(c.replace('-', '')), 'code found in the stored blob');
});

test('generateBackupCodes honours an explicit count', async () => {
  assert.equal((await mfa.generateBackupCodes(3)).codes.length, 3);
  assert.equal((await mfa.generateBackupCodes(0)).codes.length, 0);
});

test('★ a backup code works exactly once', async () => {
  const { codes, hashesJson } = await mfa.generateBackupCodes(3);
  const first = await mfa.verifyAndConsumeBackupCode(hashesJson, codes[0]);
  assert.equal(first.ok, true);
  assert.equal(mfa.backupCodesRemaining(first.hashesJson), 2, 'the used code is consumed');

  // Replaying the same code against the UPDATED list must fail — that is what single-use means.
  assert.equal((await mfa.verifyAndConsumeBackupCode(first.hashesJson, codes[0])).ok, false);
  // The others still work.
  assert.equal((await mfa.verifyAndConsumeBackupCode(first.hashesJson, codes[1])).ok, true);
});

test('backup codes are accepted regardless of dashes, case or spacing', async () => {
  const { codes, hashesJson } = await mfa.generateBackupCodes(2);
  const messy = `  ${codes[0].toUpperCase().replace('-', ' ')} `;
  assert.equal((await mfa.verifyAndConsumeBackupCode(hashesJson, messy)).ok, true);
});

test('verifyAndConsumeBackupCode rejects an unknown code', async () => {
  const { hashesJson } = await mfa.generateBackupCodes(2);
  const r = await mfa.verifyAndConsumeBackupCode(hashesJson, 'dead-beef');
  assert.equal(r.ok, false);
  assert.equal(r.hashesJson, undefined, 'nothing is consumed on a failed attempt');
});

test('verifyAndConsumeBackupCode handles empty, null and corrupt stored data', async () => {
  assert.equal((await mfa.verifyAndConsumeBackupCode(null, 'abcd-1234')).ok, false);
  assert.equal((await mfa.verifyAndConsumeBackupCode('[]', 'abcd-1234')).ok, false);
  assert.equal((await mfa.verifyAndConsumeBackupCode('{not json', 'abcd-1234')).ok, false);
  const { hashesJson } = await mfa.generateBackupCodes(1);
  assert.equal((await mfa.verifyAndConsumeBackupCode(hashesJson, '')).ok, false);
  assert.equal((await mfa.verifyAndConsumeBackupCode(hashesJson, null)).ok, false);
});

test('backupCodesRemaining is 0 for null, empty or corrupt data rather than throwing', () => {
  assert.equal(mfa.backupCodesRemaining(null), 0);
  assert.equal(mfa.backupCodesRemaining(''), 0);
  assert.equal(mfa.backupCodesRemaining('{not json'), 0);
});

test('qrDataUrl produces an embeddable PNG data URI for the enrolment QR', async () => {
  const uri = mfa.keyUri('nacho', mfa.generateSecret());
  const dataUrl = await mfa.qrDataUrl(uri);
  assert.match(dataUrl, /^data:image\/png;base64,/);
});

process.on('exit', cleanupTempDataDirs);
