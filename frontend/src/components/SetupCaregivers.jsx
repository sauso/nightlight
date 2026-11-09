import { useState } from 'react';
import { api, SLOW_REQUEST_TIMEOUT_MS } from '../lib/api.js';
import { fileToAvatarDataUrl } from '../lib/imageResize.js';
import { useDemoStatus } from '../lib/demoStatus.js';
import AvatarEditor from './AvatarEditor.jsx';

// Adds caregiver accounts from inside the setup guide (owner, 2026-11-05: "Add a caregiver account" used to jump to Settings,
// which broke the guide's feel). It is the same admin-only request Settings -> Caregivers makes for a new account
// (POST /auth/users), so the server's checks are the ones that decide: an 8+ character password, a free username, a valid photo.
//
// What it deliberately does NOT do:
//  * keep the password anywhere after the request: it lives in this form's state only while it is being typed, is cleared the
//    moment the account is created, is never put in a message, and there is no draft (the guide has none, and a password must
//    never be stored);
//  * make an admin: the role is fixed to caregiver here, admin accounts stay in Settings;
//  * edit or delete: the list below is only "what you added just now"; Settings -> Caregivers manages the rest.
const BLANK = { first_name: '', last_name: '', username: '', password: '', photo: null };

export default function SetupCaregivers({ onAdded }) {
  const demo = useDemoStatus();
  const readOnly = demo !== null;
  const [form, setForm] = useState(BLANK);
  const [added, setAdded] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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
    if (form.password.length < 8) { setError('Password must be at least 8 characters'); return; }
    setBusy(true);
    setError('');
    try {
      const body = {
        username: form.username.trim(),
        password: form.password,
        role: 'caregiver',
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
      };
      if (form.photo) body.photo = form.photo;
      const created = await api.post('/auth/users', body, { timeoutMs: SLOW_REQUEST_TIMEOUT_MS });
      const next = [...added, { id: created?.id ?? body.username, name: fullName || body.username }];
      setAdded(next);
      setForm(BLANK); // the password goes with everything else
      onAdded?.(next.length);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p>Caregivers can view the children and live cameras in this installation. You can add more, or change them, later in Settings → Caregivers.</p>
      {added.length > 0 && (
        <ul className="setup-caregivers__added" aria-label="Caregivers you added">
          {added.map((person) => <li key={person.id}>{person.name} <span aria-hidden="true">✓</span></li>)}
        </ul>
      )}
      <form className="setup-caregivers" onSubmit={submit}>
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
          <label htmlFor="sc-password">Password</label>
          <input id="sc-password" type="password" minLength={8} value={form.password} onChange={set('password')} autoComplete="new-password" required disabled={busy || readOnly} />
          <div className="camera-tile__sub">At least 8 characters.</div>
        </div>
        <button className="btn btn-secondary" type="submit" disabled={busy || readOnly}>
          {busy ? 'Adding…' : added.length ? 'Add another caregiver' : 'Add caregiver'}
        </button>
        {readOnly && <p>This demo is read-only, so changes are disabled.</p>}
      </form>
    </>
  );
}
