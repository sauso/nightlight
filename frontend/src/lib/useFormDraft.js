import { useEffect } from 'react';
import { useAuth } from './AuthContext.jsx';
import { draftKey, pickDraftFields, saveDraft, clearDraft } from './formDraft.js';
import { hasUnsavedEdits } from './unsavedEdits.js';

// The draft key for one form of the signed-in user (see formDraft.js for why it is per user).
export function useDraftKey(formId) {
  const { user } = useAuth();
  return draftKey(user?.id, formId);
}

// Keeps the stored draft equal to "what is on screen, if it differs from what is saved" (#377).
//
// DERIVED, not event-driven, on purpose: the same reasoning as hasUnsavedEdits (#396). Typing a value and
// then typing the original back must leave NO draft, and a successful save must clear it; deriving both
// from (form vs baseline) gets those for free, where a write in every onChange plus a clear in every save
// path would miss one the first time a form gained a field.
//
//   form      the object on screen
//   baseline  the object as last loaded or successfully saved (typing never touches it)
//   allow     the fields that may be stored; secrets are never in this list (see formDraft.js)
//   ready     false until the form has been initialised from the server, so the empty first render of an
//             edit form is not mistaken for "the person cleared every field" and does not wipe a draft
//             the page has yet to restore
//
// Returns whether anything is unsaved, INCLUDING secret fields passed in `secrets` (a typed camera
// password is an unsaved edit even though it can never be stored), so the page can show its indicator.
export function useFormDraft({ key, allow, form, baseline, ready, secrets = [] }) {
  const picked = pickDraftFields(form, allow);
  const base = pickDraftFields(baseline, allow);
  // Only the fields that DIFFER from what is saved are stored. Restoring then re-applies exactly what the
  // person changed and leaves every other field to follow the server, so a setting changed elsewhere in the
  // meantime is not overwritten by a stale copy of a field nobody touched. Compared as strings, like
  // hasUnsavedEdits: a number input hands back '6' where the server sent 6.
  const changed = {};
  for (const k of Object.keys(picked)) {
    if (String(picked[k] ?? '') !== String(base[k] ?? '')) changed[k] = picked[k];
  }
  const storable = Object.keys(changed).length > 0;
  const serialised = JSON.stringify(changed);

  useEffect(() => {
    if (!ready) return;
    if (storable) saveDraft(key, JSON.parse(serialised), allow);
    else clearDraft(key);
    // `allow` is a module constant on every page; the serialised snapshot is what actually changes.
  }, [ready, storable, serialised, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return ready && (storable || hasUnsavedEdits({}, {}, secrets));
}
