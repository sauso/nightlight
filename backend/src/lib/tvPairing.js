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

// A typed code as it is looked up and stored, so `bcdf ghjk`, `BCDF-GHJK` and `BCDFGHJK` are one code. Exactly what is
// taken out first: JavaScript's whitespace (\s: spaces, tabs, line breaks, the no-break and other Unicode space
// separators, U+FEFF) and dash punctuation (\p{Pd}: the hyphen-minus, and the en dash a phone's keyboard may turn it
// into). NOT the minus sign U+2212 (a math symbol, not dash punctuation) nor the zero-width space U+200B (a format
// character, not whitespace): a code holding either is refused. What is left must be exactly 8 ASCII letters BEFORE it
// is upper-cased (review of PR 1b, Codex and Opus): toUpperCase() maps some non-ASCII letters onto ASCII ones (the long
// s U+017F becomes S, the ligatures U+FB05 and U+FB00 become ST and FF), so checking only after upper-casing accepted
// strings that are not the code on the TV. Then it must be 8 symbols of the alphabet. Null otherwise, or when the input
// is not text; the routes then look up nothing and answer the uniform 404, after the same work as an unknown code.
const TYPED_CODE_SHAPE = /^[A-Za-z]{8}$/;
export function normaliseUserCode(input) {
  if (typeof input !== 'string') return null;
  const stripped = input.replace(/[\s\p{Pd}]/gu, '');
  if (!TYPED_CODE_SHAPE.test(stripped)) return null;
  const code = stripped.toUpperCase();
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
//   * a lone UTF-16 surrogate (\p{Cs}), which is not text: SQLite would store it as a replacement character;
//   * every FORMAT character (\p{Cf}) but one. That is the bidirectional controls (with a right-to-left override,
//     "VT moor gniviL" shows as a different string from the one stored, and can reorder the text around it), the
//     zero-width spaces, the word joiner U+2060, the invisible operators, the soft hyphen and the tag characters. None of
//     them draws anything, so a label made of them shows blank, and with them a label can carry text nobody sees (review
//     of PR 1b, Codex and Opus). The one kept is U+200D, the zero-width JOINER, which joins emoji into one picture (a
//     family) and some scripts' letters;
//   * the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0: letters by category, but they draw nothing, and they are
//     the usual way to make a name that looks blank.
// Then runs of spaces (including the ones a removed character leaves side by side) become one, it is trimmed, and
// clamped to LABEL_MAX_CHARS code points. Letters of every script and emoji are kept: a non-Latin label is shown as
// typed (the design's §13). Null when nothing visible is left (spaces and joiners alone count as nothing; the screens
// then say "a TV"). Known losses, accepted: a flag built from tag characters (a few regional flags) is cut to its plain
// black flag, and the zero-width NON-joiner U+200C goes, which some scripts use between letters (the word still reads).
// Text only: the caller refuses anything that is not a string.
const INVISIBLE = /(?!\u200D)[\p{Cc}\p{Cf}\p{Cs}\u115F\u1160\u3164\uFFA0]/gu;
const SOMETHING_VISIBLE = /[^ \u200D]/u;
export function sanitiseLabel(text) {
  const cleaned = text
    .replace(/\s/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  const clamped = Array.from(cleaned).slice(0, LABEL_MAX_CHARS).join('').trim();
  return SOMETHING_VISIBLE.test(clamped) ? clamped : null;
}
