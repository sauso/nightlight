import { useSyncExternalStore } from 'react';

// A per-camera save queue for the detection screens (motion/sound/schedule, DetectionSettings.jsx)
// and the camera tile's quick toggles (CameraTile.jsx) — issue #444. Both write to the same
// `PUT /cameras/:id/detection` endpoint, so this is the one place that decides when a request for a
// given camera actually goes out, and it is the fix for three defects the old per-component debounce
// (a `setTimeout` in a component effect) had:
//
//   1. Navigating away used to cancel the pending write outright, because the debounce lived in a
//      component effect that was torn down on unmount. This queue lives in module memory, so a write
//      it has already committed to keeps going after the component that started it is gone.
//   2. A failed write reset to the same blank status an idle screen shows, so the user's new value
//      looked saved when it was not. `state` now has a real `'failed'` value that only clears on a
//      successful send.
//   3. Two writes for the same camera could be in flight at once — a slow first PUT overtaken by a
//      faster second one — so the LAST request to land, not the last one the user actually made,
//      could win. `inFlight` plus the `rev`/`sentRev` revision pair make "at most one in flight per
//      camera" and "the most recent intent always wins" both true regardless of network timing.
//
// It queues PATCHES — only the fields a caller actually changed — never a caller's whole form state.
// `PUT /:id/detection` already keeps every field it isn't sent (backend/src/routes/cameras.js, issue
// #443), so a retried or coalesced patch can only ever overwrite the fields it names; it can't drag a
// stale value of some OTHER field back onto the wire the way resending the whole form used to.
//
// A first review round of this queue (still issue #444) found four more defects, now fixed:
//   4. `queuePatch` had exactly one `send` slot per entry, so a caller (CameraTile) that wrapped its
//      own Promise around `send` and resolved it from inside there broke the moment a SECOND caller
//      queued a patch for the same camera — the later call's `send` overwrote the earlier one's, and
//      the earlier caller's resolve/reject were never invoked again. `queuePatch` now returns its own
//      promise per call, tracked by revision in `waiters` and settled by `settleWaiters` — see there.
//   5. The queue called `onSaved` (the CamerasContext refresh) without awaiting it, so a caller's
//      "busy" guard could clear before the refresh landed and read stale camera state on a fast
//      second tap. `onSaved` is now awaited before a caller's promise resolves.
//   6. `pendingPatch()` read only `pending`, which is cleared the INSTANT a send starts — so a screen
//      revisited between "send started" and "send resolved" saw none of it and seeded its form from
//      stale CamerasContext values while "Saving…" was still showing. `inFlightPatch` now keeps that
//      snapshot visible to `pendingPatch()` until the send resolves.
//   7. Sendability was checked on the raw patch, so `{ snapshot_password: '' }` — which converts to
//      an empty payload — still fired an empty PUT, restarting the detector for nothing. `doSend` now
//      checks the CONVERTED payload.

const DEBOUNCE_MS = 700;
// How long "Saved ✓" stays up before the flag goes quiet again — matches the pre-#444 behaviour.
const SAVED_DISPLAY_MS = 1500;

const DEFAULT_SNAPSHOT = Object.freeze({ state: 'idle', kind: null, error: null });

const registry = new Map(); // cameraId -> entry
const subscribers = new Map(); // cameraId -> Set<callback>

// Bumped by __resetForTests(). Every doSend() capture it at the moment the request fires, and its
// .then/.catch check it before touching `registry` — otherwise a promise from a PREVIOUS test that
// resolves after that test has already reset the queue could mutate an entry a later test created
// fresh under the same camera id, corrupting that test with no visible cause.
let currentGeneration = 0;

export function minToHHMM(m) {
  return `${String(Math.floor((m || 0) / 60)).padStart(2, '0')}:${String((m || 0) % 60).padStart(2, '0')}`;
}
export function hhmmToMin(s) {
  const [h, mm] = String(s || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (mm || 0);
}

// The per-field rules a detection payload is built with, shared by every caller (a page edit, a tile
// quick-toggle, a retry of either) so none of them can disagree about what a given key means on the
// wire. Anything not listed here (source, the MQTT fields, the snapshot URL) passes through as-is;
// `zone` and `snapshot_password` get their own handling below. Everything else mirrors what the route
// itself does with a value it DOES receive (backend/src/routes/cameras.js), so whatever a form
// control hands back — a checkbox boolean, a number input's string, an HH:MM time string — always
// lands as the type the route expects.
const FIELD_CONVERTERS = {
  motion_enabled: (v) => !!v,
  sensitivity: (v) => Number(v),
  cooldown_s: (v) => Number(v),
  confirm_s: (v) => Number(v),
  schedule_enabled: (v) => !!v,
  start: (v) => hhmmToMin(v),
  end: (v) => hhmmToMin(v),
  zone: (v) => v ?? null,
  sound_enabled: (v) => !!v,
  sound_sensitivity: (v) => Number(v),
  sound_confirm_s: (v) => Number(v),
  sound_cooldown_s: (v) => Number(v),
  record_clips: (v) => !!v,
};

// Converts only the keys PRESENT in `patch` — the point of a patch rather than a full-state payload.
// This is the one function every real send goes through, whether the patch is a single field (a
// slider drag, a tile toggle) or a whole form's worth (DetectionSettings' initial `d`, which happens
// to have every key present and so round-trips unchanged — there is no separate "full payload"
// function to keep in sync with this one; factoring the per-field rules out into FIELD_CONVERTERS
// above is what makes that true rather than something that has to be maintained by hand).
//
// `snapshot_password` is not just converted but conditionally INCLUDED: the server treats an absent
// password as "keep the stored one", so a blank must never be sent. Security note (issue #444): this
// only ever runs against `pending`, which is cleared the instant a send starts and re-populated only
// on failure (see doSend below) — so a typed password is dropped from this module's memory the moment
// its send succeeds. Retry can only ever resend one that is still sitting in a FAILED patch.
export function toPartialPayload(patch) {
  const out = {};
  for (const key of Object.keys(patch)) {
    if (key === 'snapshot_password') {
      if (patch.snapshot_password) out.snapshot_password = patch.snapshot_password;
      continue;
    }
    const convert = FIELD_CONVERTERS[key];
    out[key] = convert ? convert(patch[key]) : patch[key];
  }
  return out;
}

function createEntry() {
  return {
    pending: {}, // fields changed but not yet part of a successful send
    // The exact patch object a send is currently carrying, or null when nothing is in flight (issue
    // #444 fix 2). `pending` alone isn't enough for `pendingPatch()`: doSend clears `pending` the
    // MOMENT a send starts, so a screen revisited between "send started" and "send resolved" would
    // otherwise seed its form from stale CamerasContext values while "Saving…" is still showing, and
    // initedRef then blocks the eventual refresh from correcting it.
    inFlightPatch: null,
    rev: 0, // bumped on every queuePatch call
    sentRev: 0, // the rev that was current when the in-flight/last send started
    inFlight: false,
    timer: null,
    state: 'idle', // 'idle' | 'saving' | 'saved' | 'failed'
    kind: null, // which screen the latest queued patch came from ('motion'/'sound'/'schedule'), or
    // null for the camera tile's quick toggles — read by CameraSettings' failure banner to link back
    // to the right screen.
    error: null,
    send: null, // (payload) => Promise — injected per call, captured here because the eventual send
    // can fire long after the component that queued it has unmounted (the fix for defect 1).
    onSaved: null,
    saveToken: 0,
    // Every queuePatch() caller waiting to know how ITS OWN revision turned out (issue #444 fix 1/3):
    // { rev, resolve, reject }, settled by settleWaiters() as sends complete. Needed because the
    // entry has only ONE `send`/`onSaved` slot — the old design (CameraTile resolving its own Promise
    // from inside `send`) broke the instant a second caller queued a patch for the same camera, since
    // that overwrote `send` before the first caller's request had even gone out.
    waiters: [],
    snapshot: DEFAULT_SNAPSHOT, // cached for useSyncExternalStore — see notify()
  };
}

// Recomputes the cached public snapshot and tells every subscriber for this camera to re-read it.
// The snapshot is cached (not rebuilt on every getSnapshot() call) because useSyncExternalStore
// requires a snapshot that is reference-stable between actual changes — a fresh object on every call
// would make every render see a "new" value and defeats the point of the store.
function notify(cameraId) {
  const entry = registry.get(cameraId);
  if (entry) entry.snapshot = { state: entry.state, kind: entry.kind, error: entry.error };
  const subs = subscribers.get(cameraId);
  if (subs) for (const cb of subs) cb();
}

// Settles every not-yet-settled waiter (see queuePatch) whose call was carried by the send that just
// finished — rev <= sentRev — with the given outcome, and drops them from the list (a promise only
// ever settles once, and leaving already-settled entries around would mean re-scanning them on every
// future send for this camera forever). Waiters with a HIGHER rev weren't part of this payload; they
// stay queued for whichever later send actually carries their revision.
function settleWaiters(entry, sentRev, ok, err) {
  const remaining = [];
  for (const w of entry.waiters) {
    if (w.rev <= sentRev) {
      if (ok) w.resolve();
      else w.reject(err);
    } else {
      remaining.push(w);
    }
  }
  entry.waiters = remaining;
}

// Fires the real PUT for whatever is currently pending, if anything is pending and nothing else for
// this camera is already in flight. `force` is Retry's escape hatch: a failed send already set
// `sentRev === rev` (nothing new was queued after it failed), so the ordinary `rev > sentRev` guard —
// the thing that makes `flush` idempotent, see M7 in scripts/mutants.json — would otherwise make
// retrying the very last patch a silent no-op.
function doSend(cameraId, { force = false } = {}) {
  const entry = registry.get(cameraId);
  if (!entry) return;
  if (entry.inFlight) return;
  if (!force && entry.rev <= entry.sentRev) return;
  if (Object.keys(entry.pending).length === 0) return;

  clearTimeout(entry.timer);
  entry.timer = null;

  const sentRev = entry.rev;
  const snapshot = entry.pending;
  const payload = toPartialPayload(snapshot);

  // Sendability has to be checked on the CONVERTED payload, not the raw patch (issue #444 fix 4): a
  // patch that is non-empty but converts away to nothing — today only `{ snapshot_password: '' }`, a
  // password typed then cleared — would otherwise still fire an EMPTY PUT. The route restarts the
  // camera's detector on every write it receives regardless of body content, so an empty body still
  // costs a real detector restart for a change that has nothing left to actually send. Settle it as a
  // no-op success instead: nothing was sent, so 'saved' would be misleading, but the user's intent
  // (clear the password) is fully satisfied, so it isn't 'failed' either — 'idle' is the honest state.
  if (Object.keys(payload).length === 0) {
    entry.pending = {};
    entry.sentRev = sentRev;
    entry.inFlightPatch = null;
    entry.state = 'idle';
    entry.error = null;
    notify(cameraId);
    settleWaiters(entry, sentRev, true, null);
    return;
  }

  entry.pending = {};
  // The in-flight snapshot (issue #444 fix 2) — see the field comment on createEntry(). Cleared once
  // this send finishes, success or failure alike (on failure it's already been merged back into
  // `pending` below, so leaving it set a moment longer changes nothing pendingPatch() reports).
  entry.inFlightPatch = snapshot;
  entry.sentRev = sentRev;
  entry.inFlight = true;
  entry.state = 'saving';
  entry.error = null;
  notify(cameraId);

  const generation = currentGeneration;
  const sendFn = entry.send;
  const onSavedFn = entry.onSaved;

  // `sendFn` is invoked synchronously, right here — not deferred behind an extra microtask — so
  // `immediate: true` (the tile's quick toggles) really does fire the request without waiting on
  // anything. `Promise.resolve(...)` only normalises whatever it returns (or throws) into a promise
  // this can chain off of.
  let outcome;
  try {
    outcome = sendFn(payload);
  } catch (err) {
    outcome = Promise.reject(err);
  }

  Promise.resolve(outcome)
    .then(async () => {
      if (generation !== currentGeneration) return; // a later test's reset invalidated this run
      const e = registry.get(cameraId);
      if (!e) return;
      e.inFlight = false;
      e.inFlightPatch = null;
      if (e.rev !== sentRev) {
        // Something newer was queued while this send was in flight. This response is stale: it must
        // not report success (Codex F2), and the newer patch goes out right away rather than waiting
        // out another debounce — the user has already waited through this one. No refresh runs for a
        // superseded send (only the FINAL one below calls onSaved), so the callers whose revision
        // THIS payload actually carried are fully done — settle them now rather than making them wait
        // on an unrelated later batch that may not even include their fields anymore (issue #444
        // fix 1/3).
        notify(cameraId);
        settleWaiters(e, sentRev, true, null);
        doSend(cameraId);
        return;
      }
      e.state = 'saved';
      e.error = null;
      const token = ++e.saveToken;
      notify(cameraId);
      try {
        // Awaited, not fire-and-forget (issue #444 fix 3): a caller's queuePatch() promise resolves
        // only once the refresh it depends on has actually landed. Resolving right after the PUT let
        // a caller (CameraTile's toggle) clear its own "busy" guard while CamerasContext still held
        // the pre-save camera row, so a second tap read the stale value and re-sent an already-
        // current target state as if it were new.
        await onSavedFn?.();
      } catch {
        // A refresh failing after a successful save must not be reported as the SAVE having failed —
        // the PUT succeeding is what queuePatch()'s promise represents, not the refresh.
      }
      if (generation !== currentGeneration) return; // a reset landed while the refresh was in flight
      settleWaiters(e, sentRev, true, null);
      setTimeout(() => {
        if (generation !== currentGeneration) return;
        const e2 = registry.get(cameraId);
        // Only clear back to idle if nothing has changed the state since (a save started by a change
        // made during this 1.5s window must not be stamped over).
        if (!e2 || e2.state !== 'saved' || e2.saveToken !== token) return;
        e2.state = 'idle';
        notify(cameraId);
      }, SAVED_DISPLAY_MS);
    })
    .catch((err) => {
      if (generation !== currentGeneration) return;
      const e = registry.get(cameraId);
      if (!e) return;
      e.inFlight = false;
      // The failed patch goes back under whatever has arrived since — newer keys win — so a change
      // made AFTER the failure is what Retry actually sends, not the stale snapshot that just failed.
      e.pending = { ...snapshot, ...e.pending };
      e.state = 'failed';
      e.error = err;
      notify(cameraId);
      // Reject every waiter this failed send was carrying (issue #444 fix 1/3). If Retry later
      // succeeds, it settles a FRESH set of waiters (whatever's queued by then) — a promise only ever
      // settles once, and "the PUT failed" is the correct, final outcome for exactly this revision
      // range.
      settleWaiters(e, sentRev, false, err);
    });
}

// Merges `patch` into this camera's queue and (re)starts its debounce. `kind`/`send`/`onSaved` are
// captured on the entry itself, not just read for this call, because the eventual PUT this schedules
// can fire well after the caller (a component) is gone — there is nothing left to read fresh
// callbacks from at that point, which is the whole fix for "navigating away cancels the save".
export function queuePatch(cameraId, patch, { kind = null, send, onSaved, immediate = false } = {}) {
  let entry = registry.get(cameraId);
  if (!entry) {
    entry = createEntry();
    registry.set(cameraId, entry);
  }
  entry.pending = { ...entry.pending, ...patch }; // later keys win — the most recent edit wins
  entry.rev += 1;
  const rev = entry.rev; // THIS call's revision, captured now — settleWaiters() answers "was MY
  // change saved", never a later caller's, by comparing against it.
  entry.kind = kind;
  entry.send = send;
  entry.onSaved = onSaved;
  // Shows "Saving…" for the whole debounce window, not just once it fires — otherwise a change sits
  // silently for up to 700ms before the flag says anything is happening at all.
  entry.state = 'saving';
  entry.error = null;
  notify(cameraId);

  // Returns a promise per call, settled by settleWaiters() once a send carrying THIS revision
  // resolves (issue #444 fix 1/3) — replacing the old design where CameraTile built its own Promise
  // around `send` and resolved it from inside there. That broke the moment a second caller queued a
  // patch for the same camera: the entry has one `send` slot, so the later call's `send` overwrote
  // the earlier one's, and the earlier caller's resolve/reject were simply never invoked again.
  //
  // ⚠️ This MUST be built, and the waiter pushed, before doSend() runs below — not after. Every
  // ordinary send settles its waiters from inside an async `.then`/`.catch`, which is always deferred
  // at least one microtask, so the order wouldn't matter there. But `immediate: true` with a patch
  // that converts to an EMPTY payload (fix 4) settles its waiter SYNCHRONOUSLY, inside this very call
  // to doSend() — pushing the waiter afterward would push it into an array doSend already finished
  // scanning, and this call's promise would then never resolve at all. Found by actually running the
  // new F4 test against this ordering — it hung the test runner at its 5s timeout, not the more usual
  // clean assertion failure, which is exactly the kind of silent-forever-pending bug this whole queue
  // exists to prevent.
  const promise = new Promise((resolve, reject) => {
    entry.waiters.push({ rev, resolve, reject });
  });
  // A caller that doesn't need to know when ITS OWN write lands (most page callers — they read
  // outcome from useDetectionSave's `state` instead) is free to ignore this promise entirely. Without
  // a handler attached SOMEWHERE, a failed send would then surface as an unhandled promise rejection
  // instead of the intended `state: 'failed'` + Retry UI. This no-op catch is that handler — it does
  // not swallow the rejection for a caller that DOES use the returned promise: `.then`/`.catch` calls
  // on the same promise are independent, so `await queuePatch(...)` (CameraTile) still sees the real
  // rejection.
  promise.catch(() => {});

  clearTimeout(entry.timer);
  entry.timer = null;
  if (immediate) {
    doSend(cameraId);
  } else {
    entry.timer = setTimeout(() => doSend(cameraId), DEBOUNCE_MS);
  }

  return promise;
}

// Sends now if there is an unsent revision, otherwise does nothing — safe to call any number of
// times (an unmount effect, that same effect firing twice under React StrictMode, ...) because
// doSend's own `rev > sentRev` guard makes every call after the first a no-op.
export function flush(cameraId) {
  const entry = registry.get(cameraId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = null;
  doSend(cameraId);
}

// Resends the merged pending patch after a failure. A no-op if there is nothing pending (nothing to
// retry) or a send is already running.
export function retry(cameraId) {
  const entry = registry.get(cameraId);
  if (!entry) return;
  doSend(cameraId, { force: true });
}

// Whatever hasn't made it into a successful send yet, for this camera — queued-but-not-yet-sent
// changes, or a failed patch waiting on Retry. Used to re-seed a screen's form state on mount so a
// user who navigated away mid-edit (or after a failure) sees their own values, not the server's.
export function pendingPatch(cameraId) {
  const entry = registry.get(cameraId);
  if (!entry) return {};
  // The in-flight snapshot is included, pending's own keys winning on overlap (issue #444 fix 2):
  // doSend clears `pending` the MOMENT a send starts, so without this a screen revisited between
  // "send started" and "send resolved" would seed its form from the stale CamerasContext values
  // while "Saving…" is still showing — and initedRef then blocks the eventual refresh from
  // correcting it, since the effect only runs once per mount.
  return { ...entry.inFlightPatch, ...entry.pending };
}

export function subscribe(cameraId, callback) {
  let subs = subscribers.get(cameraId);
  if (!subs) {
    subs = new Set();
    subscribers.set(cameraId, subs);
  }
  subs.add(callback);
  return () => {
    subs.delete(callback);
    if (subs.size === 0) subscribers.delete(cameraId);
  };
}

function getSnapshot(cameraId) {
  const entry = registry.get(cameraId);
  return entry ? entry.snapshot : DEFAULT_SNAPSHOT;
}

// `state` is 'idle' | 'saving' | 'saved' | 'failed'. `kind` is which screen ('motion'/'sound'/
// 'schedule', or null for the camera tile's quick toggles) the current pending/in-flight/failed patch
// came from — read by CameraSettings' failure banner to link back to the right screen.
export function useDetectionSave(cameraId) {
  return useSyncExternalStore(
    (cb) => subscribe(cameraId, cb),
    () => getSnapshot(cameraId)
  );
}

// Test-only: drops every camera's queue and invalidates any send still in flight from a previous
// test. Clearing `registry` alone is not enough — a `.then`/`.catch` already scheduled on a real
// Promise from before the reset would still run later and could resurrect or corrupt an entry a
// later test creates fresh under the same camera id.
export function __resetForTests() {
  for (const entry of registry.values()) clearTimeout(entry.timer);
  registry.clear();
  subscribers.clear();
  currentGeneration += 1;
}
