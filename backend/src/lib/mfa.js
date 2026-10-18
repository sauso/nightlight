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
// v13 also enforces a 16-byte (128-bit) minimum secret, per RFC 4226, and v12's `generateSecret()`
// produced 10 bytes — so `verifySync` THROWS on every secret enrolled under v12 rather than
// returning false. That secret is shared with the user's authenticator app, so it cannot be
// lengthened server-side; the only true fix is re-enrolment.
//
// We deliberately do NOT force that. Locking someone out of their own baby monitor — where the
// recovery path can mean SSH-ing into a box — is a worse outcome than continuing to accept an
// 80-bit secret from someone who already holds it. So legacy secrets keep verifying, via otplib's
// own escape hatch for exactly this case (`createGuardrails`, added in 13.4.1), while
// `isLegacySecret()` lets the API flag the account so it can be nudged to re-enrol at leisure.
// Anything enrolled from here on is 160-bit. See docs/mfa.md.
import { generateSecret as newSecret, generateURI, verifySync, createGuardrails } from 'otplib';
import crypto from 'crypto';
import * as passwordHash from './passwordHash.js';
import QRCode from 'qrcode';

// ±1 time step of clock drift, expressed in seconds — see the unit trap above.
const EPOCH_TOLERANCE_SEC = 30;
// otplib v13's floor, and RFC 4226's recommendation. A base32 character carries 5 bits.
const MIN_SECRET_BYTES = 16;
// Relaxed guardrails used ONLY to verify a pre-v13 secret (10 bytes / 80 bits). Never used to
// generate one — new enrolments always go through the default, strict guardrails.
const LEGACY_GUARDRAILS = createGuardrails({ MIN_SECRET_BYTES: 10 });

const BACKUP_CODE_COUNT = 10;

// v13 returns 32 base32 characters = 20 bytes (160 bits), comfortably over the minimum.
export function generateSecret() {
  return newSecret();
}

// True for a secret enrolled under otplib v12, which produced 80-bit secrets that v13's default
// guardrails refuse. These still verify (see LEGACY_GUARDRAILS); the flag exists so the account can
// be prompted to re-enrol into a 160-bit secret, not to block anyone.
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

// The time step (RFC 6238's counter: floor(unix seconds / 30)) of the code that matched, or null when
// nothing did. This is what a caller needs to refuse a REPLAY (#550): the same 6-digit code stays
// valid for up to ~90 s (its own 30 s step plus one step of drift each side), so "is this code right"
// is not enough on its own — the caller must also remember the newest step it has accepted. The step
// reported is the one the code belongs to (otplib's `timeStep`), not the server's current one, so a
// code from the previous step is recorded as that earlier step and cannot be used after a later one.
export function matchTokenStep(secret, token) {
  if (!secret || !token) return null;
  try {
    const r = verifySync({
      token: String(token).replace(/\s+/g, ''),
      secret,
      epochTolerance: EPOCH_TOLERANCE_SEC,
      // Only a pre-v13 secret gets the relaxed floor. Passing the strict default here would make
      // verifySync throw on it, which the catch below would turn into a silent "wrong code".
      ...(isLegacySecret(secret) ? { guardrails: LEGACY_GUARDRAILS } : {}),
    });
    return r.valid === true && Number.isSafeInteger(r.timeStep) ? r.timeStep : null;
  } catch {
    return null;
  }
}

// Stateless "is this code currently valid" — enrolment confirmation uses it (the pending secret has no
// last-used step yet). Login must NOT use it alone: it cannot see a replay. See matchTokenStep.
export function verifyToken(secret, token) {
  return matchTokenStep(secret, token) !== null;
}

export function qrDataUrl(uri) {
  return QRCode.toDataURL(uri, { margin: 1, width: 240 });
}

// One-time recovery codes. Returns the plaintext codes to show the user ONCE, plus a JSON string of
// their bcrypt hashes to store. Format is two groups of 4 hex chars ("a1b2-c3d4") for readability;
// the dash/case are ignored on verification.
//
// ASYNC (#548): bcryptjs is pure JavaScript, ~80 ms of blocked event loop per hash at cost 10, and ten
// of them ran back to back on /me/mfa/enable. They now run in a worker thread (lib/passwordHash.js), so
// camera/detection work keeps running. Cost factor is unchanged (10) — existing hashes still verify.
export async function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = [];
  const hashes = [];
  for (let i = 0; i < count; i += 1) {
    const raw = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
    hashes.push(await passwordHash.hash(raw, 10));
  }
  return { codes, hashesJson: JSON.stringify(hashes) };
}

const normalizeCode = (code) => String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Check a submitted backup code against the stored hashes. On a match, that hash is consumed
// (removed) so the code can't be reused. Returns { ok, hashesJson } — hashesJson is the updated
// list to persist when ok is true.
//
// ASYNC (#548): up to ten bcrypt compares (~0.8 s of blocked loop when it was synchronous), now in the
// worker thread. Sequential on purpose, stopping at the first match, exactly as findIndex did. Because
// this now yields, the caller
// can no longer assume nothing else ran between reading `hashesJson` and writing the result back: it
// must write with a compare-and-swap on the value it read (routes/auth.js does), or two simultaneous
// submissions of one backup code would both succeed.
export async function verifyAndConsumeBackupCode(hashesJson, code) {
  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false };
  let hashes;
  try {
    hashes = JSON.parse(hashesJson || '[]');
  } catch {
    return { ok: false };
  }
  let idx = -1;
  for (let i = 0; i < hashes.length; i += 1) {
    if (await passwordHash.compare(normalized, hashes[i])) {
      idx = i;
      break;
    }
  }
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
