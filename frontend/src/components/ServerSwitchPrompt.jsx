import { useEffect, useState, useSyncExternalStore } from 'react';
import Modal from './Modal.jsx';
import {
  subscribeServerSwitchPrompt,
  getServerSwitchPrompt,
  dismissServerSwitchPrompt,
  confirmServerSwitch,
  takePendingServerRequest,
  SERVER_REQUEST_EVENT,
} from '../lib/nativeBridge.js';

// The one place the app asks before an alert or link moves it to another server (#559). The decision about
// WHICH dialog to show is in lib/nativeBridge.js (requestServerSwitch); this only shows it.
//
// Mounted once at the app root, OUTSIDE the sign-in gate (App.jsx): the saved-server list it relies on is the
// phone's own, so no sign-in is needed, and a request that arrives on the sign-in screen, or while the server
// cannot be reached, must still be answered rather than wait unseen.
//
// Also where the native shell's held request is collected: once when the app loads (a cold start from a link
// fires no event, because the page was not loaded yet) and again whenever the shell says it has one.
export default function ServerSwitchPrompt() {
  const prompt = useSyncExternalStore(subscribeServerSwitchPrompt, getServerSwitchPrompt);

  useEffect(() => {
    // Both calls swallow their own failures (takePendingServerRequest catches the native rejection), so
    // nothing here can throw into React. `void` marks the promise as deliberately not awaited.
    void takePendingServerRequest();
    const onRequest = () => { void takePendingServerRequest(); };
    window.addEventListener(SERVER_REQUEST_EVENT, onRequest);
    return () => window.removeEventListener(SERVER_REQUEST_EVENT, onRequest);
  }, []);

  if (!prompt) return null;
  // Keyed by request, so a newer request that replaces an open dialog starts with fresh busy/error state.
  return prompt.kind === 'confirm'
    ? <ConfirmSwitch key={prompt.id} prompt={prompt} />
    : <RefusedSwitch key={prompt.id} prompt={prompt} />;
}

// Long host names must wrap inside the sheet rather than push it wider than a phone screen.
const ORIGIN_STYLE = { overflowWrap: 'anywhere' };
const ACTIONS_STYLE = { display: 'flex', gap: 8, justifyContent: 'flex-end' };

function ConfirmSwitch({ prompt }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stay = () => dismissServerSwitchPrompt(prompt.id);

  async function doSwitch() {
    setBusy(true);
    setError('');
    // On success the app restarts into the other server and nothing after this runs. A false answer means it
    // did not switch: the server did not answer its health check, or it is no longer in the saved list.
    const switched = await confirmServerSwitch(prompt.id);
    if (!switched) {
      setBusy(false);
      setError('Couldn’t switch to that server, so the app stayed on this one. Check that it’s running and try again.');
    }
  }

  return (
    <Modal title="Switch server?" error={error} onClose={() => (busy ? null : stay())}>
      <p style={{ marginTop: 0 }}>An alert or link is from another server saved in this app:</p>
      <p><strong style={ORIGIN_STYLE}>{prompt.origin}</strong></p>
      <p className="muted">Switching stops anything playing here, including background listening.</p>
      {/* Stay first in the row AND the one focused when the dialog opens: the safe answer is the default
          one, so a stray Enter or a tap through does not change server. */}
      <div style={ACTIONS_STYLE}>
        <button type="button" className="btn" data-autofocus onClick={stay} disabled={busy}>Stay</button>
        <button type="button" className="btn btn-primary" onClick={doSwitch} disabled={busy}>
          {busy ? 'Switching…' : 'Switch'}
        </button>
      </div>
    </Modal>
  );
}

// Deliberately has no "add it" button: adding a server stays a step the person takes on the setup screen,
// never one an alert or link can lead them into.
function RefusedSwitch({ prompt }) {
  const close = () => dismissServerSwitchPrompt(prompt.id);
  return (
    <Modal title="Server not saved in this app" onClose={close}>
      <p style={{ marginTop: 0 }}>An alert or link is from a server this app hasn’t been connected to:</p>
      <p><strong style={ORIGIN_STYLE}>{prompt.origin}</strong></p>
      <p>Nothing has changed. If it’s your server, add it first from Settings → Change server.</p>
      <div style={ACTIONS_STYLE}>
        <button type="button" className="btn" data-autofocus onClick={close}>OK</button>
      </div>
    </Modal>
  );
}
