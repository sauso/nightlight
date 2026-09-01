const crypto = require('crypto');

// A minimal TOTP generator, so the two-factor spec can act as the authenticator app.
//
// ★ WHY THIS IS HAND-ROLLED. The Playwright container installs exactly one dependency
// (`@playwright/test` — see docker-compose.e2e.yml), and pulling otplib in just to generate six
// digits would mean the test verifying the server agrees with the same library the server uses. That
// is a weaker test: a change to otplib's defaults would move both sides together and the spec would
// stay green. RFC 6238 with the app's parameters is ~25 lines of Node's own crypto, and being an
// INDEPENDENT implementation is the point — it is the only thing here that would notice if the
// server's algorithm, digit count or time step quietly changed.
//
// Parameters match what the app enrols with (backend/src/lib/mfa.js): base32 secret, HMAC-SHA1,
// 30-second step, 6 digits — the defaults every authenticator app assumes.

// RFC 4648 base32, which is how the secret is handed to the user and stored.
function base32Decode(input) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`not a base32 secret (bad character "${char}")`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// The current 6-digit code for a secret. `atMs` lets a test ask for a NEIGHBOURING time step, which
// is how the "a stale code is refused" case is written without waiting 30 seconds for one to expire.
function totp(secret, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / 30);
  const counterBytes = Buffer.alloc(8);
  // 64-bit counter, big-endian. Written as two 32-bit halves because writeBigUInt64BE would mean
  // BigInt literals, and the high half is zero until the year 10000 anyway.
  counterBytes.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBytes.writeUInt32BE(counter >>> 0, 4);

  const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBytes).digest();
  // Dynamic truncation (RFC 4226 §5.3): the low nibble of the last byte picks a 4-byte window, and
  // the top bit is masked off so the result is positive on every platform.
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, '0');
}

module.exports = { totp, base32Decode };
