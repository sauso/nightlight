import { useEffect } from 'react';

// Puts `setup-wizard` on <html> while `active` is true. index.css keys off it: it hides the bottom bar / sidebar and draws the
// navy strip under the phone's status bar (the setup screens have no header of their own, so without the strip the page scrolls
// up behind the status-bar icons, and a light page colour hides those icons).
//
// A class on <html> because the navigation lives outside the pages (Shell in App.jsx) - the way modals use `modal-scroll-locked`.
// Used by the guide (Setup.jsx) and by the screens before the first admin exists (FirstRun.jsx, on the Login route), so the
// status bar looks the same from the welcome screen to the last step.
export function useSetupChrome(active = true) {
  useEffect(() => {
    if (!active) return undefined;
    document.documentElement.classList.add('setup-wizard');
    return () => document.documentElement.classList.remove('setup-wizard');
  }, [active]);
}
