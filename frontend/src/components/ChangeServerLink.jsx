import { isNativeApp, changeServer } from '../lib/nativeBridge.js';

// Owner testing 2026-11-05 (Android app): enter a server you do not have a login for and you were stuck there, because "Change
// server" only lived in Settings, which a signed-out person never reaches. This puts the same action on the screens a signed-out
// person sees (sign-in, and "Can't reach"). Only the native app has a saved server to change, so a browser shows nothing.
// changeServer() is the Settings action unchanged: it stops playback, forgets the saved address and restarts the shell on its
// server screen. iOS uses the same plugin call but has not been tried.
export default function ChangeServerLink() {
  if (!isNativeApp()) return null;
  return (
    <button className="btn btn-secondary" type="button" onClick={changeServer} style={{ marginTop: 8 }}>
      Change server
    </button>
  );
}
