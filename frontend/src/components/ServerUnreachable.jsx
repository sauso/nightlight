import { useSettings } from '../lib/SettingsContext.jsx';
import { isTailnetHost } from '../lib/tailnetHost.js';
import ChangeServerLink from './ChangeServerLink.jsx';

// Shown instead of the sign-in form when startup cannot reach the server (#382). Sign-in is only right
// when the server ANSWERED and said this device is not signed in (a 401): showing the form to someone
// whose server is merely down invites a password retype that cannot work and reads as "my login broke".
// Retrying itself is the caller's (useAutoRetry plus this button); this is only the calm face of it.
// `hostname` is a prop only so a test can say which address the page was opened at (jsdom will not let a test change
// window.location); every real caller leaves it out.
export default function ServerUnreachable({ onRetry, retrying, hostname = window.location.hostname }) {
  const { settings } = useSettings();
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <img src="/icons/icon-192.png" alt="" className="auth-icon" />
        <h1>{settings.app_name}</h1>
        <p className="tagline" role="status">
          Can't reach {settings.app_name}. Trying again…
        </p>
        <p className="camera-tile__sub" style={{ textAlign: 'center' }}>
          {isTailnetHost(hostname)
            ? 'Check that Tailscale is switched on for this device and that the server is running. This page retries by itself.'
            : 'Check that the server is running and this device is on the home network. This page retries by itself.'}
        </p>
        <button className="btn btn-primary" type="button" onClick={onRetry} disabled={retrying}>
          {retrying ? 'Trying…' : 'Try again'}
        </button>
        <ChangeServerLink />
      </div>
    </div>
  );
}
