// Has the person typed something into a settings form that has not been saved yet? (#396)
//
// Used by the push provider pages to disable "Send test": that button POSTs with no body and the server
// tests the SAVED configuration, so with edits on screen it would report on settings the person is not
// looking at ("Test sent" while the field they just corrected was never used, or a failure for a value
// they already fixed).
//
// DERIVED from the current state rather than a flag set in each onChange, on purpose: typing and then
// putting the original value back must make the button usable again, and a flag cannot know that.
//
//   form    the editable object the page renders (loaded from the server, then edited in place).
//   saved   the object as last loaded or last successfully saved. Never touched by typing.
//   secrets the separate secret inputs (a token, a password). They start empty and the server never
//           sends a secret back, so ANY non-empty value is an edit: there is nothing to compare it to.
//
// Values are compared as String(v ?? ''), not with ===. Gotify's `priority` is a number when it arrives
// from the server and a STRING once it has been typed into a number input, so `5 !== '5'` would leave a
// form that was edited 5 -> 6 -> 5 "dirty" for good (found in plan review, with a test that fails on `===`).
// `?? ''` (not `||`) so a loaded 0 stays '0' and is not read as "unset".
export function hasUnsavedEdits(form, saved, secrets = []) {
  if (secrets.some((s) => String(s ?? '') !== '')) return true;
  if (!form || !saved) return false;
  return Object.keys(form).some((k) => String(form[k] ?? '') !== String(saved[k] ?? ''));
}

// What the push pages print under the buttons while Send test is held back. One sentence so the three
// pages say the same thing.
export const UNSAVED_TEST_HINT =
  'Save your changes first — Send test uses the settings you last saved, not what is on screen.';
