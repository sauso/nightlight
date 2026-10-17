// Shared validation for an avatar photo (children + users). The image is resized to a small square
// in the browser and sent as a base64 data-URL; we just sanity-check and cap it so a bad or huge
// upload can't bloat the SQLite file.
//
// The cap (#555 bullet 3) used to be 700 KB, which was UNREACHABLE: the whole JSON body goes through
// express.json() with its default 100 KB limit (index.js), so anything over ~99 KB was refused with a 413
// before this code ran (verified at the time: 101 KB -> 413). The client sends ~256 px JPEGs, a few tens
// of KB (frontend/src/lib/imageResize.js), so it never noticed. The cap is now what is true: 90 KB of
// data URL, which leaves ~10 KB of the 100 KB body for the other fields in the same request, and gives
// the user this readable message instead of the generic 413 for a photo between 90 and 99 KB.
// Raising express.json's limit for these routes was the other option; it would widen what an
// unauthenticated-size body parser accepts for no client that needs it, so it is not done.
// photo.test.js pins that a photo at the cap still fits in a default-limit body.
export const MAX_PHOTO_LEN = 90 * 1024;

// A fixed allowlist, not "any image/*" (#555 bullet 2): image/svg+xml is a document that can carry script,
// inert inside an <img> but not if a photo URL is ever opened on its own. The browser always produces
// image/jpeg (canvas.toDataURL), the other two are what an API caller might reasonably send.
// base64 only: a non-base64 data URL ("data:image/png,...") is not what any client produces.
const PHOTO_PREFIX = /^data:image\/(?:jpeg|png|webp);base64,/;

// `photo === undefined` → field omitted, keep `existing`. `null`/'' → explicit clear. A string must
// be an image data URL within the size cap. Throws a user-facing message otherwise.
//
// A value equal to `existing` is accepted unchecked: the edit forms re-send the whole record, so an
// avatar stored before this allowlist (a GIF, say) must not block every later save of that child or
// user, a rename included. Only a CHANGED photo is held to the allowlist and the cap.
export function normalizePhoto(photo, existing) {
  if (photo === undefined) return existing;
  if (photo === null || photo === '') return null;
  if (typeof photo === 'string' && photo === existing) return existing;
  // Two messages so the long-standing one (a client may match on it) is unchanged for what it always covered.
  if (typeof photo !== 'string' || !photo.startsWith('data:image/')) {
    throw new Error('Photo must be an image data URL');
  }
  if (!PHOTO_PREFIX.test(photo)) throw new Error('Photo must be a JPEG, PNG or WebP image');
  if (photo.length > MAX_PHOTO_LEN) throw new Error('Photo is too large — try a smaller image');
  return photo;
}
