// Shared validation for an avatar photo (children + users). The image is resized to a small square
// in the browser and sent as a base64 data-URL; we just sanity-check and cap it so a bad or huge
// upload can't bloat the SQLite file (~700KB of base64 ≈ a 512px JPEG with headroom).
const MAX_PHOTO_LEN = 700 * 1024;

// `photo === undefined` → field omitted, keep `existing`. `null`/'' → explicit clear. A string must
// be an image data URL within the size cap. Throws a user-facing message otherwise.
export function normalizePhoto(photo, existing) {
  if (photo === undefined) return existing;
  if (photo === null || photo === '') return null;
  if (typeof photo !== 'string' || !photo.startsWith('data:image/')) {
    throw new Error('Photo must be an image data URL');
  }
  if (photo.length > MAX_PHOTO_LEN) throw new Error('Photo is too large — try a smaller image');
  return photo;
}
