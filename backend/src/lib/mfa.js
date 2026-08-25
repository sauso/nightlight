// TOTP two-factor auth helpers, on otplib v13.
//
// v13 is a rewrite of v12, not a bump: the `authenticator` singleton is gone, replaced by named
// exports (`generateSecret`, `generateURI`, `verifySync`). All three are synchronous, so the call
// sites in routes/auth.js stay synchronous too.
//
// TWO UNIT TRAPS, both of which produce working-looking but wrong behaviour rather than an error:
//   * `epochTolerance` is in SECONDS, not time steps. v12's `{ window: 1 }` (±1 step) is
//     `epochTolerance: 30` here — passing 1 means ±1 second, which rejects nearly every real code
//     from a phone whose clock isn't perfectly in step with the server.
//   * `epoch` is in SECONDS (parts of the v12 API took milliseconds).
//
// v13 also enforces a 16-byte (128-bit) minimum secret, per RFC 4226. v12's `generateSecret()`
// produced 10 bytes, so any secret enrolled under v12 is refused — and `verifySync` THROWS on it
// rather than returning false. `isLegacySecret()` detects those so the login route can say
// "re-enrol" instead of "wrong code". There is no migration path: the secret is shared with the
// user's authenticator app, so it can't be lengthened server-side. See docs/mfa.md.
import { generateSecret as newSecret, generateURI, verifySync } from 'otplib';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';

// ±1 time step of clock drift, expressed in seconds — see the unit trap above.
const EPOCH_TOLERANCE_SEC = 30;
// otplib v13's floor, and RFC 4226's recommendation. A base32 character carries 5 bits.
const MIN_SECRET_BYTES = 16;

const BACKUP_CODE_COUNT = 10;

// v13 returns 32 base32 characters = 20 bytes (160 bits), comfortably over the minimum.
export function generateSecret() {
  return newSecret();
}

// True for a secret enrolled under otplib v12, which produced 80-bit secrets that v13 refuses.
// Those accounts have to re-enrol; callers should say so rather than reporting a bad code.
export function isLegacySecret(secret) {
  if (!secret) return false;
  const chars = String(secret).trim().replace(/=+$/, '').length;
  return Math.floor((chars * 5) / 8) < MIN_SECRET_BYTES;
}

// The otpauth:// URI an authenticator app scans. `issuer`/label use the instance's app name so the
// entry reads e.g. "Nightlight (alice)" in the app rather than a generic name. v13 omits `period`
// and `digits` from the URI; both are at their defaults (30s / 6 digits), which is what an
// authenticator app assumes when they're absent, so the resulting code stream is unchanged.
export function keyUri(username, secret, issuer = 'Nightlight') {
  return generateURI({ type: 'totp', secret, label: username, issuer, algorithm: 'SHA1' });
}

export function verifyToken(secret, token) {
  if (!secret || !token) return false;
  // Guard before calling in: verifySync throws on an under-length secret, and a thrown error here
  // would read as "wrong code" to the caller. isLegacySecret lets routes/auth.js explain instead.
  if (isLegacySecret(secret)) return false;
  try {
    return (
      verifySync({
        token: String(token).replace(/\s+/g, ''),
        secret,
        epochTolerance: EPOCH_TOLERANCE_SEC,
      }).valid === true
    );
  } catch {
    return false;
  }
}

export function qrDataUrl(uri) {
  return QRCode.toDataURL(uri, { margin: 1, width: 240 });
}

// One-time recovery codes. Returns the plaintext codes to show the user ONCE, plus a JSON string of
// their bcrypt hashes to store. Format is two groups of 4 hex chars ("a1b2-c3d4") for readability;
// the dash/case are ignored on verification.
export function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = [];
  const hashes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    hashes.push(bcrypt.hashSync(raw, 10));
  }
  return { codes, hashesJson: JSON.stringify(hashes) };
}

const normalizeCode = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Check a submitted backup code against the stored hashes. On a match, that hash is consumed
// (removed) so the code can't be reused. Returns { ok, hashesJson } — hashesJson is the updated
// list to persist when ok is true.
export function verifyAndConsumeBackupCode(hashesJson, code) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false };
  let hashes;
  try {
    hashes = JSON.parse(hashesJson || '[]');
  } catch {
    return { ok: false };
  }
  const idx = hashes.findIndex((h) => bcrypt.compareSync(normalized, h));
  if (idx === -1) return { ok: false };
  hashes.splice(idx, 1);
  return { ok: true, hashesJson: JSON.stringify(hashes) };
}

export function backupCodesRemaining(hashesJson) {
  try {
    return JSON.parse(hashesJson || '[]').length;
  } catch {
    return 0;
  }
}
