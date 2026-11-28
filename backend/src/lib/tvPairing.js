// The pure parts of signing in a TV by code (#1237, phase 2 of the Android TV app; planning/tv-pairing-design.md §4.2):
// the two codes, their normalisation, and the label a TV sends. No database, no request: the routes, the state machine
// and the limits are in routes/auth.js (the pairing section at the end), which needs its module-private createSession
// and sign the same way the invite redeem does.
//
// TWO CODES, AND ONLY ONE IS A SECRET:
//   * device_code: 32 random bytes in base64url (43 characters), as an invite token. Held only by the TV, sent only in a
//     POST body, and stored only as its sha256 (tv_pairings.device_hash): 256 random bits need no slow hash, the lookup
//     is by equality. Whoever holds it collects the session once the pairing is approved, so it is never logged, never
//     shown, never in a URL.
//   * user_code: 8 characters the TV shows (and the person types on their phone). NOT a credential: it only names a
//     pending pairing to a SIGNED-IN approver, who must type it. 20 symbols x 8 = about 34.6 bits, bounded by the
//     failures-only limiter on the three signed-in routes and by the cap on live pairings (routes/auth.js).
import { createHash, randomBytes, randomInt } from 'node:crypto';

// No vowels (so no words, rude or otherwise), no digits and no L (so no 0/O, 1/I/L confusion on a TV across a room).
// 20 symbols. The design's first draft had an L in it and sample codes outside the alphabet (first design review).
export const USER_CODE_ALPHABET = 'BCDFGHJKMNPQRSTVWXYZ';
export const USER_CODE_LENGTH = 8;
const USER_CODE_PATTERN = new RegExp(`^[${USER_CODE_ALPHABET}]{${USER_CODE_LENGTH}}$`);
// The shape newDeviceCode makes: anything else is not a device code, and is answered like an unknown one.
export const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// What a TV may call itself, in characters (code points, so an emoji is one and is never cut in half). Long enough for
// "Living room TV (upstairs)", short enough for one line on the approval page and in the session list.
export const LABEL_MAX_CHARS = 40;

export function newDeviceCode() {
  return randomBytes(32).toString('base64url');
}

export function deviceCodeHash(deviceCode) {
  return createHash('sha256').update(deviceCode).digest('hex');
}

// One user code. `draw(n)` must answer a uniformly random integer in [0, n); the default is crypto.randomInt, which
// does the rejection sampling itself (Node draws again whenever the random bytes fall in the biased tail). Never
// `randomBytes(1)[0] % 20`: 256 is not a multiple of 20, so the first 16 symbols would come up more often. `draw` is a
// parameter only so a test can force a collision (routes/auth.js retries one); anything it answers that is not an
// integer in range is a fault, never a symbol.
export function newUserCode(draw = randomInt) {
  let code = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    const index = draw(USER_CODE_ALPHABET.length);
    if (!Number.isInteger(index) || index < 0 || index >= USER_CODE_ALPHABET.length) {
      throw new Error(`newUserCode: draw answered ${JSON.stringify(index)}, not an integer in [0, ${USER_CODE_ALPHABET.length})`);
    }
    code += USER_CODE_ALPHABET[index];
  }
  return code;
}

// A typed code as it is looked up and stored: upper case, with every space and dash taken out, so `bcdf ghjk`,
// `BCDF-GHJK` and `BCDFGHJK` are one code. Any dash: a phone's keyboard can turn `-` into an en dash (\p{Pd} is every
// dash punctuation character). Null when the result is not exactly 8 symbols of the alphabet, or the input is not text;
// the routes then look up nothing and answer the uniform 404, after the same work as an unknown code.
export function normaliseUserCode(input) {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s\p{Pd}]/gu, '');
  return USER_CODE_PATTERN.test(code) ? code : null;
}

// How the TV shows it: two groups of four, `BCDF-GHJK`. normaliseUserCode takes the dash out again.
export function displayUserCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// The label a TV sent, made safe to SHOW (design §3 row 1 g). It is attacker-controlled: anyone can start a pairing
// and call it "Living room TV", so the approval page shows it in quotes beside the TV's own browser string. What this
// takes away is what could make the label LIE about itself on screen or in a log:
//   * line breaks and other whitespace become a space (a label must be one line: the log line and the session row),
//     then every other control character goes: C0, DEL and C1 (\p{Cc});
//   * the bidirectional controls (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069): with them, "VT moor gniviL"
//     plus a right-to-left override shows as a different string from the one stored, and can reorder the text around it;
//   * a lone UTF-16 surrogate (\p{Cs}), which is not text: SQLite would store it as a replacement character.
// Then runs of spaces (including the ones a removed character leaves side by side) become one, it is trimmed, and
// clamped to LABEL_MAX_CHARS code points. Letters of every script, emoji and joiners are kept: a non-Latin label is
// shown as typed (the design's §13). Null when nothing is left (the screens then say "a TV").
// Text only: the caller refuses anything that is not a string.
const BIDI_CONTROLS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;
const CONTROLS_AND_LONE_SURROGATES = /[\p{Cc}\p{Cs}]/gu;
export function sanitiseLabel(text) {
  const cleaned = text
    .replace(/\s/gu, ' ')
    .replace(CONTROLS_AND_LONE_SURROGATES, '')
    .replace(BIDI_CONTROLS, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  const clamped = Array.from(cleaned).slice(0, LABEL_MAX_CHARS).join('').trim();
  return clamped || null;
}
