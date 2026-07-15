import { useEffect, useState } from 'react';

const DISMISS_KEY = 'nightlight_install_dismissed';

function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}

export default function InstallPrompt() {
  const [deferredEvent, setDeferredEvent] = useState(null);
  const [showIOSInstructions, setShowIOSInstructions] = useState(false);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1');

  useEffect(() => {
    if (isStandalone() || dismissed) return;

    function handleBeforeInstall(e) {
      e.preventDefault();
      setDeferredEvent(e);
    }
    function handleInstalled() {
      setDeferredEvent(null);
      dismiss();
    }
    window.addEventListener('beforeinstallprompt', handleBeforeInstall);
    window.addEventListener('appinstalled', handleInstalled);

    // Chrome/Android fire beforeinstallprompt themselves. iOS Safari never does —
    // there's no programmatic install API there, so show static instructions instead.
    if (isIOS()) setShowIOSInstructions(true);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstall);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, [dismissed]);

  function dismiss() {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }

  async function handleInstallClick() {
    if (!deferredEvent) return;
    deferredEvent.prompt();
    await deferredEvent.userChoice;
    setDeferredEvent(null);
    dismiss();
  }

  if (dismissed || isStandalone()) return null;
  if (!deferredEvent && !showIOSInstructions) return null;

  return (
    <div className="install-banner">
      {deferredEvent ? (
        <>
          <span>Install this app on your device for quick access, full-screen.</span>
          <button className="install-banner__btn" onClick={handleInstallClick}>Install</button>
        </>
      ) : (
        <span>
          Add to your Home Screen: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
        </span>
      )}
      <button className="install-banner__close" onClick={dismiss} aria-label="Dismiss">✕</button>
    </div>
  );
}
