// Lets a screen that holds state the server cannot give back stop the "reload after a long spell in the
// background" rule in App.jsx (#765). The two-factor set-up panel is the case: its secret, QR and half-typed
// code live only in React state, and on a phone the person leaves for their authenticator app (hidden for
// well over 15 s) and comes back to a reload that wipes them.
//
// A COUNT, not a flag, so two holders cannot release each other's hold; each holdReload() returns its own
// release, which is safe to call twice.
let holds = 0;

export function holdReload() {
  holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
  };
}

export function isReloadHeld() {
  return holds > 0;
}
