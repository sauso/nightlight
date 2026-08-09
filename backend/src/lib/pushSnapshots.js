import crypto from 'crypto';

// Ephemeral store for the snapshot picture attached to a Firebase (FCM) push alert. FCM can't
// carry image bytes the way Pushover can — it only takes an image URL that the receiving phone
// downloads itself, in the Android system layer, WITHOUT the app's login token. So we hand out a
// short-lived, unguessable URL for exactly that one frame instead of exposing an authenticated
// endpoint to an unauthenticated fetch.
//
// Security model: the id is 256 bits of randomness (infeasible to guess), the entry is deleted
// after TTL_MS (and on process exit it's just gone — in-memory only, never written to disk), and
// it only ever holds a single motion frame. The exposure is one transient snapshot to whoever
// holds the unguessable URL, for a few minutes. Kept in memory (not the DB) precisely so it's
// naturally short-lived and leaves nothing behind.

const TTL_MS = 3 * 60 * 1000; // long enough for a phone that fetches the image a little late
const store = new Map(); // id -> { buffer, timer }

// Stash a JPEG buffer and return its random id. Returns null for an empty/absent buffer so callers
// can simply send a text-only alert.
export function storeSnapshot(buffer) {
  if (!buffer || !buffer.length) return null;
  const id = crypto.randomBytes(32).toString('hex');
  const timer = setTimeout(() => store.delete(id), TTL_MS);
  if (timer.unref) timer.unref(); // don't keep the event loop alive for a pending snapshot
  store.set(id, { buffer, timer });
  return id;
}

// Fetch a stored JPEG by id, or null if it's unknown/expired.
export function getSnapshot(id) {
  const entry = store.get(id);
  return entry ? entry.buffer : null;
}
