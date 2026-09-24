import { useMemo, useState } from 'react';

// Persisted server state vs. in-flight user edits, kept as two separate things instead of one
// mutable form — issue #449.
//
// SettingsRecording.jsx used to do `useEffect(() => setForm(settings), [settings])`: a sync effect
// that copies the context's `settings` into local form state on every change. That is exactly the
// pattern that caused the bug — the on-demand switch there saves immediately and then refreshes the
// context, which republishes a NEW `settings` object, which re-fires the effect and overwrites every
// OTHER unsaved field (pre-roll, retention, wake-clip fields) with whatever the server last had,
// even though none of them were touched by that save.
//
// Deriving `form` at render time instead removes the sync effect entirely, so there is no code path
// left that can clobber a draft: a context refresh changes `settings`, `form` is recomputed as
// `{ ...settings, ...drafts }`, and any key the user has actually edited still comes from `drafts`
// and wins. A key nobody has touched has no entry in `drafts`, so it still tracks the server on every
// refresh — an effect-based "only sync untouched keys" fix would need to know, per key, whether it
// was ever edited; this gets that for free because editing is the only thing that ever populates
// `drafts` in the first place.
export function useSettingsDraft(settings) {
  const [drafts, setDrafts] = useState({});

  const form = useMemo(() => ({ ...settings, ...drafts }), [settings, drafts]);

  function setField(key, value) {
    setDrafts((d) => ({ ...d, [key]: value }));
  }

  function setFields(patch) {
    setDrafts((d) => ({ ...d, ...patch }));
  }

  // Drop each key from `sentValues` out of `drafts`, but only if the draft's CURRENT value still
  // equals what was actually sent (Object.is, so a stored 0 is never confused with "unset"). Without
  // that check, an edit typed while the save's request was still in flight would be silently thrown
  // away the moment that request's own (now-stale) payload gets marked saved — the draft would
  // vanish even though what's on screen was never sent anywhere.
  function markSaved(sentValues) {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const key of Object.keys(sentValues)) {
        if (key in next && Object.is(next[key], sentValues[key])) delete next[key];
      }
      return next;
    });
  }

  const dirtyKeys = Object.keys(drafts);

  return { form, setField, setFields, dirtyKeys, markSaved };
}
