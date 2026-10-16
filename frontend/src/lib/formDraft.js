// Drafts of settings forms that survive a page reload (#377).
//
// WHY THIS EXISTS. App.jsx reloads the whole page when the app comes back after more than 15 s in the
// background, on purpose: a phone that was put away can leave the live streams half-dead, and a reload is
// what reliably repairs them. That reload also throws away React state, so a parent who switched to a
// password manager halfway through a form came back to an empty one. The reload stays; the typing is saved
// here first and put back when the form mounts again. The same store also makes "type a child's name, open
// Settings, come back" resume instead of reverting (the other half of the issue).
//
// WHERE: sessionStorage, not localStorage. It survives location.reload() and in-tab navigation, but is
// gone when the tab or PWA window is closed, so a half-typed form does not linger on a shared tablet for
// weeks. Entries also carry a timestamp and are ignored after DRAFT_TTL_MS, for a PWA window that stays
// open for days. Every call is wrapped in try/catch: storage can be missing or throw (private windows,
// blocked site data), and a form must work exactly as before when it does.
//
// ⚠️ NEVER A SECRET. A draft is plain text in browser storage, readable by any script on this origin and
// by anyone holding the unlocked device. So:
//   1. Each form passes an ALLOW-LIST of the fields it may store (`allow`). A field added to a form later
//      is NOT persisted until someone chooses to add it here, which is the safe direction to fail in.
//   2. On top of that, any key whose name looks like a credential is dropped even if a caller allowed it
//      (SECRET_KEY_RE). That is the backstop for a careless allow-list, not the primary defence.
//   The cost is deliberate and documented: after a reload the camera password has to be typed again. The
//   issue suggested an "in-memory or short-lived" mechanism for it; a reload empties memory, and a
//   short-lived storage entry is still a stored password, so the owner's rule (never persist a secret) wins.
//
// KEYS are scoped by user id, so a draft typed by one signed-in person is never offered to another who
// signs in on the same tab; clearAllDrafts() also runs on logout.

export const DRAFT_PREFIX = 'nightlight_draft:';

// 6 hours: long enough for "put the phone down, deal with the baby, come back", short enough that an
// abandoned form is not resurrected the next day. A judgement, not a measurement.
export const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

// pass(word) | secret | token | key | credential | auth. Matches rtsp_password, talk_password, app_token,
// api_key, user_key, and so on; a plain `name`, `birthday`, `color` or `sleep_window_start` does not match.
export const SECRET_KEY_RE = /pass|secret|token|key|credential|auth/i;

export function draftKey(userId, formId) {
  return `${DRAFT_PREFIX}${userId ?? 'anon'}:${formId}`;
}

function store() {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

// Only the allowed keys, and never one that looks like a secret. Values must be plain strings, numbers,
// booleans or null: an object (or a data: URL for a photo) is not what these forms keep in a draft.
export function pickDraftFields(values, allow) {
  const out = {};
  for (const k of allow) {
    if (SECRET_KEY_RE.test(k)) continue;
    if (!values || !(k in values)) continue;
    const v = values[k];
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v;
  }
  return out;
}

export function saveDraft(key, values, allow) {
  const s = store();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify({ at: Date.now(), values: pickDraftFields(values, allow) }));
  } catch { /* quota or blocked storage: the form simply is not resumable */ }
}

// The stored fields, filtered through the allow-list AGAIN on the way out (so an entry written by an older
// build that allowed more cannot inject a field now), or null when there is no usable draft.
export function loadDraft(key, allow) {
  const s = store();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.at !== 'number' || Date.now() - parsed.at > DRAFT_TTL_MS) {
      s.removeItem(key);
      return null;
    }
    const values = pickDraftFields(parsed.values, allow);
    return Object.keys(values).length ? values : null;
  } catch {
    return null;
  }
}

export function clearDraft(key) {
  const s = store();
  if (!s) return;
  try { s.removeItem(key); } catch { /* nothing to do */ }
}

// Sign-out: nothing typed by the previous person may be offered to the next.
export function clearAllDrafts() {
  const s = store();
  if (!s) return;
  try {
    for (const k of Object.keys(s)) if (k.startsWith(DRAFT_PREFIX)) s.removeItem(k);
  } catch { /* nothing to do */ }
}
