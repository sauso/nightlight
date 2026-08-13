// TOTP two-factor auth helpers. otplib v12's `authenticator` API is imported via a namespace
// import because the package is CommonJS and Node's ESM interop doesn't expose its named exports
// directly. Verification allows ±1 time-step (±30s) of clock drift, which is the usual tolerance
// for authenticator apps whose clocks aren't perfectly in sync with the server.
import * as otplib from 'otplib';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';

const { authenticator } = otplib;
authenticator.options = { window: 1 };

const BACKUP_CODE_COUNT = 10;

export function generateSecret() {
  return authenticator.generateSecret();
}

// The otpauth:// URI an authenticator app scans. `issuer`/label use the instance's app name so the
// entry reads e.g. "Nightlight (alice)" in the app rather than a generic name.
export function keyUri(username, secret, issuer = 'Nightlight') {
  return authenticator.keyuri(username, issuer, secret);
}

export function verifyToken(secret, token) {
  if (!secret || !token) return false;
  try {
    return authenticator.verify({ token: String(token).replace(/\s+/g, ''), secret });
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
