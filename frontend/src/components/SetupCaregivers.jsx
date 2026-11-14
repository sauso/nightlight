import { useEffect, useState } from 'react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';
import { useDemoStatus } from '../lib/demoStatus.js';
import { holdReload } from '../lib/reloadGuard.js';
import AvatarEditor from './AvatarEditor.jsx';
import InvitePanel from './InvitePanel.jsx';

// Adds caregiver accounts from inside the setup guide (owner, 2026-11-05: "Add a caregiver account" used to jump to Settings,
// which broke the guide's feel). It is the same admin-only request Settings -> Users makes for a new account
// (POST /auth/users), so the server's checks are the ones that decide: an 8+ character password, a free username, a valid photo.
//
// What it deliberately does NOT do:
//  * keep the password anywhere after the request: it lives in this form's state only while it is being typed, is cleared the
//    moment the account is created, is never put in a message, and there is no draft (the guide has none, and a password must
//    never be stored);
//  * make an admin: the role is fixed to caregiver here, admin accounts stay in Settings;
//  * (#1094) offer a choice of how the caregiver gets a password: type one (the default), or "Send an invite", which shows the one-time
//    link and QR code (components/InvitePanel.jsx) for the caregiver to open and choose their own. The token lives in this component's
//    state only while the panel shows; there is no "Revoke" here (Settings -> Users has it), because the guide is for adding people;
//  * edit or delete: the list below is only "what you added just now"; Settings -> Users manages the rest.
const BLANK = { first_name: '', last_name: '', username: '', password: '', photo: null };

export default function SetupCaregivers({ onAdded }) {
  const demo = useDemoStatus();
  const readOnly = demo !== null;
  const [form, setForm] = useState(BLANK);
  const [added, setAdded] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // #1094: 'password' (type one) or 'invite' (send a link). The default keeps the guide exactly as it was for anyone who does not look.
  const [mode, setMode] = useState('password');
  const inviteMode = mode === 'invite';
  // The invite just made, while its panel is on screen: { token, expiresAt, firstName }.
  const [panel, setPanel] = useState(null);
  // The panel's token cannot be fetched again, so a background reload (App.jsx, after 15 s hidden: the admin leaves for a messaging
  // app to send the link) must not destroy it. Same hold as the two-factor set-up panel; released when the panel closes or the guide
  // is left.
  const panelOpen = !!panel;
  useEffect(() => (panelOpen ? holdReload() : undefined), [panelOpen]);

  const fullName = [form.first_name, form.last_name].map((part) => part.trim()).filter(Boolean).join(' ');
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));

  async function pickPhoto(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setError('');
    try {
      const photo = await fileToAvatarDataUrl(file);
      setForm((current) => ({ ...current, photo }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (busy || readOnly) return;
    // The field's `minLength` stops a short password in a browser, but the check is repeated here so it never depends on the
    // browser's form validation; the server's message is the same words (routes/auth.js).
    if (!inviteMode && form.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setBusy(true);
    setError('');
    try {
      const body = {
        username: form.username.trim(),
        role: 'caregiver',
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
      };
      // An invite sends `invite: true` and NO password key (the server refuses both together).
      if (inviteMode) body.invite = true; else body.password = form.password;
      if (form.photo) body.photo = form.photo;
      const created = await api.post('/auth/users', body, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      const next = [...added, { id: created?.id ?? body.username, name: fullName || body.username }];
      setAdded(next);
      setForm(BLANK); // the password goes with everything else
      if (inviteMode) setPanel({ token: created.invite.token, expiresAt: created.invite.expires_at, firstName: body.first_name });
      onAdded?.(next.length);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>Caregivers can view the children and live cameras in this installation. You can add more, or change them, later in Settings → Users.</p>
      {added.length > 0 && (
        <ul className="setup-caregivers__added" aria-label="Caregivers you added">
          {added.map((person) => <li key={person.id}>{person.name} <span aria-hidden="true">✓</span></li>)}
        </ul>
      )}
      {panel && (
        <InvitePanel token={panel.token} expiresAt={panel.expiresAt} firstName={panel.firstName} onDone={() => setPanel(null)} />
      )}
      {!panel && <form className="setup-caregivers" onSubmit={submit}>
        {error && <div className="error-banner" role="alert">{error}</div>}
        <div className="setup-caregivers__photo">
          <AvatarEditor name={fullName || 'Caregiver'} src={form.photo} size={64} onChange={pickPhoto} />
          {form.photo && <button type="button" className="icon-btn" onClick={() => setForm((current) => ({ ...current, photo: null }))}>Remove</button>}
        </div>
        <div className="onvif-box__row">
          <div className="field">
            <label htmlFor="sc-first">First name</label>
            <input id="sc-first" value={form.first_name} onChange={set('first_name')} autoComplete="off" disabled={busy || readOnly} />
          </div>
          <div className="field">
            <label htmlFor="sc-last">Last name</label>
            <input id="sc-last" value={form.last_name} onChange={set('last_name')} autoComplete="off" disabled={busy || readOnly} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="sc-username">Username</label>
          <input id="sc-username" value={form.username} onChange={set('username')} autoComplete="off" autoCapitalize="none" required disabled={busy || readOnly} />
        </div>
        <div className="field">
          <div className="seg-track" role="group" aria-label="How they get a password">
            <button type="button" aria-pressed={!inviteMode} className={`seg-track__btn${!inviteMode ? ' seg-track__btn--active' : ''}`}
              onClick={() => setMode('password')} disabled={busy || readOnly}>Set a password</button>
            <button type="button" aria-pressed={inviteMode} className={`seg-track__btn${inviteMode ? ' seg-track__btn--active' : ''}`}
              // The typed password is dropped: a hidden field must not keep a secret the person can no longer see.
              onClick={() => { setMode('invite'); setForm((current) => ({ ...current, password: '' })); }} disabled={busy || readOnly}>Send an invite</button>
          </div>
          {inviteMode && <div className="camera-tile__sub" style={{ marginTop: 6 }}>You get a link and a QR code to give them. They open it and choose their own password.</div>}
        </div>
        {!inviteMode && (
          <div className="field">
            <label htmlFor="sc-password">Password</label>
            <input id="sc-password" type="password" minLength={8} value={form.password} onChange={set('password')} autoComplete="new-password" required disabled={busy || readOnly} />
            <div className="camera-tile__sub">At least 8 characters.</div>
          </div>
        )}
        <button className="btn btn-secondary" type="submit" disabled={busy || readOnly}>
          {inviteMode
            ? (busy ? 'Creating…' : 'Create and show invite')
            : (busy ? 'Adding…' : added.length ? 'Add another caregiver' : 'Add caregiver')}
        </button>
        {readOnly && <p>This demo is read-only, so changes are disabled.</p>}
      </form>}
    </>
  );
}
