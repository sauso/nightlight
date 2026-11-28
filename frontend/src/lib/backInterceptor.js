// Lets a screen take the Android Back button for itself while it is showing something Back should close first
// (the TV screen's full-screen tile), instead of the app stepping back through history or exiting.
//
// WHY this exists: useHardwareBack listens to the Capacitor `backButton` event, which the native shell fires INSTEAD of
// a key event, so a page cannot see Back through `keydown` in the app (it can in a desktop browser, as Escape). Two
// listeners on that event would both run for one press, so a screen that closed its overlay in its own listener
// would also have the app exit or step back in the same press. One owner, asked first, is the only shape that cannot
// do both. Only one handler is ever active: the screen that registers last wins, and unregistering only clears
// the registration it made.

let handler = null;

// Register `fn`: called on Back, returns true when it dealt with it (the app then does nothing more).
// Returns the function that removes it.
export function setBackHandler(fn) {
  handler = fn;
  return () => {
    if (handler === fn) handler = null;
  };
}

// Offer a Back press to the registered handler. True means it was handled and the caller must stop.
// A handler that throws counts as "not handled": a broken screen must not be able to take Back away from the app.
export function offerBackToScreen() {
  if (!handler) return false;
  try {
    return handler() === true;
  } catch {
    return false;
  }
}
