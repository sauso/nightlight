import { useEffect, useRef, useState } from 'react';
import QrCode from './QrCode.jsx';
import { copyText } from '../lib/copyText.js';
import { useHomeTime } from '../lib/useHomeTime.js';

// "Valid until <date and time>": a few words, in the home time zone like every other time in the app (lib/homeTime.js), with the
// short zone name added only when this device is somewhere else.
const EXPIRY_FORMAT = Object.freeze({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// The server sends UTC text without a zone marker ("2026-11-21 22:10:03", the same shape as every session time). The `T` makes it
// ISO 8601 so Safari parses it (it refuses a space before the `Z`); the `Z` makes it UTC.
function parseUtcText(text) {
  if (typeof text !== 'string') return null;
  const date = new Date(`${text.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// The caregiver invite the admin hands over (#1094): a QR code and a link, shown ONCE, right after the invite is made (or re-issued).
//
// THE TOKEN: the server never returns it again, so this panel is the only place it exists. It is drawn in exactly two places, the QR
// and the link the admin copies. It is not logged, not stored (no localStorage/sessionStorage), not in an analytics call, and not in
// any accessible name (the QR's label is a fixed phrase, the Copy button's name says "link"), so a screen reader never reads it out
// twice. The parent keeps it in component state only, which is why a reload loses it (the admin makes a new invite).
//
// THE ADDRESS: the link is built from the page the admin is looking at, `window.location`, not from a server setting. The server cannot
// reliably know the address people use (behind a proxy, a Tailscale name, a LAN IP), and the admin's browser is by definition one
// that reaches the server. The HashRouter keeps the token after the `#`, so it is not sent to the server or into a proxy log. The
// panel says so in plain words: an address that only works on the home network gives a link that only works there.
//
// `onRevoke` (optional) adds a "Revoke invite" button. No confirmation: it is undone by making another invite.
export default function InvitePanel({ token, expiresAt, firstName, onRevoke, onDone }) {
  const { dateTime } = useHomeTime();
  const [copied, setCopied] = useState(null); // null | 'copied' | 'manual' (see lib/copyText.js)
  const [revoking, setRevoking] = useState(false);

  // The panel REPLACES the form whose button the admin just pressed, so focus would fall to <body> and a screen-reader or keyboard
  // user would be left at the top of the page with no sign anything happened (review of #1096). Move it to the heading, which names
  // what appeared. tabIndex -1 makes it focusable by script only (not a tab stop).
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus(); }, []);

  const link = `${window.location.origin}${window.location.pathname}#/invite/${token}`;
  const expiry = parseUtcText(expiresAt);
  const expiryText = expiry ? dateTime(expiry, EXPIRY_FORMAT) : '';
  const who = firstName?.trim() || 'the person you are inviting';

  async function revoke() {
    setRevoking(true);
    try {
      await onRevoke();
    } finally {
      setRevoking(false);
    }
  }

  return (
    <section className="card invite-panel" aria-label="Caregiver invite">
      <h2 className="card-heading" ref={headingRef} tabIndex={-1} style={{ outline: 'none' }}>{firstName?.trim() ? `Invite for ${firstName.trim()}` : 'Invite ready'}</h2>
      <QrCode value={link} label="Scan to open your invite" />
      <p className="invite-panel__link">{link}</p>
      <div className="tailscale-actions">
        <button type="button" className="btn btn-secondary" onClick={async () => setCopied(await copyText(link))}>Copy link</button>
      </div>
      {/* Always in the page (empty until there is something to say): a live region is announced when its text CHANGES, and one that
          appears together with its text is often missed. */}
      <p role="status" aria-live="polite" className="invite-panel__status">
        {copied === 'copied' ? 'Copied' : copied === 'manual' ? 'Couldn’t copy. Select the link above and copy it by hand.' : ''}
      </p>
      {expiryText && <p><strong>Valid until {expiryText}</strong></p>}
      <p>This link uses the address you are using now ({window.location.host}). It only works where that address works, so on your home network if it is a home address.</p>
      <p>Anyone with this link can set the password: send it only to {who}. It works once and expires in 7 days.</p>
      <div className="form-actions">
        {onDone && <button type="button" className="btn btn-primary" onClick={onDone}>Done</button>}
        {onRevoke && <button type="button" className="btn btn-secondary" onClick={revoke} disabled={revoking}>Revoke invite</button>}
      </div>
    </section>
  );
}
